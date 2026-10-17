#!/usr/bin/env node
/**
 * Live SFTP verification against a real saved connection.
 *
 *   node probe-sftp.mjs            # uses the first usable saved connection
 *   node probe-sftp.mjs vps1    # or name one explicitly
 *
 * Drives the real MCP server over stdio with the real MCP SDK client, so the
 * tool declarations, the JSON-Schema adapter, the activity log and the transfer
 * core are all exercised — not just `lib/sftp.mjs` in isolation.
 *
 * Round trip: upload a file, upload a directory, download both back, and hash
 * every copy. Then the guards: the overwrite default must skip, `overwrite:true`
 * must replace, and a missing source must fail cleanly. The remote scratch
 * directory is removed at the end; the shared records file is hashed before and
 * after to prove nothing rewrote DSH's data.
 *
 * @module wb-ssh-mcp/probe-sftp
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { loadConfig } from './lib/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}
function info(text) {
  process.stdout.write(`      ${text}\n`);
}
function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return '(missing)';
  }
}

const recordsBefore = sha256File(config.recordsPath);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(here, 'server.mjs')],
  stderr: 'pipe',
  env: { ...process.env },
});
const serverLog = [];
transport.stderr?.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    if (line.trim() !== '') serverLog.push(line.trimEnd());
  }
});

const client = new Client({ name: 'wb-ssh-probe-sftp', version: '0.1.0' });

/** Call a tool and parse its JSON payload. */
async function call(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content ?? []).map((part) => part.text ?? '').join('');
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { json, text, isError: response.isError === true };
}

// ---------------------------------------------------------------- fixtures
const stamp = Date.now().toString(36);
const remoteRoot = `/tmp/wb-ssh-sftp-probe-${stamp}`;
const localRoot = mkdtempSync(join(tmpdir(), 'wb-ssh-sftp-'));

const textBody = `wb-ssh sftp probe\n${stamp}\n${'line\n'.repeat(50)}`;
const binBody = randomBytes(1024 * 1024); // 1 MiB, so a real chunked transfer runs

writeFileSync(join(localRoot, 'text.txt'), textBody);
writeFileSync(join(localRoot, 'bin.dat'), binBody);
mkdirSync(join(localRoot, 'pkg', 'sub'), { recursive: true });
writeFileSync(join(localRoot, 'pkg', 'a.txt'), 'alpha\n');
writeFileSync(join(localRoot, 'pkg', 'sub', 'b.txt'), 'beta\n');

/** Hash every file under a directory, keyed by its relative POSIX path. */
function hashTree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      if (item.isDirectory()) walk(join(dir, item.name), rel);
      else out[rel] = sha256File(join(dir, item.name));
    }
  };
  walk(root, '');
  return out;
}

const expectedTextHash = sha256File(join(localRoot, 'text.txt'));
const expectedBinHash = sha256File(join(localRoot, 'bin.dat'));
const expectedTree = hashTree(join(localRoot, 'pkg'));

/** Remove the remote scratch tree through the ordinary exec tool. */
async function cleanRemote(connection) {
  await call('ssh_exec', { connection, command: `rm -rf ${remoteRoot}`, timeoutMs: 30000 });
}

let exitCode = 0;

