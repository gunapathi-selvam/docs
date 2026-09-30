// Browser client for /api/mcp, plus the MCP-to-Claude tool schema mapping.
// The pure mapping functions (canBeStrict, toClaudeTools) are exported for
// unit tests and have no I/O or DOM dependencies. SPEC §5

// ---------------------------------------------------------------- schema mapping

// SPEC §5.2 — determine whether an MCP inputSchema can use strict: true.
// Returns { ok: true } or { ok: false, reason: string }.
export function canBeStrict(schema) {
  if (!schema || schema.type !== 'object') {
    return { ok: false, reason: 'type must be "object"' };
  }
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    return { ok: false, reason: 'properties must be a non-empty object' };
  }
  if (schema.additionalProperties === true) {
    return { ok: false, reason: 'additionalProperties: true cannot be strict' };
  }
  if ('required' in schema && !Array.isArray(schema.required)) {
    return { ok: false, reason: 'required must be an array' };
  }
  for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) {
    if (key in schema) return { ok: false, reason: `unsupported combinator: ${key}` };
  }
  for (const key of ['$ref', '$defs', 'definitions']) {
    if (key in schema) return { ok: false, reason: `unsupported reference: ${key}` };
  }
  for (const key of ['patternProperties', 'propertyNames']) {
    if (key in schema) return { ok: false, reason: `dynamic key pattern not allowed for strict: ${key}` };
  }
  // Recurse into property schemas.
  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    if (propSchema && typeof propSchema === 'object') {
      const nested = canBeStrict(propSchema);
      // Only object-typed properties need to recurse strictly;
      // primitive property schemas are allowed to omit type.
      if (propSchema.type === 'object') {
        if (!nested.ok) return { ok: false, reason: `property "${propName}": ${nested.reason}` };
      }
    }
  }
  return { ok: true };
}

// SPEC §5.2 — two omissions are repairable, one explicit is not.
function repairSchema(schema) {
  const repairs = [];
  const s = { ...schema };
  if (!('additionalProperties' in s)) {
    s.additionalProperties = false;
    repairs.push('additionalProperties');
  }
  if (!('required' in s)) {
    s.required = [];
    repairs.push('required');
  }
  return { schema: s, repairs };
}

// SPEC §5.1 — map a single MCP tool definition to a Claude tool definition.
export function mcpToolToClaudeTool(mcpTool) {
  const nameOk = /^[a-zA-Z0-9_-]{1,64}$/.test(mcpTool.name ?? '');
  if (!nameOk) {
    return {
      dropped: true,
      reason: `name "${mcpTool.name}" does not match ^[a-zA-Z0-9_-]{1,64}$`,
      name: mcpTool.name,
    };
  }

  const { schema: repairedSchema, repairs } = repairSchema(mcpTool.inputSchema ?? {});
  const strictCheck = canBeStrict(repairedSchema);

  const claudeTool = {
    name: mcpTool.name,
    description: mcpTool.description ?? '',
    input_schema: repairedSchema,
  };

  if (strictCheck.ok) {
    claudeTool.strict = true;
    if (repairs.length > 0) claudeTool.repairs = repairs;
  } else {
    claudeTool.degraded = true;
    claudeTool.degradedReason = strictCheck.reason;
    if (repairs.length > 0) claudeTool.repairs = repairs;
  }

  return claudeTool;
}

// SPEC §5.4 — sort by name for byte-stable caching, drop invalid names.
export function toClaudeTools(mcpTools) {
  return mcpTools
    .map(mcpToolToClaudeTool)
    .filter((t) => !t.dropped)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- browser client

export class McpClient {
  constructor(options = {}) {
    this._base = options.base ?? '';
  }

  // POST one JSON-RPC message to /api/mcp, return result or throw on RPC error.
  async call(method, params) {
    const res = await fetch(`${this._base}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status));
      throw new Error(`MCP bridge error ${res.status}: ${text}`);
    }
    const msg = await res.json();
    if (msg.error) throw Object.assign(new Error(msg.error.message), { code: msg.error.code });
    return msg.result;
  }

  // The initialize handshake is performed by server.js when the subprocess is
  // spawned — by the time the browser reaches this, the server has already
  // completed the handshake. This method is a no-op from the browser side.
  async initialize() {
    // no-op: server.js handles initialize + notifications/initialized on spawn
  }

  async listTools() {
    const result = await this.call('tools/list', undefined);
    return result?.tools ?? [];
  }

  async callTool(name, args) {
    const result = await this.call('tools/call', { name, arguments: args });
    return { content: result?.content ?? [], isError: result?.isError ?? false };
  }
}
