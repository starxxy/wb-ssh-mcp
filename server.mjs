#!/usr/bin/env node
/**
 * wb-ssh — an MCP server exposing the SSH connection manager of
 * `@jmcc-guo/dsh-ssh` (the `starxxy/dsh-ssh` fork) to any MCP client.
 *
 * The DSH plugin itself cannot be installed outside DeepSeek Harness: its
 * entry point needs the DSH runtime (`ctx.tools`, `ctx.credentials`,
 * `ctx.settings`, the web server) and its UI half is a DSH web-GUI panel. Its
 * SSH core, however, is harness-free — `vendor/manager.js` is explicitly
 * Cordis-free and takes only `{credentials, logger}`. That core is reused here
 * verbatim; only the transport changes (MCP stdio instead of a DSH tool
 * registry) and the credential/record locations stay shared with DSH.
 *
 * Transport: stdio. Diagnostics go to stderr exclusively.
 *
 * @module wb-ssh-mcp
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { SshManager } from './vendor/manager.js';
import { createTools } from './vendor/tools.js';
import { createSftpTools } from './lib/sftp-tools.mjs';
import { CredentialProvider } from './lib/credentials.mjs';
import { callTool, toMcpTool } from './lib/mcp-tools.mjs';
import { createLogger, loadConfig } from './lib/config.mjs';
import { ActivityLog } from './lib/activity.mjs';
import { failureText, identifyAgent, outcomeOf, scrub, summarise, targetOf } from './lib/agent-identity.mjs';

const VERSION = '0.1.0';

const logger = createLogger('wb-ssh');
const config = loadConfig();
for (const warning of config.warnings) logger.warn(warning);

/**
 * The shared activity log.
 *
 * Appended to from this process and read by the connection-manager page, which
 * is a different process entirely — see `lib/activity.mjs`. Writes are
 * synchronous and never throw, so telemetry can never fail a tool call.
 */
const activity = new ActivityLog({ path: config.activityPath, logger });

const credentials = new CredentialProvider({ path: config.credentialsPath, logger });

const manager = new SshManager({ credentials, logger }, config.manager);
manager.initialize();

// The vendored SSH tool set plus this project's own additions. `vendor/` is a
// byte-for-byte upstream copy (see vendor/PROVENANCE.md), so anything upstream
// does not have is declared in `lib/` and appended here.
const declarations = [...createTools(manager), ...createSftpTools(manager, config.sftp)];
const tools = declarations.map(toMcpTool);
const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));

logger.info(
  'ready — %d tools, %d saved connections (%s), credentials (%s)',
  tools.length,
  manager.store.list().length,
  config.recordsPath,
  config.credentialsPath,
);

/**
 * Re-read the shared records file into memory.
 *
 * The DSH desktop client writes the same file whenever a connection is added,
 * edited or removed in its panel. `RecordStore.load()` merges rather than
 * replaces, so the in-memory table is cleared first — otherwise a record
 * deleted in DSH would survive here and be resurrected on the next write.
 *
 * Called immediately before every tool call, which keeps the window in which a
 * concurrent DSH write can be lost down to that single call.
 */
function resyncRecords() {
  try {
    manager.store.records.clear();
    manager.store.load();
  } catch (error) {
    logger.warn('record resync failed: %s', error instanceof Error ? error.message : String(error));
  }
}

