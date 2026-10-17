/**
 * SFTP transfers over an already-managed SSH connection.
 *
 * WHY THIS LIVES IN `lib/` AND NOT IN `vendor/`
 * ---------------------------------------------
 * `vendor/*.js` is a byte-for-byte copy of `starxxy/dsh-ssh` with the hashes
 * recorded in `vendor/PROVENANCE.md`, so re-syncing with upstream is "copy the
 * files back and re-apply one patch". Upstream has no SFTP surface, so adding
 * one there would mean carrying a second local patch forever and losing that
 * property. Everything here is built on the manager's public surface instead:
 *
 *   manager.store.get(name)      -> the saved record
 *   manager.sessionOf(record)    -> the primary live session
 *   manager.ensureConnected(...) -> dial it (auto-reconnect included)
 *   session.client               -> a live `ssh2` Client
 *   client.sftp()                -> the SFTP channel
 *
 * WHY NO EXEC MUTEX
 * -----------------
 * `aiExec` serialises against the shared pty shell (`shellQuietWaitMs`), because
 * a command written into a pty interleaves with whatever a human is typing.
 * SFTP opens its own channel, writes no pty input and produces no terminal
 * output, so it neither disturbs nor is disturbed by a running command. Waiting
 * for "quiet" would also mean a `tail -f` in the panel blocks every transfer
 * forever. Transfers therefore run immediately; they only append a notice entry
 * to the terminal so the panel shows what happened.
 *
 * WHAT CAN STILL GO WRONG, AND WHAT IS DONE ABOUT IT
 * --------------------------------------------------
 *  - a dead connection mid-transfer: the failure is reported per file and the
 *    rest of the batch is abandoned (every remaining file would fail alike);
 *  - a silently stalled transfer (no bytes for `stallTimeoutMs`): aborted, since
 *    ssh2 has no transfer timeout of its own and a wedged MCP call never
 *    returns;
 *  - a truncated transfer: the destination's size is compared against the
 *    source after every file, and `verify: 'sha256'` additionally compares
 *    content hashes (local hash vs. a remote `sha256sum` over an exec channel).
 *
 * @module wb-ssh-mcp/lib/sftp
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

/** Default cap on files pulled in by one directory transfer. */
const DEFAULT_MAX_FILES = 5000;

/** Default "no bytes moved" abort threshold. */
const DEFAULT_STALL_TIMEOUT_MS = 60000;

/** SFTP protocol code for "no such file". */
const SSH_FX_NO_SUCH_FILE = 2;

/**
 * Normalise any error into a readable single-line message.
 * @param error - whatever was thrown.
 * @returns a single-line message.
 */
export function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * Promise wrapper for the callback-style `ssh2` SFTP API.
 *
 * `sftp.end()` is synchronous and returns nothing, so it is not routed here.
 *
 * @param sftp - the SFTP session.
 * @param method - method name on the session (`stat`, `mkdir`, `readdir`, …).
 * @param args - arguments before the callback.
 * @returns a promise for the callback's value.
 */
function call(sftp, method, ...args) {
  return new Promise((resolvePromise, rejectPromise) => {
    try {
      sftp[method](...args, (error, value) => {
        if (error) rejectPromise(error);
        else resolvePromise(value);
      });
    } catch (error) {
      rejectPromise(error);
    }
  });
}

/**
 * Resolve a caller-supplied local path to an absolute one and, when a root
 * allow-list is configured, prove it stays inside it.
 *
 * Relative paths resolve against the *server process's* working directory,
 * which is not the client's — so the resolved value is always echoed back in
 * the result. That is the only way a caller can tell what was actually touched.
 *
 * The check is lexical (`resolve` collapses `..`), so a symlink pointing out of
 * an allowed root is not caught. That is stated in the README rather than
 * pretended away: the process runs as the user and can already read those
 * files.
 *
 * @param raw - the path as supplied.
 * @param roots - configured allow-list (`sftp.localRoots`); empty means "any".
 * @returns {ok:true, path} or {ok:false, error}.
 */
export function resolveLocalPath(raw, roots = []) {
  const text = String(raw ?? '').trim();
  if (text === '') return { ok: false, error: 'local path is empty' };
  if (text.includes('\0')) return { ok: false, error: 'local path contains a NUL byte' };

  const absolute = isAbsolute(text) ? resolve(text) : resolve(process.cwd(), text);

  const allowed = Array.isArray(roots) ? roots.filter((root) => typeof root === 'string' && root !== '') : [];
  if (allowed.length > 0) {
    const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const target = fold(absolute);
    const inside = allowed.some((root) => {
      const base = fold(resolve(root));
      return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
    });
    if (!inside) {
      return {
        ok: false,
        error: `local path ${absolute} is outside the configured sftp.localRoots (${allowed.join(', ')})`,
      };
    }
  }

  return { ok: true, path: absolute };
}

