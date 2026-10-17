/**
 * Shared activity log for wb-ssh.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two different processes need to tell the same story:
 *
 *   - the MCP server, one short-lived stdio child per client, which sees every
 *     tool call (who called, which connection, what happened);
 *   - the connection-manager page (`ui.mjs`), a long-lived server, which sees
 *     every button press in the browser and does the connecting.
 *
 * A process-local array cannot do that — the page would never see tool calls.
 * So entries are appended to one JSONL file that both processes open in append
 * mode. Append is atomic enough for line-sized writes on Windows and Linux for
 * the volumes involved here (a handful of events per minute, not per second),
 * so no lock is needed; a torn final line is discarded on read instead.
 *
 * FORMAT
 * ------
 * One JSON object per line — JSONL, not a JSON array, precisely because it must
 * be appendable without rewriting the file. Fields:
 *
 *   t      epoch ms (number)   ts  ISO string, for humans reading the raw file
 *   id     monotonic-ish id, used as the React-style key in the page
 *   actor  who did it  — {kind, label, detail}
 *   action what they did, one of ACTIONS
 *   target the connection it concerns — {name, host, port, user}
 *   ok     boolean | null (null = not an outcome, e.g. a plain connect attempt)
 *   detail free-text result summary, secrets already scrubbed by the caller
 *   ms     duration in ms when known
 *   source 'mcp' | 'ui'  — which service emitted it
 *   demo   true when this is seeded sample data, absent otherwise
 *
 * `demo` exists because seeded entries are otherwise **indistinguishable** from
 * real ones: they come from a real server over a real pipe with a real
 * `clientInfo`. A first attempt at seeding produced a log claiming four agents
 * had connected on a day they were never launched, and a human caught it. In an
 * audit trail that is a correctness bug, not a cosmetic one — so the flag is
 * persisted and surfaced in the UI.
 *
 * `actor.kind` is 'agent' for MCP callers, 'human' for the page, 'system' for
 * housekeeping. The page filters on all three.
 *
 * @module wb-ssh-mcp/lib/activity
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Recognised actions. Anything else is still accepted, but not grouped. */
export const ACTIONS = {
  'mcp.call': { label: '调用工具', tone: 'neutral' },
  connect: { label: '连接', tone: 'ok' },
  disconnect: { label: '断开', tone: 'neutral' },
  exec: { label: '执行命令', tone: 'neutral' },
  'exec.kill': { label: '终止命令', tone: 'warn' },
  create: { label: '新建连接', tone: 'ok' },
  update: { label: '修改连接', tone: 'neutral' },
  remove: { label: '删除连接', tone: 'warn' },
  login: { label: '登录页面', tone: 'neutral' },
  'access.denied': { label: '拒绝访问', tone: 'warn' },
  credential: { label: '修改凭据', tone: 'neutral' },
  'system.start': { label: '服务启动', tone: 'neutral' },
};

/** Default cap — the file is rotated once past this many bytes. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/** Entries returned by one `read()` when the caller does not say. */
const DEFAULT_READ_LIMIT = 2000;

/** A stable id for one event, unique enough for keys inside a session. */
function nextId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * An append-only activity log.
 *
 * Deliberately not a class the rest of the code has to hold: every write is a
 * synchronous append, so a crash between two calls loses nothing that was
 * already acknowledged.
 */
export class ActivityLog {
  /**
   * @param options - {path, maxBytes?, logger?}
   */
  constructor({ path, maxBytes = DEFAULT_MAX_BYTES, logger } = {}) {
    if (typeof path !== 'string' || path === '') throw new Error('ActivityLog needs a path');
    this.path = path;
    this.maxBytes = maxBytes;
    this.logger = logger;
    /** Set after a failed write so a broken disk is not retried per event. */
    this.broken = false;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (error) {
      this.#fail('create directory', error);
    }
  }

