#!/usr/bin/env node
/** Ad-hoc: what does one MCP session write to the log? */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sandbox = mkdtempSync(join(tmpdir(), 'dbg-'));
const recordsPath = join(sandbox, 'connections.json');
const activityPath = join(sandbox, 'activity.jsonl');
const configPath = join(sandbox, 'config.json');
const credentialsPath = join(sandbox, 'credentials.yaml');

writeFileSync(recordsPath, JSON.stringify({
  version: 1,
  records: [{ name: 'box1', host: '10.0.0.1', port: 2222, user: 'root', auth: { type: 'password', passwordRef: 'c' }, createdAt: 1, updatedAt: 1 }],
  tabs: [],
}));
writeFileSync(credentialsPath, '');
writeFileSync(configPath, JSON.stringify({ recordsPath, credentialsPath, activityPath }));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['C:/path/to/wb-ssh-mcp/server.mjs'],
  env: { ...process.env, WB_SSH_CONFIG: configPath, DSH_HOME: sandbox },
  stderr: 'ignore',
});
const client = new Client({ name: 'WorkBuddy', version: '9.9.9' });
await client.connect(transport);
await client.callTool({ name: 'ssh_list', arguments: {} });
await client.close();

for (const line of readFileSync(activityPath, 'utf8').trim().split('\n')) {
  const entry = JSON.parse(line);
  console.log(
    entry.action.padEnd(14),
    'actor=' + entry.actor.label.padEnd(14),
    'raw=' + JSON.stringify(entry.actor.detail).padEnd(20),
    'detail=' + entry.detail,
  );
}