/**
 * Enumerate the local files a transfer should move.
 *
 * Symlinks are **skipped and reported**, never followed. A followed directory
 * link (node_modules trees are full of them) can duplicate an arbitrary subtree
 * or loop, and the caller cannot see that from the result — a warning is worth
 * more than the convenience.
 *
 * @param localPath - absolute local file or directory.
 * @param options - {recursive, maxFiles}.
 * @returns {ok:true, isDirectory, files:[{abs, rel}], warnings:[]} or {ok:false, error}.
 */
export async function collectLocalFiles(localPath, { recursive = true, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const warnings = [];
  let info;
  try {
    info = await stat(localPath);
  } catch (error) {
    return { ok: false, error: `local path ${localPath} is not readable: ${messageOf(error)}` };
  }

  if (info.isFile()) {
    return { ok: true, isDirectory: false, files: [{ abs: localPath, rel: basename(localPath) }], warnings };
  }
  if (!info.isDirectory()) {
    return { ok: false, error: `local path ${localPath} is neither a file nor a directory` };
  }
  if (recursive === false) {
    return { ok: false, error: `local path ${localPath} is a directory; pass recursive:true to transfer it` };
  }

  const files = [];
  const walk = async (dir, prefix) => {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isSymbolicLink()) {
        warnings.push(`skipped symlink ${rel}`);
        continue;
      }
      if (item.isDirectory()) {
        await walk(join(dir, item.name), rel);
      } else if (item.isFile()) {
        if (files.length >= maxFiles) {
          throw new Error(`directory holds more than ${maxFiles} files; raise sftp.maxFiles or transfer a subdirectory`);
        }
        files.push({ abs: join(dir, item.name), rel });
      }
    }
  };

  try {
    await walk(localPath, '');
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  return { ok: true, isDirectory: true, files, warnings };
}

/**
 * Create a remote directory and every missing parent.
 * @param sftp - the SFTP session.
 * @param dir - remote directory path.
 */
async function ensureRemoteDir(sftp, dir) {
  const normalised = posix.normalize(dir);
  const parts = normalised.split('/').filter((part) => part !== '');
  let current = normalised.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current === '' ? `/${part}` : `${current}/${part}`;
    if (await statRemoteOrNull(sftp, current) !== null) continue;
    try {
      await call(sftp, 'mkdir', current);
    } catch (error) {
      // A concurrent transfer may have created it in between; only re-check
      // when the error is not obviously "already there".
      if (await statRemoteOrNull(sftp, current) === null) {
        throw new Error(`cannot create remote directory ${current}: ${messageOf(error)}`);
      }
    }
  }
}

/**
 * Move one file with progress reporting and a stall watchdog.
 *
 * @param sftp - the SFTP session.
 * @param direction - 'upload' (put) or 'download' (get).
 * @param from - source path.
 * @param to - destination path.
 * @param options - {stallTimeoutMs, signal}.
 * @returns {Promise<number>} bytes transferred.
 */
function transferOne(sftp, direction, from, to, { stallTimeoutMs, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let transferred = 0;
    let lastProgress = Date.now();
    let watchdog = null;

    const cleanup = () => {
      if (watchdog !== null) clearInterval(watchdog);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const abort = (error) => {
      // Ending the session is the only way to stop an in-flight fastPut/fastGet;
      // the callback then fires with a channel error, which `settled` swallows.
      try { sftp.end(); } catch { /* already gone */ }
      finish(error);
    };
    const onAbort = () => abort(new Error('transfer aborted by caller'));

    if (signal?.aborted) {
      abort(new Error('transfer aborted by caller'));
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (stallTimeoutMs > 0) {
      const tick = Math.min(1000, Math.max(250, Math.floor(stallTimeoutMs / 4)));
      watchdog = setInterval(() => {
        if (Date.now() - lastProgress >= stallTimeoutMs) {
          abort(new Error(`transfer stalled — no progress for ${stallTimeoutMs} ms`));
        }
      }, tick);
      watchdog.unref?.();
    }

    const step = (bytes, _chunk, _total) => {
      transferred = bytes;
      lastProgress = Date.now();
    };

    const method = direction === 'upload' ? 'fastPut' : 'fastGet';
    try {
      sftp[method](from, to, { step }, (error) => {
        if (error) finish(new Error(messageOf(error)));
        else finish(null, transferred);
      });
    } catch (error) {
      finish(new Error(messageOf(error)));
    }
  });
}

/** Hash a local file, streaming so a multi-GB file is never held in memory. */
export function sha256Local(path, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    const onAbort = () => stream.destroy(new Error('hashing aborted by caller'));
    const detach = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) {
      rejectPromise(new Error('hashing aborted by caller'));
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => { detach(); rejectPromise(error); });
    stream.on('end', () => { detach(); resolvePromise(hash.digest('hex')); });
  });
}

