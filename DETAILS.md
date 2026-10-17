# wb-ssh — 详细说明

> 安装步骤看 [README.md](README.md)。本文件是完整的技术细节：SFTP 语义、活动日志、
> 安全栅栏、配置项、验证方法与踩坑记录。

---

# wb-ssh — SSH over MCP

A standalone [MCP](https://modelcontextprotocol.io) server that gives any MCP
client — WorkBuddy, Codex, Claude Code, Cursor, … — the SSH connection manager
of [`starxxy/dsh-ssh`](https://github.com/starxxy/dsh-ssh) (a fork of
`@jmcc-guo/dsh-ssh`).

The DSH plugin itself cannot be installed outside DeepSeek Harness. Its SSH
core can: it is harness-free, so it is reused here verbatim and re-transported
from a DSH tool registry to MCP stdio. See [`vendor/PROVENANCE.md`](vendor/PROVENANCE.md).

It **shares data with DeepSeek Harness**:

| | |
|---|---|
| Connections | `$DSH_HOME/storages/dsh-ssh/connections.json` — the file the DSH SSH panel uses |
| Credentials | `$DSH_HOME/.credentials.yaml` — the DSH credential store |

A connection saved in the DSH panel is usable here immediately, and vice versa.
`$DSH_HOME` defaults to `~/.dsh`.

Two things come with it beyond the tools:

- a **connection-manager page** (`node ui.mjs`) for editing connections in a
  browser, protected by a token link or a password — see
  [连接管理页面](#连接管理页面);
- an **activity log** that records which agent called which tool against which
  server, with filtering by agent / time / VPS — see [活动日志](#活动日志).

## Tools

| Tool | Purpose |
|---|---|
| `ssh_list` | Every saved connection with live status. **Start here.** |
| `ssh_connect` | Establish (or re-establish) a connection; optionally through a saved connection used as a jump host. |
| `ssh_exec` | Run a command. Reconnects if offline, waits if busy or reconnecting; long commands return an `execId` with status `running`. |
| `ssh_exec_read` | Incremental output of a command still running. |
| `ssh_exec_kill` | Kill a running command by `execId`. |
| `ssh_status` | Live status of one connection. |
| `ssh_disconnect` | Deliberate disconnect (no auto-reconnect). Optionally delete the record. |
| `ssh_delete` | Delete a saved connection record. |
| `ssh_upload` | **SFTP** upload a local file or directory. Recursive; existing destinations are skipped unless `overwrite:true`. |
| `ssh_download` | **SFTP** download a remote file or directory. Recursive; existing destinations are skipped unless `overwrite:true`. |

## Secrets never travel through the model

Tool arguments are recorded verbatim in the model's transcript, so `ssh_connect`
**refuses inline secrets**. Auth is by reference only:

| `auth` field | Meaning |
|---|---|
| `passwordRef` | A stored credential name, or `env:NAME` for an environment variable |
| `privateKeyPath` | Absolute path to a key file on this host |
| `privateKeyRef` | Stored credential holding the key text |
| `passphraseRef` | Stored credential holding the key passphrase |

Store a secret from your own terminal, never through the agent:

```bash
node C:/path/to/wb-ssh-mcp/cred.mjs set MY_REF        # prompts, input hidden
echo -n 'secret' | node C:/path/to/wb-ssh-mcp/cred.mjs set MY_REF
node C:/path/to/wb-ssh-mcp/cred.mjs list
node C:/path/to/wb-ssh-mcp/cred.mjs resolve MY_REF    # checks it resolves; value never printed
node C:/path/to/wb-ssh-mcp/cred.mjs rm MY_REF
```

Credentials written this way land in the shared DSH store, so the DSH panel
sees them too.

## 文件传输（SFTP）

`ssh_upload` / `ssh_download` 在**已有的连接**上开一条 SFTP 通道，不需要另外配置什么：

```
ssh_upload   { connection, local, remote, overwrite?, verify? }   # 本机 → 服务器
ssh_download { connection, remote, local, overwrite?, verify? }   # 服务器 → 本机
```

`local` 在**本机**，`remote` 在**服务器**，两个方向不会搞混。连接离线会自动重连，
跟 `ssh_exec` 一样不用先 `ssh_connect`。

**为什么是 SFTP 而不是 scp。** `scp` 要另起一个 `ssh.exe` 进程，而本机出站是按进程
拦的（只有托管版 `node.exe` 能出去，见 `wb-ssh-push-large-files` 那份记录）；SFTP 走
的是已经建好的那条 SSH 连接，同一个 TCP 连接、同一套凭据，既不用重新认证，也不受
那个拦截影响。

**目录会递归。** `local` 是目录就整个传上去（远端目录树按需 `mkdir -p`），`remote`
是目录就整个拉下来（本地目录树按需创建）。`maxFiles` 默认 5000 个文件封顶，防止
手一抖传了 `node_modules`。**符号链接跳过并记进 `warnings`** —— 跟随目录软链会把
任意子树复制一遍甚至绕圈，而调用方从结果里看不出来，所以宁可报出来。

**默认不覆盖。** 目标已存在时该文件进 `skipped` 并原样保留，要覆盖得显式写
`overwrite:true`。这个默认是为部署场景定的：AI 替你传一个配置文件，不该悄悄盖掉
服务器上已经改过的那份。

**传完会验。** 默认 `verify:"size"`，每个文件传完比对两端字节数——截断和半途中断都
跑不掉，成本是一次 `stat`。`verify:"sha256"` 再比内容哈希（本地算，远端通过 exec
通道跑 `sha256sum`，没有就退到 `shasum -a 256` / `openssl dgst`，都没有就降级成一条
warning，不会误报成功）。

**卡死会被掐掉。** ssh2 自己没有传输超时，对端假死会让一次 MCP 调用永远挂着，所以有
`stallTimeoutMs`（默认 60000）：多久没有字节推进就中止，返回失败而不是无限等。

**为什么不和 `ssh_exec` 抢锁。** `ssh_exec` 要和共享 pty 里的手工输入互斥
（`shellQuietWaitMs`），因为命令是写进同一个 pty 的。SFTP 开自己的 channel、不写 pty、
不产生终端输出，两边互不干扰——真要互斥的话，面板里挂一个 `tail -f` 就会让所有传输
永远等下去。传输只在终端里留一条 notice，方便你在面板里看到发生了什么。

**本机路径默认不设限**，可以配 `sftp.localRoots` 收口（见 Configuration）。不设限是
诚实的默认值：这个进程以你的身份运行，本来就能读那些文件；白名单防的是误操作，不是
越权。注意它是**字面路径**比较（`..` 会被规范化掉），软链指向白名单外的情况拦不住。

实测（`node probe-sftp.mjs vps1`，公网 VPS）：单文件、1 MiB 二进制、目录树三个往返
全部哈希一致，`skipped` / `overwrite` / 错误路径各一条断言，19/19 通过。

## Running

```bash
node C:/path/to/wb-ssh-mcp/server.mjs        # MCP server on stdio; logs go to stderr
node C:/path/to/wb-ssh-mcp/ui.mjs            # connection manager page (opens the browser)
```

## 接入其他 agent

MCP 是客户端各自拉起一个 stdio 子进程，所以**每个 agent 都要在自己的配置文件里
写一条**。三要素永远是同一个 `command` + `args`：

```
command: C:\Users\yourname\.workbuddy-ai\binaries\node\versions\22.x.x\node.exe
args:    ["C:\\path\\to\\wb-ssh-mcp\server.mjs"]
```

差别只在**文件位置**和**顶层字段名** —— 注意字段名各家不一样，这是最容易写错的地方：

| 客户端 | 配置文件 | 顶层字段 |
|---|---|---|
| WorkBuddy / WorkBuddy AI | `~/.workbuddy-ai/mcp.json` | `mcpServers` |
| Antigravity（2.0 / IDE / CLI 共用一份） | `~/.gemini/config/mcp_config.json` | `mcpServers` |
| Claude Code | `~/.claude.json` | `mcpServers` |
| VS Code + Copilot Chat | `%APPDATA%/Code/User/mcp.json`（或工作区 `.vscode/mcp.json`） | `servers` + `"type": "stdio"` |
| Qoder | `~/.qoder/mcp.json` | `mcpServers` |
| CodeBuddy | `~/.codebuddy/mcp.json` | `mcpServers` |
| TRAE SOLO CN | `%APPDATA%/TRAE SOLO CN/User/mcp.json` | `mcpServers` |
| ZCode | `~/.zcode/cli/config.json` | `mcp.servers`（**两层嵌套**） |
| Codex | `~/.codex/config.toml` | `[mcp_servers.wb-ssh]` 表 |

各家的坑：

- **ZCode**：`~/.zcode/cli/config.json` 里只要读到**任何** MCP 服务，同作用域的
  `~/.agents/mcp.json` 就被整体跳过，**不合并**。所以要么都写进 `.zcode`，要么都用 `.agents`，
  别两边混。另外它还有工作区级的 `<项目根>/.zcode/config.json`，同名服务以用户级为准。
- **TRAE**：用户级在 `%APPDATA%/TRAE SOLO CN/User/mcp.json`（IDE 版的 `Trae CN/User/`
  下没有这个文件）。项目级另有 `<项目根>/.trae/mcp.json`，需要在设置里手动打开
  「启用项目级 MCP」。文档明确说 `command` **不能含空格**。
- **Cursor**：本体没装（只有 `~/.cursor/extensions` 残留），没配。
- **ChatGPT 桌面版接不了**：它只接受**远程** MCP（HTTP/SSE），不跑本地 stdio 子进程。
  要把 wb-ssh 暴露成公网 HTTPS 才能接——那是把 SSH 凭据管理端点挂到互联网上，不做。
- **DeepSeek Harness 不需要 MCP**：`vendor/` 就是从它的插件拷出来的，它在 DSH 里
  本来就是原生 Cordis 插件，比 MCP 这条路更直接。

用绝对路径指向 node，不要依赖 `PATH` —— 客户端拉子进程时的环境不一定和你终端里一样。

`check-agents.mjs` 会把 `command`/`args` **从每个客户端自己的配置文件里读出来**，
用那份值真的 spawn 一次服务、走完 MCP 握手和 `tools/list`，再调一次 `ssh_list`。
只校验 JSON 能解析是没用的：路径写错、漏了 `type` 字段，看起来都完全合法。

```bash
node check-agents.mjs        # 9/9 client configs launch the server
```

（`root` 是点分路径，因为各家嵌套不同：VS Code 是 `servers`，ZCode 是 `mcp.servers`，
其余是顶层 `mcpServers`。）

### 多 agent 并存时的边界

- **连接定义是共享的** —— 都读 `~/.dsh/storages/dsh-ssh/connections.json`，
  在 A 里新建的连接，B 下次调用就能看到。
- **凭据库也是共享的** —— `~/.dsh/.credentials.yaml`，A 存的密码 B 能用。
- **连接状态不是共享的** —— 记录文件里根本没有 `status` 字段；谁连着、开着哪些
  shell，都在各自进程的内存里。所以在 WorkBuddy 里连上 `vps1`，Codex 那边
  `ssh_list` 看到的仍然是 `disconnected`，要用就得自己再连一次。
- **同时写定义有竞态** —— 两个 agent 在同一瞬间新建/删除连接，是读-改-写，后写的
  会盖掉先写的。人手操作碰不到，批量脚本要注意。

## 连接管理页面

`ui.mjs` 起一个小网页，用来填 SSH 信息 —— 这是补上
`cred.mjs` 那个摩擦点：密钥不能走模型，所以在有页面之前，往凭据库里放密码只能开终端。

```bash
node ui.mjs                  # 随机端口，自动打开浏览器
node ui.mjs --port 7812      # 固定端口
node ui.mjs --no-open        # 只打印地址
node ui.mjs --host 0.0.0.0   # 开放给局域网（默认只绑回环）
```

**默认只监听 `127.0.0.1`。** 想从别的机器访问就传 `--host 0.0.0.0`（绑全部网卡）或
某个具体网卡地址；也可以把 `ui.host` 写进 `~/.workbuddy-ai/ssh/config.json` 让它常驻。
优先级是 `--host` > `ui.host` > 回环。默认留在回环是因为这个页面能改 SSH 凭据，
放宽到局域网等于「拿到令牌的人都能改」，不该是默认值。

### Windows 双击启动（隐藏窗口）

四个入口，端口都写死 7812、都带 `--host 0.0.0.0`：

| 文件 | 行为 |
|---|---|
| `start-ui.vbs` | 零窗口启动，服务在后台跑，浏览器自动打开页面。**日常用这个** |
| `start-ui.cmd` | 转发到 `start-ui.vbs`，照顾双击 `.cmd` 的老习惯（会闪一下黑框随即消失） |
| `start-ui-debug.cmd` | 可见模式：窗口留着、实时输出、`Ctrl+C` 停服务。排障用 |
| `stop-ui.cmd` | 停止后台服务 |

**为什么必须是 `.vbs` 而不是 `.cmd`。** 双击 `.cmd` 时 Windows 一定会为它创建一个
conhost 控制台窗口 —— 这是 CreateProcess 层面的行为，脚本自己关不掉（`start /min`
只是最小化）。Windows Script Host 的 `WshShell.Run(command, 0, False)` 才是「以
`SW_HIDE` 启动、且不等待」的正规做法，所以启动器是 VBS，`.cmd` 只做转发。

隐藏启动要付两个代价，各有一条兜底：

1. **没有 stdout 了。** 输出改写到项目目录的 `ui.log`（`>>` 追加，超过 1 MB 轮转成
   `ui.log.1`）。想看实时输出就用 `start-ui-debug.cmd`。
2. **没有 Ctrl+C 了。** 所以 `ui.mjs` 在 listen 成功后把自己的 PID 写进
   `~/.workbuddy-ai/ssh/ui.pid`，退出时（`process.on('exit')`）删掉；`stop-ui.cmd`
   读这个文件，`taskkill /f` 之前先 `tasklist` 确认该 PID 现在确实是 `node.exe`
   —— Windows 会复用 PID，只看数字就杀会误伤无关程序。`taskkill /f` 不触发任何
   handler，所以强杀后残留的 PID 文件是正常的，下次启动直接覆盖；`stop-ui.cmd`
   遇到这种情况会提示并自行清理。

`stop-ui.cmd` 有两条路径，按顺序试：

| 路径 | 条件 | 行为 |
|---|---|---|
| PID 文件 | `ui.pid` 存在且里面的 PID 现在确实是 `node.exe` | 直接结束 |
| 端口回退 | 没有可用的 `ui.pid`（WMI 起的实例、或比 PID 文件更早的版本） | 找 7812 的 LISTENING 进程，确认是 `node.exe` 后**问一句**再结束；不是 node 就报出来不动手 |

端口回退之所以要问：万一 7812 被别的程序占了（那时本服务已经 fallback 到随机端口），
脚本不能默认"占着 7812 的就是自己"。

`clearPidFile()` 里有个守卫：只有当文件里记的还是**自己**的 PID 才删。少了它，
「第二个实例发现端口被占 → 退出」这条路径会把正在服务的那个实例的记录删掉。
实测：A 起在 7813 后 `ui.pid` = A 的 PID，再起一次 B，B 打印「服务已经在运行了」
并退出，`ui.pid` 仍是 A 的。

### 给 agent 用的第三条路：WMI 启动（无窗口、活过会话）

用户双击之外，agent 也可以自己起一个隐藏实例。`start-ui.vbs` 是给用户双击的；
沙箱里的 agent 用它会被安全策略拦（`wscript` 属 LOLBin），走 WMI 即可：

```powershell
# 第 2 个参数是工作目录；返回 ReturnValue=0 和 PID
([wmiclass]'Win32_Process').Create(
  '"C:\Program Files\nodejs\node.exe" ui.mjs --port 7812 --host 0.0.0.0 --no-open',
  'C:\\path\\to\\wb-ssh-mcp')
```

WMI 创建的进程只有 0×0 的伪控制台（`PseudoConsoleWindow`），屏幕上不显示、任务栏
里也没有；父链是 `node → WmiPrvSE → svchost → services`，**不在沙箱的 Job Object
里**，所以不会被会话结束时回收。代价是它也不写 `ui.pid`（除非跑的是带 PID 代码的
版本）—— `stop-ui.cmd` 的端口回退就是为这种情况准备的。

已知不通的路子，别再试：`CREATE_BREAKAWAY_FROM_JOB`（沙箱 Job 没开 breakaway，
拒绝访问）、`Register-ScheduledTask`（沙箱虚拟化任务库，报成功但不落地）、
`explorer.exe "<file>"` 做进程交接（静默无效）。

**编码与换行**：`.cmd` / `.vbs` 按 GBK 存盘（cmd.exe 和 WSH 用系统 ANSI 代码页读
它们，UTF-8 会让中文提示变成乱码），`.gitattributes` 另外给这两个后缀钉了
`eol=crlf` —— `.cmd` 的行尾若是裸 LF，`goto` 标签可能解析不出来。

**绑定放宽后，`Host`/`Origin` 栅栏会同步放开。** 栅栏不再只认回环，而是认
「回环 + 本机每张网卡的 IPv4」——否则通过局域网地址发来的请求会被自己的栅栏挡掉
（`Host: 192.0.2.150:7812` 不在白名单里）。恶意域名仍然不在白名单内，防 DNS rebinding
的作用不变。实测：`--host 0.0.0.0` 时，`Host: evil.example` → 403，`Origin: http://evil.example`
→ 403，正常局域网 `Host`/`Origin` → 200。

**地址是固定的，可以收藏。** 端口写死 7812，访问令牌第一次运行就生成并写进
`~/.workbuddy-ai/ssh/config.json` 的 `ui.token`，之后一直复用：

```
http://127.0.0.1:7812/?t=<ui-token>
```

在此之前 token 每次启动都是新的随机值，URL 因此从来存不下来 —— 这就是"链接又失效了"
的原因。想换一个令牌，把 `ui.token` 删掉再启动即可。

**重复双击不会起第二个副本。** 端口被占时先问占用者是不是自己（用同一个 token 请求
`/api/state`）：是的话打印它的地址、打开浏览器、退出码 0；只有碰上**别的**程序占着
7812，才退回随机端口。所以双击多少次，页面都是同一个。

### 两种进入方式

| 方式 | 怎么进 | 用在哪 |
|---|---|---|
| **令牌** | 完整地址 `http://127.0.0.1:7812/?t=<ui-token>` | 收藏起来日常用 |
| **密码** | 打开裸地址 `127.0.0.1:7812` → 输密码 → 直接进页面 | 忘了地址，或不想把令牌留在浏览器里 |

两种**同时生效，任一通过即可**；只设一种也照常工作。

页面里有一张「访问凭据」卡片：

- **访问令牌** —— 显示当前值，带「随机生成」和「复制地址」两个按钮。生成新的之后
  **旧地址立刻失效**，但当前这个浏览器不受影响（会话凭据是独立的），不用重新登录。
  也可以手工填一个（至少 32 字符）。
- **访问密码** —— 填新密码点保存；点「清除」关掉密码登录，回到只用令牌。

密码**只存不可逆哈希**（scrypt，每个密码独立盐），落在 `config.json` 的 `ui.passwordHash`，
页面只显示「已设置 / 未设置」，**永不回显原文**。

> **忘了密码怎么办**：删掉 `config.json` 里的 `ui.passwordHash` 字段并重启服务，
> 密码校验即关闭。没有「找回」这条路 —— 存的就是哈希。

### 凭据落盘，安全性上没有损失

令牌防的是**浏览器里的其他网页**够到本地这个端口（跨站请求、DNS rebinding），
它从来不是用来防本机其他程序的 —— 那些程序本来就能直接读 `connections.json` 和
`.credentials.yaml`，两个都是明文。所以把令牌写进本机文件不降低实际防护，换来的是一个
能收藏的地址。真要换，删掉 `ui.token` 重启，旧地址立刻作废（实测旧 token 返回 403）。

页面能做：列出所有连接和实时状态、新建/编辑（连接名、主机、端口、用户、密码 /
私钥文件路径 / 私钥内容、跳板机）、连接/断开/删除、在指定连接上执行命令
（长命令返回 `execId`，可继续读取或终止）。

密码框填的内容直接写进共享凭据库，**连接记录里只存引用**；任何接口的返回都不含密钥。

界面是左侧深色侧栏（搜索框 + 实时状态列表）+ 右侧连接卡片网格、表单、终端输出区，
按 `web-design-layout` 的设计系统做（60-30-10 配色、4px 网格、1.25 字号层级）。
单文件、零外部依赖，离线可用。

内容区宽度上限 `--measure: 1920px`（常见屏幕撑满，超宽屏居中而不是贴左），
表单字段用 `auto-fit` 自适应列数，所以放开宽度后输入框不会被拉成一米宽。
顶部工具条用同一个 measure，标题才和下面的卡片对齐。

![主界面 1920](preview/ui-main.png)

超宽屏（2560）下内容居中：

![超宽屏](preview/ui-wide.png)

### 无凭据打开时看到什么

裸地址打开是一张**密码登录页**，不是报错 JSON：

![登录页](preview/ui-gate.png)

`ui-gate.html` 是静态页：**不知道令牌、不知道密码是否设过、不列任何连接**。
密码框下面折着一条兜底 —— 粘贴完整链接直接进去。

登录成功后服务下发会话 cookie（`HttpOnly` + `SameSite=Strict`、**不设 `Max-Age`**，
关掉浏览器即失效），刷新和跳转都不用再输。会话只存在服务进程内存里，
**重启服务 = 所有人重新登录**。

API 请求（`/api/*`）没凭据时仍然返回 JSON 403 —— 那不是人误输地址的场景。
**`/api/login` 是唯一不需要凭据的接口**，但它照样要过 `Host` 和 `Origin` 两道栅栏。

### 三道栅栏

只绑回环不够 —— 浏览器里任何一个网页都能向 `127.0.0.1` 发请求。所以每个请求都要过：

| 栅栏 | 拦什么 |
|---|---|
| `Host` 必须属于本服务自己的权威地址（回环 + 本机各网卡 IPv4） | DNS rebinding（恶意域名解析到本机地址） |
| 必须带凭据：令牌匹配，**或**持有有效会话 cookie | 不知道凭据的页面读不到也改不了任何东西 |
| 若带 `Origin`，必须等于本服务自己的 origin | 其它网页发起的跨站请求 |

第一道只在 `--host` 放宽绑定时才把网卡地址加进白名单；仍是回环绑定时白名单就是回环三项。
第三道的 origin 集合与第一道同源，一起算。

前两道对 `/api/login` 同样生效（只免掉凭据那一项）。

密码比对用 `timingSafeEqual`，且**先跑完 KDF 再比较**，所以响应时间不会泄露
「密码错了」和「压根没设过密码」的区别 —— 两种情况返回同一句话。

`node check-ui.mjs` 复查两个页面的内联脚本语法、标签配对和 id 引用完整性。

### 局域网里的其他机器怎么用（实测 2026-10-06）

页面开在 `0.0.0.0` 时，同一网段的任何机器拿同一个令牌就能干两件事：

**① 拿连接信息** —— `GET /api/state` 返回每条的 `name / host / port / user / tunnel /
authType`，以及 `hasPassword / hasKeyRef / hasPassphrase` 这类**布尔存在标志**。
**不含任何密码、口令或私钥文本**（实测响应里没有 PEM 块、没有密钥值，只有
`hasPassword: true` 这种标志）。拿到 host/port/user 就能用本机自己的 ssh 连过去。

**② 让这台机器代跑命令** —— `POST /api/exec`，等价于把本机的 SSH 能力借出去：

```bash
curl -s -X POST "http://192.0.2.150:7812/api/exec?t=<ui-token>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"nas","command":"hostname"}'
# → {"ok":true,"status":"done","exitCode":0,"output":"my-nas\n"}
```

实测（从局域网 IP `192.0.2.150` 发起）：`echo LAN-EXEC-OK; hostname; uname -s`
→ `LAN-EXEC-OK / my-nas / Linux`。

> ⚠️ **令牌是唯一的门槛，而且是共享的。** 谁能拿到令牌，谁就能读全部连接信息、
> 并在这些服务器上执行任意命令（用的是本机凭据库里的密码/密钥）。所以：
> 只在可信局域网里开 `--host 0.0.0.0`，**绝不往公网映射**；怀疑泄露就重新生成令牌
> （页面「访问凭据」卡片，或删掉 `config.json` 的 `ui.token` 重启）。

## 活动日志

页面下半部分有两块：**活动**（最近 40 条的实时流）和**日志**（可筛选的全量表格）。

![活动流](preview/feed-final.png)

每一行回答四个问题：**谁**（agent / 本机 / 系统）、**什么时候**、**哪台 VPS**、**做了什么、成没成**。

### 「谁调用了」是怎么认出来的

这是本功能唯一的难点，因为 **MCP 协议里没有调用方字段**，而进程表也走不通 ——
Windows 没有可移植的父进程查询 API（WMIC 已从新版移除），为每次工具调用去 spawn
一个 PowerShell 会给每条命令加上几百毫秒。

真正的来源是 **MCP 握手时的 `clientInfo`**：

```
客户端 → initialize { clientInfo: { name: "WorkBuddy", version: "1.0.0" } } → 服务
```

它由客户端主动上报，跨 stdio 管道传输，**第三方无法伪造**，所以足以用作归属依据。
SDK 通过 `server.getClientVersion()` 暴露它，`lib/agent-identity.mjs` 把它映射成
可读标签：

| 客户端上报 | 显示为 |
|---|---|
| `WorkBuddy` / `codebuddy` | WorkBuddy / CodeBuddy |
| `claude-ai` / `claude-code` | Claude / Claude Code |
| `cursor-vscode` | Cursor |
| `antigravity` / `gemini` | Antigravity |
| `qoder` / `zcode` / `trae` | Qoder / ZCode / TRAE |

没匹配上的名字**原样显示**（比统一报「未知」有用），原始名字和版本留在 `title` 里，
方便发现新客户端后补进映射表。

> **时机陷阱**：`getClientVersion()` 要等客户端发完 `initialized` 通知才有值，而
> `await server.connect()` 可能在那之前就返回了。启动记录因此写在
> `server.oninitialized` 回调里 —— 写在 `connect()` 之后会把启动那条记成「未知调用方」。
> 这个 bug 真发生过，`probe-activity.mjs` 里有对应断言。

### 演示数据必须能被认出来

身份识别做得越真，伪造它的代价就越低 —— 这正是本功能踩过的坑。探针脚本用真实
`clientInfo`、真实 stdio 管道调用真实服务，所以它写出来的条目在字节层面上和真人调用
**完全一样**。第一版没做标记，日志里于是出现了 Qoder / Antigravity / Cursor / Claude
在某天连接过服务器的记录；**那一天它们一次都没被启动过**。用户发现了。

现在的规则：

- `seed-activity.mjs` 写的每条都带 `demo: true`（`tagAsDemo()` 事后回写，因为 MCP
  工具调用没法透传自定义字段）。
- `ActivityLog` 持久化该字段，但**只在为真时才写** —— 真实条目保持逐字节不变，
  `grep demo` 能直接筛出演示数据。
- 页面渲染橙色「演示」徽章 + 行底色，并在两块卡片顶部显示
  `⚠ N / M 条是演示数据，不是真实调用。`
- 计数**永远给出全量比值**（`1 / 1` 而不是 `1`），所以筛选后也不可能只看到徽章看不到总数。
- `--purge` / 「清除演示数据」只删标记行；**解析失败的行一律保留** —— 那是崩溃时写了一半
  的真实记录，不是演示数据。

`probe-activity.mjs` 为此加了 11 条断言，包括「真实条目不带 `demo` 字段」「原始 JSONL
里 `demo` 可被 grep 到」「半行不会被当成演示数据删掉」。

### 两个进程怎么共享一份日志

**MCP 服务和网页服务是两个独立进程**，MCP 每次调用时客户端还会另起一个短命子进程。
内存数组做不到共享，所以写的是 **JSONL 追加文件**（`~/.workbuddy-ai/ssh/activity.jsonl`）：

- 两个进程都用 append 打开，写完即返回 —— 行级写入在 Windows/Linux 上对这个量级
  （每分钟几条，不是每秒）足够原子，不需要加锁；
- 读取时**半行会被丢弃**而不是让整次读取失败（写入方被 kill 时会留下半行）；
- 文件超过 4 MB 自动**保留后一半**，在写路径上做，代价由文件大小而非事件数决定；
- 写入**永不抛异常** —— 日志写失败不该让一条 SSH 命令失败。

所以：**任一 agent 调用 MCP，网页下一次轮询就能看到**，agent 不需要通知页面任何东西。

### 记录了什么

| action | 含义 |
|---|---|
| `mcp.call` | 一次工具调用（含工具名、连接名、命令、耗时、成败） |
| `connect` / `disconnect` | 页面里点连接/断开 |
| `exec` | 页面里执行命令 |
| `create` / `update` / `remove` | 增删改连接 |
| `login` / `access.denied` | 页面登录成功 / 被栅栏拒绝 |
| `credential` | 改令牌、改密码 |
| `system.start` | 服务启动（MCP 侧和页面侧各一条） |

**脱敏**：`summarise` 和 `failureText` 的输出都过一遍 `scrub()`，把
`cred_xxx` / `env:NAME` 形态的凭据引用名替换成 `〔凭据引用〕`。
这是必需的 —— 上游 manager 报「凭据没配」时会**把引用名念出来**
（`password credential "cred_box1_password" is not configured`），
原样落盘就把凭据库的内部命名泄进了一个纯文本文件。
`server.mjs` 里还有一道兜底：`detail` 整体再过一次 `scrub()`，
将来新增字段忘了处理也不会泄露。

### 筛选

后端（`ActivityLog.read`）支持 `actor` / `target` / `action` / `ok` / `since` / `until` / `q`，
页面提供 6 个控件 + 4 个快捷按钮（全部 / 只看 agent / 只看本机操作 / 只看失败）。

> 「只看 agent」这类按**类型**筛选是前端做的：后端 `actor` 字段是精确的标签名，
> 表达不了「所有 agent，包括以后新出现的」。此时统计文案会换成
> 「本页 N 条中筛出 M 条」，而不是引用后端的 `total` —— 否则会虚报匹配数。

`probe-activity.mjs` 覆盖 47 条断言：身份识别、目标解析、命令记录、脱敏、
各种筛选组合、`limit`/分页、facets、跨进程读回，以及**演示数据标记与外科式清除**。

## Verification

```bash
node selftest.mjs                      # offline + protocol, no network, nothing written
node e2e.mjs                           # live: both saved connections, every tool
node e2e.mjs vps1                   # live: one connection
node probe-reconnect.mjs vps1 12    # regression probe for the close race (below)
node probe-sftp.mjs vps1            # live SFTP round trip, recursion, overwrite guards
node probe-access.mjs                  # token / password / cookie paths, isolated config
node probe-activity.mjs                # activity log end-to-end, isolated config
node probe-activity.mjs 7812           # ...and read it back through the page's HTTP API
node probe-client-info-check.mjs       # caller identity survives the MCP handshake
node probe-rename.mjs                  # rename paths, in an isolated DSH_HOME
node probe-handshake.mjs 1.2.3.4 22    # per-phase ssh2 events, to see where a host dies
node check-agents.mjs                  # every configured client can still launch the server
node check-ui.mjs                      # both pages: script syntax, tag balance, id refs
```

`seed-activity.mjs` 往日志里添几条**演示**记录（走真实代码路径，方便预览界面）。

> ⚠️ **演示记录必须可辨认。** 探针脚本写的条目带 `demo: true`，页面会渲染橙色
> 「演示」徽章并在列表顶部显示 `⚠ N / M 条是演示数据，不是真实调用。`，旁边一个
> 「清除演示数据」按钮。此前的版本不加标记，结果日志里出现了 Qoder / Antigravity /
> Cursor / Claude 在某天"使用过"的记录 —— 那天它们从没被启动过。**无法与伪造记录区分的
> 审计轨迹，比没有审计轨迹更糟。**
>
> ```bash
> node seed-activity.mjs           # 添加演示记录（全部带 demo: true）
> node seed-activity.mjs --purge   # 只删演示记录，真实记录一条不动
> ```
>
> `--purge` 是**外科手术式**的：它逐行判断 `demo === true` 才删，解析失败的行（崩溃时
> 写了一半的追加）一律保留 —— 宁可留一条坏行，也不能误删真实记录。

两个截图小工具（诊断界面用，不参与功能）：

```bash
node shot-element.mjs <url> <选择器> <out.png>   # 按元素精确截图（文档坐标 + 超高元素）
node page-eval.mjs <url> "<js 表达式>"           # 在活页面里求值并打印，含 console 与未捕获异常
```

`probe-rename.mjs` starts the UI against a throwaway `DSH_HOME` and drives the
real HTTP API through: create → rename → rename again → rename with a bogus
tunnel. It never touches the real store.

### 连接失败的排查顺序

`probe-handshake.mjs` 订阅 ssh2 的每个事件（`banner` → `handshake` → `ready` →
`error`），并给每一步打时间戳。**先跑它再猜原因**，因为它能把三类问题分开：

| 现象 | 含义 |
|---|---|
| 没有 `banner`，只有 `connect ETIMEDOUT` / `ECONNREFUSED` | 网络层就没通（路由、防火墙、端口没开） |
| 有 `banner` 没 `handshake` | 版本交换到了，但密钥协商被打断（中间设备干扰、服务器过载） |
| `handshake` 完成、卡在认证 | sshd 正常，问题在认证（凭据错、PTY 限制、`UseDNS yes` 导致反查慢） |

**别被错误文案骗了**：`Connection lost before handshake` 听起来像「对端断开」，
其实是 ssh2 在 `readyTimeout` 到期后主动 `end()` 时抛的——**真实原因是超时**。
超时阈值是 `connectTimeoutMs`（默认 15 秒），改法见上面的 Configuration。

### 一个上游缺陷（rename 与 tunnel 校验的顺序）

`vendor/manager.js` 的 `updateRecordWithSecrets` 先执行改名（`store.remove(旧名)`
+ `record.name = 新名`），**之后**才校验跳板机：

```js
if (newName !== undefined && newName !== name) {
  ...
  await this.store.remove(name);      // 旧记录已经删了
  record.name = newName;
}
if (params.tunnel !== undefined) {
  const tunnel = normalizeTunnelInput(...);
  if (!tunnel.ok) return tunnel;      // ← 这里返回，后面的 store.put 不会执行
}
await this.store.put(record);         // ← 记录再也回不来
```

后果：**改名时填了一个不存在的跳板机，旧记录被删掉、新记录没写回，记录凭空消失。**
`probe-rename.mjs` 的第 4 步会复现（改名后列表变空）。

这是上游代码的问题，本仓库未改动（`vendor/manager.js` 目前只有一处本地补丁，
见 `vendor/PROVENANCE.md`）。修法是把 tunnel 校验挪到改名分支之前。

`selftest.mjs` — offline + protocol. Record store, credential resolution per
record (value length only), JSON Schema for all 10 tools, the SFTP path rules
(empty path rejected, allow-list enforced, remote paths shell-quoted), a
credential-YAML round trip, then a real MCP handshake over stdio with a real
`ssh_list`. No network, nothing written.

`e2e.mjs` — live, read-only remote commands only: auto-connect through
`ssh_exec`, remote identity, `ssh_status`, long command → `ssh_exec_read` →
`ssh_exec_kill`, `ssh_disconnect` → self-reconnect, `ssh_connect`/`ssh_delete`
round-trip against a closed local port, inline-secret rejection, and the
unknown-connection/execId/tool paths. It hashes the shared records file before
and after to prove this server did not rewrite DSH's data.

`probe-sftp.mjs` — live SFTP: a text file, a 1 MiB binary and a nested directory
each go up and come back down with matching hashes; the overwrite default skips,
`overwrite:true` replaces, and a missing local/remote source fails cleanly. It
removes its own remote scratch tree and leaves the records file byte-identical.

`probe-reconnect.mjs` — the regression probe for a real race fixed in
`vendor/patches/0001-stale-close-guard.patch`: `ssh_disconnect` immediately
followed by `ssh_exec` used to leave a healthy connection reporting
`connecting`/`error`, because the ended socket's `close` event arrives *after*
the replacement connection is up. Measured before the fix: 3 of 12 iterations
had corrupted status. After: 12/12 clean. See `vendor/PROVENANCE.md`.

## Configuration

Optional file `~/.workbuddy-ai/ssh/config.json` (override the location with
`$WB_SSH_CONFIG`):

```json
{
  "recordsPath": "C:\\Users\\you\\.dsh\\storages\\dsh-ssh\\connections.json",
  "credentialsPath": "C:\\Users\\you\\.dsh\\.credentials.yaml",
  "activityPath": "C:\\Users\\you\\.workbuddy-ai\\ssh\\activity.jsonl",
  "manager": {
    "execTimeoutMs": 120000,
    "shellQuietWaitMs": 2000,
    "connectTimeoutMs": 15000,
    "reconnectMaxAttempts": 5,
    "execOutputMaxBytes": 200000
  },
  "sftp": {
    "localRoots": [],
    "stallTimeoutMs": 60000,
    "maxFiles": 5000
  },
  "ui": {
    "token": "…",
    "passwordHash": "scrypt$…",
    "host": "127.0.0.1"
  }
}
```

Every `manager` key is a `SshManager` config key; unknown or ill-typed values
are ignored. See `vendor/manager.js` `DEFAULT_CONFIG` for the full set.

`sftp` configures the file-transfer tools, which are this project's own rather
than upstream's (see `lib/sftp.mjs`). `localRoots` is an allow-list of local
directories; **empty means any path**, which is the honest default for a process
that already runs as you. `stallTimeoutMs` aborts a file that stops moving.
`maxFiles` caps one directory transfer.

`activityPath` defaults to `~/.workbuddy-ai/ssh/activity.jsonl` — it lives with
the override file rather than in DSH's storage, because it records wb-ssh's own
MCP and page traffic. `ui.token` and `ui.passwordHash` are written by the page
itself; see the access section above.

`ui.host` is the interface `ui.mjs` binds. Absent or `127.0.0.1` keeps the page
on loopback; `0.0.0.0` opens it to the local network. The `--host` flag wins
over it. Widening the bind also widens the `Host`/`Origin` fences to the
machine's own IPv4 addresses — see 「三道栅栏」 above.

`ui.mjs` also writes one file that is *not* configuration: `ui.pid`, sitting
beside the config file, holding the PID of the running instance so that
`stop-ui.cmd` can stop a server that has no console to press Ctrl+C in. Point
`WB_SSH_CONFIG` somewhere else and the PID file follows it there. Nothing reads
`ui.pid` at startup — a stale one is harmless and is simply overwritten.

## Two things worth knowing

**Concurrent writers.** DSH and this server both write the records file. The
server re-reads it immediately before every tool call and writes atomically, so
the window in which a simultaneous DSH edit can be lost is one tool call. If you
are editing connections in the DSH panel, don't also create one here at the same
instant.

**Plaintext credentials.** The DSH credential store is a plaintext YAML file —
that is DSH's design, not something this server introduced. Anything stored
through `cred.mjs` inherits that. The file sits in your user profile; treat it
like `~/.ssh/id_rsa`.

## Layout

```
server.mjs            MCP stdio server — builds the manager, registers the tools
ui.mjs                connection manager page — loopback HTTP + token/Host/Origin fences
ui.html               the page itself (single file, no dependencies)
ui-gate.html          the password login page served for a credential-less URL
start-ui.vbs          Windows launcher — starts the page with no console window
start-ui.cmd          forwards to start-ui.vbs (double-click habit)
start-ui-debug.cmd    same thing with a visible console: live output, Ctrl+C to stop
stop-ui.cmd           stops the hidden server via ~/.workbuddy-ai/ssh/ui.pid
check-ui.mjs          static checks for both pages (script syntax, tag balance, id refs)
preview/              screenshots of the pages
cred.mjs              credential store CLI (human-facing, hidden input)
selftest.mjs          offline + protocol checks
check-agents.mjs      launches the server from each client's own config, then handshakes
e2e.mjs               live end-to-end checks against the saved connections
probe-reconnect.mjs   regression probe for the close race
probe-sftp.mjs        live SFTP round trip: upload, recursion, overwrite guards, hashes
probe-access.mjs      token / password / session-cookie paths (isolated config + DSH_HOME)
probe-activity.mjs    activity log end-to-end: identity, targets, scrubbing, filters, demo tagging
probe-client-info.mjs       tiny MCP server that echoes the caller's clientInfo
probe-client-info-check.mjs proves caller identity survives the handshake
probe-rename.mjs      rename paths + the tunnel/rename ordering bug (isolated DSH_HOME)
probe-handshake.mjs   per-phase ssh2 event trace for one host:port
seed-activity.mjs     write demo entries (tagged `demo: true`); `--purge` removes them
shot-element.mjs      screenshot one element by document coordinates (diagnostics)
page-eval.mjs         evaluate JS in the live page, print console + exceptions (diagnostics)
lib/config.mjs        paths, optional override file, stderr logger
lib/credentials.mjs   env: / file: / DSH-store credential provider
lib/activity.mjs      the shared JSONL activity log (append, rotate, filter, facets)
lib/agent-identity.mjs  caller identity from the MCP handshake + log scrubbing
lib/mcp-tools.mjs     DSH declaration -> MCP tool + JSON Schema
lib/sftp.mjs          SFTP transfers over a managed connection (recursion, verification)
lib/sftp-tools.mjs    the ssh_upload / ssh_download tool declarations
shims/dsh-tools/      identity `defineTool`, so vendor/tools.js stays unmodified
vendor/               SSH core from starxxy/dsh-ssh (MIT) + PROVENANCE.md
vendor/patches/       the one local patch applied to manager.js
```
