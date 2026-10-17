#!/usr/bin/env node
/**
 * Credential store CLI for the wb-ssh MCP server.
 *
 * The MCP tools deliberately refuse inline secrets — tool arguments are
 * recorded verbatim in the model's transcript. Secrets therefore enter the
 * shared store through this command, run by a human in their own terminal,
 * never through the model.
 *
 *   node cred.mjs list                     # stored credential names
 *   node cred.mjs set MY_REF               # prompts for the secret (hidden)
 *   echo -n 'secret' | node cred.mjs set MY_REF
 *   node cred.mjs resolve MY_REF           # whether it resolves (value never printed)
 *   node cred.mjs rm MY_REF
 *
 * @module wb-ssh-mcp/cred
 */
import { CredentialProvider } from './lib/credentials.mjs';
import { createLogger, loadConfig } from './lib/config.mjs';

const config = loadConfig();
const logger = createLogger('wb-ssh-cred');
const provider = new CredentialProvider({ path: config.credentialsPath, logger });

const [command, ref] = process.argv.slice(2);

/** Print usage and exit non-zero. */
function usage(message) {
  if (message !== undefined) process.stderr.write(`${message}\n`);
  process.stderr.write(
    `usage: node cred.mjs <list|set|resolve|rm> [REF]\n`
    + `store: ${config.credentialsPath}\n`,
  );
  process.exit(2);
}

/** Read a secret from a piped stdin (trailing newline trimmed). */
function readPiped() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
  });
}

/** Read a secret from an interactive terminal without echoing it. */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      reject(new Error('no TTY for a hidden prompt; pipe the secret on stdin instead'));
      return;
    }
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (char) => {
      if (char === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(value);
        return;
      }
      if (char === '\u007f' || char === '\b') { value = value.slice(0, -1); return; }
      value += char;
    };
    stdin.on('data', onData);
  });
}

if (command === 'list') {
  const names = provider.list();
  if (names.length === 0) {
    process.stdout.write(`(no stored credentials in ${config.credentialsPath})\n`);
  } else {
    for (const name of names) process.stdout.write(`${name}\n`);
  }
  process.exit(0);
}

if (command === 'resolve') {
  if (ref === undefined || ref === '') usage('resolve needs a REF');
  const resolved = await provider.resolve(ref);
  if (resolved === undefined) {
    process.stdout.write(`unresolved: ${ref}\n`);
    process.exit(1);
  }
  process.stdout.write(`resolved: ${ref} (kind=${resolved.kind}, ${resolved.value.length} chars, value not printed)\n`);
  process.exit(0);
}

if (command === 'rm') {
  if (ref === undefined || ref === '') usage('rm needs a REF');
  const removed = await provider.remove(ref);
  process.stdout.write(removed ? `removed: ${ref}\n` : `not found: ${ref}\n`);
  process.exit(removed ? 0 : 1);
}

if (command === 'set') {
  if (ref === undefined || ref === '') usage('set needs a REF');
  const secret = process.stdin.isTTY ? await readHidden(`secret for ${ref}: `) : await readPiped();
  if (secret === '') {
    process.stderr.write('refusing to store an empty secret\n');
    process.exit(1);
  }
  await provider.set(ref, secret);
  process.stdout.write(`stored: ${ref} (${secret.length} chars)\n`);
  process.exit(0);
}

usage(command === undefined ? undefined : `unknown command "${command}"`);
