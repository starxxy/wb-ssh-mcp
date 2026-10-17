#!/usr/bin/env node
/**
 * Screenshot the activity card and the log card, at a readable height.
 *
 * `shot-element.mjs` captures an element whole; these two cards are 2400px tall
 * with a dozen rows, which is unreadable as a preview image. So this trims to
 * the top N rows plus the surrounding chrome.
 *
 *   node shot-panels.mjs <url> <out-dir>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, outDir = 'preview'] = process.argv.slice(2);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = mkdtempSync(join(tmpdir(), 'wb-ssh-panels-'));
const port = 9355;

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
    } catch { /* not up yet */ }
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

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);
// Long enough for the 2.5s poll plus the facet and log fetches to land.
await new Promise((r) => setTimeout(r, 8000));

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value;
};

mkdirSync(outDir, { recursive: true });

/**
 * Capture a card, trimmed to `rows` feed rows.
 *
 * The trim is done by measuring the Nth row's bottom edge and clipping the card
 * to that, so the result keeps the card's head and rounded corners.
 */
async function shotCard(cardSelector, feedSelector, rows, file) {
  const rect = await evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(cardSelector)});
    if (card === null) return null;
    const feed = card.querySelector(${JSON.stringify(feedSelector)});
    const items = feed === null ? [] : [...feed.querySelectorAll('.feed-row')].slice(0, ${rows});
    const cardRect = card.getBoundingClientRect();
    // Bottom of the last kept row, relative to the card; fall back to the
    // whole feed when there are fewer rows than asked for.
    const last = items.length > 0 ? items[items.length - 1] : feed;
    const bottom = last === null
      ? cardRect.bottom
      : last.getBoundingClientRect().bottom;
    return {
      x: Math.max(0, Math.round(cardRect.left + window.scrollX)),
      y: Math.max(0, Math.round(cardRect.top + window.scrollY)),
      w: Math.round(cardRect.width),
      h: Math.round(bottom - cardRect.top + 14),
    };
  })()`);
  if (rect === null) throw new Error(`no card matched ${cardSelector}`);
  await new Promise((r) => setTimeout(r, 300));

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
    captureBeyondViewport: true,
  }, sessionId);

  writeFileSync(join(outDir, file), Buffer.from(shot.data, 'base64'));
  console.log(`${join(outDir, file)}  ${rect.w}x${rect.h}`);
}

// The two cards are siblings inside `.content`; select by their headings.
await shotCard('section.card:has(#actFeed)', '#actFeed', 7, 'activity-feed.png');
await shotCard('section.card:has(#logFeed)', '#logFeed', 7, 'log-table.png');

socket.close();
child.kill();
process.exit(0);
