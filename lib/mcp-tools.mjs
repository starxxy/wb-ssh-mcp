/**
 * Adapter from DSH tool declarations to MCP tools.
 *
 * `vendor/tools.js` is an unmodified copy of the upstream dsh-ssh tool set. Its
 * declarations use the DSH parameter shorthand:
 *
 *   parameters: {
 *     connection: { type: 'string', required: true, description: '...' },
 *     auth: { type: 'object', properties: { ... }, additionalProperties: false },
 *   }
 *
 * where a nested object literal is already JSON Schema. MCP wants a real JSON
 * Schema object, so the shorthand is converted here — one level of `required`
 * flags is hoisted into the schema's `required` array and everything else is
 * passed through untouched.
 *
 * The declaration's `output.render` already returns MCP content blocks
 * (`[{type:'text', text}]`), so results need no translation at all.
 *
 * @module wb-ssh-mcp/mcp-tools
 */

/**
 * Convert a DSH `parameters` shorthand into a JSON Schema object.
 * @param parameters - the declaration's `parameters` value.
 * @returns JSON Schema for the tool input.
 */
export function parametersToJsonSchema(parameters) {
  const source = parameters !== null && typeof parameters === 'object' ? parameters : {};
  const properties = {};
  const required = [];

  for (const [key, spec] of Object.entries(source)) {
    if (spec === null || typeof spec !== 'object') continue;
    const { required: isRequired, ...schema } = spec;
    properties[key] = schema;
    if (isRequired === true) required.push(key);
  }

  const jsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) jsonSchema.required = required;
  return jsonSchema;
}

/**
 * Project one DSH tool declaration onto the MCP `tools/list` shape.
 * @param declaration - a tool from `createTools()`.
 * @returns {{name: string, description: string, inputSchema: object}}
 */
export function toMcpTool(declaration) {
  return {
    name: declaration.name,
    description: declaration.description,
    inputSchema: parametersToJsonSchema(declaration.parameters),
  };
}

/**
 * Execute one tool and normalise the outcome into an MCP result.
 *
 * `isError` is reserved for a thrown handler: a tool that ran and reported
 * `ok: false` (auth failure, busy connection, missing record) is a normal,
 * readable payload and is returned as content so the model can act on it.
 *
 * @param declaration - the tool declaration.
 * @param args - arguments supplied by the MCP client.
 * @param extra - MCP request extras; `extra.signal` aborts in-flight work.
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function callTool(declaration, args, extra) {
  const exec = { signal: extra?.signal };
  try {
    const result = await declaration.execute(args ?? {}, exec);
    const render = declaration.output?.render;
    if (typeof render === 'function') {
      const content = render(args ?? {}, result);
      if (Array.isArray(content) && content.length > 0) return { content };
    }
    return { content: [{ type: 'text', text: stringify(result) }] };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { content: [{ type: 'text', text: `${declaration.name} failed — ${message}` }], isError: true };
  }
}

/** JSON-encode a value, degrading to a string when it cannot be serialised. */
function stringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default { parametersToJsonSchema, toMcpTool, callTool };
