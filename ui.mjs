#!/usr/bin/env node
/**
 * wb-ssh connection manager — local web UI.
 *
 *   node ui.mjs                 # pick a free port, open the browser
 *   node ui.mjs --port 7812     # fixed port
 *   node ui.mjs --no-open       # just print the URL
 *   node ui.mjs --host 0.0.0.0  # reachable from the LAN, not just loopback
 *
 * A form for adding and editing SSH connections, backed by the same
 * `SshManager` the MCP server uses, and therefore by the same data: the
 * DeepSeek Harness connection records and credential store. A connection added
 * here is immediately usable from the MCP tools and from the DSH panel, and
 * vice versa.
 *
 * This exists because secrets must never travel through a model: the MCP tools
 * only accept credential *references*, so before this page the only way to put
 * a password into the store was `cred.mjs` in a terminal. Here the password is
 * typed into a local page and written straight into the shared credential
 * store — the record keeps only the reference, and no API response ever
 * contains a secret.
 *
 * ## Exposure
 *
 * Bound to the loopback interface by default, and every request must clear
 * three fences:
 *
 *   1. `Host` must be one of this server's own authorities — loopback, plus
 *      each local IPv4 once the bind goes beyond loopback (see `--host`). That
 *      blocks DNS rebinding, where a hostile domain resolves to a local address.
 *   2. A token must be present — a page that does not know it cannot read or
 *      change anything. A human who opens the bare URL by hand gets
 *      `ui-gate.html` instead of a JSON 403; the gate page knows no token and
 *      exposes no data, it only explains how to get the real link. The token is
 *      persisted rather than regenerated per launch (see `resolveToken`), so
 *      the URL can be bookmarked.
 *   3. If an `Origin` header is present it must be this server's own origin —
 *      blocks cross-site requests from any other page in the browser.
 *
 * A hostile page can therefore neither enumerate connections nor add, delete,
 * or execute anything.
 *
 * `--host 0.0.0.0` (or `ui.host` in the config file) opens the page to the
 * local network so other machines can reach it. The token is then the only
 * thing between a LAN peer and your SSH credentials — including the passwords
 * in the shared credential store. Fine on a trusted LAN, wrong on a shared or
 * public one; loopback stays the default for exactly that reason.
 *
 * @module wb-ssh-mcp/ui
 */
import { createServer, request } from 'node:http';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { networkInterfaces } from 'node:os';

import { SshManager } from './vendor/manager.js';
import { CredentialProvider } from './lib/credentials.mjs';
import { ActivityLog } from './lib/activity.mjs';
import { scrub } from './lib/agent-identity.mjs';
import { createLogger, loadConfig } from './lib/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const logger = createLogger('wb-ssh-ui');
const config = loadConfig();

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined;
};
const requestedPort = Number(flagValue('--port') ?? 0);
const openBrowser = !argv.includes('--no-open');
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  process.stderr.write(`invalid --port value\n`);
  process.exit(2);
}

/**
 * Which interface to bind.
 *
 * `--host` wins, then `ui.host` from the config file, then loopback. Loopback
 * is the default because the page edits SSH credentials: anything wider means
 * every peer that learns the token can read and change them. `0.0.0.0` binds
 * every interface, which is what "let other machines on the LAN reach it"
 * means in practice.
 */
const requestedHost =
  flagValue('--host') ??
  (typeof config.ui?.host === 'string' && config.ui.host !== '' ? config.ui.host : '127.0.0.1');
const exposed = requestedHost !== '127.0.0.1' && requestedHost !== '::1';

/**
 * The page's access token.
 *
 * A fresh random token per launch is marginally safer and useless in practice:
 * the URL changes every time, so it can never be bookmarked, and the only way
 * to get the current one is to read the terminal it was printed in.
 *
 * Persisting it costs nothing. The token defends against *other pages in the
 * browser* reaching this port — cross-site requests, DNS rebinding. It was
 * never a defence against other programs on this machine: those can read
 * `connections.json` and `.credentials.yaml` directly, and both are plain text.
 * So the token is generated once, written to the config file, and reused.
 */
/**
 * Merge a patch into the `ui` section of the override file, preserving every
 * other key. A value of `undefined` removes the key, which is how the password
 * gets cleared.
 */
