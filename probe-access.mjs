#!/usr/bin/env node
/**
 * End-to-end check of the access-credential paths: token, password, session
 * cookie, and the fences that must survive all three.
 *
 * Runs against a throwaway config file and DSH home in a temp directory, so the
 * real token, the real password hash, and the real connection list are never
 * read or written. The script asserts that before doing anything.
 *
 *   node probe-access.mjs
 */
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), 'wb-ssh-access-'));
const configPath = join(sandbox, 'config.json');
const dshHome = join(sandbox, 'dsh');
const PORT = 7911;

if (!sandbox.startsWith(tmpdir())) {
  console.error('refusing to run: sandbox is not under the temp directory');
  process.exit(1);
}

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`);
  if (ok) pass += 1;
  else fail += 1;
}

function http(path, options = {}) {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    call.on('error', reject);
    if (options.body !== undefined) call.write(options.body);
    call.end();
  });
}

const post = (path, payload, headers = {}) =>
  http(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });

const json = (res) => {
  try {
    return JSON.parse(res.body);
  } catch {
    return {};
  }
};

const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));

const child = spawn(process.execPath, [join(here, 'ui.mjs'), '--port', String(PORT), '--no-open'], {
  env: { ...process.env, WB_SSH_CONFIG: configPath, DSH_HOME: dshHome },
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

/** Wait for the listener, not for a particular status code. */
async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await http('/');
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

try {
  if (!(await waitForServer())) throw new Error('server did not start');
  if (!existsSync(configPath)) throw new Error('config was not written');
  if (sandbox !== dirname(configPath)) throw new Error('config escaped the sandbox');

  const token0 = readConfig().ui.token;
  check('首次启动写入了令牌', typeof token0 === 'string' && token0.length >= 32, `${token0.length} 字符`);

  // ---------------------------------------------------------------- fences

  const gate = await http('/');
  check('无凭据打开页面 → 403 HTML', gate.status === 403 && String(gate.headers['content-type']).includes('text/html'));

  const apiNoAuth = await http('/api/state');
  check('无凭据打 API → 403 JSON', apiNoAuth.status === 403 && String(apiNoAuth.headers['content-type']).includes('application/json'));

  const badHost = await http('/', { headers: { host: 'evil.example' } });
  check('伪造 Host → 403', badHost.status === 403);

  const badOrigin = await http('/', { headers: { origin: 'http://evil.example' } });
  check('跨站 Origin → 403', badOrigin.status === 403);

  const loginCrossOrigin = await post('/api/login', { password: 'x' }, { origin: 'http://evil.example' });
  check('登录接口也要过 Origin 栅栏', loginCrossOrigin.status === 403);

  // ---------------------------------------------------------------- token

  const withToken = await http(`/?t=${token0}`);
  check('带正确令牌 → 200', withToken.status === 200);

  const loginNoPassword = await post('/api/login', { password: 'anything' });
  check('未设密码时登录失败（且不提示原因）', json(loginNoPassword).ok === false);

  // ---------------------------------------------------------------- password

  const setPw = await post('/api/setPassword', { password: 'hunter2hunter2' }, { 'x-wb-ssh-token': token0 });
  check('设置访问密码', json(setPw).ok === true, json(setPw).error ?? '');

  const hash = readConfig().ui.passwordHash;
  check('密码以哈希存储', typeof hash === 'string' && hash.startsWith('scrypt$'));
  check('明文密码不出现在配置文件里', !readFileSync(configPath, 'utf8').includes('hunter2hunter2'));

  const shortPw = await post('/api/setPassword', { password: 'short' }, { 'x-wb-ssh-token': token0 });
  check('过短的密码被拒', json(shortPw).ok === false);

  const wrong = await post('/api/login', { password: 'nope-nope-nope' });
  check('错误密码登录失败', json(wrong).ok === false);

  const right = await post('/api/login', { password: 'hunter2hunter2' });
  const cookie = String(right.headers['set-cookie'] ?? '').split(';')[0];
  check('正确密码登录成功', json(right).ok === true);
  check('下发的是 HttpOnly + SameSite=Strict 会话 cookie',
    cookie.startsWith('wb_ssh_session=') &&
    String(right.headers['set-cookie']).includes('HttpOnly') &&
    String(right.headers['set-cookie']).includes('SameSite=Strict') &&
    !String(right.headers['set-cookie']).includes('Max-Age'));

  const withCookie = await http('/', { headers: { cookie } });
  check('带会话 cookie → 200', withCookie.status === 200);

  const apiWithCookie = await http('/api/state', { headers: { cookie } });
  check('带会话 cookie 打 API → 200', apiWithCookie.status === 200);

  // ---------------------------------------------------------------- rotation

  const rotated = await post('/api/setToken', { token: '' }, { 'x-wb-ssh-token': token0 });
  const token1 = json(rotated).token;
  check('生成新令牌', json(rotated).ok === true && token1 !== token0);

  const oldToken = await http(`/?t=${token0}`);
  check('旧令牌立即失效', oldToken.status === 403);

  const newToken = await http(`/?t=${token1}`);
  check('新令牌可用', newToken.status === 200);

  const cookieAfterRotation = await http('/', { headers: { cookie } });
  check('换令牌后当前会话仍然有效', cookieAfterRotation.status === 200);

  const custom = await post('/api/setToken', { token: 'A'.repeat(40) }, { 'x-wb-ssh-token': token1 });
  check('可以手工设置令牌', json(custom).ok === true && json(custom).token === 'A'.repeat(40));

  const tooShort = await post('/api/setToken', { token: 'abc' }, { 'x-wb-ssh-token': 'A'.repeat(40) });
  check('过短的令牌被拒', json(tooShort).ok === false);

  const stateUnauth = await http('/api/credential');
  check('未认证读不到凭据', stateUnauth.status === 403);

  const cred = await http('/api/credential', { headers: { cookie } });
  check('已认证能读到凭据', json(cred).ok === true && json(cred).hasPassword === true);

  // ---------------------------------------------------------------- clearing

  const cleared = await post('/api/setPassword', { password: '' }, { 'x-wb-ssh-token': 'A'.repeat(40) });
  check('清除访问密码', json(cleared).ok === true && json(cleared).hasPassword === false);
  check('清除后哈希从配置里移除', readConfig().ui.passwordHash === undefined);

  const loginAfterClear = await post('/api/login', { password: 'hunter2hunter2' });
  check('清除后原密码不再可用', json(loginAfterClear).ok === false);
} catch (error) {
  check('探针本身没有抛异常', false, error.message);
} finally {
  child.kill();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
