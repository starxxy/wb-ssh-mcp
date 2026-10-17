#!/usr/bin/env node
/**
 * Offline + protocol selftest for the wb-ssh MCP server.
 *
 *   node selftest.mjs
 *
 * Phase 1 (offline, no network, no SSH):
 *   - resolves the shared records and credential paths
 *   - loads the record store and lists saved connections
 *   - resolves each record's credential reference (value length only, never
 *     the value) so a broken credential path is caught before any connection
 *   - validates the DSH -> JSON Schema conversion for every tool
 *   - round-trips the credential YAML in memory to prove a write cannot damage
 *     the DSH-owned sections of the file
 *
 * Phase 2 (protocol):
 *   - spawns server.mjs over stdio with the real MCP SDK client
 *   - lists tools and calls ssh_list (no network: it only reads the store)
 *
 * Exits non-zero if any check fails. Nothing is written to disk.
 *
 * @module wb-ssh-mcp/selftest
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { SshManager } from './vendor/manager.js';
import { createTools } from './vendor/tools.js';
import { createSftpTools } from './lib/sftp-tools.mjs';
import { CredentialProvider } from './lib/credentials.mjs';
import { parametersToJsonSchema } from './lib/mcp-tools.mjs';
import { createLogger, loadConfig } from './lib/config.mjs';
import { resolveLocalPath, shellQuote } from './lib/sftp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const logger = createLogger('wb-ssh-selftest');
const results = [];

/**
 * Tools the server must expose: 8 vendored SSH tools + ssh_upload/ssh_download.
 * Pinned rather than derived from `declarations`, because a check that reads
 * its own expectation from the thing it is checking proves nothing.
 */
const EXPECTED_TOOLS = 10;

/** Record one check. */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

const config = loadConfig();
process.stdout.write(`\n== wb-ssh selftest ==\nrecords:     ${config.recordsPath}\ncredentials: ${config.credentialsPath}\n\n`);

// ---------------------------------------------------------------- phase 1

const credentials = new CredentialProvider({ path: config.credentialsPath, logger });
const manager = new SshManager({ credentials, logger }, config.manager);
manager.initialize();

const records = manager.store.list();
check('record store loaded', true, `${records.length} saved connection(s)`);

let allCredentialsResolve = true;
for (const record of records) {
  const resolved = await manager.resolveAuth(record);
  const label = `${record.name} (${record.user}@${record.host}:${record.port}, ${record.auth.type})`;
  if (resolved.ok) {
    const sizes = (resolved.secrets ?? []).map((secret) => `${secret.length} chars`).join(', ');
    check(`credential resolves: ${label}`, true, sizes === '' ? 'no secret needed' : sizes);
  } else {
    allCredentialsResolve = false;
    check(`credential resolves: ${label}`, false, resolved.error);
  }
}
if (records.length === 0) {
  process.stdout.write('INFO  no saved connections yet — add one in the DSH panel or with ssh_connect\n');
}
check('every saved connection has usable credentials', allCredentialsResolve);

const declarations = [...createTools(manager), ...createSftpTools(manager, config.sftp)];
const toolNames = declarations.map((declaration) => declaration.name);
check(`tool set built (${EXPECTED_TOOLS} expected)`, toolNames.length === EXPECTED_TOOLS, toolNames.join(', '));

let schemaOk = true;
for (const declaration of declarations) {
  const schema = parametersToJsonSchema(declaration.parameters);
  const bad = schema.type !== 'object' || typeof schema.properties !== 'object';
  if (bad) schemaOk = false;
  const required = Array.isArray(schema.required) ? schema.required.join(',') : '-';
  process.stdout.write(`      ${declaration.name}: props=${Object.keys(schema.properties).join(',') || '-'} required=${required}\n`);
}
check('every tool has a valid JSON Schema input', schemaOk);

// The SFTP path rules are pure functions, so they are checked here rather than
// only against a live server: an escaping `..` or a mis-quoted remote path must
// fail before anything is written, not after.
const relativeResolved = resolveLocalPath('sftp-selftest-target.txt');
check(
  'sftp: a relative local path resolves to an absolute one',
  relativeResolved.ok === true && isAbsolute(relativeResolved.path),
  relativeResolved.ok ? relativeResolved.path : relativeResolved.error,
);

const emptyRejected = resolveLocalPath('   ');
check('sftp: an empty local path is rejected', emptyRejected.ok === false, emptyRejected.error);

const outsideRoot = resolveLocalPath('sftp-selftest-target.txt', [join(process.cwd(), 'definitely-not-here')]);
check('sftp: localRoots rejects a path outside the allow-list', outsideRoot.ok === false, outsideRoot.error);

const quoted = shellQuote("a'b");
check('sftp: remote paths are shell-quoted', quoted === "'a'\\''b'", quoted);

try {
  const original = parseYaml(readFileSync(config.credentialsPath, 'utf8'));
  const roundTripped = parseYaml(stringifyYaml(original));
  const same = JSON.stringify(roundTripped) === JSON.stringify(original);
  const sections = Object.keys(original ?? {}).join(',');
  check('credential YAML round-trips losslessly', same, `top-level sections preserved: ${sections}`);
} catch (error) {
  check('credential YAML round-trips losslessly', false, error.message);
}

// ---------------------------------------------------------------- phase 2

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'server.mjs')],
  stderr: 'pipe',
  env: { ...process.env },
});
const client = new Client({ name: 'wb-ssh-selftest', version: '0.1.0' });

try {
  await client.connect(transport);
  check('MCP handshake over stdio', true);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  check(`tools/list returns the SSH tool set (${EXPECTED_TOOLS} expected)`, names.length === EXPECTED_TOOLS, names.join(', '));

  const call = await client.callTool({ name: 'ssh_list', arguments: {} });
  const text = call.content?.map((part) => part.text ?? '').join('') ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const ok = parsed?.ok === true && Array.isArray(parsed.connections);
  check('ssh_list over MCP', ok, ok ? `${parsed.connections.length} connection(s) returned` : text.slice(0, 200));
} catch (error) {
  check('MCP handshake over stdio', false, error.message);
} finally {
  await client.close().catch(() => {});
  await manager.shutdown();
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