  #fail(what, error) {
    this.broken = true;
    const message = error instanceof Error ? error.message : String(error);
    if (this.logger !== undefined) this.logger.warn('activity log: %s failed: %s', what, message);
  }

  /**
   * Append one entry.
   *
   * Never throws: this is telemetry, and a full disk must not fail an SSH
   * command. Errors are reported once through the logger.
   *
   * @param entry - {actor, action, target?, ok?, detail?, ms?, source}
   * @returns the stored entry (with t/id/ts filled in), or null when dropped.
   */
  write(entry) {
    if (this.broken) return null;

    const record = {
      t: Date.now(),
      ts: new Date().toISOString(),
      id: nextId(),
      actor: normaliseActor(entry.actor),
      action: typeof entry.action === 'string' ? entry.action : 'unknown',
      target: normaliseTarget(entry.target),
      ok: entry.ok === undefined ? null : entry.ok === true,
      detail: entry.detail === undefined || entry.detail === null ? '' : String(entry.detail).slice(0, 600),
      ms: Number.isFinite(entry.ms) ? Math.round(entry.ms) : null,
      source: entry.source === 'ui' ? 'ui' : 'mcp',
    };

    // Only written when set, so real entries stay byte-identical to before and
    // the flag is obvious when grepping the raw file.
    if (entry.demo === true) record.demo = true;

    try {
      this.#rotateIfNeeded();
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
      return record;
    } catch (error) {
      this.#fail('append', error);
      return null;
    }
  }

  /**
   * Keep the file bounded without losing recent history.
   *
   * Rotation keeps the newest half: reading a multi-megabyte file on the write
   * path only happens once the cap is crossed, and the cost is bounded by the
   * file size rather than by the number of events.
   */
  #rotateIfNeeded() {
    if (!existsSync(this.path)) return;
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size <= this.maxBytes) return;

    const keep = readFileSync(this.path, 'utf8').split('\n').filter((line) => line.trim() !== '');
    const tail = keep.slice(Math.floor(keep.length / 2));
    try {
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, tail.length === 0 ? '' : `${tail.join('\n')}\n`, 'utf8');
      renameSync(temp, this.path);
    } catch (error) {
      this.#fail('rotate', error);
    }
  }

  /**
   * Read entries newest-first, with optional filters.
   *
   * Reads the whole file: at the rotation cap that is a few MB, and the page
   * polls this a few times a minute. `limit` bounds the response, not the read.
   *
   * @param filter - {limit?, actor?, action?, target?, ok?, since?, until?, q?}
   * @returns {{entries: object[], total: number, truncated: boolean, broken: boolean}}
   */
  read(filter = {}) {
    const limit = Number.isFinite(filter.limit) && filter.limit > 0
      ? Math.min(Math.floor(filter.limit), 5000)
      : DEFAULT_READ_LIMIT;

    let lines = [];
    try {
      if (existsSync(this.path)) {
        lines = readFileSync(this.path, 'utf8').split('\n');
      }
    } catch (error) {
      this.#fail('read', error);
      return { entries: [], total: 0, truncated: false, broken: true };
    }

    const entries = [];
    let total = 0;

    // Walk backwards so `limit` can stop early once enough matches are found.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Torn final line from a killed writer, or a half-written one: skip it
        // rather than failing the whole read.
        continue;
      }
      if (!matches(parsed, filter)) continue;
      total += 1;
      if (entries.length < limit) entries.push(parsed);
    }

    return { entries, total, truncated: total > entries.length, broken: this.broken };
  }

  /** Distinct values seen, for populating filter dropdowns. */
  facets() {
    const { entries } = this.read({ limit: 5000 });
    const actors = new Map();
    const targets = new Map();
    for (const entry of entries) {
      const key = entry.actor?.label ?? '未知';
      actors.set(key, { label: key, kind: entry.actor?.kind ?? 'agent', count: (actors.get(key)?.count ?? 0) + 1 });
      const target = entry.target?.name;
      if (typeof target === 'string' && target !== '') {
        targets.set(target, { name: target, host: entry.target?.host ?? '', count: (targets.get(target)?.count ?? 0) + 1 });
      }
    }
    return {
      actors: [...actors.values()].sort((a, b) => b.count - a.count),
      targets: [...targets.values()].sort((a, b) => b.count - a.count),
    };
  }

  /** Remove every entry. Used by the page's "clear log" action. */
  clear() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, '', 'utf8');
      return { ok: true };
    } catch (error) {
      this.#fail('clear', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Delete only the synthetic entries, leaving every real one untouched.
   *
   * Separate from `clear()` on purpose: `clear()` throws away real audit
   * history, which is almost never what someone wants. Rows written by
   * seed-activity.mjs carry `demo: true`, so they can be removed surgically.
   */
  purgeDemo() {
    try {
      if (!existsSync(this.path)) return { ok: true, removed: 0, kept: 0 };
      const text = readFileSync(this.path, 'utf8');
      const kept = [];
      let removed = 0;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A half-written line is a torn append, not demo data. Keep it so a
          // crash mid-write never silently destroys a real record.
          kept.push(line);
          continue;
        }
        if (parsed !== null && typeof parsed === 'object' && parsed.demo === true) removed += 1;
        else kept.push(line);
      }
      const body = kept.length === 0 ? '' : `${kept.join('\n')}\n`;
      writeFileSync(this.path, body, 'utf8');
      return { ok: true, removed, kept: kept.length };
    } catch (error) {
      this.#fail('purgeDemo', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Current size on disk, for the page's footer. */
  size() {
    try {
      return existsSync(this.path) ? statSync(this.path).size : 0;
    } catch {
      return 0;
    }
  }
}

