#!/usr/bin/env node
/**
 * End-to-end check of the activity log.
 *
 * Two processes have to cooperate for this feature to be real: the MCP server
 * writes entries while handling tool calls, and the page reads them back from
 * a different process. Verifying either half alone proves very little.
 *
 * This drives the real MCP server over stdio under several different client
 * identities, then reads the shared log back through the page's own HTTP API
 * and asserts the entries landed with the right attribution.
 *
 *   node probe-activity.mjs [port]
 *
 * `port` is the connection-manager page to read back through. Omit it to skip
 * the HTTP half and only check what the MCP server wrote.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pagePort = Number(process.argv[2] ?? 0);

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${extra === '' ? '' : `  — ${extra}`}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${extra === '' ? '' : `  — ${extra}`}`);
  }
};

// An isolated world: our own config, records and log, so the user's real log is
// never touched and the assertions cannot be confused by previous entries.
const sandbox = mkdtempSync(join(tmpdir(), 'wb-ssh-activity-'));
if (!sandbox.startsWith(tmpdir())) throw new Error('refusing to run outside the temp dir');

const recordsPath = join(sandbox, 'connections.json');
const activityPath = join(sandbox, 'activity.jsonl');
const configPath = join(sandbox, 'config.json');
const credentialsPath = join(sandbox, 'credentials.yaml');

writeFileSync(recordsPath, JSON.stringify({
  version: 1,
  records: [
    {
      name: 'box1',
      host: '10.0.0.1',
      port: 2222,
      user: 'root',
      auth: { type: 'password', passwordRef: 'cred_box1_password' },
      createdAt: 1,
      updatedAt: 1,
    },
    {
      name: 'box2',
      host: '10.0.0.2',
      port: 22,
      user: 'deploy',
      auth: { type: 'password', passwordRef: 'cred_box2_password' },
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  tabs: [],
}, null, 2));

writeFileSync(credentialsPath, '');
writeFileSync(configPath, JSON.stringify({ recordsPath, credentialsPath, activityPath }, null, 2));

const env = {
  ...process.env,
  WB_SSH_CONFIG: configPath,
  DSH_HOME: sandbox,
};

/** Run one MCP session under a given client identity and call some tools. */
async function session(clientName, calls) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, 'server.mjs')],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: clientName, version: '9.9.9' });
  await client.connect(transport);
  const results = [];
  for (const call of calls) {
    results.push(await client.callTool({ name: call, arguments: call === 'ssh_exec' ? { connection: 'box1', command: 'uptime' } : {} }));
  }
  await client.close();
  return results;
}

