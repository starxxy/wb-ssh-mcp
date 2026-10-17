/**
 * Minimal local stand-in for `@deepseek-ai/dsh-tools`.
 *
 * The vendored `vendor/tools.js` (from @jmcc-guo/dsh-ssh) imports exactly one
 * symbol from that package: `defineTool`. In DSH it validates a tool
 * declaration and hands it to the host registry. Here the declaration object
 * is used as-is and translated into an MCP tool by `lib/mcp-tools.mjs`, so the
 * identity function is all that is required — which is what keeps
 * `vendor/tools.js` an unmodified copy of upstream.
 *
 * @param {object} declaration - {name, description, parameters, output, execute}
 * @returns {object} the same declaration.
 */
export function defineTool(declaration) {
  if (declaration === null || typeof declaration !== 'object') {
    throw new TypeError('defineTool expects a declaration object');
  }
  if (typeof declaration.name !== 'string' || declaration.name === '') {
    throw new TypeError('defineTool: `name` is required');
  }
  if (typeof declaration.execute !== 'function') {
    throw new TypeError(`defineTool(${declaration.name}): \`execute\` must be a function`);
  }
  return declaration;
}

export default { defineTool };