/** Fill in an actor block, tolerating partial input. */
function normaliseActor(actor) {
  const source = actor !== null && typeof actor === 'object' ? actor : {};
  const kind = ['agent', 'human', 'system'].includes(source.kind) ? source.kind : 'agent';
  const label = typeof source.label === 'string' && source.label.trim() !== ''
    ? source.label.trim().slice(0, 80)
    : (kind === 'human' ? '本机页面' : kind === 'system' ? '系统' : '未知调用方');
  return {
    kind,
    label,
    detail: typeof source.detail === 'string' ? source.detail.slice(0, 160) : '',
  };
}

/** Fill in a target block; all fields optional (a login has no target). */
function normaliseTarget(target) {
  if (target === null || typeof target !== 'object') {
    return { name: '', host: '', port: null, user: '' };
  }
  const port = Number(target.port);
  return {
    name: typeof target.name === 'string' ? target.name.slice(0, 120) : '',
    host: typeof target.host === 'string' ? target.host.slice(0, 120) : '',
    port: Number.isFinite(port) && port > 0 ? port : null,
    user: typeof target.user === 'string' ? target.user.slice(0, 80) : '',
  };
}

/** Does one stored entry satisfy every supplied filter? */
function matches(entry, filter) {
  if (filter.actor !== undefined && filter.actor !== '' && entry.actor?.label !== filter.actor) return false;
  if (filter.target !== undefined && filter.target !== '' && entry.target?.name !== filter.target) return false;

  if (filter.action !== undefined && filter.action !== '') {
    const wanted = Array.isArray(filter.action) ? filter.action : [filter.action];
    if (!wanted.includes(entry.action)) return false;
  }

  if (filter.ok === true && entry.ok !== true) return false;
  if (filter.ok === false && entry.ok !== false) return false;

  const since = Number(filter.since);
  if (Number.isFinite(since) && since > 0 && entry.t < since) return false;
  const until = Number(filter.until);
  if (Number.isFinite(until) && until > 0 && entry.t > until) return false;

  if (typeof filter.q === 'string' && filter.q.trim() !== '') {
    const needle = filter.q.trim().toLowerCase();
    const haystack = [
      entry.actor?.label, entry.actor?.detail, entry.action, entry.detail,
      entry.target?.name, entry.target?.host, entry.target?.user,
    ].filter((part) => typeof part === 'string').join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

/** Default log location: beside the config the MCP server and page already share. */
export function defaultActivityPath(configDir) {
  return join(configDir, 'activity.jsonl');
}

export default { ActivityLog, ACTIONS, defaultActivityPath };
