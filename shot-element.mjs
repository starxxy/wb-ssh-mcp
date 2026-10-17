#!/usr/bin/env node
/**
 * Screenshot one element of the page, by scrolling to it first.
 *
 * `--screenshot` only captures the viewport (or a fixed window size) from the
 * top of the document, so a card far down the page comes out either cut off or
 * scaled to nothing. This drives a real headless browser over the DevTools
 * protocol, measures the element, scrolls it into view and captures exactly
 * that region — which is what "look at the card I just built" actually needs.
 *
 *   node shot-element.mjs <url> <selector> <out.png> [width] [height]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const [url, selector, out, widthArg, heightArg] = process.argv.slice(2);
if (url === undefined || selector === undefined || out === undefined) {
  console.error('usage: node shot-element.mjs <url> <selector> <out.png> [width] [height]');
  process.exit(2);
}

const width = Number(widthArg ?? 1500);
const height = Number(heightArg ?? 1000);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'wb-ssh-shot-'));
const port = 9333;

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`,
  `--window-size=${width},${height}`,
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

/** Wait for the DevTools endpoint to answer. */
async function endpoint() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('DevTools endpoint never came up');
}

/** Minimal CDP client over the browser-level websocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry !== undefined) {
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message));
          else entry.resolve(message.result);
        }
      } else {
        this.events.push(message);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }
}

const wsUrl = await endpoint();
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve);
  socket.addEventListener('error', reject);
});
const cdp = new Cdp(socket);

// One tab, attached so commands can be sent with its sessionId.
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);

// `networkidle`-ish: the page polls, so there is no quiet moment. Waiting for
// the element to exist and for a fixed settle period is the reliable signal.
await cdp.send('Page.navigate', { url }, sessionId);
await new Promise((resolve) => setTimeout(resolve, 7000));

/** Run an expression in the page and return its value. */
async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate failed');
  return result.value;
}

// Measured with `captureBeyondViewport: true`, which renders the whole document
// and clips in *document* coordinates — so no scrolling is needed at all, and
// the fragile scroll-then-measure dance disappears. `getBoundingClientRect` is
// viewport-relative, so the scroll offsets are added back on.
const rect = await evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (node === null) return null;
  const r = node.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(r.left + window.scrollX)),
    y: Math.max(0, Math.round(r.top + window.scrollY)),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
})()`);

if (rect === null) throw new Error(`no element matched ${selector}`);
await new Promise((resolve) => setTimeout(resolve, 400));

const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: rect.x, y: rect.y, width: rect.w, height: Math.min(rect.h, 2600), scale: 1 },
  captureBeyondViewport: true,
}, sessionId);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`${out}  ${rect.w}x${Math.min(rect.h, 2600)}`);

socket.close();
child.kill();
process.exit(0);
