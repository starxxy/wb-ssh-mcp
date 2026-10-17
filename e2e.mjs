#!/usr/bin/env node
/**
 * End-to-end verification against the real servers.
 *
 *   node e2e.mjs            # both saved connections
 *   node e2e.mjs vps1    # one connection
 *
 * Drives the real MCP server over stdio with the real MCP SDK client and
 * exercises every tool path that matters:
 *
 *   ssh_list -> ssh_exec (auto-connect) -> ssh_status -> ssh_disconnect
 *   long-running command -> ssh_exec_read (poll) -> ssh_exec_kill
 *   error paths (unknown connection, unknown execId)
 *
 * Every remote command is read-only. The shared records file is hashed before
 * and after to prove this server did not rewrite DSH's data.
 *
 * @module wb-ssh-mcp/e2e
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from './lib/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const wanted = process.argv.slice(2);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}
function info(text) {
  process.stdout.write(`      ${text}\n`);
}
function sha256(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return '(missing)';
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const recordsBefore = sha256(config.recordsPath);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'server.mjs')],
  stderr: 'pipe',
  env: { ...process.env },
});
const serverLog = [];
transport.stderr?.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    if (line.trim() !== '') serverLog.push(line.trimEnd());
  }
});

const client = new Client({ name: 'wb-ssh-e2e', version: '0.1.0' });

/** Call a tool and parse its JSON payload. */
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content ?? []).map((part) => part.text ?? '').join('');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { json, text, isError: response.isError === true };
}

await client.connect(transport);
check('MCP handshake over stdio', true);

const listed = await client.listTools();
// Pinned, not derived: the point is to notice when the surface changes.
// 8 vendored SSH tools + ssh_upload / ssh_download (see lib/sftp-tools.mjs).
check('tools/list', listed.tools.length === 10, `${listed.tools.length} tools`);

const list = await call('ssh_list');
const connections = list.json?.connections ?? [];
check('ssh_list', list.json?.ok === true, `${connections.length} saved connection(s)`);
for (const item of connections) {
  info(`${item.name}: ${item.user}@${item.host}:${item.port} — ${item.status}`);
}

const targets = connections
  .filter((item) => wanted.length === 0 || wanted.includes(item.name))
  .map((item) => item.name);

if (targets.length === 0) {
  process.stdout.write('INFO  nothing selected to exercise\n');
}

for (const name of targets) {
  process.stdout.write(`\n--- ${name} ---\n`);

  // 1. exec on a cold connection: must auto-connect, no separate ssh_connect.
  const uptime = await call('ssh_exec', { connection: name, command: 'uptime' });
  check(`${name}: ssh_exec auto-connects`, uptime.json?.ok === true && uptime.json?.status === 'done',
    uptime.json?.ok === true ? `exit=${uptime.json.exitCode}` : uptime.json?.message);
  if (uptime.json?.output) info(`uptime -> ${uptime.json.output.trim()}`);

  // 2. identity of the remote host, proving the password from the shared store worked.
  const who = await call('ssh_exec', { connection: name, command: 'id -un; uname -sr; hostname' });
  check(`${name}: authenticated as the expected user`, who.json?.ok === true, (who.json?.output ?? '').trim().replace(/\n/g, ' | '));

  // 3. status reflects the live session.
  const status = await call('ssh_status', { connection: name });
  check(`${name}: ssh_status reports connected`, status.json?.status === 'connected', `status=${status.json?.status}`);

  // 4. long command: returns "running" + execId, then poll it to completion.
  const long = await call('ssh_exec', { connection: name, command: 'sleep 3; echo LONG_DONE', timeoutMs: 800 });
  check(`${name}: long command returns running + execId`,
    long.json?.status === 'running' && typeof long.json?.execId === 'string',
    `status=${long.json?.status} execId=${long.json?.execId}`);

  if (typeof long.json?.execId === 'string') {
    const execId = long.json.execId;
    let read = await call('ssh_exec_read', { execId });
    check(`${name}: ssh_exec_read while running`, read.json?.ok === true && read.json?.running === true, `running=${read.json?.running}`);
    await sleep(3500);
    read = await call('ssh_exec_read', { execId });
    check(`${name}: ssh_exec_read sees completion`, read.json?.running === false && read.json?.exitCode === 0,
      `output=${(read.json?.output ?? '').trim()}`);
  }

  // 5. kill a long command.
  const killable = await call('ssh_exec', { connection: name, command: 'sleep 30; echo NEVER', timeoutMs: 800 });
  if (typeof killable.json?.execId === 'string') {
    const killed = await call('ssh_exec_kill', { execId: killable.json.execId });
    check(`${name}: ssh_exec_kill`, killed.json?.ok === true && killed.json?.killed === true, killed.json?.message);
  } else {
    check(`${name}: ssh_exec_kill`, false, `no execId (status=${killable.json?.status})`);
  }

  // 6. deliberate disconnect, then a reconnect through ssh_exec.
  const off = await call('ssh_disconnect', { connection: name });
  check(`${name}: ssh_disconnect`, off.json?.ok === true, off.json?.message);
  const after = await call('ssh_status', { connection: name });
  check(`${name}: status is disconnected afterwards`, after.json?.status === 'disconnected', `status=${after.json?.status}`);
  const back = await call('ssh_exec', { connection: name, command: 'echo RECONNECTED' });
  const backOk = back.json?.ok === true && (back.json?.output ?? '').includes('RECONNECTED');
  check(`${name}: ssh_exec reconnects on its own`, backOk,
    backOk ? `status=${back.json.status}` : `payload=${JSON.stringify(back.json)}`);
}

