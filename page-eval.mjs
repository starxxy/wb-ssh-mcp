#!/usr/bin/env node
/**
 * Evaluate an expression inside the live page and print the result.
 *
 * For diagnosing the page without guessing: `Page.$eval` in a real headless
 * browser answers "did this actually run and what did it produce", which a
 * static read of the source cannot.
 *
 *   node page-eval.mjs <url> "<js expression>"
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, expression] = process.argv.slice(2);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'wb-ssh-eval-'));
const port = 9344;

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
  '--window-size=1500,1000', 'about:blank',
], { stdio: 'ignore', windowsHide: true });

async function endpoint() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('DevTools never came up');
}

const socket = new WebSocket(await endpoint());
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve);
  socket.addEventListener('error', reject);
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (entry === undefined) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

// Collect console output and uncaught errors — usually the actual answer.
const logs = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${message.params.type}] ${message.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    logs.push(`[uncaught] ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ''}`);
  }
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);
await new Promise((r) => setTimeout(r, 4000));

const { result, exceptionDetails } = await send('Runtime.evaluate', {
  expression, returnByValue: true, awaitPromise: true,
}, sessionId);

console.log('--- console ---');
for (const line of logs) console.log(line);
console.log('--- result ---');
if (exceptionDetails) console.log('EXCEPTION:', exceptionDetails.text, exceptionDetails.exception?.description ?? '');
else console.log(JSON.stringify(result.value, null, 2));

socket.close();
child.kill();
process.exit(0);
