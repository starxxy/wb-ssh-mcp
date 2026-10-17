#!/usr/bin/env node
/**
 * Put demo entries into the activity log so the page can be judged with data
 * in it.
 *
 * ⚠️ READ THIS BEFORE RUNNING
 *
 * These entries are **indistinguishable from real tool calls** if they are
 * written plainly: they come from a real MCP server, over a real stdio pipe,
 * with a real `clientInfo`. That is exactly what makes them useful for
 * designing the page — and exactly what makes them dangerous in an audit log.
 *
 * The first version of this script did write them plainly, and the result was
 * a log claiming that Qoder, Antigravity, Cursor and Claude had each connected
 * to servers on a day they were never launched. The user spotted it. An audit
 * trail that cannot be trusted is worse than no audit trail.
 *
 * So every entry is now stamped `demo: true`, `ActivityLog` persists that flag,
 * and the page renders it as a "演示" badge. `--purge` removes them again.
 *
 *   node seed-activity.mjs           # add demo entries
 *   node seed-activity.mjs --purge   # remove every demo entry, keep real ones
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const { ActivityLog } = await import('./lib/activity.mjs');
const { loadConfig } = await import('./lib/config.mjs');
const config = loadConfig();
const log = new ActivityLog({ path: config.activityPath });

// ---------------------------------------------------------------- --purge

if (process.argv.includes('--purge')) {
  const result = log.purgeDemo();
  if (result.ok !== true) {
    process.stderr.write(`清除失败：${result.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`已清除 ${result.removed} 条演示数据，保留 ${result.kept} 条真实记录\n`);
  process.exit(0);
}

// ------------------------------------------------------------------- seed

/**
 * Impersonated clients. Each entry is written with `demo: true` regardless of
 * which name it claims, so the page can label it.
 */
const SESSIONS = [
  { name: 'WorkBuddy', tools: ['ssh_list', 'ssh_status', 'ssh_exec'] },
  { name: 'claude-ai', tools: ['ssh_list', 'ssh_exec'] },
  { name: 'cursor-vscode', tools: ['ssh_list'] },
  { name: 'antigravity', tools: ['ssh_list', 'ssh_status'] },
  { name: 'qoder', tools: ['ssh_list', 'ssh_exec'] },
];

/**
 * Mark every entry written since `mark` as demo data.
 *
 * The MCP server writes the log itself, so there is no way to pass a flag
 * through a tool call. Instead the entries are rewritten in place afterwards:
 * read, tag the ones created in this run, write back. The log is small and this
 * runs offline, so a read-modify-write is fine here.
 *
 * @param mark - epoch ms captured before the run started.
 * @returns how many entries were tagged.
 */
function tagAsDemo(mark) {
  const all = log.read({ limit: 5000 }).entries;
  const tagged = all.map((entry) => (entry.t >= mark ? { ...entry, demo: true } : entry));
  const count = tagged.filter((entry) => entry.demo === true).length;
  writeFileSync(config.activityPath, `${tagged.reverse().map((e) => JSON.stringify(e)).join('\n')}\n`);
  return count;
}

async function run(clientName, toolNames) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, 'server.mjs')],
    env: { ...process.env },
    stderr: 'ignore',
  });
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(transport);

  // ssh_list first so target resolution has a real record to read.
  await client.callTool({ name: 'ssh_list', arguments: {} });

  for (const tool of toolNames) {
    const args = tool === 'ssh_exec'
      ? { connection: 'vps1', command: 'uptime && df -h /' }
      : tool === 'ssh_status'
        ? { connection: 'aliyun1' }
        : {};
    await client.callTool({ name: tool, arguments: args }).catch(() => {});
  }
  await client.close();
}

const startedAt = Date.now();

for (const session of SESSIONS) {
  await run(session.name, session.tools);
  process.stdout.write(`seeded ${session.name}\n`);
}

// Two representative browser-side entries, written through the same ActivityLog
// the page uses.
log.write({
  actor: { kind: 'human', label: '本机页面', detail: '' },
  action: 'connect',
  target: { name: 'vps1', host: '198.51.100.30', port: 22, user: 'root' },
  ok: true,
  detail: '连接成功',
  ms: 2840,
  source: 'ui',
  demo: true,
});
log.write({
  actor: { kind: 'system', label: '访问栅栏', detail: 'unexpected Origin "http://evil.example.com"' },
  action: 'access.denied',
  ok: false,
  detail: 'POST /api/state 被拒：unexpected Origin "http://evil.example.com"',
  source: 'ui',
  demo: true,
});

const tagged = tagAsDemo(startedAt);
process.stdout.write(`\n${tagged} 条记录已标记为演示数据（demo: true）\n`);
process.stdout.write(`清除它们：node seed-activity.mjs --purge\n`);
