#!/usr/bin/env node
/**
 * Verify every MCP client that has wb-ssh registered can actually launch it.
 *
 * Reading the config and checking it parses proves very little — a wrong path
 * or a missing `type` field looks perfectly valid as JSON. So this takes the
 * `command`/`args` *out of each client's own config file* and spawns the server
 * with exactly those values, then does a real MCP handshake and `tools/list`.
 *
 * That is the same thing the client does at startup, minus the client.
 *
 *   node check-agents.mjs
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HOME = 'C:/Users/yourname';

// `root` is a dotted path into the JSON, because every client nests its server
// map differently: VS Code uses `servers`, ZCode uses `mcp.servers`, the rest
// use `mcpServers` at the top level.
const TARGETS = [
  { label: 'WorkBuddy', file: `${HOME}/.workbuddy-ai/mcp.json`, kind: 'json', root: 'mcpServers' },
  { label: 'Antigravity', file: `${HOME}/.gemini/config/mcp_config.json`, kind: 'json', root: 'mcpServers' },
  { label: 'Claude Code', file: `${HOME}/.claude.json`, kind: 'json', root: 'mcpServers' },
  { label: 'VS Code', file: `${HOME}/AppData/Roaming/Code/User/mcp.json`, kind: 'json', root: 'servers' },
  { label: 'Qoder', file: `${HOME}/.qoder/mcp.json`, kind: 'json', root: 'mcpServers' },
  { label: 'CodeBuddy', file: `${HOME}/.codebuddy/mcp.json`, kind: 'json', root: 'mcpServers' },
  { label: 'ZCode', file: `${HOME}/.zcode/cli/config.json`, kind: 'json', root: 'mcp.servers' },
  { label: 'TRAE SOLO', file: `${HOME}/AppData/Roaming/TRAE SOLO CN/User/mcp.json`, kind: 'json', root: 'mcpServers' },
  { label: 'Codex', file: `${HOME}/.codex/config.toml`, kind: 'toml' },
];

const SERVER_NAME = 'wb-ssh';

/** Pull { command, args } out of a client config, without launching anything. */
function extract(target) {
  const text = readFileSync(target.file, 'utf8');

  if (target.kind === 'json') {
    const container = target.root
      .split('.')
      .reduce((node, key) => (node === undefined ? undefined : node[key]), JSON.parse(text));
    const entry = container?.[SERVER_NAME];
    if (!entry) throw new Error(`no "${SERVER_NAME}" under "${target.root}"`);
    if (entry.command === undefined) {
      throw new Error(`entry has no "command" (url-based server? ${entry.url ?? 'n/a'})`);
    }
    return { command: entry.command, args: entry.args ?? [] };
  }

  // TOML: the [mcp_servers.wb-ssh] table, up to the next table header.
  const body = text.split(`[mcp_servers.${SERVER_NAME}]`)[1]?.split(/^\[/m)[0];
  if (body === undefined) throw new Error(`no [mcp_servers.${SERVER_NAME}] table`);
  const command = body.match(/^command\s*=\s*'([^']*)'/m)?.[1];
  if (command === undefined) throw new Error('table has no command = ... line');
  const argsLine = body.match(/^args\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '';
  const args = [...argsLine.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  return { command, args };
}

let failures = 0;

for (const target of TARGETS) {
  let command;
  let args;
  try {
    ({ command, args } = extract(target));
  } catch (error) {
    console.log(`FAIL  ${target.label.padEnd(12)} ${error.message}`);
    failures += 1;
    continue;
  }

  const transport = new StdioClientTransport({ command, args, stderr: 'pipe', env: { ...process.env } });
  // Named so the activity log files these calls under "自检探针" rather than
  // presenting them as a product — see PATTERNS in lib/agent-identity.mjs.
  const client = new Client({ name: 'wb-ssh-check', version: '0.1.0' });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const call = await client.callTool({ name: 'ssh_list', arguments: {} });
    const text = call.content?.map((part) => part.text ?? '').join('') ?? '';
    const connections = JSON.parse(text)?.connections?.length ?? '?';

    console.log(
      `PASS  ${target.label.padEnd(12)} handshake ok · ${tools.length} tools · ssh_list -> ${connections} connection(s)`,
    );
    console.log(`      ${command} ${args.join(' ')}`);
  } catch (error) {
    console.log(`FAIL  ${target.label.padEnd(12)} ${error.message}`);
    failures += 1;
  } finally {
    await client.close().catch(() => {});
  }
}

console.log(`\n${TARGETS.length - failures}/${TARGETS.length} client configs launch the server`);
process.exit(failures === 0 ? 0 : 1);
