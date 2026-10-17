# Provenance of `vendor/`

The three JavaScript files in this directory come from
[`starxxy/dsh-ssh`](https://github.com/starxxy/dsh-ssh) — a fork of
[`jmcc-guo/dsh-ssh`](https://github.com/jmcc-guo/dsh-ssh) that fixes DSH
`0.2.0-rc.2` / desktop-client compatibility.

`store.js` and `tools.js` are **byte-for-byte copies**. `manager.js` is a copy
plus **one local patch** (see below) — the only deviation from upstream.

| Vendored file | Upstream path | State |
|---|---|---|
| `manager.js` | `lib/manager.js` | copy + `patches/0001-stale-close-guard.patch` |
| `store.js` | `lib/store.js` | unmodified |
| `tools.js` | `lib/tools.js` | unmodified |
| `LICENSE` | `LICENSE` (MIT, © jmcc-guo) | unmodified |

| | |
|---|---|
| Fork | `starxxy/dsh-ssh` @ `d9270703641d43e00f6237ff4f9765b848f727e3` |
| Upstream base | `jmcc-guo/dsh-ssh` @ `v0.5.0` (`8d9c7d6659752cc3b1e6446e26e2d8756cf82d83`) |
| License | MIT |
| Copied | 2026-09-30 |


## Why these files and not the whole plugin

The plugin cannot run outside DeepSeek Harness: `lib/index.js` needs the DSH
plugin runtime (`ctx.tools`, `ctx.credentials`, `ctx.settings`, `ctx.get('webServer')`)
and `lib/client.js` is a DSH Web-GUI panel. But the SSH core is harness-free by
design — `manager.js`'s own module doc says it "is Cordis-free: it receives a
thin deps object ({credentials, logger})".

The import graph confirms it:

```
manager.js -> node:crypto, node:fs, ssh2, ./store.js
store.js   -> node:crypto, node:fs, node:os, node:path
tools.js   -> @deepseek-ai/dsh-tools   (only `defineTool`)
```

Nothing else is pulled in. `lib/ws.js` and `lib/client.js` (the terminal panel)
are **not** vendored — they are web-GUI transport and have no role in an MCP
server.

`@deepseek-ai/dsh-tools` is satisfied by `../shims/dsh-tools`, a local package
whose `defineTool` is an identity function. That shim is what lets `tools.js`
stay a byte-for-byte copy of upstream: the DSH declaration objects it produces
are translated to MCP tools in `lib/mcp-tools.mjs`.

## Local patch — `patches/0001-stale-close-guard.patch`

**Symptom.** `ssh_disconnect` immediately followed by `ssh_exec` intermittently
leaves a *working* connection reporting `connecting` or `error`. Measured
before the fix with `probe-reconnect.mjs vps1 12`: the command succeeded in
12/12 iterations, but the connection status afterwards was wrong in 3 of them
(`connecting`, `connecting`, `error`).

**Cause.** `disconnect()` ends the client with `client.end()`, which closes the
socket asynchronously. The next `ssh_exec` builds a new client and spawns a new
shell, and only then does the old client's `close` event arrive. That handler
was identity-guarded for `session.client` but not for `session.shellStream`,
and it ended in

```js
if (becameReady) { this.startReconnect(session); ... }
```

so a dead socket could orphan the live shell and start an auto-reconnect on a
healthy connection. The file already uses identity guards elsewhere (see the
shell stream's own `close` handler), so this was an oversight, not a design.

**Fix.** Track the newest attempt's client on the session
(`session.connectingClient`) and ignore a `close` that belongs to neither the
current client nor the newest attempt. The shell cleanup is now gated on the
closing client actually being the current one.

**Why it matters more under MCP than in DSH.** A human clicking "disconnect"
and then typing cannot issue the two calls close enough together. An agent
issuing `ssh_disconnect` → `ssh_exec` back to back does it every time.

**After the fix.** `probe-reconnect.mjs vps1 12` → 12/12 clean, status
`connected` every iteration.

**Not covered by a live test.** The *unexpected* drop → auto-reconnect path
cannot be triggered safely against a production host. It is unchanged by
construction: for the current client's own close, `isCurrent` is true, so the
new branch is never taken.

## Integrity

```
ff9b9a823aa919dfb82beb3260aae6bba3dd3b28b940e227806c983bc19df7af  manager.js   (copy + patch 0001)
00bfea0d671c9f39c83ae2e72f7e23a00db1722ae17cbc813938e36f7951585c  store.js     (unmodified)
07246c91196683a2f9fa11ce9c03aced261ff7377727498e8846188b4a499f60  tools.js     (unmodified)
```

`manager.js` before the patch was
`48079fafdb00c4088ad1e0bf777df785587e1c80d2fd0538060d1cdbcd3ed41c` — the same
hash as upstream `lib/manager.js`. Verify with `sha256sum vendor/*.js` from the
project root.

## Re-syncing with upstream

```bash
git clone --depth 50 https://github.com/starxxy/dsh-ssh.git /tmp/dsh-ssh
cp /tmp/dsh-ssh/lib/{manager.js,store.js,tools.js} vendor/
cp /tmp/dsh-ssh/LICENSE vendor/LICENSE
git apply vendor/patches/0001-stale-close-guard.patch   # re-apply the local fix
sha256sum vendor/*.js                                   # manager.js -> ff9b9a82…
node selftest.mjs && node probe-reconnect.mjs vps1 12
```

The patch is LF-only, and the fork's `.gitattributes` (`*.js text eol=lf`) keeps
it that way inside a clone. If you apply it somewhere without those attributes
on a machine with `core.autocrlf=true`, git will write CRLF — the content is
still identical, only the line endings differ; use
`git -c core.autocrlf=false apply …` if you need the hash to match.

The selftest is the gate: it re-derives the tool set and JSON Schemas from the
copied files, so an upstream change that this adapter cannot express fails
loudly instead of silently.