process.stdout.write('\n--- error paths ---\n');
const missing = await call('ssh_status', { connection: '__no_such_connection__' });
check('unknown connection is a readable failure, not a crash', missing.json?.ok === false && /no saved connection/.test(missing.json?.message ?? ''), missing.json?.message);

const badExec = await call('ssh_exec_read', { execId: 'deadbeef' });
check('unknown execId is a readable failure', badExec.json?.ok === false, badExec.json?.message ?? JSON.stringify(badExec.json));

const badTool = await client.callTool({ name: 'ssh_nope', arguments: {} }).catch((error) => ({ content: [{ text: error.message }], isError: true }));
check('unknown tool is rejected by the server', badTool.isError === true, (badTool.content?.[0]?.text ?? '').slice(0, 120));

// ssh_connect + ssh_delete round-trip, against a closed local port so no real
// host is touched. The record is created and then deleted, which also proves
// the shared records file comes back to exactly its original bytes.
process.stdout.write('\n--- ssh_connect / ssh_delete round-trip ---\n');
let sampleRef;
try {
  const stored = JSON.parse(readFileSync(config.recordsPath, 'utf8'));
  sampleRef = stored.records?.find((record) => record.auth?.passwordRef)?.auth.passwordRef;
} catch { /* handled below */ }
check('a password credential reference is available for the probe', typeof sampleRef === 'string', sampleRef === undefined ? 'no password-auth record found' : 'ref name only, value never read');

if (typeof sampleRef === 'string') {
  const tmpName = '__wb_ssh_e2e_tmp__';
  await call('ssh_delete', { connection: tmpName });
  const connect = await call('ssh_connect', {
    name: tmpName,
    host: '127.0.0.1',
    port: 1,
    user: 'nobody',
    auth: { passwordRef: sampleRef },
    timeoutMs: 3000,
  });
  check('ssh_connect to a closed port fails readably', connect.json?.ok === false, connect.json?.message);
  const stored = await call('ssh_status', { connection: tmpName });
  check('the failed attempt still saved the record', stored.json?.ok === true, `status=${stored.json?.status}`);
  const removed = await call('ssh_delete', { connection: tmpName });
  check('ssh_delete removes it again', removed.json?.ok === true && removed.json?.deleted === true, removed.json?.message);
}

const inlineSecret = await call('ssh_connect', {
  name: '__wb_ssh_e2e_tmp2__',
  host: '127.0.0.1',
  user: 'nobody',
  auth: { password: 'plaintext-should-be-rejected' },
});
check('inline secrets are refused', inlineSecret.json?.ok === false && /auth is required/.test(inlineSecret.json?.message ?? ''), inlineSecret.json?.message);

// leave everything closed
const finalList = await call('ssh_list');
for (const item of finalList.json?.connections ?? []) {
  if (item.status !== 'disconnected') await call('ssh_disconnect', { connection: item.name });
}

await client.close();

process.stdout.write('\n--- shared data integrity ---\n');
const recordsAfter = sha256(config.recordsPath);
check('DSH records file untouched by this run', recordsBefore === recordsAfter, `${recordsBefore.slice(0, 16)}…`);
const credsAfter = sha256(config.credentialsPath);
info(`credentials file sha256 ${credsAfter.slice(0, 16)}… (not written by this run)`);

if (serverLog.length > 0) {
  process.stdout.write('\n--- server stderr (tail) ---\n');
  for (const line of serverLog.slice(-12)) process.stdout.write(`${line}\n`);
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
