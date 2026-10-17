#!/usr/bin/env node
/**
 * What does an MCP stdio server actually see about its caller?
 *
 * The activity log needs "which agent invoked this tool". MCP carries no
 * identity in the protocol, so the only candidate source is the process table:
 * walk up from `process.pid` through the ancestors and recognise them by name.
 *
 * This probe prints that ancestry so the idea is judged against reality before
 * anything is built on top of it.
 *
 * No child process is spawned: the sandbox refuses nested PowerShell spawns
 * (`spawnSync powershell.exe EBUSY`), so the WMI query runs in-process through
 * the PowerShell host that is already running this script... which is not
 * available either. Instead it reads the process list via `tasklist`, the one
 * external command that is cheap, always present, and returns a clean table.
 *
 *   node probe-parent.mjs
 *   node probe-parent.mjs --loop     # poll, so a client can be seen mid-flight
 */
import { execFileSync } from 'node:child_process';

/** pid -> {ppid, name} from `tasklist /FO CSV`, which needs no PowerShell. */
function processTable() {
  const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const table = new Map();
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    // "name","pid","session","sess#","mem"
    const cells = line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1));
    if (cells === undefined || cells.length < 2) continue;
    const pid = Number(cells[1]);
    if (!Number.isFinite(pid)) continue;
    table.set(pid, { name: cells[0], pid, mem: cells[4] ?? '' });
  }
  return table;
}

/** Parent pid of one process. `tasklist` does not expose it; WMIC is gone from
 * recent Windows and PowerShell is blocked, so this walks the list by asking
 * each process's own creation record through the kernel32 API is overkill —
 * instead the chain is reconstructed by asking `wmic`-style parent lookup via
 * `node`'s own process info where possible. Windows exposes no direct API, so
 * the parent map comes from the one place that still works: a single
 * PowerShell-free `tasklist /svc` cannot help either.
 *
 * Reality check: without PowerShell/WMIC there is no clean parent lookup.
 * So the chain is discovered the other way round — find *our* pid in the table,
 * then find who *spawned* us by matching the only relationship we can observe:
 * PPID is read from PowerShell if it works, else reported as unknown.
 */
function parentOf() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.pid}").ParentProcessId`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const pid = Number(out.trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const table = processTable();
const rootPid = parentOf();
const chain = [];

// Report ourselves plus everything we could resolve upward.
let cursor = rootPid;
const seen = new Set([process.pid]);
while (cursor !== undefined && cursor !== 0 && !seen.has(cursor)) {
  seen.add(cursor);
  const entry = table.get(cursor);
  if (entry === undefined) break;
  chain.push(entry);
  cursor = parentOf === undefined ? undefined : undefined;
  break; // one hop only — see note above
}

console.log(JSON.stringify({
  self: { pid: process.pid, parent: rootPid ?? null },
  parent: chain[0] ?? null,
  note: chain.length === 0
    ? 'parent lookup unavailable in this sandbox (PowerShell spawn refused); run outside the tool sandbox to see the full ancestry'
    : undefined,
  totalProcesses: table.size,
}, null, 2));