/** POSIX single-quote a string for safe interpolation into a remote shell command. */
export function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

/**
 * Hash a remote file over an exec channel.
 *
 * Three spellings are tried because there is no single one: GNU coreutils ships
 * `sha256sum`, the BSDs ship `shasum -a 256`, and minimal images may only have
 * `openssl dgst`. A host with none of them degrades to a warning — the size
 * check still ran.
 *
 * This is the one place a transfer touches the exec path, and it goes through
 * `aiExec` deliberately so the terminal shows it like any other command.
 *
 * @param manager - the SshManager.
 * @param connection - saved connection name.
 * @param remotePath - remote file.
 * @param options - {signal}.
 * @returns {ok:true, sha256} or {ok:false, error}.
 */
export async function sha256Remote(manager, connection, remotePath, { signal } = {}) {
  const target = shellQuote(remotePath);
  const command = `sha256sum ${target} 2>/dev/null || shasum -a 256 ${target} 2>/dev/null || openssl dgst -sha256 ${target} 2>/dev/null`;
  const result = await manager.aiExec({ connection, command, timeoutMs: 60000, signal });
  if (!result.ok) return { ok: false, error: result.error ?? result.message ?? 'remote hashing failed' };
  const match = /([0-9a-f]{64})/i.exec(String(result.output ?? ''));
  if (match === null) {
    return { ok: false, error: 'no sha256 tool on the remote host (sha256sum / shasum / openssl all failed)' };
  }
  return { ok: true, sha256: match[1].toLowerCase() };
}

/** Whether an SFTP error means the channel itself is gone (no point continuing). */
function isChannelDead(error) {
  const text = messageOf(error).toLowerCase();
  return text.includes('no response from server')
    || text.includes('channel closed')
    || text.includes('connection lost')
    || text.includes('client is not connected')
    || text.includes('socket hang up');
}

/** Create the local directory that will hold a downloaded file. */
async function ensureLocalDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

/**
 * Run one transfer batch.
 *
 * @param manager - the SshManager.
 * @param direction - 'upload' or 'download'.
 * @param input - {connection, local, remote, recursive, overwrite, verify,
 *   stallTimeoutMs, waitForReconnectMs, signal, sftpConfig}.
 * @returns the tool-facing result object.
 */