/** Read the shared log straight off disk. */
function readLog() {
  return readFileSync(activityPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------- the checks

// Three different agents in sequence, each calling a couple of tools.
await session('WorkBuddy', ['ssh_list', 'ssh_status']);
await session('cursor-vscode', ['ssh_list']);
await session('claude-ai', ['ssh_list', 'ssh_status', 'ssh_exec']);

const entries = readLog();
check('日志文件被创建并写入', entries.length > 0, `${entries.length} 条`);

const calls = entries.filter((entry) => entry.action === 'mcp.call');
check('每次工具调用都有记录', calls.length === 6, `期望 6，实得 ${calls.length}`);

const byActor = (label) => calls.filter((entry) => entry.actor.label === label).length;
check('WorkBuddy 的调用被归给 WorkBuddy', byActor('WorkBuddy') === 2, `实得 ${byActor('WorkBuddy')}`);
check('Cursor 的调用被归给 Cursor', byActor('Cursor') === 1, `实得 ${byActor('Cursor')}`);
check('Claude 的调用被归给 Claude', byActor('Claude') === 3, `实得 ${byActor('Claude')}`);

// This probe reports itself as `wb-ssh-activity-...`, so it must NOT be
// mistaken for a real agent — and conversely a product name that merely
// contains a substring must not be swallowed by the diagnostic prefixes.
const { identifyAgent } = await import('./lib/agent-identity.mjs');
check('自检探针不会被当成 agent', identifyAgent({ name: 'wb-ssh-check-wb-ssh' }).label === '自检探针', identifyAgent({ name: 'wb-ssh-check-wb-ssh' }).label);
check('selftest 也被识别为探针', identifyAgent({ name: 'wb-ssh-selftest' }).label === '自检探针', identifyAgent({ name: 'wb-ssh-selftest' }).label);
check('真实产品名不受探针前缀影响', identifyAgent({ name: 'WorkBuddy' }).label === 'WorkBuddy');
check('claude-code 优先于 claude', identifyAgent({ name: 'claude-code' }).label === 'Claude Code', identifyAgent({ name: 'claude-code' }).label);
check('未识别的名字原样保留', identifyAgent({ name: 'some-new-client' }).label === 'some-new-client');

const versioned = calls.find((entry) => entry.actor.label === 'Cursor');
check('原始客户端名与版本被保留', versioned?.actor.detail.includes('cursor-vscode'), versioned?.actor.detail ?? '(无)');

const attached = calls.find((entry) => entry.detail.includes('ssh_exec'));
check('目标连接被解析出来', attached?.target.name === 'box1', JSON.stringify(attached?.target ?? {}));
check('目标主机被解析出来', attached?.target.host === '10.0.0.1', attached?.target.host ?? '(无)');
check('命令内容被记录', attached?.detail.includes('uptime'), attached?.detail ?? '(无)');

const listCall = calls.find((entry) => entry.detail.startsWith('ssh_list'));
check('无目标调用也能记录', listCall !== undefined && listCall.target.name === '');

// Regression: tool results arrive wrapped in an MCP envelope
// (`{content:[{type:'text',text:'<json>'}]}`), so reading `ok` off the envelope
// yields nothing. Every successful `ssh_list` was first logged as a failure
// because of this — assert the outcome and the summary both survived unwrapping.
check('成功的 ssh_list 记为成功', listCall?.ok === true, `ok=${JSON.stringify(listCall?.ok)}`);
check('ssh_list 的结果摘要被解出', listCall?.detail.includes('条连接'), listCall?.detail ?? '(空)');

const statusCall = calls.find((entry) => entry.detail.startsWith('ssh_status'));
check('ssh_status 也解出了摘要', statusCall !== undefined && statusCall.detail.includes('ssh_status'), statusCall?.detail ?? '(空)');

check('每次调用都带耗时', calls.every((entry) => typeof entry.ms === 'number'), `${calls.filter((e) => typeof e.ms === 'number').length}/${calls.length}`);

const starts = entries.filter((entry) => entry.action === 'system.start' && entry.source === 'mcp');
check('每次服务启动都有记录', starts.length === 3, `期望 3，实得 ${starts.length}`);

const serialised = readFileSync(activityPath, 'utf8');
// The manager names a missing credential in its error text
// (`password credential "cred_box1_password" is not configured`). That name
// must never reach disk — see `scrub()` in lib/agent-identity.mjs.
check('日志里没有出现凭据引用名', !serialised.includes('cred_box1_password'), '已脱敏');
check('日志里没有出现 cred_ / env: 形态的引用', !/\bcred_[A-Za-z0-9_]+/.test(serialised) && !/env:/.test(serialised));
check('日志里没有出现明文密码', !serialised.includes('"password"'));
check('脱敏占位符确实被写入了', serialised.includes('〔凭据引用〕'));

// Filtering is what the page relies on.
//
// Only `ssh_exec` names a connection; `ssh_list` and `ssh_status` are
// connection-less tools, so `target.name` is legitimately empty for them.
const { ActivityLog } = await import('./lib/activity.mjs');
const log = new ActivityLog({ path: activityPath });
// Note: filtering by actor alone also matches that agent's `system.start` line,
// which is correct — the same client really did launch the server. Assertions
// that care about calls alone add `action`.
check('按 agent 筛选', log.read({ actor: 'WorkBuddy' }).total === 3, `实得 ${log.read({ actor: 'WorkBuddy' }).total}（2 次调用 + 1 次启动）`);
check('按 agent+action 筛选', log.read({ actor: 'WorkBuddy', action: 'mcp.call' }).total === 2, `实得 ${log.read({ actor: 'WorkBuddy', action: 'mcp.call' }).total}`);
check('按 vps 名称筛选', log.read({ target: 'box1' }).total === 1, `实得 ${log.read({ target: 'box1' }).total}`);
check('按 action 筛选', log.read({ action: 'mcp.call' }).total === 6, `实得 ${log.read({ action: 'mcp.call' }).total}`);
check('组合筛选（agent+vps）', log.read({ actor: 'Claude', target: 'box1' }).total === 1, `实得 ${log.read({ actor: 'Claude', target: 'box1' }).total}`);
check('组合筛选（agent+vps，不匹配）', log.read({ actor: 'WorkBuddy', target: 'box1' }).total === 0, `实得 ${log.read({ actor: 'WorkBuddy', target: 'box1' }).total}`);
check('关键字搜索', log.read({ q: 'uptime' }).total === 1, `实得 ${log.read({ q: 'uptime' }).total}`);
check('倒序返回（最新在前）', entries[entries.length - 1].t <= log.read({ limit: 1 }).entries[0].t);
check('limit 生效', log.read({ limit: 2 }).entries.length === 2 && log.read({ limit: 2 }).truncated === true);

const facets = log.facets();
check('facets 列出所有 agent', facets.actors.length === 3, facets.actors.map((a) => a.label).join(', '));
check('facets 没有未知调用方', !facets.actors.some((a) => a.label === '未知调用方'), facets.actors.map((a) => a.label).join(', '));
check('facets 列出所有 vps', facets.targets.length === 1 && facets.targets[0].name === 'box1', facets.targets.map((t) => t.name).join(', '));

// ------------------------------------------------- demo rows must be labelled
//
// The first version of seed-activity.mjs wrote synthetic entries with no mark,
// and the log ended up claiming that four agents had been used on a day they
// were never launched. The user caught it. An audit trail that cannot be told
// apart from a fabricated one is worse than no audit trail, so the flag gets
// its own assertions.

const beforeCount = log.read({}).total;
log.write({ actor: { kind: 'agent', label: 'Qoder' }, action: 'mcp.call', detail: 'demo row', ok: true, source: 'mcp', demo: true });
log.write({ actor: { kind: 'agent', label: 'Qoder' }, action: 'mcp.call', detail: 'real row', ok: true, source: 'mcp' });

const afterDemo = log.read({ q: 'demo row' }).entries[0];
const afterReal = log.read({ q: 'real row' }).entries[0];
check('demo 标记能往返（写入 → 读回仍在）', afterDemo?.demo === true, JSON.stringify(afterDemo?.demo));
check('真实条目不带 demo 字段', afterReal !== undefined && !('demo' in afterReal), JSON.stringify(afterReal && Object.keys(afterReal)));
check('demo 标记没有污染其他字段', afterDemo?.actor?.label === 'Qoder' && afterDemo?.action === 'mcp.call');

// The raw file is the thing an auditor would open; the flag has to be visible
// there too, not just through the reader.
const rawLines = readFileSync(activityPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
const demoLines = rawLines.filter((line) => JSON.parse(line).demo === true);
check('原始 JSONL 里 demo 字段可被 grep 到', demoLines.length === 1, `实得 ${demoLines.length} 行`);
check('原始 JSONL 里真实行不含 demo 字段', rawLines.every((line) => JSON.parse(line).demo === true || !('demo' in JSON.parse(line))));

// Purge must be surgical: demo rows go, real rows stay.
const purged = log.purgeDemo();
check('purgeDemo 只删掉演示行', purged.ok === true && purged.removed === 1, JSON.stringify(purged));
check('purgeDemo 保留了全部真实行', purged.kept === beforeCount + 1, `期望 ${beforeCount + 1}，实得 ${purged.kept}`);
check('清除后演示行确实消失', log.read({ q: 'demo row' }).total === 0);
check('清除后真实行仍然在', log.read({ q: 'real row' }).total === 1);
check('再清一次是空操作', log.purgeDemo().removed === 0);

// A torn line (crash mid-append) is not demo data and must survive a purge.
appendFileSync(activityPath, '{"t":1,"action":"mcp.call","broken', 'utf8');
const afterTorn = log.purgeDemo();
check('半行不会被当成演示数据删掉', afterTorn.removed === 0 && readFileSync(activityPath, 'utf8').includes('"broken'));
// Clean up the torn line so the HTTP section below still sees a sane file.
log.clear();

// ------------------------------------------------- reading back through HTTP

if (pagePort > 0) {
  const config = JSON.parse(readFileSync(join(process.env.HOME ?? 'C:/Users/yourname', '.workbuddy-ai', 'ssh', 'config.json'), 'utf8'));
  const token = config.ui?.token ?? '';
  const res = await fetch(`http://127.0.0.1:${pagePort}/api/activity?limit=100`, {
    headers: { 'x-wb-ssh-token': token },
  });
  const payload = await res.json();
  check('页面进程能读到 MCP 进程写的日志', res.status === 200 && payload.ok === true, `HTTP ${res.status}`);
  check(
    '页面读到的是同一批条目',
    Array.isArray(payload.entries) && payload.entries.some((entry) => entry.actor?.label === 'Claude'),
    `${payload.entries?.length ?? 0} 条`,
  );
}

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
