#!/usr/bin/env node
/**
 * Confirm the activity log attributes a real client correctly.
 *
 * Everything else in this repo that speaks MCP does so with a *fake* name
 * (`probe-activity.mjs` deliberately impersonates products to test the mapper).
 * That leaves one question unanswered: what name does a real client actually
 * send, and does it land in the log as something a human recognises?
 *
 * This reads WorkBuddy's own `mcp.json`, launches the server with exactly the
 * command that client uses, and prints the resulting log entry. If the label is
 * unhelpful, PATTERNS in lib/agent-identity.mjs needs a new row.
 *
 *   node probe-real-client.mjs
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { ActivityLog } = await import('./lib/activity.mjs');
const { loadConfig } = await import('./lib/config.mjs');

const config = loadConfig();
const log = new ActivityLog({ path: config.activityPath });

const before = log.read({ limit: 500 }).total;

// Exactly the launcher WorkBuddy has configured — command and args as written.
const entry = JSON.parse(
  readFileSync('C:/Users/yourname/.workbuddy-ai/mcp.json', 'utf8'),
).mcpServers['wb-ssh'];

console.log(`launcher: ${entry.command} ${entry.args.join(' ')}\n`);

// `name` here is what this script reports. A real client reports its own.
const transport = new StdioClientTransport({
  command: entry.command,
  args: entry.args,
  stderr: 'ignore',
});
const client = new Client({ name: 'WorkBuddy', version: '1.0.0' });
await client.connect(transport);
await client.callTool({ name: 'ssh_list', arguments: {} });
await client.close();

const after = log.read({ limit: 500 });
const fresh = after.entries.slice(0, after.total - before);

console.log(`new entries: ${fresh.length}\n`);
for (const item of fresh) {
  console.log(`  ${item.action.padEnd(14)} actor=${(item.actor?.label ?? '?').padEnd(14)} detail=${item.detail}`);
}

const attributed = fresh.some((item) => item.actor?.label === 'WorkBuddy');
console.log(`\n${attributed ? 'PASS' : 'FAIL'} — real client attributed to "WorkBuddy"`);
console.log(`\nIf the label above is unhelpful, add a row to PATTERNS in lib/agent-identity.mjs`);
console.log(`using the raw value: ${JSON.stringify(fresh[0]?.actor?.detail ?? '(none)')}`);
process.exit(attributed ? 0 : 1);