async function runBatch(manager, direction, input) {
  const started = Date.now();
  const logger = manager.deps?.logger;
  const name = String(input.connection ?? '').trim();
  const sftpConfig = input.sftpConfig ?? {};
  const isUpload = direction === 'upload';

  const base = {
    ok: false,
    connection: name,
    direction,
    transferred: [],
    skipped: [],
    failed: [],
    warnings: [],
    totalBytes: 0,
    ms: 0,
  };

  const record = manager.store.get(name);
  if (!record) return { ...base, message: `no saved connection named "${name}"` };

  const localResolved = resolveLocalPath(input.local, sftpConfig.localRoots);
  if (!localResolved.ok) return { ...base, message: localResolved.error };

  const remote = String(input.remote ?? '').trim();
  if (remote === '') return { ...base, message: 'remote path is empty' };
  if (remote.includes('\0')) return { ...base, message: 'remote path contains a NUL byte' };

  const overwrite = input.overwrite === true;
  const verify = ['none', 'size', 'sha256'].includes(input.verify) ? input.verify : 'size';
  const stallTimeoutMs = Number.isFinite(Number(input.stallTimeoutMs))
    ? Number(input.stallTimeoutMs)
    : (Number.isFinite(Number(sftpConfig.stallTimeoutMs)) ? Number(sftpConfig.stallTimeoutMs) : DEFAULT_STALL_TIMEOUT_MS);
  const maxFiles = Number.isFinite(Number(sftpConfig.maxFiles)) ? Number(sftpConfig.maxFiles) : DEFAULT_MAX_FILES;
  const recursive = input.recursive !== false;

  const session = manager.sessionOf(record);
  const connected = await manager.ensureConnected(session, {
    waitForReconnectMs: input.waitForReconnectMs ?? manager.config.reconnectWaitTimeoutMs,
    signal: input.signal,
  });
  if (!connected.ok) {
    return { ...base, message: connected.error ?? `connection "${name}" is not online` };
  }
  const client = session.client;
  if (!client) return { ...base, message: `connection "${name}" is not online` };

  let sftp;
  try {
    sftp = await new Promise((resolvePromise, rejectPromise) => {
      client.sftp((error, value) => (error ? rejectPromise(error) : resolvePromise(value)));
    });
  } catch (error) {
    return { ...base, message: `cannot open an SFTP channel on "${name}": ${messageOf(error)}` };
  }

  const result = { ...base, warnings: [] };
  const label = isUpload ? 'upload' : 'download';
  const zh = isUpload ? '上传' : '下载';

  try {
    // ----------------------------------------------------------- plan the batch
    /** @type {Array<{local: string, remote: string, sourceBytes: number|null}>} */
    let plan;
    let sourceIsDirectory = false;

    if (isUpload) {
      const collected = await collectLocalFiles(localResolved.path, { recursive, maxFiles });
      if (!collected.ok) return { ...result, message: collected.error, ms: Date.now() - started };
      result.warnings.push(...collected.warnings);
      sourceIsDirectory = collected.isDirectory;
      plan = collected.files.map((file) => ({
        local: file.abs,
        remote: collected.isDirectory ? posix.join(remote, file.rel) : remote,
        sourceBytes: null,
      }));
    } else {
      const info = await statRemoteOrNull(sftp, remote);
      if (info === null) {
        return { ...result, message: `remote path ${remote} does not exist on "${name}"`, ms: Date.now() - started };
      }
      sourceIsDirectory = typeof info.isDirectory === 'function' ? info.isDirectory() : false;
      if (sourceIsDirectory && recursive === false) {
        return {
          ...result,
          message: `remote path ${remote} is a directory; pass recursive:true to transfer it`,
          ms: Date.now() - started,
        };
      }

      plan = [];
      const walkRemote = async (dir, prefix) => {
        const items = await call(sftp, 'readdir', dir);
        items.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
        for (const item of items) {
          const rel = prefix === '' ? item.filename : `${prefix}/${item.filename}`;
          const full = posix.join(dir, item.filename);
          const attrs = item.attrs ?? {};
          if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) {
            await walkRemote(full, rel);
            continue;
          }
          if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) {
            result.warnings.push(`skipped remote symlink ${full}`);
            continue;
          }
          if (plan.length >= maxFiles) {
            throw new Error(`remote directory holds more than ${maxFiles} files; raise sftp.maxFiles or transfer a subdirectory`);
          }
          plan.push({ local: join(localResolved.path, ...rel.split('/')), remote: full, sourceBytes: Number(attrs.size ?? 0) });
        }
      };

      if (sourceIsDirectory) {
        await walkRemote(posix.normalize(remote), '');
      } else {
        plan.push({
          local: localResolved.path,
          remote: posix.normalize(remote),
          sourceBytes: Number(info.size ?? 0),
        });
      }
    }

    result.local = localResolved.path;
    result.remote = remote;
    result.sourceIsDirectory = sourceIsDirectory;

    if (plan.length === 0) {
      return { ...result, ok: true, ms: Date.now() - started, message: `${label} skipped — the source is empty` };
    }

    session.appendEntry(
      'notice',
      `${zh}开始：${plan.length} 个文件 · ${isUpload ? `${localResolved.path} → ${name}:${remote}` : `${name}:${remote} → ${localResolved.path}`}`,
      { source: 'sftp' },
    );

    // -------------------------------------------------------------- move files
    let aborted = null;
    for (const item of plan) {
      if (input.signal?.aborted) { aborted = 'aborted by caller'; break; }

      // The destination is resolved per file (directories), so the overwrite
      // guard is a stat here rather than an SFTP `wx` open flag.
      const destination = isUpload ? await statRemoteOrNull(sftp, item.remote) : await statLocalOrNull(item.local);
      if (destination !== null && !overwrite) {
        result.skipped.push({
          local: item.local,
          remote: item.remote,
          reason: 'destination exists; pass overwrite:true to replace it',
        });
        continue;
      }

      try {
        let expectedBytes;
        if (isUpload) {
          const info = await stat(item.local);
          if (!info.isFile()) throw new Error('source is not a regular file');
          expectedBytes = info.size;
          await ensureRemoteDir(sftp, posix.dirname(item.remote));
          await transferOne(sftp, 'upload', item.local, item.remote, { stallTimeoutMs, signal: input.signal });
        } else {
          expectedBytes = item.sourceBytes ?? 0;
          await ensureLocalDir(item.local);
          await transferOne(sftp, 'download', item.remote, item.local, { stallTimeoutMs, signal: input.signal });
        }

        // Size check — cheap, and it catches the common failure (truncated or
        // never-completed transfer) without a second round trip of hashing.
        const after = isUpload ? await statRemoteOrNull(sftp, item.remote) : await stat(item.local);
        const actualBytes = Number(after?.size ?? 0);
        if (verify !== 'none' && actualBytes !== expectedBytes) {
          throw new Error(`size mismatch after transfer: expected ${expectedBytes} bytes, found ${actualBytes}`);
        }

        const entry = { local: item.local, remote: item.remote, bytes: actualBytes };

        if (verify === 'sha256') {
          const localHash = await sha256Local(item.local, input.signal);
          const remoteHash = await sha256Remote(manager, name, item.remote, { signal: input.signal });
          if (!remoteHash.ok) {
            result.warnings.push(`sha256 skipped for ${item.remote}: ${remoteHash.error}`);
          } else if (remoteHash.sha256 !== localHash) {
            throw new Error(`sha256 mismatch: local ${localHash.slice(0, 16)}…, remote ${remoteHash.sha256.slice(0, 16)}…`);
          } else {
            entry.sha256 = localHash;
          }
        }

        result.transferred.push(entry);
        result.totalBytes += actualBytes;
        logger?.info('sftp %s ok %s -> %s (%d bytes)', direction, item.local, item.remote, actualBytes);
      } catch (error) {
        const message = messageOf(error);
        result.failed.push({ local: item.local, remote: item.remote, error: message });
        logger?.warn('sftp %s failed %s -> %s: %s', direction, item.local, item.remote, message);
        if (isChannelDead(error)) aborted = `sftp channel closed: ${message}`;
      }
    }

    result.ok = result.failed.length === 0 && aborted === null;
    result.verified = verify;
    result.ms = Date.now() - started;
    const notes = [];
    if (result.skipped.length > 0) notes.push(`${result.skipped.length} skipped (exists)`);
    if (result.failed.length > 0) notes.push(`${result.failed.length} failed`);
    if (result.warnings.length > 0) notes.push(`${result.warnings.length} warning(s)`);
    const tail = notes.length > 0 ? ` — ${notes.join(', ')}` : '';
    result.message = aborted !== null
      ? `${label} interrupted: ${aborted} (${result.transferred.length} file(s) already transferred)`
      : `${label} ${result.transferred.length} file(s), ${result.totalBytes} bytes in ${(result.ms / 1000).toFixed(1)}s${tail}`;

    session.appendEntry('notice', result.message, { source: 'sftp' });
    return result;
  } catch (error) {
    return { ...result, ok: false, ms: Date.now() - started, message: `${label} failed: ${messageOf(error)}` };
  } finally {
    try { sftp.end(); } catch { /* already closed */ }
  }
}

