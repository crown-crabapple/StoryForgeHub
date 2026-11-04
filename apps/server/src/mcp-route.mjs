// MCP over Streamable HTTP: POST /mcp (personal and shared mode). One JSON-RPC message in, one JSON reply out (202 and no body for a notification); no SSE,
// no session. Authentication is the plugin bearer token (M08-J02) and nothing else: an unknown or revoked token is refused here, before any MCP method runs.
// Every tool call becomes an in-process /api/v1 request through handlePluginRequest, so plugin-policy.mjs decides each one (permission, granted books, the
// integrations module), the token is resolved again on every call (a revocation takes effect at once), and shared mode audits each call as plugin.<route>.
// Nothing here writes a file: the propose tools create a suggestion through POST /api/v1/books/:b/proposals.
import { createMcpServer } from '@storyforge/mcp';
import pkg from '../package.json' with { type: 'json' };
import { handlePluginRequest } from './api-v1.mjs';

/**
 * @param {{ bearer: string, message: unknown, repository: any, state: any, service: ReturnType<typeof import('./plugin-service.mjs').createPluginService>,
 *   audit?: ((e: Record<string, unknown>) => Promise<void>) | null, ip?: string, afterProposal?: (book: any, proposal: any, by: any) => void }} p
 * @returns {Promise<{ status: number, body?: unknown }>} status 202 has no body
 */
export async function handleMcpRequest({ bearer, message, repository, state, service, audit = null, ip, afterProposal }) {
  const record = async (/** @type {Record<string, unknown>} */ e) => {
    if (audit) await audit(e).catch((err) => process.stderr.write(`storyforge: audit write failed: ${err?.message ?? err}\n`));
  };
  let grant;
  try {
    grant = await (await service.tokens()).resolve(bearer);
  } catch {
    return { status: 503, body: { error: 'unavailable', code: 'PLUGINS_UNAVAILABLE', message: 'the plugin tokens cannot be read on this server' } };
  }
  if (!grant) {
    await record({ actor: 'plugin:unknown', event: 'plugin.mcp', result: 401, ...(ip ? { ip } : {}) });
    return { status: 401, body: { error: 'unauthorized', code: 'TOKEN', message: 'the plugin token is not valid (unknown or revoked)' } };
  }

  /** One /api/v1 request, decided and answered exactly as if the plugin had sent it over HTTP. */
  const call = async (/** @type {{ method: string, path: string, query?: Record<string, string>, body?: unknown }} */ { method, path, query, body }) => {
    if ((method !== 'GET' && method !== 'POST') || typeof path !== 'string' || !(path === '/api/v1' || path.startsWith('/api/v1/'))) {
      throw new Error('an MCP tool may reach /api/v1 only');
    }
    const r = await handlePluginRequest({
      method, pathname: path, params: new URLSearchParams(query ?? {}), bearer, repository, state, service,
      readJson: async () => ({ ok: /** @type {const} */ (true), value: body ?? {} }),
    });
    await record({ ...r.event, result: r.status });
    if (r.status === 201 && r.proposal && r.by && afterProposal) afterProposal(r.book, r.proposal, r.by);
    return { status: r.status, body: r.body };
  };

  const mcp = createMcpServer({ call, permissions: [...grant.permissions], serverInfo: { name: 'storyforge', version: pkg.version } });
  const reply = await mcp.handle(message);
  return reply === null ? { status: 202 } : { status: 200, body: reply };
}
