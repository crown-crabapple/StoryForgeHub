// The MCP JSON-RPC handler (M08 MCP service), hand-written: initialize, ping, tools/list and tools/call over already-parsed JSON values. The transport (POST /mcp or the
// stdio loop) owns framing and authentication and hands us `call`, which runs one request against /api/v1 as the token's plugin, so plugin-policy.mjs decides every call.
// A tool failure is a normal result with isError: true (the model can read it); only protocol mistakes are JSON-RPC errors. Pure logic: no network, no filesystem.
import { NOT_OFFERED, TOOLS, ToolError } from './tools.mjs';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = 'This server reads a StoryForge library: books, chapters, scenes and codex entries. The save and propose tools never change a scene or entry; they create a suggestion that the author accepts or rejects in StoryForge. The canvas tools (only with the canvas permission) change canvas files, which are planning boards, never prose. A book is given as its slug or its id.';

const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rpcError = (/** @type {unknown} */ id, /** @type {number} */ code, /** @type {string} */ message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (/** @type {unknown} */ id, /** @type {unknown} */ result) => ({ jsonrpc: '2.0', id, result });
const failure = (/** @type {string} */ text) => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * Check a value against the small JSON Schema subset the tool table uses.
 * @param {Record<string, any>} schema @param {unknown} value @param {string} name what to call the value in the message
 * @returns {string | null} a message naming the problem, or null when valid
 */
function validate(schema, value, name) {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return `${name} must be a string`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${name} must be at least ${schema.minLength} characters`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${name} must be at most ${schema.maxLength} characters`;
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${name} must be a ${schema.type}`;
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${name} must be an integer`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${name} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${name} must be at most ${schema.maximum}`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `${name} must be a boolean`;
      break;
    case 'array': {
      if (!Array.isArray(value)) return `${name} must be an array`;
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const bad = validate(schema.items, value[i], `${name}[${i}]`);
          if (bad) return bad;
        }
      }
      break;
    }
    case 'object': {
      if (!isObject(value)) return `${name} must be an object`;
      const obj = /** @type {Record<string, unknown>} */ (value);
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) if (obj[key] === undefined) return `missing required argument "${key}"`;
      for (const key of Object.keys(obj)) {
        if (props[key] === undefined) {
          if (schema.additionalProperties === false) return `unknown argument "${key}"`;
          continue;
        }
        const bad = validate(props[key], obj[key], `argument "${key}"`);
        if (bad) return bad;
      }
      break;
    }
    default:
      break;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${name} must be one of ${schema.enum.join(', ')}`;
  return null;
}

/**
 * Wrap the server's `call` as the tool helper: bodies on 2xx, ToolError otherwise.
 * @param {(req: { method: 'GET' | 'POST', path: string, query?: Record<string, string>, body?: unknown }) => Promise<{ status: number, body: any }>} call
 */
function makeApi(call) {
  /** @param {{ status: number, body: any }} res */
  const unwrap = (res) => {
    if (res.status >= 200 && res.status < 300) return res.body;
    const b = res.body ?? {};
    throw new ToolError(`StoryForge said ${res.status}${b.code ? ' ' + b.code : ''}: ${b.message ?? b.error}`);
  };
  return {
    get: async (/** @type {string} */ path, /** @type {Record<string, string> | undefined} */ query) => unwrap(await call({ method: 'GET', path, ...(query ? { query } : {}) })),
    post: async (/** @type {string} */ path, /** @type {unknown} */ body) => unwrap(await call({ method: 'POST', path, body })),
    put: async (/** @type {string} */ path, /** @type {unknown} */ body) => unwrap(await call({ method: 'PUT', path, body })),
  };
}

/**
 * Create the MCP handler for one token.
 * @param {{ call: (req: { method: 'GET' | 'POST' | 'PUT', path: string, query?: Record<string, string>, body?: unknown }) => Promise<{ status: number, body: any }>,
 *   permissions: string[], serverInfo: { name: string, version: string } }} options
 * @returns {{ handle: (message: unknown) => Promise<Record<string, unknown> | null> }}
 */
export function createMcpServer({ call, permissions, serverInfo }) {
  const api = makeApi(call);
  const offered = TOOLS.filter((t) => permissions.includes(t.need));

  /** @param {Record<string, any>} params */
  async function callTool(params) {
    const name = params.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      if (NOT_OFFERED.includes(name)) return failure(`${name} is not available in StoryForge v2's MCP service. StoryForge v2 has no such route for plugins; do this in the StoryForge app instead.`);
      return null;
    }
    if (!permissions.includes(tool.need)) return failure(`this token lacks the "${tool.need}" permission`);
    const args = params.arguments ?? {};
    const bad = validate(tool.inputSchema, args, 'arguments');
    if (bad) return failure(`invalid arguments: ${bad}`);
    try {
      return await tool.run(args, api);
    } catch (e) {
      if (e instanceof ToolError) return failure(e.message);
      return failure('internal error');
    }
  }

  /** @param {unknown} message */
  async function handle(message) {
    if (Array.isArray(message)) return rpcError(null, -32600, 'batching is not supported');
    if (!isObject(message)) return rpcError(null, -32600, 'invalid request');
    const m = /** @type {Record<string, any>} */ (message);
    const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return rpcError(id, -32600, 'invalid request');
    if (!('id' in m)) return null;
    const params = m.params;
    if (params !== undefined && !isObject(params)) return rpcError(id, -32602, 'invalid params');
    switch (m.method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
        return rpcResult(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo, instructions: INSTRUCTIONS });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: offered.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })) });
      case 'tools/call': {
        if (!params || typeof params.name !== 'string') return rpcError(id, -32602, 'invalid params: name is required');
        if (params.arguments !== undefined && !isObject(params.arguments)) return rpcError(id, -32602, 'invalid params: arguments must be an object');
        const out = await callTool(params);
        return out === null ? rpcError(id, -32602, 'unknown tool') : rpcResult(id, out);
      }
      default:
        return rpcError(id, -32601, 'method not found');
    }
  }

  return { handle };
}