try {
  await client.connect(transport);
  check('MCP handshake over stdio', true);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  check('tools/list exposes both SFTP tools', names.includes('ssh_upload') && names.includes('ssh_download'), names.length + ' tools');

  // -------------------------------------------------------- pick a connection
  const connections = await call('ssh_list');
  const all = connections.json?.connections ?? [];
  const wanted = process.argv.slice(2);
  const candidates = wanted.length > 0 ? wanted : all.map((entry) => entry.name);
  let connection = '';
  for (const name of candidates) {
    const probe = await call('ssh_exec', { connection: name, command: 'echo wb-ssh-sftp-probe', timeoutMs: 45000 });
    if (probe.json?.ok === true) { connection = name; break; }
    info(`skipping ${name}: ${probe.json?.message ?? probe.text.slice(0, 120)}`);
  }
  if (connection === '') {
    check('a saved connection is reachable', false, 'none of the candidates answered ssh_exec');
    throw new Error('no reachable connection');
  }
  check('a saved connection is reachable', true, connection);

  const hasSha256 = await call('ssh_exec', { connection, command: 'command -v sha256sum || command -v shasum', timeoutMs: 30000 });
  const sha256Available = hasSha256.json?.exitCode === 0;
  info(`remote sha256 tool: ${sha256Available ? 'available' : 'absent (sha256 verification will degrade to a warning)'}`);

  await cleanRemote(connection);

  // ------------------------------------------------------------ single file
  const uploadOne = await call('ssh_upload', {
    connection,
    local: join(localRoot, 'text.txt'),
    remote: `${remoteRoot}/text.txt`,
    verify: 'sha256',
  });
  check(
    'upload: single file transfers',
    uploadOne.json?.ok === true && uploadOne.json?.transferred?.length === 1,
    uploadOne.json?.message ?? uploadOne.text.slice(0, 200),
  );
  check(
    'upload: content hash matches the local file',
    uploadOne.json?.transferred?.[0]?.sha256 === expectedTextHash,
    uploadOne.json?.warnings?.[0] ?? uploadOne.json?.transferred?.[0]?.sha256?.slice(0, 16),
  );

  // ---------------------------------------------------- overwrite guard (off)
  const again = await call('ssh_upload', {
    connection,
    local: join(localRoot, 'text.txt'),
    remote: `${remoteRoot}/text.txt`,
  });
  check(
    'upload: an existing destination is skipped by default',
    again.json?.ok === true && again.json?.skipped?.length === 1 && again.json?.transferred?.length === 0,
    again.json?.message ?? again.text.slice(0, 200),
  );

  // ----------------------------------------------------- overwrite guard (on)
  const replaced = await call('ssh_upload', {
    connection,
    local: join(localRoot, 'text.txt'),
    remote: `${remoteRoot}/text.txt`,
    overwrite: true,
  });
  check(
    'upload: overwrite:true replaces it',
    replaced.json?.ok === true && replaced.json?.transferred?.length === 1,
    replaced.json?.message ?? replaced.text.slice(0, 200),
  );

  // -------------------------------------------------------------- big binary
  const uploadBin = await call('ssh_upload', {
    connection,
    local: join(localRoot, 'bin.dat'),
    remote: `${remoteRoot}/bin.dat`,
    verify: 'sha256',
  });
  check(
    'upload: a 1 MiB binary round-trips byte-exactly',
    uploadBin.json?.ok === true
      && uploadBin.json?.transferred?.[0]?.bytes === binBody.length
      && (sha256Available ? uploadBin.json?.transferred?.[0]?.sha256 === expectedBinHash : true),
    `${uploadBin.json?.transferred?.[0]?.bytes} bytes in ${uploadBin.json?.ms} ms`,
  );

  // ------------------------------------------------------------- directory
  const uploadDir = await call('ssh_upload', {
    connection,
    local: join(localRoot, 'pkg'),
    remote: `${remoteRoot}/pkg`,
  });
  check(
    'upload: a directory is walked recursively',
    uploadDir.json?.ok === true && uploadDir.json?.transferred?.length === 2,
    uploadDir.json?.message ?? uploadDir.text.slice(0, 200),
  );

  // ------------------------------------------------------------- downloads
  const downloadDir = join(localRoot, 'back');
  const getOne = await call('ssh_download', {
    connection,
    remote: `${remoteRoot}/text.txt`,
    local: join(downloadDir, 'text.txt'),
    verify: 'sha256',
  });
  check(
    'download: single file matches the uploaded content',
    getOne.json?.ok === true && sha256File(join(downloadDir, 'text.txt')) === expectedTextHash,
    getOne.json?.message ?? getOne.text.slice(0, 200),
  );

  const getBin = await call('ssh_download', {
    connection,
    remote: `${remoteRoot}/bin.dat`,
    local: join(downloadDir, 'bin.dat'),
    verify: 'sha256',
  });
  check(
    'download: the 1 MiB binary matches byte-exactly',
    getBin.json?.ok === true && sha256File(join(downloadDir, 'bin.dat')) === expectedBinHash,
    `${getBin.json?.transferred?.[0]?.bytes} bytes`,
  );

  const getTree = await call('ssh_download', {
    connection,
    remote: `${remoteRoot}/pkg`,
    local: join(downloadDir, 'pkg'),
  });
  const gotTree = existsSync(join(downloadDir, 'pkg')) ? hashTree(join(downloadDir, 'pkg')) : {};
  check(
    'download: a remote directory is recreated locally',
    getTree.json?.ok === true
      && JSON.stringify(gotTree) === JSON.stringify(expectedTree),
    getTree.json?.message ?? JSON.stringify(gotTree),
  );

  const skippedLocal = await call('ssh_download', {
    connection,
    remote: `${remoteRoot}/text.txt`,
    local: join(downloadDir, 'text.txt'),
  });
  check(
    'download: an existing local file is skipped by default',
    skippedLocal.json?.ok === true && skippedLocal.json?.skipped?.length === 1,
    skippedLocal.json?.message ?? skippedLocal.text.slice(0, 200),
  );

  // ------------------------------------------------------------ error paths
  const missingLocal = await call('ssh_upload', {
    connection,
    local: join(localRoot, 'does-not-exist.bin'),
    remote: `${remoteRoot}/nope.bin`,
  });
  check(
    'upload: a missing local source fails cleanly',
    missingLocal.json?.ok === false && /not readable/.test(missingLocal.json?.message ?? ''),
    missingLocal.json?.message,
  );

  const missingRemote = await call('ssh_download', {
    connection,
    remote: `${remoteRoot}/does-not-exist.bin`,
    local: join(downloadDir, 'nope.bin'),
  });
  check(
    'download: a missing remote source fails cleanly',
    missingRemote.json?.ok === false && /does not exist/.test(missingRemote.json?.message ?? ''),
    missingRemote.json?.message,
  );

  const unknownConnection = await call('ssh_upload', {
    connection: 'no-such-connection-wb-ssh-probe',
    local: join(localRoot, 'text.txt'),
    remote: '/tmp/nope.txt',
  });
  check(
    'upload: an unknown connection fails cleanly',
    unknownConnection.json?.ok === false && /no saved connection/.test(unknownConnection.json?.message ?? ''),
    unknownConnection.json?.message,
  );

  // ------------------------------------------------------------ local paths
  const resolvedEcho = await call('ssh_upload', {
    connection,
    local: join(localRoot, 'text.txt'),
    remote: `${remoteRoot}/echo.txt`,
  });
  check(
    'upload: the resolved absolute local path is echoed back',
    resolvedEcho.json?.local === join(localRoot, 'text.txt') && resolvedEcho.json?.remote === `${remoteRoot}/echo.txt`,
    `${resolvedEcho.json?.local} → ${resolvedEcho.json?.remote}`,
  );

  // ------------------------------------------------------- cold-start upload
  // The common real path: an agent calls ssh_upload without ever calling
  // ssh_connect, on a connection that is not currently online.
  const dropped = await call('ssh_disconnect', { connection });
  check('the connection can be dropped for the cold-start test', dropped.json?.ok === true, dropped.json?.message);

  const coldUpload = await call('ssh_upload', {
    connection,
    local: join(localRoot, 'text.txt'),
    remote: `${remoteRoot}/cold.txt`,
  });
  check(
    'upload: an offline connection is re-established automatically',
    coldUpload.json?.ok === true && coldUpload.json?.transferred?.length === 1,
    coldUpload.json?.message ?? coldUpload.text.slice(0, 200),
  );

  // --------------------------------------------------------------- cleanup
  await cleanRemote(connection);
  const afterClean = await call('ssh_exec', { connection, command: `test -e ${remoteRoot} && echo present || echo absent`, timeoutMs: 30000 });
  check('the remote scratch tree is removed', /absent/.test(afterClean.json?.output ?? ''), (afterClean.json?.output ?? '').trim());
} catch (error) {
  check('probe completed', false, error.message);
  exitCode = 1;
} finally {
  const recordsAfter = sha256File(config.recordsPath);
  check('the shared records file was not rewritten', recordsBefore === recordsAfter, recordsBefore.slice(0, 16));

  await client.close().catch(() => {});
  try {
    rmSync(localRoot, { recursive: true, force: true });
  } catch (error) {
    info(`could not remove ${localRoot}: ${error.message}`);
  }
  const fatal = serverLog.filter((line) => /error|uncaught|unhandled/i.test(line));
  if (fatal.length > 0) info(`server log warnings: ${fatal.slice(0, 5).join(' | ')}`);
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(exitCode !== 0 || failed.length > 0 ? 1 : 0);
