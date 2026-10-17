/**
 * Configuration resolution for the wb-ssh MCP server.
 *
 * Defaults deliberately match the DSH plugin's own defaults so that the two
 * consumers share one set of data:
 *   records     $DSH_HOME/storages/dsh-ssh/connections.json
 *   credentials $DSH_HOME/.credentials.yaml
 *
 * `$DSH_HOME` is read from the environment and falls back to `~/.dsh`.
 *
 * Optional overrides live in a JSON file (default
 * `~/.workbuddy-ai/ssh/config.json`, or the path in `$WB_SSH_CONFIG`):
 *
 *   {
 *     "recordsPath": "...",
 *     "credentialsPath": "...",
 *     "activityPath": "...",
 *     "manager": { "execTimeoutMs": 120000, "shellQuietWaitMs": 2000 },
 *     "sftp": { "localRoots": [], "stallTimeoutMs": 60000, "maxFiles": 5000 },
 *     "ui": { "token": "…", "host": "127.0.0.1" }
 *   }
 *
 * Any key of `manager` is passed straight through to SshManager, which clamps
 * unknown/ill-typed values against its own DEFAULT_CONFIG.
 *
 * `sftp` configures the file-transfer tools, which are this project's own (not
 * upstream's) — see `lib/sftp.mjs`. `localRoots`, when non-empty, restricts
 * every transfer to those local directories; empty (the default) means any path
 * this process can read, which is the honest default for a tool that runs as
 * the user and whose whole purpose is moving files around.
 *
 * `ui.token` is the connection-manager page's access token. `ui.mjs` writes it
 * on first run so the page URL stops changing between launches — see the
 * exposure notes in ui.mjs for why persisting it costs nothing.
 *
 * `ui.host` is the interface `ui.mjs` binds. Absent (or `127.0.0.1`) keeps the
 * page on loopback; `0.0.0.0` opens it to the local network, which is what the
 * `--host` flag overrides. Loopback is the default because the page edits SSH
 * credentials — see the exposure notes in ui.mjs.
 *
 * @module wb-ssh-mcp/config
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

/** DeepSeek Harness home directory. */
export const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh');

/** Shared connection-record file (identical to the DSH plugin default). */
export const DEFAULT_RECORDS_PATH = join(DSH_HOME, 'storages', 'dsh-ssh', 'connections.json');

/** Shared credential store (identical to the DSH credential service file). */
export const DEFAULT_CREDENTIALS_PATH = join(DSH_HOME, '.credentials.yaml');

/** Where the optional override file lives. */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.workbuddy-ai', 'ssh', 'config.json');

/**
 * Shared activity log.
 *
 * Lives next to the override file rather than in DSH's storage, because it
 * records wb-ssh's own MCP and page traffic — DSH has no interest in it. Both
 * processes append to this one file; see `lib/activity.mjs` for why it is JSONL.
 */
export const DEFAULT_ACTIVITY_PATH = join(homedir(), '.workbuddy-ai', 'ssh', 'activity.jsonl');

/**
 * Load the effective configuration.
 * @returns {{recordsPath: string, credentialsPath: string, activityPath: string, configPath: string, manager: object, sftp: object, ui: object, warnings: string[]}}
 */
export function loadConfig() {
  const configPath = process.env.WB_SSH_CONFIG && process.env.WB_SSH_CONFIG !== ''
    ? process.env.WB_SSH_CONFIG
    : DEFAULT_CONFIG_PATH;

  const warnings = [];
  let file = {};
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, 'utf8')) ?? {};
    } catch (error) {
      warnings.push(`config file ${configPath} is unreadable (${error.message}); using defaults`);
      file = {};
    }
  }

  const recordsPath = typeof file.recordsPath === 'string' && file.recordsPath !== ''
    ? file.recordsPath
    : DEFAULT_RECORDS_PATH;
  const credentialsPath = typeof file.credentialsPath === 'string' && file.credentialsPath !== ''
    ? file.credentialsPath
    : DEFAULT_CREDENTIALS_PATH;
  const activityPath = typeof file.activityPath === 'string' && file.activityPath !== ''
    ? file.activityPath
    : DEFAULT_ACTIVITY_PATH;
  const manager = file.manager !== null && typeof file.manager === 'object' ? { ...file.manager } : {};
  const sftp = file.sftp !== null && typeof file.sftp === 'object' ? { ...file.sftp } : {};
  const ui = file.ui !== null && typeof file.ui === 'object' ? { ...file.ui } : {};

  // SshManager owns the records path through its own config key.
  manager.recordsPath = recordsPath;

  return { recordsPath, credentialsPath, activityPath, configPath, manager, sftp, ui, warnings };
}

/**
 * A logger that writes to stderr only.
 *
 * stdout carries the MCP stdio protocol — a single stray byte there corrupts
 * the session — so every diagnostic must go to stderr.
 *
 * Messages are formatted with `node:util.format`, because the vendored
 * manager.js logs printf-style (`logger.info('… (%d saved connections)', n)`).
 * Joining the arguments instead would print a literal `%d`.
 */
export function createLogger(prefix = 'wb-ssh') {
  const write = (stream, level, args) => {
    const message = format(...args);
    stream.write(`[${prefix}] ${level} ${message}\n`);
  };
  return {
    info: (...args) => write(process.stderr, 'info', args),
    warn: (...args) => write(process.stderr, 'warn', args),
    error: (...args) => write(process.stderr, 'error', args),
    debug: (...args) => write(process.stderr, 'debug', args),
  };
}
