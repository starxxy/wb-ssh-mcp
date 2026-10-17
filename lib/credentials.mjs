/**
 * Credential provider for the wb-ssh MCP server.
 *
 * Implements the two-method interface `SshManager` expects from
 * `deps.credentials` (see `vendor/manager.js`):
 *
 *   resolve(ref) -> Promise<{value} | undefined>
 *   set(ref, value) -> Promise<void>
 *
 * A reference resolves in this order:
 *
 *   1. `env:NAME`   — the process environment variable NAME.
 *   2. `file:PATH`  — the contents of PATH (used for private-key material).
 *   3. anything else — the `refs` map of the DeepSeek Harness credential store
 *      (`$DSH_HOME/.credentials.yaml`), which is exactly what the DSH SSH
 *      plugin writes. This is what makes connections saved in the DSH panel
 *      work here with no migration.
 *
 * Writes go back into that same file so the DSH panel and this server see one
 * set of secrets. The store is re-read immediately before every write and
 * replaced atomically (temp file + rename), which keeps a concurrently running
 * DSH process from losing its other entries to a stale in-memory copy.
 *
 * Secrets are never logged and never returned in tool output.
 *
 * @module wb-ssh-mcp/credentials
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** Environment-variable reference prefix. */
export const ENV_PREFIX = 'env:';

/** File-contents reference prefix. */
export const FILE_PREFIX = 'file:';

/**
 * Credential provider backed by the shared DSH credential store.
 */
export class CredentialProvider {
  /**
   * @param options - {path, logger}.
   * @param options.path - credential store path (`$DSH_HOME/.credentials.yaml`).
   * @param options.logger - {info,warn,error} sink; optional.
   */
  constructor({ path, logger } = {}) {
    this.path = path;
    this.logger = logger ?? { info() {}, warn() {}, error() {} };
    /** Set of refs resolved since start — used by the selftest, never persisted. */
    this.lastResolvedRef = null;
  }

  /**
   * Resolve a credential reference to its secret value.
   * @param ref - `env:NAME`, `file:PATH`, or a stored credential name.
   * @returns {Promise<{value: string, kind: string} | undefined>} the secret, or
   *   undefined when the reference is unknown or empty.
   */
  async resolve(ref) {
    const name = String(ref ?? '').trim();
    if (name === '') return undefined;
    this.lastResolvedRef = name;

    if (name.startsWith(ENV_PREFIX)) {
      const key = name.slice(ENV_PREFIX.length);
      const value = process.env[key];
      return value === undefined || value === '' ? undefined : { value, kind: 'env' };
    }

    if (name.startsWith(FILE_PREFIX)) {
      const file = name.slice(FILE_PREFIX.length);
      try {
        const value = readFileSync(file, 'utf8');
        return value === '' ? undefined : { value, kind: 'file' };
      } catch (error) {
        this.logger.warn('credential file %s unreadable: %s', file, error.message);
        return undefined;
      }
    }

    const refs = this.#read().refs;
    const stored = refs?.[name];
    if (stored === undefined || stored === null || String(stored) === '') return undefined;
    return { value: String(stored), kind: 'store' };
  }

  /**
   * Store a secret under a name in the shared credential store.
   * @param ref - a plain credential name; `env:`/`file:` references are read-only.
   * @param value - the secret.
   */
  async set(ref, value) {
    const name = String(ref ?? '').trim();
    if (name === '') throw new Error('credential name is required');
    if (name.startsWith(ENV_PREFIX) || name.startsWith(FILE_PREFIX)) {
      throw new Error(`"${name}" is a read-only reference kind and cannot be written`);
    }
    const secret = String(value ?? '');
    if (secret === '') throw new Error(`refusing to store an empty secret for "${name}"`);
    const doc = this.#read();
    doc.refs = { ...(doc.refs ?? {}), [name]: secret };
    this.#write(doc);
  }

  /**
   * Remove a stored credential.
   * @param ref - stored credential name.
   * @returns {boolean} whether an entry was removed.
   */
  async remove(ref) {
    const name = String(ref ?? '').trim();
    const doc = this.#read();
    if (doc.refs === undefined || !(name in doc.refs)) return false;
    delete doc.refs[name];
    this.#write(doc);
    return true;
  }

  /**
   * List stored credential names (never their values).
   * @returns {string[]} sorted names.
   */
  list() {
    return Object.keys(this.#read().refs ?? {}).sort();
  }

  /** Re-read the store from disk. Never throws: a missing file is an empty store. */
  #read() {
    try {
      const raw = readFileSync(this.path, 'utf8');
      const doc = parseYaml(raw);
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { version: 1, refs: {} };
      if (doc.refs === null || typeof doc.refs !== 'object' || Array.isArray(doc.refs)) doc.refs = {};
      return doc;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('credential store %s unreadable (%s); treating as empty', this.path, error.message);
      }
      return { version: 1, refs: {} };
    }
  }

  /** Atomically replace the store file. */
  #write(doc) {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const payload = stringifyYaml(doc);
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export default { CredentialProvider, ENV_PREFIX, FILE_PREFIX };
