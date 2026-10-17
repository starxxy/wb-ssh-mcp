#!/usr/bin/env node
/**
 * Deterministic reproduction of the stale-close race in vendor/manager.js.
 *
 *   node probe-reconnect.mjs [connection] [iterations]
 *
 * The race: `disconnect` calls `client.end()`, which closes the socket
 * asynchronously. The next `ssh_exec` immediately builds a NEW client and
 * spawns a NEW shell — and only then does the OLD client's `close` event
 * arrive. That handler is guarded for `session.client` but not for
 * `session.shellStream`, and it ends with
 *
 *     if (becameReady) { this.startReconnect(session); ... }
 *
 * so a stale socket tears down the live shell's stream reference and starts an
 * auto-reconnect on a healthy connection. A human clicking "disconnect" then
 * typing cannot hit this; an agent issuing disconnect -> exec back to back can.
 *
 * Each iteration is: disconnect, exec immediately, then read the status the
 * race would have corrupted. Read-only commands only.
 *
 * @module wb-ssh-mcp/probe-reconnect
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const connection = process.argv[2] ?? 'vps1';
const iterations = Number(process.argv[3] ?? 12);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'server.mjs')],
  stderr: 'ignore',
  env: { ...process.env },
});
const client = new Client({ name: 'wb-ssh-probe', version: '0.1.0' });
await client.connect(transport);

async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content ?? []).map((part) => part.text ?? '').join('');
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

let failures = 0;
const signatures = new Map();

for (let i = 1; i <= iterations; i += 1) {
  await call('ssh_disconnect', { connection });
  const exec = await call('ssh_exec', { connection, command: 'echo RACE_PROBE' });
  const status = await call('ssh_status', { connection });

  const ok = exec.ok === true && (exec.output ?? '').includes('RACE_PROBE');
  if (!ok) failures += 1;

  const signature = ok
    ? 'ok'
    : `exec.status=${exec.status} ok=${exec.ok} status=${status.status} msg=${exec.message ?? ''}`;
  signatures.set(signature, (signatures.get(signature) ?? 0) + 1);

  process.stdout.write(
    `${ok ? 'ok  ' : 'FAIL'} #${String(i).padStart(2)} exec=${exec.status ?? '?'} exit=${exec.exitCode ?? '-'} `
    + `connStatus=${status.status ?? '?'} out=${JSON.stringify((exec.output ?? '').trim().slice(0, 24))}\n`,
  );

  // Leave the connection in a known state before the next iteration.
  if (status.status !== 'connected') await call('ssh_exec', { connection, command: 'true' });
}

process.stdout.write(`\n${iterations - failures}/${iterations} iterations clean\n`);
for (const [signature, count] of signatures) process.stdout.write(`  ${count}x  ${signature}\n`);

for (const item of (await call('ssh_list')).connections ?? []) {
  if (item.status !== 'disconnected') await call('ssh_disconnect', { connection: item.name });
}
await client.close();
process.exit(failures === 0 ? 0 : 1);
