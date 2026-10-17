/**
 * Calling-agent identification.
 *
 * WHY NOT THE PROCESS TABLE
 * -------------------------
 * The obvious way to answer "which agent called this tool" is to walk up from
 * `process.pid` and read the ancestor's executable name. On Windows that is a
 * dead end: there is no Win32 API for parent lookup, WMIC is removed from
 * current builds, and spawning PowerShell per tool call to fake it would add
 * hundreds of milliseconds to every command — and the dev sandbox refuses the
 * spawn outright (`EBUSY`), so it could not even be tested.
 *
 * WHAT IS USED INSTEAD
 * --------------------
 * Every MCP client opens with an `initialize` request carrying a `clientInfo`
 * block — `{name, version}` naming the product. The SDK stores it and exposes
 * it as `server.getClientVersion()`. That value crosses the stdio pipe between
 * the client and this process, so it cannot be set by a third party and is a
 * trustworthy attribution for "which agent is talking to me". Verified against
 * real clients in `probe-client-info-check.mjs`.
 *
 * The name arrives in whatever spelling each vendor chose (`WorkBuddy`,
 * `claude-ai`, `cursor-vscode`, …), so it is mapped onto a friendly label
 * through PATTERNS. Unrecognised names pass through verbatim — better to show
 * `some-new-client` than to claim it is "unknown".
 *
 * @module wb-ssh-mcp/lib/agent-identity
 */

/** Substring -> display label, checked in order.
 *
 * Keep these specific: `claude-code` must win over `claude`, so it comes first.
 *
 * The first entries are this project's own diagnostic clients. They are real
 * MCP clients that really do call the tools, so their calls belong in the log —
 * but labelling them "wb-ssh-selftest" implies an agent did something it did
 * not. Naming them explicitly keeps the timeline honest.
 */
const PATTERNS = [
  ['wb-ssh-check', '自检探针'],
  ['wb-ssh-selftest', '自检探针'],
  ['wb-ssh-probe', '自检探针'],
  ['wb-ssh-activity', '自检探针'],
  ['wb-ssh-', '本机诊断'],
  ['workbuddy', 'WorkBuddy'],
  ['codebuddy', 'CodeBuddy'],
  ['claude-code', 'Claude Code'],
  ['claude-ai', 'Claude'],
  ['claude', 'Claude'],
  ['antigravity', 'Antigravity'],
  ['gemini', 'Antigravity'],
  ['cursor', 'Cursor'],
  ['codex', 'Codex'],
  ['qoder', 'Qoder'],
  ['zcode', 'ZCode'],
  ['trae', 'TRAE'],
  ['windsurf', 'Windsurf'],
  ['cline', 'Cline'],
  ['roo', 'Roo Code'],
  ['copilot', 'Copilot'],
  ['vscode', 'VS Code'],
  ['deepseek', 'DeepSeek Harness'],
  ['dsh', 'DeepSeek Harness'],
];

/**
 * Turn the raw `clientInfo` into the actor block the activity log stores.
 *
 * @param clientInfo - `{name, version}` as reported at handshake, or undefined.
 * @returns {{kind: 'agent', label: string, detail: string}}
 */
export function identifyAgent(clientInfo) {
  const rawName = typeof clientInfo?.name === 'string' ? clientInfo.name.trim() : '';
  const version = typeof clientInfo?.version === 'string' ? clientInfo.version.trim() : '';

  if (rawName === '') {
    return { kind: 'agent', label: '未知调用方', detail: version };
  }

  const lower = rawName.toLowerCase();
  const match = PATTERNS.find(([needle]) => lower.includes(needle));
  const label = match !== undefined ? match[1] : rawName.slice(0, 60);

  // Keep the raw name visible when it differs from the label, so an unexpected
  // client can be recognised and added to PATTERNS instead of being hidden.
  const detail = label === rawName
    ? version
    : (version === '' ? rawName : `${rawName} ${version}`);

  return { kind: 'agent', label, detail };
}

/**
 * Derive the target connection from a tool's arguments.
 *
 * `ssh_connect` may create a connection (host/port/user inline) or reuse one
 * (`connection`), and `ssh_exec` addresses one by name — so the record store is
 * consulted when the arguments alone are not enough.
 *
 * @param toolName - the MCP tool being called.
 * @param args - its arguments.
 * @param lookup - `(name) => record|undefined` from the manager's store.
 * @returns {{name: string, host: string, port: number|null, user: string}}
 */