function patchConfig(configPath, patch) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(configPath, 'utf8')) ?? {};
  } catch {
    file = {};
  }
  const ui = { ...(file.ui ?? {}), ...patch };
  for (const [key, value] of Object.entries(ui)) {
    if (value === undefined) delete ui[key];
  }
  file.ui = ui;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return file;
}

/** The password hash currently on disk — re-read so an edit applies at once. */
function currentCredentialHash() {
  try {
    const file = JSON.parse(readFileSync(config.configPath, 'utf8')) ?? {};
    const value = file.ui?.passwordHash;
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

function resolveToken(config) {
  const existing = config.ui?.token;
  if (typeof existing === 'string' && existing.length >= 32) return existing;

  const token = randomBytes(24).toString('hex');
  try {
    patchConfig(config.configPath, { token });
    process.stdout.write(`已生成访问令牌并写入 ${config.configPath}（以后地址固定）\n`);
  } catch (error) {
    process.stdout.write(`写入配置文件失败（${error.message}）——本次地址仍是临时的\n`);
  }
  return token;
}

// `let`, because the token can be changed from the page at runtime.
let TOKEN = resolveToken(config);
const MAX_BODY_BYTES = 512 * 1024;

// ------------------------------------------------------------------ pid file

/**
 * Where this instance records its own process id.
 *
 * `start-ui.vbs` launches the server with no console window, which is what
 * "hide the shell" costs you: there is no Ctrl+C left to press. `stop-ui.cmd`
 * reads this file instead of hunting for the process by port, so it cannot
 * kill something else that happens to hold 7812.
 *
 * Kept beside the config file rather than in the project directory — it
 * describes a running process on *this machine*, not the source tree, and the
 * project directory may be a checkout shared with other machines.
 */
const PID_PATH = join(dirname(config.configPath), 'ui.pid');

function writePidFile() {
  try {
    mkdirSync(dirname(PID_PATH), { recursive: true });
    writeFileSync(PID_PATH, `${process.pid}\n`, 'utf8');
  } catch (error) {
    logger.warn('could not write %s: %s', PID_PATH, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Remove the pid file, but only when it still names *this* process.
 *
 * `taskkill /f` terminates without running any handler, so a stale file is
 * normal after a forced stop and the next launch simply overwrites it. The
 * guard matters for the other case: a second launch that finds the port taken
 * exits immediately, and must not delete the record of the instance that is
 * actually serving.
 */
function clearPidFile() {
  try {
    if (readFileSync(PID_PATH, 'utf8').trim() !== String(process.pid)) return;
    unlinkSync(PID_PATH);
  } catch {
    // Nothing to clean up — the file is already gone.
  }
}

// ------------------------------------------------------------------ credentials

/** scrypt with a per-password salt, stored as a single self-describing line. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const scrypt = promisify(scryptCallback);

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Constant-time password check.
 *
 * Returns false both for a wrong password and for "no password configured" —
 * the caller must not be able to tell those apart. The KDF runs before any
 * comparison, so timing does not leak whether a hash exists either.
 */
async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltHex, keyHex] = parts;
  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const SESSION_COOKIE = 'wb_ssh_session';
/** Live logins, in memory only — restarting the server logs everyone out. */
const sessions = new Set();

function readCookies(req) {
  const header = req.headers.cookie;
  const jar = new Map();
  if (typeof header !== 'string') return jar;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    jar.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return jar;
}

/** Either credential opens the door: a matching token, or a live session. */
function isAuthorized(req, url) {
  const token = url.searchParams.get('t') ?? req.headers['x-wb-ssh-token'];
  if (typeof token === 'string' && token === TOKEN) return { ok: true, via: 'token' };

  const sid = readCookies(req).get(SESSION_COOKIE);
  if (sid !== undefined && sessions.has(sid)) return { ok: true, via: 'session' };

  return { ok: false, via: null };
}

/**
 * Is one of *our* instances already listening on this port?
 *
 * Asked with our own token, so a `200 {"ok":true}` means the thing holding the
 * port is this program with the same token — safe to hand the URL back instead
 * of starting a second copy on some random port.
 */
function alreadyRunning(port, token) {
  return new Promise((resolve) => {
    const probe = request(
      { host: '127.0.0.1', port, path: `/api/state?t=${token}`, timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body)?.ok === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    probe.on('error', () => resolve(false));
    probe.on('timeout', () => {
      probe.destroy();
      resolve(false);
    });
    probe.end();
  });
}

// ------------------------------------------------------------------ manager

const credentials = new CredentialProvider({ path: config.credentialsPath, logger });
const manager = new SshManager({ credentials, logger }, config.manager);
manager.initialize();

/**
 * The same shared activity log the MCP server appends to.
 *
 * This process reads it to show what the agents have been doing, and writes to
 * it for everything that happens in the browser — so one timeline covers both
 * sides and the page can answer "who connected to this box, and when".
 */
const activity = new ActivityLog({ path: config.activityPath, logger });

/** Every browser action is attributed to a human on this machine. */
const HUMAN = { kind: 'human', label: '本机页面', detail: '' };

/** Re-read the shared records file, exactly as the MCP server does. */
function resyncRecords() {
  try {
    manager.store.records.clear();
    manager.store.load();
  } catch (error) {
    logger.warn('record resync failed: %s', error instanceof Error ? error.message : String(error));
  }
}

/** Session lookup tolerant of the panel's duplicate keys. */
function statusOf(name) {
  const session = manager.sessions.get(name);
  if (session === undefined) return 'disconnected';
  return session.status;
}

// ------------------------------------------------------------------ helpers

/** Read and JSON-parse a request body, bounded. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Trimmed string or undefined. */
const str = (value) => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
};

/** The API never returns secret material — only whether a slot is filled. */
function publicConnection(item) {
  const record = manager.store.get(item.name);
  return {
    name: item.name,
    host: item.host,
    port: item.port,
    user: item.user,
    tunnel: item.tunnel ?? '',
    authType: item.authType,
    hasPassword: record?.auth?.type === 'password' && Boolean(record.auth.passwordRef),
    hasKeyRef: record?.auth?.type === 'privateKey' && Boolean(record.auth.privateKeyRef),
    keyPath: record?.auth?.type === 'privateKey' ? (record.auth.keyPath ?? '') : '',
    hasPassphrase: Boolean(record?.auth?.passphraseRef),
    status: item.status,
    busyBy: item.busyBy ?? null,
    lastError: item.lastError ?? null,
    connectedAt: item.connectedAt ?? null,
    reconnectAttempts: item.reconnectAttempts ?? 0,
  };
}

/** Create or update a record, routing secrets into the shared credential store. */
async function saveConnection(body) {
  const mode = body.mode === 'update' ? 'update' : 'create';
  const authType = ['password', 'keypath', 'keytext'].includes(body.authType) ? body.authType : 'password';
  const name = str(body.name);
  const newName = str(body.newName);
  const host = str(body.host);
  const user = str(body.user);
  const tunnel = str(body.tunnel);
  const port = body.port === undefined || body.port === '' ? 22 : Number(body.port);
  const password = typeof body.password === 'string' && body.password !== '' ? body.password : undefined;
  const privateKey = typeof body.privateKey === 'string' && body.privateKey.trim() !== '' ? body.privateKey : undefined;
  const passphrase = typeof body.passphrase === 'string' && body.passphrase !== '' ? body.passphrase : undefined;
  const privateKeyPath = str(body.privateKeyPath);

  if (name === undefined) return { ok: false, error: '连接名不能为空' };
  if (host === undefined) return { ok: false, error: '主机不能为空' };
  if (user === undefined) return { ok: false, error: '用户名不能为空' };
  if (!Number.isFinite(port) || port < 1 || port > 65535) return { ok: false, error: '端口必须是 1-65535' };
  if (authType === 'keypath' && privateKeyPath === undefined) {
    return { ok: false, error: '选择「私钥文件」时必须填写私钥路径' };
  }

  const base = { host, port, user, tunnel };

  if (mode === 'create') {
    if (authType === 'keypath') {
      return manager.createRecord({ name, ...base, auth: { privateKeyPath } });
    }
    if (authType === 'keytext' && privateKey === undefined) {
      return { ok: false, error: '选择「私钥内容」时必须粘贴私钥，或改用私钥文件路径' };
    }
    if (authType === 'password' && password === undefined) {
      return { ok: false, error: '选择「密码」时必须填写密码' };
    }
    return manager.createRecordWithSecrets({
      name,
      ...base,
      password: authType === 'password' ? password : undefined,
      privateKey: authType === 'keytext' ? privateKey : undefined,
      passphrase: authType === 'keytext' ? passphrase : undefined,
    });
  }

  // update — host/port/user/tunnel/newName first, secrets only when supplied
  const params = { newName, ...base };
  if (authType === 'password' && password !== undefined) params.password = password;
  if (authType === 'keytext' && privateKey !== undefined) {
    params.privateKey = privateKey;
    if (passphrase !== undefined) params.passphrase = passphrase;
  }
  const updated = await manager.updateRecordWithSecrets(name, params);
  if (!updated.ok) return updated;
  if (authType === 'keypath') {
    return manager.updateRecord(updated.record.name, { auth: { privateKeyPath } });
  }
  return updated;
}

// ------------------------------------------------------------------ API

/** Read-only state for the page. */
async function state() {
  resyncRecords();
  return {
    ok: true,
    connections: manager.sessionsPublic().map(publicConnection),
    paths: { records: config.recordsPath, credentials: config.credentialsPath, activity: config.activityPath },
    configPath: config.configPath,
    tunnelCandidates: manager.store.list().map((record) => record.name),
    activitySize: activity.size(),
  };
}

const routes = {
  state,

  async save(body) {
    resyncRecords();
    const saved = await saveConnection(body);
    if (!saved.ok) return saved;
    const name = saved.record.name;
    const record = manager.store.get(name);
    const target = { name, host: record?.host ?? '', port: record?.port ?? null, user: record?.user ?? '' };

    if (body.connect === true) {
      const connected = await manager.connect(name);
      activity.write({
        actor: { ...HUMAN },
        action: body.mode === 'update' ? 'update' : 'create',
        target,
        ok: connected.ok === true,
        detail: scrub(connected.ok === true ? '保存并连接成功' : `保存成功，连接失败：${connected.error ?? '未知错误'}`),
        source: 'ui',
      });
      return {
        ok: connected.ok === true,
        name,
        status: statusOf(name),
        message: connected.ok === true
          ? `已保存并连接：${saved.record.user}@${saved.record.host}:${saved.record.port}`
          : `已保存，但连接失败：${connected.error ?? '未知错误'}`,
      };
    }

    activity.write({
      actor: { ...HUMAN },
      action: body.mode === 'update' ? 'update' : 'create',
      target,
      ok: true,
      detail: '已保存',
      source: 'ui',
    });
    return { ok: true, name, status: statusOf(name), message: `已保存：${name}` };
  },

  async connect(body) {
    resyncRecords();
    const name = str(body.name);
    if (name === undefined) return { ok: false, error: '缺少连接名' };
    const started = Date.now();
    const result = await manager.connect(name);
    const session = manager.sessions.get(name);
    const record = manager.store.get(name);
    activity.write({
      actor: { ...HUMAN },
      action: 'connect',
      target: { name, host: record?.host ?? '', port: record?.port ?? null, user: record?.user ?? '' },
      ok: result.ok === true,
      detail: scrub(result.ok === true ? '连接成功' : (session?.lastError ?? result.error ?? '连接失败')),
      ms: Date.now() - started,
      source: 'ui',
    });
    return {
      ok: result.ok === true,
      name,
      status: statusOf(name),
      message: result.ok === true ? `${name} 已连接` : (session?.lastError ?? result.error ?? '连接失败'),
    };
  },

  async disconnect(body) {
    resyncRecords();
    const name = str(body.name);
    if (name === undefined) return { ok: false, error: '缺少连接名' };
    const record = manager.store.get(name);
    await manager.disconnect(name);
    activity.write({
      actor: { ...HUMAN },
      action: 'disconnect',
      target: { name, host: record?.host ?? '', port: record?.port ?? null, user: record?.user ?? '' },
      ok: true,
      detail: '手动断开',
      source: 'ui',
    });
    return { ok: true, name, status: statusOf(name), message: `${name} 已断开` };
  },

  async remove(body) {
    resyncRecords();
    const name = str(body.name);
    if (name === undefined) return { ok: false, error: '缺少连接名' };
    const record = manager.store.get(name);
    const result = await manager.deleteRecord(name);
    if (!result.ok) return result;
    activity.write({
      actor: { ...HUMAN },
      action: 'remove',
      target: { name, host: record?.host ?? '', port: record?.port ?? null, user: record?.user ?? '' },
      ok: true,
      detail: '已删除（凭据引用保留）',
      source: 'ui',
    });
    return { ok: true, name, message: `已删除：${name}（凭据引用保留在凭据库中）` };
  },

  async exec(body) {
    resyncRecords();
    const name = str(body.name);
    const command = str(body.command);
    if (name === undefined) return { ok: false, error: '缺少连接名' };
    if (command === undefined) return { ok: false, error: '命令不能为空' };
    const timeoutMs = Number(body.timeoutMs ?? 30000);
    const started = Date.now();
    const result = await manager.aiExec({ connection: name, command, timeoutMs });
    const record = manager.store.get(name);
    activity.write({
      actor: { ...HUMAN },
      action: 'exec',
      target: { name, host: record?.host ?? '', port: record?.port ?? null, user: record?.user ?? '' },
      ok: result.ok === true,
      detail: scrub([command.slice(0, 200), result.error ?? ''].filter((part) => part !== '').join(' · ')),
      ms: Date.now() - started,
      source: 'ui',
    });
    return {
      ok: result.ok === true,
      status: result.status,
      execId: result.execId,
      exitCode: result.exitCode,
      output: result.output ?? '',
      truncated: result.truncated === true,
      message: result.error ?? null,
    };
  },

  async execRead(body) {
    const execId = str(body.execId);
    if (execId === undefined) return { ok: false, error: '缺少 execId' };
    const result = manager.execRead(execId, { tail: body.tail });
    return {
      ok: result.ok === true,
      status: result.running === true ? 'running' : 'done',
      execId: result.execId,
      exitCode: result.exitCode,
      output: result.output ?? '',
      truncated: result.truncated === true,
      message: result.error ?? result.message ?? null,
    };
  },

  async execKill(body) {
    const execId = str(body.execId);
    if (execId === undefined) return { ok: false, error: '缺少 execId' };
    const result = await manager.killExec(execId);
    return { ok: result.ok === true, execId, message: result.error ?? (result.killed ? '已终止' : '命令已结束') };
  },

  // ---------------------------------------------------------------- access

  /**
   * The only route reachable without credentials. On success the session id is
   * handed back as an HttpOnly, SameSite=Strict, session-scoped cookie — no
   * `Max-Age`, so closing the browser ends the login.
   */
  async login(body, res) {
    const password = str(body.password) ?? '';
    const ok = await verifyPassword(password, currentCredentialHash());

    // One message for both "wrong" and "never set", on purpose.
    if (!ok) {
      activity.write({
        actor: { ...HUMAN },
        action: 'access.denied',
        ok: false,
        detail: '页面登录：密码不正确',
        source: 'ui',
      });
      return { ok: false, error: '密码不正确' };
    }

    const sid = randomBytes(24).toString('hex');
    sessions.add(sid);
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`);
    activity.write({
      actor: { ...HUMAN },
      action: 'login',
      ok: true,
      detail: '通过密码登录页面',
      source: 'ui',
    });
    return { ok: true, message: '已登录' };
  },

  async credential() {
    return {
      ok: true,
      token: TOKEN,
      hasPassword: currentCredentialHash() !== undefined,
      address: primaryUrl(server.address()?.port),
    };
  },

  // ---------------------------------------------------------------- activity

  /**
   * The activity log, newest first.
   *
   * Entries written by the MCP server are read from the shared file, so page
   * refreshes pick up tool calls made by agents in other processes.
   *
   * `limit` bounds one response; the page loads more on demand with `before`.
   */
  async activity(body) {
    const before = Number(body.before);
    const filter = {
      limit: Number.isFinite(Number(body.limit)) ? Number(body.limit) : 200,
      actor: str(body.actor),
      target: str(body.target),
      action: str(body.action),
      q: str(body.q),
      since: Number.isFinite(Number(body.since)) ? Number(body.since) : undefined,
      until: Number.isFinite(before) && before > 0 ? before - 1 : (Number.isFinite(Number(body.until)) ? Number(body.until) : undefined),
    };
    if (body.ok === true || body.ok === false || body.ok === 'true' || body.ok === 'false') {
      filter.ok = body.ok === true || body.ok === 'true';
    }

    const page = activity.read(filter);
    return {
      ok: true,
      entries: page.entries,
      total: page.total,
      truncated: page.truncated,
      broken: page.broken,
      size: activity.size(),
    };
  },

  /** Distinct actors and targets, for the filter dropdowns. */
  async activityFacets() {
    return { ok: true, ...activity.facets() };
  },

  /** Empty the log. Guarded by a confirm in the page. */
  async activityClear() {
    const result = activity.clear();
    if (result.ok !== true) return { ok: false, error: result.error };
    activity.write({
      actor: { ...HUMAN },
      action: 'credential',
      target: {},
      ok: true,
      detail: '清空了活动日志',
      source: 'ui',
    });
    return { ok: true, message: '活动日志已清空' };
  },

  /**
   * Drop only the rows marked `demo: true`, keeping real audit history.
   *
   * This is the honest counterpart to the seed script: demo data can be shown
   * off and then removed without anyone having to choose between "keep a fake
   * record" and "throw away the real ones too".
   */
  async seedPurge() {
    const result = activity.purgeDemo();
    if (result.ok !== true) return { ok: false, error: result.error };
    if (result.removed > 0) {
      activity.write({
        actor: { ...HUMAN },
        action: 'credential',
        target: {},
        ok: true,
        detail: `清除了 ${result.removed} 条演示数据，保留 ${result.kept} 条真实记录`,
        source: 'ui',
      });
    }
    return {
      ok: true,
      removed: result.removed,
      kept: result.kept,
      message: result.removed === 0 ? '没有发现演示数据' : `已清除 ${result.removed} 条演示数据`,
    };
  },

  /** Set the token, or mint a fresh one when none is supplied. */
  async setToken(body) {
    const requested = str(body.token);
    const generated = requested === undefined || requested === '';
    const next = generated ? randomBytes(24).toString('hex') : requested;

    if (next.length < 32) return { ok: false, error: '令牌至少需要 32 个字符' };
    if (/\s/.test(next)) return { ok: false, error: '令牌不能包含空白字符' };

    try {
      patchConfig(config.configPath, { token: next });
    } catch (error) {
      return { ok: false, error: `写入配置失败：${error.message}` };
    }

    // Takes effect immediately; the session cookie is untouched, so the browser
    // that asked for the change stays logged in.
    TOKEN = next;
    activity.write({
      actor: { ...HUMAN },
      action: 'credential',
      ok: true,
      detail: generated ? '重新生成了访问令牌' : '手工设置了访问令牌',
      source: 'ui',
    });
    return {
      ok: true,
      token: TOKEN,
      generated,
      address: primaryUrl(server.address()?.port),
      message: generated ? '已生成新令牌，旧地址立即失效' : '已更新令牌，旧地址立即失效',
    };
  },

  /** Set the access password, or clear it when the value is empty. */
  async setPassword(body) {
    const password = str(body.password);

    if (password === undefined || password === '') {
      try {
        patchConfig(config.configPath, { passwordHash: undefined });
      } catch (error) {
        return { ok: false, error: `写入配置失败：${error.message}` };
      }
      sessions.clear();
      activity.write({
        actor: { ...HUMAN },
        action: 'credential',
        ok: true,
        detail: '清除了访问密码，并注销了所有会话',
        source: 'ui',
      });
      return { ok: true, hasPassword: false, message: '已清除访问密码，之后只能用令牌进入' };
    }

    if (password.length < 8) return { ok: false, error: '密码至少需要 8 个字符' };

    let hash;
    try {
      hash = await hashPassword(password);
    } catch (error) {
      return { ok: false, error: `生成密码哈希失败：${error.message}` };
    }
    try {
      patchConfig(config.configPath, { passwordHash: hash });
    } catch (error) {
      return { ok: false, error: `写入配置失败：${error.message}` };
    }

    activity.write({
      actor: { ...HUMAN },
      action: 'credential',
      ok: true,
      detail: '设置了新的访问密码',
      source: 'ui',
    });
    return { ok: true, hasPassword: true, message: '已设置访问密码' };
  },
};

// ------------------------------------------------------------------ server

/**
 * Every non-internal IPv4 address of this machine, in interface order.
 *
 * Used to widen the Host/Origin fences when the bind goes beyond loopback:
 * a peer reaching us at `192.168.x.y:7812` sends exactly that in `Host`, and
 * the fence would otherwise reject our own address.
 */
function localIPv4s() {
  const found = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

/** `host:port`, bracketing a bare IPv6 literal the way a URL would. */
function authorityOf(host, port) {
  const shown = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${shown}:${port}`;
}

/**
 * The `host:port` authorities this server answers to.
 *
 * Loopback always. Once the bind goes beyond loopback, every local IPv4 joins
 * the set as well — otherwise our own Host fence would reject requests that
 * arrive through the LAN address. A hostile domain is still absent from the
 * set, which is the entire point of the check.
 */
function allowedAuthorities(port) {
  const hosts = ['127.0.0.1', 'localhost', '[::1]'];
  if (exposed) {
    hosts.push(...localIPv4s());
    if (requestedHost !== '0.0.0.0' && requestedHost !== '::') hosts.push(requestedHost);
  }
  return new Set(hosts.map((host) => authorityOf(host, port)));
}

/**
 * The two fences that apply to *every* request, credentials or not. Split out
 * because `/api/login` has to clear these while still being reachable without
 * a token — you cannot present a credential before you have one.
 */
function transportReason(req, port) {
  const host = String(req.headers.host ?? '').toLowerCase();
  const allowed = allowedAuthorities(port);
  if (!allowed.has(host)) return `unexpected Host header "${host}"`;

  const origin = req.headers.origin;
  if (origin !== undefined) {
    let ok = false;
    for (const authority of allowed) {
      if (origin === `http://${authority}`) {
        ok = true;
        break;
      }
    }
    if (!ok) return `unexpected Origin "${origin}"`;
  }

  return null;
}

/** Loopback-only fences plus the credential; an error string when refused. */
function rejectReason(req, url, port) {
  const transport = transportReason(req, port);
  if (transport !== null) return transport;
  if (!isAuthorized(req, url).ok) return 'missing or wrong credential';
  return null;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * The credential fence, for a human who landed on the bare URL.
 *
 * `ui-gate.html` is a static page that leaks nothing — it does not know the
 * token, does not know whether a password is even configured, does not list
 * connections. It offers a password box and, as a fallback, a field for pasting
 * a full link. The status stays 403; the body is just nicer than a JSON blob.
 * Any other refusal (Host or Origin) keeps the JSON form, since those indicate
 * something other than a person mistyping an address.
 */
function sendGate(res) {
  let html;
  try {
    html = readFileSync(join(here, 'ui-gate.html'), 'utf8');
  } catch (error) {
    logger.warn('ui-gate.html unavailable: %s', error instanceof Error ? error.message : String(error));
    sendJson(res, 403, { ok: false, error: 'refused: missing or wrong credential' });
    return;
  }
  res.writeHead(403, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(html);
}

const server = createServer(async (req, res) => {
  const port = server.address()?.port;
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

  const isHtmlGet = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html');

  // The one route reachable without a credential — it is how you get one.
  // The Host and Origin fences still apply; only the credential check is skipped.
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const transport = transportReason(req, port);
    if (transport !== null) {
      logger.warn('refused POST /api/login: %s', transport);
      activity.write({
        actor: { kind: 'system', label: '访问栅栏', detail: transport },
        action: 'access.denied',
        ok: false,
        detail: `登录请求被拒：${transport}`,
        source: 'ui',
      });
      sendJson(res, 403, { ok: false, error: `refused: ${transport}` });
      return;
    }
    try {
      sendJson(res, 200, await routes.login(await readBody(req), res));
    } catch (error) {
      logger.error('login failed: %s', error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: '登录处理失败' });
    }
    return;
  }

  const reason = rejectReason(req, url, port);
  if (reason !== null) {
    logger.warn('refused %s %s: %s', req.method, url.pathname, reason);
    // A missing credential on the bare URL is a person who has not logged in
    // yet — normal, and the gate page is about to ask them for it. Only a
    // *forged* request (bad Host/Origin) is worth an audit entry, otherwise
    // every page load would flood the log.
    if (reason !== 'missing or wrong credential') {
      activity.write({
        actor: { kind: 'system', label: '访问栅栏', detail: reason },
        action: 'access.denied',
        ok: false,
        detail: `${req.method} ${url.pathname} 被拒：${reason}`,
        source: 'ui',
      });
    }
    if (isHtmlGet && reason === 'missing or wrong credential') {
      sendGate(res);
      return;
    }
    sendJson(res, 403, { ok: false, error: `refused: ${reason}` });
    return;
  }

  if (isHtmlGet) {
    const html = readFileSync(join(here, 'ui.html'), 'utf8');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
    return;
  }

  // GET and POST both map onto `routes`, so the read-only ones (`state`,
  // `credential`) answer a plain GET while the rest take a JSON body.
  const routeName = url.pathname.startsWith('/api/') ? url.pathname.slice('/api/'.length) : null;
  const handler = routeName === null ? undefined : routes[routeName];

  if (typeof handler !== 'function' || (req.method !== 'GET' && req.method !== 'POST')) {
    sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` });
    return;
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    sendJson(res, 200, await handler(body));
  } catch (error) {
    logger.error('api error: %s', error instanceof Error ? error.message : String(error));
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * Print the URL and open the browser. Called on every successful `listen`,
 * including the retry after an occupied port — which is why it is a named
 * function rather than an inline callback.
 */
function openInBrowser(url) {
  if (!openBrowser) return;
  execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, (error) => {
    if (error) logger.warn('could not open the browser automatically: %s', error.message);
  });
}

/** Every URL the page answers on: loopback first, then each LAN address. */
function pageUrls(port) {
  const urls = [`http://127.0.0.1:${port}/?t=${TOKEN}`];
  if (exposed) {
    for (const address of localIPv4s()) urls.push(`http://${address}:${port}/?t=${TOKEN}`);
  }
  return urls;
}

/**
 * The URL to hand to a human. When the page is reachable on the LAN, prefer
 * that one — it works both from this machine and from every other machine, so
 * it is the one worth copying into a bookmark or into another agent's config.
 */
function primaryUrl(port) {
  const urls = pageUrls(port);
  return urls.length > 1 ? urls[1] : urls[0];
}

function announce() {
  const port = server.address().port;
  const urls = pageUrls(port);
  writePidFile();
  activity.write({
    actor: { kind: 'system', label: '管理页面' },
    action: 'system.start',
    ok: true,
    detail: `管理页面启动于 ${urls[0].replace(TOKEN, '…')}`,
    source: 'ui',
  });
  for (const url of urls) process.stdout.write(`wb-ssh 连接管理页面: ${url}\n`);
  process.stdout.write(`  进程 PID: ${process.pid}（停止请运行 stop-ui.cmd）\n`);
  process.stdout.write(`  记录文件: ${config.recordsPath}\n`);
  process.stdout.write(`  凭据库  : ${config.credentialsPath}\n`);
  process.stdout.write(`  活动日志: ${config.activityPath}\n`);
  if (exposed) {
    process.stdout.write(`  ⚠ 已监听 ${requestedHost}，局域网内任何机器都能访问\n`);
    process.stdout.write('    令牌是唯一门槛（页面能改 SSH 凭据）——别在不可信网络里开着\n');
    process.stdout.write('    停止：本窗口按 Ctrl+C，或运行 stop-ui.cmd\n');
  } else {
    process.stdout.write('  仅监听 127.0.0.1，停止：本窗口按 Ctrl+C，或运行 stop-ui.cmd\n');
  }
  process.stdout.write('  （地址要连 ?t=… 一起复制；只输 IP:端口 会看到一个提示页）\n');
  openInBrowser(urls[0]);
}

/**
 * Port taken. Ask who holds it: if it is another copy of this program with our
 * token, the right move is to hand back its URL and exit, not to start a second
 * instance on a random port — that is what made the address drift, and a URL
 * that changes every launch can never be bookmarked. Only a genuine stranger on
 * the port causes a fallback.
 */
async function onPortBusy() {
  const url = `http://127.0.0.1:${requestedPort}/?t=${TOKEN}`;

  if (await alreadyRunning(requestedPort, TOKEN)) {
    process.stdout.write(`服务已经在运行了: ${url}\n`);
    process.stdout.write('  （没有另起副本；要停止请运行 stop-ui.cmd）\n');
    openInBrowser(url);
    process.exit(0);
  }

  process.stdout.write(`端口 ${requestedPort} 被别的程序占用，改用随机端口\n`);
  server.listen(0, requestedHost);
}

// `once`, not a callback passed to `listen`: the failed first attempt leaves
// its `listening` listener registered, so passing the callback on the retry
// too would run it twice.
server.once('listening', announce);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && requestedPort !== 0) {
    onPortBusy().catch((failure) => {
      logger.error('could not resolve the occupied port: %s', failure.message);
      process.exit(1);
    });
    return;
  }
  logger.error('server error: %s', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

server.listen(requestedPort, requestedHost);

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    process.stdout.write('\n关闭连接并退出…\n');
    manager.shutdown().catch(() => {}).finally(() => process.exit(0));
  });
}

// `exit` covers every way out that runs handlers — the two signals above, a
// failed listen, an uncaught error. A forced stop (`taskkill /f`) skips it, so
// the next launch just overwrites the stale file.
process.on('exit', clearPidFile);
