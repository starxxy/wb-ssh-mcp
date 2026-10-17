# wb-ssh-mcp — SSH over MCP

把一套成熟的 SSH 连接管理器封装成 [MCP](https://modelcontextprotocol.io)（Model Context Protocol）服务器：
任何 MCP 客户端接入一次，就拥有同一组 SSH 工具 —— 远程执行、长命令轮询、SFTP 上传下载，
而**密码和私钥永远不进入模型的上下文**。

- 🧩 **一次配置，多端共用** —— WorkBuddy、Codex、Claude Code、Cursor、VS Code、Qoder、CodeBuddy、TRAE、ZCode……每个客户端只需要一条 stdio 配置。
- 🔐 **凭据零暴露** —— 密码/私钥只存本地凭据库，工具参数只收「引用名」（`passwordRef` / `privateKeyPath` / `passphraseRef`）。
- 🗄️ **与 DeepSeek Harness 数据互通** —— 连接清单与凭据库和 DSH 的 SSH 管理器是同一份文件，两边录入的连接即时互认。
- ⏱️ **长命令不阻塞** —— 超时命令返回 `execId`，用 `ssh_exec_read` 轮询增量输出、`ssh_exec_kill` 终止。
- 🖥️ **自带连接管理页面** —— 浏览器里增删改连接、看活动日志；可选开放给局域网，让同一网段的机器（比如 Mac）借用这台机器的 SSH 能力。

> 完整技术细节（SFTP 语义、活动日志、三道安全栅栏、配置项、踩坑记录）见 [DETAILS.md](DETAILS.md)。

---

## 一、它解决什么问题

给 AI 客户端配 SSH 通常有两条烂路：要么把密码写进工具参数（会原样记进会话日志），要么每个客户端各配一套连接。
wb-ssh-mcp 把这两件事都收掉：

| 传统做法 | wb-ssh-mcp |
|---|---|
| 密码写进命令/参数，进会话日志 | 凭据存本地 YAML，工具只收引用名 |
| 每个客户端各配一套连接 | 一份连接清单，所有客户端（含 DSH）共用 |
| 长命令卡住对话 | `execId` + 轮询 + 主动终止 |
| 没有审计 | 活动日志记录每次调用与调用方身份 |

## 二、环境要求

- Node.js **≥ 18**（用绝对路径指 node，别依赖 PATH —— 客户端拉起子进程时的环境不一定和你终端一样）
- git（拉取代码）

## 三、安装

```bash
git clone https://github.com/starxxy/wb-ssh-mcp.git
cd wb-ssh-mcp
npm install
```

## 四、录入第一条连接

两种方式任选：

**方式 A：连接管理页面（推荐）**

```bash
node ui.mjs          # 随机端口，只监听本机
node ui.mjs --port 7812   # 固定端口
```

浏览器打开页面即可增删改连接、登记凭据引用、查看活动日志。Windows 下还有免开窗口的入口：
双击 `start-ui.vbs`（后台启动并自动打开页面）、`stop-ui.cmd`（停止）、`start-ui-debug.cmd`（可见窗口排障），
这几个入口固定 7812 端口。

**方式 B：命令行**

```bash
node cred.mjs set <凭据名>        # 交互式录入密码/私钥，输入隐藏，落在本地凭据库
```

然后在连接清单（见 §七 数据位置）里加一条记录，认证字段只写引用名：

```json
{
  "name": "my-vps",
  "host": "203.0.113.10",
  "port": 22,
  "user": "root",
  "auth": { "passwordRef": "MY_VPS_PASSWORD" }
}
```

支持跳板机（`tunnel` 字段指向另一条连接）、私钥文件路径、带口令私钥。

## 五、接入你的 MCP 客户端

MCP 是**客户端各自拉起一个 stdio 子进程**，所以每个客户端都要在自己配置里写一条。三要素固定
（node 用绝对路径；路径分隔符按你客户端的 JSON 转义规则写）：

```json
"wb-ssh": {
  "command": "C:\\path\\to\\node.exe",
  "args": ["C:\\path\\to\\wb-ssh-mcp\\server.mjs"]
}
```

差别只在配置文件位置和顶层字段名（最容易写错的地方）：

| 客户端 | 配置文件 | 顶层字段 |
|---|---|---|
| WorkBuddy / WorkBuddy AI | `~/.workbuddy-ai/mcp.json` | `mcpServers` |
| Antigravity（2.0 / IDE / CLI 共用） | `~/.gemini/config/mcp_config.json` | `mcpServers` |
| Claude Code | `~/.claude.json` | `mcpServers` |
| VS Code + Copilot Chat | `%APPDATA%/Code/User/mcp.json` | `servers` + `"type": "stdio"` |
| Qoder | `~/.qoder/mcp.json` | `mcpServers` |
| CodeBuddy | `~/.codebuddy/mcp.json` | `mcpServers` |
| TRAE SOLO CN | `%APPDATA%/TRAE SOLO CN/User/mcp.json` | `mcpServers` |
| ZCode | `~/.zcode/cli/config.json` | `mcp.servers`（**两层嵌套**） |
| Codex | `~/.codex/config.toml` | `[mcp_servers.wb-ssh]` 表 |

**一行验证**（真去 spawn 服务、走完 MCP 握手和 `tools/list`，不是只校验 JSON）：

```bash
node check-agents.mjs
```

## 六、工具（10 个）

| 工具 | 用途 |
|---|---|
| `ssh_list` | 列出所有已存连接及实时状态。**先调这个。** |
| `ssh_connect` | 建立/重建连接，可指定跳板机 |
| `ssh_exec` | 执行命令；长命令返回 `execId` 供轮询 |
| `ssh_exec_read` | 读取运行中命令的增量输出 |
| `ssh_exec_kill` | 按 `execId` 杀掉运行中的命令 |
| `ssh_status` | 单条连接的实时状态 |
| `ssh_disconnect` | 主动断开（不自动重连） |
| `ssh_delete` | 删除已存连接 |
| `ssh_upload` | **SFTP** 上传本机文件/目录（递归、覆盖校验、卡死检测） |
| `ssh_download` | **SFTP** 下载远端文件/目录（递归、覆盖校验、卡死检测） |

> ⚠️ **密钥绝不进工具参数。** `ssh_connect` 只接受引用：`passwordRef` / `privateKeyPath` /
> `privateKeyRef` / `passphraseRef`。存密码用 `node cred.mjs set <名字>`（输入隐藏）。

## 七、数据与配置位置

| 内容 | 路径 | 说明 |
|---|---|---|
| 连接清单 | `$DSH_HOME/storages/dsh-ssh/connections.json` | `$DSH_HOME` 缺省 `~/.dsh` |
| 凭据库 | `$DSH_HOME/.credentials.yaml` | 值只存这里；连接清单里只有引用名 |
| 可选覆盖配置 | `~/.workbuddy-ai/ssh/config.json`（或 `$WB_SSH_CONFIG`） | 可改上述路径、SFTP 限制、UI 令牌等 |
| 活动日志 | `~/.workbuddy-ai/ssh/activity.jsonl` | 每次调用一条，含调用方识别 |

> 与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 SSH 管理器共用前两个文件：
> 在 DSH 面板里存的连接，这里直接能用，反之亦然。

## 八、自测

```bash
node selftest.mjs       # 离线检查 + 真实 spawn 服务走 MCP 握手 + ssh_list
node check-agents.mjs   # 逐个检查本机已配置的 MCP 客户端能否连通
```

`selftest.mjs` 会列出每条连接的凭据解析结果；某条连接提示凭据未配置属于正常现象
（引用名还没在凭据库里登记），把对应 ref 录入凭据库即可。

## 九、局域网模式（可选）

```bash
node ui.mjs --port 7812 --host 0.0.0.0
```

开放后，同一网段的机器**不需要装任何东西**，`curl` 即可借用这台机器的 SSH 能力：

```bash
# 列出连接（响应不含任何密码）
curl -s "http://192.0.2.150:7812/api/state?t=<ui-token>"

# 让这台机器代跑命令，结果回传
curl -s -X POST "http://192.0.2.150:7812/api/exec?t=<ui-token>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-vps","command":"hostname"}'
# → {"ok":true,"status":"done","exitCode":0,"output":"my-nas\n",...}
```

长命令返回 `status:"running"` 和 `execId`，用 `POST /api/execRead`（body `{"execId":"…"}`）取增量输出。

### ⚠️ 安全边界

`/api/state` 和 `/api/exec` **只认令牌，而令牌是共享的**。局域网里任何拿到它的人都能读连接列表、
并在这些服务器上执行任意命令（用的是这台机器凭据库里的密码/密钥）。所以只在可信局域网里开
`--host 0.0.0.0`，**绝不往公网映射**；怀疑泄露就重新生成令牌（页面「访问凭据」卡片，或删掉
配置文件里的 `ui.token` 重启）。

## 十、目录结构

```
wb-ssh-mcp/
├── server.mjs          # MCP 入口（stdio）：工具注册、握手、调用分发
├── ui.mjs / ui.html    # 连接管理页面（本机/局域网 HTTP 服务）
├── ui-gate.html        # 页面访问令牌门
├── cred.mjs            # 凭据录入 CLI（交互式，输入隐藏）
├── lib/                # 本项目自身实现：配置、凭据、SFTP、活动日志、调用方识别、MCP 工具封装
├── vendor/             # 上游 SSH 管理器核心（byte-for-byte + 一份本地补丁，出处与校验见 PROVENANCE.md）
├── shims/              # 供 vendor 核心引用的最小接口垫片
├── probe-*.mjs         # 各协议/重连/SFTP 行为探针（开发用）
├── selftest.mjs        # 离线 + 协议自测
├── check-agents.mjs    # 检查本机各 MCP 客户端的接入配置
├── e2e.mjs             # 端到端演练
├── start-ui.vbs        # Windows：无窗口启动页面（推荐双击入口）
├── start-ui.cmd        # Windows：同上（会闪一下黑框）
├── start-ui-debug.cmd  # Windows：可见窗口排障
└── stop-ui.cmd         # Windows：停止后台页面服务
```

`vendor/` 的三个文件来自 [`starxxy/dsh-ssh`](https://github.com/starxxy/dsh-ssh)
（[`jmcc-guo/dsh-ssh`](https://github.com/jmcc-guo/dsh-ssh) 的兼容性修复 fork），
逐字节校验与本地补丁记录见 [vendor/PROVENANCE.md](vendor/PROVENANCE.md)。

## 十一、已知限制

- 单实例单令牌：管理页面的访问令牌是共享的（见 §九 安全边界）。
- Windows 启动脚本（`.cmd` / `.vbs`）按系统 ANSI 代码页解析，脚本内的中文注释在非中文系统上可能显示乱码（不影响功能）。
- SFTP 大文件传输受 `stallTimeoutMs` 等配置约束，默认值与调整方法见 DETAILS.md。

更多细节 —— SFTP 的覆盖/校验/超时语义、活动日志与「谁调用了」的识别、三道安全栅栏、
全部配置项、验证清单 —— 见 **[DETAILS.md](DETAILS.md)**。

## 许可证

本项目**未附带开源许可证**：保留所有权利，未经许可请勿复制、分发或二次开发。
`vendor/` 目录内的第三方组件遵循其自带的 MIT 许可（见 [vendor/LICENSE](vendor/LICENSE) 与
[vendor/PROVENANCE.md](vendor/PROVENANCE.md)）。