const server = new Server(
  { name: 'wb-ssh', version: VERSION },
  {
    capabilities: { tools: {} },
    instructions:
      'SSH connections shared with the DeepSeek Harness SSH panel. '
      + 'Call ssh_list first to see the saved connections. '
      + 'Files move over SFTP with ssh_upload / ssh_download on any saved connection. '
      + 'Secrets are never passed inline: ssh_connect accepts auth.passwordRef '
      + '(a stored credential name or env:NAME), auth.privateKeyPath (a key file '
      + 'on this host) or auth.privateKeyRef.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const name = request.params?.name;
  const declaration = byName.get(name);
  if (declaration === undefined) {
    return {
      content: [{ type: 'text', text: `unknown tool "${name}"; available: ${[...byName.keys()].join(', ')}` }],
      isError: true,
    };
  }
  resyncRecords();
  logger.info('call %s', name);

  const args = request.params?.arguments ?? {};
  const started = Date.now();
  let result;
  let thrown;
  try {
    result = await callTool(declaration, args, extra);
  } catch (error) {
    // callTool already converts handler throws into `isError` content, so this
    // only fires on a defect inside callTool itself.
    thrown = error;
    throw error;
  } finally {
    recordCall(name, args, result, thrown, Date.now() - started);
  }
  return result;
});

/**
 * Recover a tool's own return value from the MCP envelope.
 *
 * `callTool` wraps every result as `{content:[{type:'text',text:'<json>'}]}` —
 * that is the wire format, not the tool's value. Reading `ok` or `connections`
 * off the envelope silently yields nothing, which is how every `ssh_list` first
 * showed up as a failure: no `ok` field, so the outcome fell through to
 * "unknown" and the summary was empty.
 *
 * The text is tried as JSON and falls back to the raw string, so a tool that
 * returns a plain message still reads sensibly.
 *
 * @param envelope - the value returned by `callTool`.
 * @returns the parsed tool value, or undefined when there is nothing to parse.
 */
function unwrapToolResult(envelope) {
  const text = envelope?.content?.find((part) => part.type === 'text')?.text;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Write one entry per tool call to the shared activity log.
 *
 * Runs in `finally`, so a call that throws is still recorded. The caller's
 * identity comes from the MCP handshake rather than the process table — see
 * `lib/agent-identity.mjs` for why.
 *
 * Nothing secret is stored: `summarise` echoes only the connection name and the
 * command line, never `auth.passwordRef` or any credential value.
 */
function recordCall(toolName, args, result, thrown, ms) {
  const payload = unwrapToolResult(result);

  // `isError` means the handler itself threw; that must win over a payload that
  // happens to look fine.
  const ok = result?.isError === true ? false : outcomeOf(payload);

  activity.write({
    actor: identifyAgent(server.getClientVersion()),
    action: 'mcp.call',
    target: targetOf(toolName, args, (key) => manager.store.get(key)),
    ok,
    // Scrubbed again as a whole, so a future branch added to `summarise` or
    // `failureText` cannot leak a reference name by being forgotten here.
    detail: scrub([toolName, summarise(toolName, args, payload), failureText(payload, thrown)]
      .filter((part) => typeof part === 'string' && part !== '')
      .join(' · ')),
    ms,
    source: 'mcp',
  });
}

let shuttingDown = false;

/** Close every SSH session, then exit. */
async function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down (%s)', reason);
  try {
    await manager.shutdown();
  } catch (error) {
    logger.warn('shutdown error: %s', error instanceof Error ? error.message : String(error));
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void shutdown(signal); });
}
process.on('uncaughtException', (error) => {
  logger.error('uncaught: %s', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection: %s', reason instanceof Error ? reason.message : String(reason));
});

await server.connect(new StdioServerTransport());
logger.info('stdio transport connected');

/**
 * One entry per server launch, written the moment the handshake completes.
 *
 * Not right after `connect()`: that promise resolves when the transport is
 * wired up, which can be *before* the client's `initialized` notification
 * arrives — and `getClientVersion()` is only populated by that notification.
 * Logging there produced "未知调用方" for the launch line. `oninitialized` is
 * the first moment the identity is guaranteed to be known.
 *
 * Over a day this makes the log readable as a timeline: bursts of calls are
 * bracketed by the process that served them, and a client restarting the
 * server is visible.
 */
server.oninitialized = () => {
  activity.write({
    actor: identifyAgent(server.getClientVersion()),
    action: 'system.start',
    detail: `MCP 服务启动 · ${tools.length} 个工具 · ${manager.store.list().length} 条连接`,
    ok: true,
    source: 'mcp',
  });
};
