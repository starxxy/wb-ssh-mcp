/**
 * Throwaway probe: exercise rename through the UI's own HTTP API, in an
 * isolated DSH_HOME. Confirms the fixed `formBody` renames instead of failing.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';

const HOME = 'C:/Users/yourname/AppData/Local/Temp/dsh-ui-probe';
const PORT = 7899;
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

const child = spawn(process.execPath, ['ui.mjs', '--port', String(PORT), '--no-open'], {
  cwd: process.cwd(),
  env: { ...process.env, DSH_HOME: HOME, WB_SSH_CONFIG: HOME + '/none.json' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
let token = null;
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start:\n' + out)), 10000);
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
    const match = /t=([0-9a-f]+)/.exec(out);
    if (match && token === null) {
      token = match[1];
      clearTimeout(timer);
      resolve();
    }
  });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
});
await ready;
console.log('服务已起，token 前缀', token.slice(0, 8) + '…');
if (!readFileSync) throw new Error('unreachable');

const api = async (route, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wb-ssh-token': token },
    body: JSON.stringify(body),
  });
  return res.json();
};

const state = async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/state`, {
    headers: { 'x-wb-ssh-token': token },
  });
  return res.json();
};

const show = async (label) => {
  const s = await state();
  console.log('  [' + label + '] ' + s.connections.map((c) => c.name).join(', '));
  const disk = JSON.parse(readFileSync(HOME + '/storages/dsh-ssh/connections.json', 'utf8'));
  for (const r of disk.records) console.log('    磁盘 ' + r.name.padEnd(8), 'id=' + r.id, 'ref=' + (r.auth.passwordRef ?? '-'));
};

const base = { host: '127.0.0.1', port: 1, user: 'root', authType: 'password', tunnel: '' };

console.log();
console.log('=== 1. 新建 r_a（密码） ===');
console.log(' ', JSON.stringify(await api('save', { mode: 'create', name: 'r_a', ...base, password: 'pw1' })));
await show('1');

console.log();
console.log('=== 2. 改名 r_a -> r_b（修复后前端会传的 body） ===');
console.log(' ', JSON.stringify(await api('save', { mode: 'update', name: 'r_a', newName: 'r_b', ...base, password: '' })));
await show('2');

console.log();
console.log('=== 3. 再改名 r_b -> r_c（密码留空，应复用同一 ref） ===');
console.log(' ', JSON.stringify(await api('save', { mode: 'update', name: 'r_b', newName: 'r_c', ...base, password: '' })));
await show('3');

console.log();
console.log('=== 4. 改名 + 不存在的跳板机（上游 rename 顺序 bug 的触发条件） ===');
console.log(' ', JSON.stringify(await api('save', { mode: 'update', name: 'r_c', newName: 'r_d', ...base, password: '', tunnel: '没有这条' })));
await show('4');

child.kill();