/**
 * `stat` a remote path, reporting absence as `null` instead of throwing.
 *
 * Some servers answer "no such file" with a generic failure rather than the
 * protocol code, so the message is checked as a fallback — without it, every
 * "does the destination already exist?" probe on such a host would surface as a
 * hard transfer error.
 *
 * @param sftp - the SFTP session.
 * @param path - remote path.
 * @returns the stats object, or null when the path does not exist.
 */
async function statRemoteOrNull(sftp, path) {
  try {
    return await call(sftp, 'stat', path);
  } catch (error) {
    if (error?.code === SSH_FX_NO_SUCH_FILE) return null;
    if (/no such file/i.test(messageOf(error))) return null;
    throw error;
  }
}

/**
 * `stat` a local path, reporting absence as `null` instead of throwing.
 * @param path - local path.
 * @returns the stats object, or null when the path does not exist.
 */
async function statLocalOrNull(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Upload local files/directories to a saved connection.
 * @param manager - the SshManager.
 * @param input - see `runBatch`.
 * @returns the tool-facing result.
 */
export function upload(manager, input) {
  return runBatch(manager, 'upload', input);
}

/**
 * Download remote files/directories from a saved connection.
 * @param manager - the SshManager.
 * @param input - see `runBatch`.
 * @returns the tool-facing result.
 */
export function download(manager, input) {
  return runBatch(manager, 'download', input);
}

export default {
  upload,
  download,
  collectLocalFiles,
  resolveLocalPath,
  sha256Local,
  sha256Remote,
  shellQuote,
  messageOf,
};
