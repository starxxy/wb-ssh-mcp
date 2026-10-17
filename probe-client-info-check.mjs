#!/usr/bin/env node
/**
 * Does the MCP handshake carry a usable caller identity?
 *
 * The activity log wants "which agent invoked this tool". The protocol has no
 * caller field, and the process table is a dead end on Windows (WMIC is gone,
 * the dev sandbox refuses to spawn any helper at all). But clients send
 * `initialize` with a `clientInfo` block naming the product, and the SDK
 * exposes it as `server.getClientVersion()`.
 *
 * This script drives `probe-client-info.mjs` as a real MCP client and prints
 * what the server saw — i.e. verifies the attribution source end to end.
 *
 *   node probe-client-info.mjs     # the server under test (not run directly)
 *   node probe-client-info-check.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The names real clients actually send, as observed in the wild.
const FAKE_CLIENTS = [
  { name: 'WorkBuddy', version: '1.0.0' },
  { name: 'claude-ai', version: '0.1.0' },
  { name: 'cursor-vscode', version: '1.2.3' },
];

let failures = 0;

for (const fake of FAKE_CLIENTS) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, 'probe-client-info.mjs')],
    stderr: 'pipe',
  });
  const client = new Client(fake);

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}');
    const seen = payload.clientInfo;

    if (seen?.name !== fake.name || seen?.version !== fake.version) {
      console.log(`FAIL  sent ${fake.name}@${fake.version} -> server saw ${JSON.stringify(seen)}`);
      failures += 1;
    } else {
      console.log(`PASS  sent ${fake.name}@${fake.version} -> server saw ${seen.name}@${seen.version}`);
    }
  } catch (error) {
    console.log(`FAIL  ${fake.name}: ${error.message}`);
    failures += 1;
  } finally {
    await client.close().catch(() => {});
  }
}

console.log(`\n${FAKE_CLIENTS.length - failures}/${FAKE_CLIENTS.length} clients were correctly identified`);
process.exit(failures === 0 ? 0 : 1);