export function targetOf(toolName, args, lookup) {
  const connection = typeof args?.connection === 'string' ? args.connection : '';
  const name = typeof args?.name === 'string' ? args.name : '';
  const record = connection !== '' ? lookup?.(connection) : undefined;

  if (record !== undefined) {
    return { name: record.name, host: record.host, port: record.port, user: record.user };
  }

  // A new connection being established: host/user are inline.
  if (toolName === 'ssh_connect' && (name !== '' || args?.host !== undefined)) {
    return {
      name: name !== '' ? name : connection,
      host: typeof args?.host === 'string' ? args.host : '',
      port: Number.isFinite(Number(args?.port)) ? Number(args.port) : 22,
      user: typeof args?.user === 'string' ? args.user : '',
    };
  }

  // ssh_list / status with no argument addresses everything.
  if (connection === '' && name === '') return { name: '', host: '', port: null, user: '' };

  return { name: connection !== '' ? connection : name, host: '', port: null, user: '' };
}

/**
 * One-line, secret-free summary of what a tool call did, for the log.
 *
 * Deliberately narrow: tool arguments may contain `auth.passwordRef` and
 * similar, and the log is plain text on disk that the page renders. Only the
 * connection name and, for commands, the command line are echoed — a command
 * is something the caller already chose to send and is the single most useful
 * thing to see in an audit trail.
 *
 * @param toolName - the MCP tool being called.
 * @param args - its arguments.
 * @param result - the tool's return value, when it has one.
 * @returns a short human-readable string.
 */
export function summarise(toolName, args, result) {
  // Every branch is scrubbed: a command line is caller-supplied text and could
  // mention a credential name, and result strings come from the manager.
  return scrub(rawSummary(toolName, args, result));
}

/** The unscrubbed form; `summarise` is the only caller. */
function rawSummary(toolName, args, result) {
  switch (toolName) {
    case 'ssh_exec':
      return typeof args?.command === 'string' ? args.command.slice(0, 300) : '';
    case 'ssh_upload':
    case 'ssh_download': {
      // Record the direction, because "local → remote" and "remote → local"
      // mean opposite things and an audit trail that cannot tell them apart is
      // worse than useless. The local path is the server process's own
      // filesystem, so it belongs in the log next to the remote one.
      const from = toolName === 'ssh_upload' ? args?.local : args?.remote;
      const to = toolName === 'ssh_upload' ? args?.remote : args?.local;
      if (typeof from !== 'string' || typeof to !== 'string') return '';
      return `${from} → ${to}${args?.overwrite === true ? ' (overwrite)' : ''}`;
    }
    case 'ssh_connect': {
      const who = typeof args?.user === 'string' ? args.user : '';
      const host = typeof args?.host === 'string' ? args.host : '';
      if (host !== '') return `${who}@${host}${args?.port ? `:${args.port}` : ''}`;
      return typeof args?.connection === 'string' ? `复用 ${args.connection}` : '';
    }
    case 'ssh_disconnect':
    case 'ssh_delete':
      return typeof args?.connection === 'string' ? args.connection : '';
    case 'ssh_exec_read':
    case 'ssh_exec_kill':
      return typeof args?.execId === 'string' ? args.execId : '';
    case 'ssh_list':
      return result?.connections !== undefined ? `共 ${result.connections.length} 条连接` : '';
    case 'ssh_status':
      return result?.status !== undefined ? String(result.status) : '';
    default:
      return '';
  }
}

/**
 * Whether a tool's result counts as success.
 *
 * `ssh_connect` returning `ok:false` is a normal payload describing a failed
 * connection; `ssh_list` has no `ok` field at all. Both are handled here so the
 * log's ok/fail dot reflects reality instead of "undefined".
 *
 * @param result - the tool's return value.
 * @returns true / false / null when the tool reports no outcome.
 */
export function outcomeOf(result) {
  if (result === null || typeof result !== 'object') return null;
  if (typeof result.ok === 'boolean') return result.ok;
  if (typeof result.error === 'string' && result.error !== '') return false;
  return null;
}

/** Human-readable error line for a failed tool call, secrets already absent. */
export function failureText(result, thrown) {
  if (thrown !== undefined) {
    return scrub(thrown instanceof Error ? thrown.message : String(thrown));
  }
  if (result === null || typeof result !== 'object') {
    return typeof result === 'string' ? scrub(result) : '';
  }
  return scrub(String(result.message ?? result.error ?? ''));
}

/**
 * Strip credential-reference names out of text that is about to be persisted.
 *
 * The upstream manager explains a missing credential by naming it — e.g.
 * `password credential "cred_box1_password" is not configured`. That name is
 * not the secret, but it discloses the credential store's internal naming and
 * puts a stable identifier into a plain-text file, so it is replaced with a
 * placeholder before the line reaches disk.
 *
 * Also catches the `env:NAME` form, which names a real environment variable.
 *
 * @param text - any string bound for the log.
 * @returns the same text with reference names masked.
 */
export function scrub(text) {
  return String(text)
    .replace(/"[^"]*cred_[^"]*"/gi, '"〔凭据引用〕"')
    .replace(/\bcred_[A-Za-z0-9_]+/g, '〔凭据引用〕')
    .replace(/\benv:[A-Za-z_][A-Za-z0-9_]*/g, 'env:〔变量〕');
}

export default { identifyAgent, targetOf, summarise, outcomeOf, failureText, scrub };
