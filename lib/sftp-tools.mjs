/**
 * SFTP tool declarations for the wb-ssh MCP server.
 *
 * Kept in `lib/` beside the transfer core rather than appended to
 * `vendor/tools.js`, for the same reason the core is: `vendor/` is a
 * byte-for-byte upstream copy with recorded hashes (`vendor/PROVENANCE.md`).
 *
 * The declaration shape is deliberately identical to the vendored ones — the
 * DSH `parameters` shorthand, `output.render` returning MCP content blocks — so
 * `lib/mcp-tools.mjs` converts these without a special case.
 *
 * @module wb-ssh-mcp/lib/sftp-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { download, upload } from './sftp.mjs';

/** Strip undefined values (lossless JSON requires them absent, not undefined). */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = clean(item);
    }
    return out;
  }
  return value;
}

const renderJson = (_args, value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
}];

/** Shared parameter block: only the direction differs between the two tools. */
const TRANSFER_PARAMETERS = {
  connection: { type: 'string', required: true, description: 'Saved connection name (see ssh_list). An offline connection is re-established from its saved settings first — no separate ssh_connect needed.' },
  recursive: { type: 'boolean', description: 'When the source is a directory, walk it recursively (default true). Pass false to refuse a directory instead of transferring it.' },
  overwrite: { type: 'boolean', description: 'Replace destination files that already exist (default false). When false, existing files are reported in `skipped` and nothing is written — the default protects a deploy from silently clobbering remote config.' },
  verify: { type: 'string', enum: ['none', 'size', 'sha256'], description: 'Post-transfer check (default "size"). "size" compares byte counts, which catches a truncated transfer at no extra cost; "sha256" also hashes both ends over an exec channel (one extra command per file).' },
  stallTimeoutMs: { type: 'integer', description: 'Abort a file when no bytes move for this long (default 60000). ssh2 has no transfer timeout of its own, so without it a wedged host would hang the call forever.' },
  waitForReconnectMs: { type: 'integer', description: 'Max time in ms to wait while the connection is reconnecting (default from config, 30000).' },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    connection: { type: 'string' },
    direction: { type: 'string', enum: ['upload', 'download'] },
    local: { type: 'string' },
    remote: { type: 'string' },
    sourceIsDirectory: { type: 'boolean' },
    transferred: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          local: { type: 'string', required: true },
          remote: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          sha256: { type: 'string' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          local: { type: 'string', required: true },
          remote: { type: 'string', required: true },
          reason: { type: 'string' },
        },
      },
    },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          local: { type: 'string', required: true },
          remote: { type: 'string', required: true },
          error: { type: 'string' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    totalBytes: { type: 'integer' },
    verified: { type: 'string' },
    ms: { type: 'integer' },
    message: { type: 'string' },
  },
};

/**
 * Build the SFTP tool set bound to one manager.
 * @param manager - SshManager instance.
 * @param sftpConfig - the `sftp` block of the wb-ssh config file.
 * @returns tool definitions.
 */
export function createSftpTools(manager, sftpConfig = {}) {
  /** Run one transfer and shape the result for the model. */
  const run = (direction, args, exec) => (direction === 'upload' ? upload : download)(manager, {
    connection: args.connection,
    local: args.local,
    remote: args.remote,
    recursive: args.recursive,
    overwrite: args.overwrite,
    verify: args.verify,
    stallTimeoutMs: args.stallTimeoutMs,
    waitForReconnectMs: args.waitForReconnectMs,
    signal: exec?.signal,
    sftpConfig,
  });

  return [
    defineTool({
      name: 'ssh_upload',
      description: 'Upload a local file or directory to a saved SSH connection over SFTP. '
        + 'The connection is reused — if it is offline it is re-established from its saved settings first. '
        + 'A directory is walked recursively and the remote directory tree is created as needed. '
        + 'Existing destination files are NOT replaced unless `overwrite:true`; they come back under `skipped`. '
        + 'Every file is size-checked after transfer, and `verify:"sha256"` compares content hashes too. '
        + 'Paths are on the two ends respectively: `local` is on THIS host, `remote` is on the server.',
      parameters: {
        connection: TRANSFER_PARAMETERS.connection,
        local: { type: 'string', required: true, description: 'Local source path on this host — a file or a directory. Relative paths resolve against the server process\'s working directory, so prefer an absolute path; the resolved value is echoed back in `local`.' },
        remote: { type: 'string', required: true, description: 'Remote destination path on the server. For a single file this is the target file; for a directory it is the target directory (created if missing).' },
        recursive: TRANSFER_PARAMETERS.recursive,
        overwrite: TRANSFER_PARAMETERS.overwrite,
        verify: TRANSFER_PARAMETERS.verify,
        stallTimeoutMs: TRANSFER_PARAMETERS.stallTimeoutMs,
        waitForReconnectMs: TRANSFER_PARAMETERS.waitForReconnectMs,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      async execute(args, exec) {
        return clean(await run('upload', args, exec));
      },
    }),

    defineTool({
      name: 'ssh_download',
      description: 'Download a remote file or directory from a saved SSH connection over SFTP. '
        + 'The connection is reused — if it is offline it is re-established from its saved settings first. '
        + 'A remote directory is walked recursively and the local directory tree is created as needed. '
        + 'Existing local files are NOT replaced unless `overwrite:true`; they come back under `skipped`. '
        + 'Every file is size-checked after transfer, and `verify:"sha256"` compares content hashes too. '
        + 'Paths are on the two ends respectively: `remote` is on the server, `local` is on THIS host.',
      parameters: {
        connection: TRANSFER_PARAMETERS.connection,
        remote: { type: 'string', required: true, description: 'Remote source path on the server — a file or a directory.' },
        local: { type: 'string', required: true, description: 'Local destination path on this host. For a single file this is the target file; for a directory it is the target directory (created if missing). Relative paths resolve against the server process\'s working directory, so prefer an absolute path; the resolved value is echoed back in `local`.' },
        recursive: TRANSFER_PARAMETERS.recursive,
        overwrite: TRANSFER_PARAMETERS.overwrite,
        verify: TRANSFER_PARAMETERS.verify,
        stallTimeoutMs: TRANSFER_PARAMETERS.stallTimeoutMs,
        waitForReconnectMs: TRANSFER_PARAMETERS.waitForReconnectMs,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      async execute(args, exec) {
        return clean(await run('download', args, exec));
      },
    }),
  ];
}

export default { createSftpTools };
