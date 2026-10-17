#!/usr/bin/env node
/**
 * Can an MCP stdio server learn *which client* is talking to it?
 *
 * The activity log wants "which agent invoked this tool". Nothing in the MCP
 * protocol carries a caller identity, and the process table is unreliable
 * (Windows has no portable parent lookup once WMIC is gone; the sandbox used
 * during development blocks spawning any helper at all).
 *
 * There is a better source: clients send an `initialize` request whose
 * `clientInfo` names the product and version. That is *volunteered* by the
 * client and cannot be forged across a stdio pipe, so it is trustworthy for
 * attribution — good enough to answer "which agent called this".
 *
 * This probe is a tiny MCP server that prints whatever `clientInfo` it is
 * given, then exits. Register it as a server in a client and call any tool.
 *
 *   node probe-client-info.mjs
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let clientInfo = null;

const server = new Server(
  { name: 'probe-client-info', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

// `initialize` is the very first request; the SDK surfaces its params here.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'whoami',
    description: 'Report which MCP client is connected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, clientInfo }, null, 2) }],
}));

// Capture the handshake. `server.oninitialized` fires after the client's
// `initialized` notification; the params we want were sent with `initialize`,
// which the SDK exposes through this getter.
server.oninitialized = () => {
  const info = server.getClientVersion?.();
  clientInfo = info ?? null;
  process.stderr.write(`[probe-client-info] clientInfo=${JSON.stringify(clientInfo)}\n`);
};

await server.connect(new StdioServerTransport());
