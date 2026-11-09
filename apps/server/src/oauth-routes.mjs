// OAuth 2.1 for the MCP service, so claude.ai and ChatGPT connectors (and any client that follows the MCP authorization spec) can connect with a sign-in
// instead of a pasted key. This server is both the protected resource (POST /mcp) and its authorization server:
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728: the resource (<origin>/mcp) and its authorization server (this origin)
//   GET  /.well-known/oauth-authorization-server       RFC 8414: the endpoints below; PKCE S256 only; public and confidential clients
//   POST /oauth/register                               RFC 7591 dynamic client registration (bounded and rate limited; registering grants nothing)
//   GET  /oauth/authorize                              the web app's consent page (static; it calls the two routes below)
//   POST /oauth/token                                  authorization_code (with PKCE) and refresh_token (rotated on every use)
//   POST /oauth/revoke                                 RFC 7009; revoking a refresh token ends the AI connection
//   GET  /api/oauth/request?<authorize query>          the consent page: who asks, the books, the suggested name   (member API, owner only)
//   POST /api/oauth/approve|deny { request, ... }      the owner's answer: a redirect back to the client             (member API, owner only)
//
// Approving creates an ordinary AI connection (a plugin grant named mcp-<name>, Settings -> AI connections) with the books and permissions the owner chose; the
// OAuth tokens only point at it (packages/shared/src/oauth.mjs), so the book's AI level, the integrations module and Revoke apply exactly as for a pasted key.
// Access tokens are accepted at POST /mcp only (their audience); server.mjs refuses them on /api/v1.
import { PLUGIN_PERMISSIONS, createLimiter } from '@storyforge/shared';

const JSON_HEADERS = { 'cache-control': 'no-store', pragma: 'no-cache' };
/** Anyone may read the metadata and call the client endpoints from a browser (MCP Inspector): they take no cookie and answer only to what is sent. */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version', 'access-control-max-age': '600' };
/** What an AI connection made by OAuth may be given: every plugin permission except webhook events. */
export const OAUTH_PERMISSIONS = Object.freeze(PLUGIN_PERMISSIONS.filter((p) => p !== 'events'));
/** Ticked on the consent page unless the client asked for less. */
const DEFAULT_PERMISSIONS = Object.freeze(['read', 'propose']);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PUBLIC_PATHS = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token', '/oauth/revoke']);

/** Is this one of the public OAuth paths server.mjs hands to handleOAuthPublic (before the shared-mode gate)? @param {string} pathname */
export const isOAuthPublicPath = (pathname) => PUBLIC_PATHS.has(pathname);

/** The MCP resource of this server. @param {string} issuer */
export const resourceOf = (issuer) => `${issuer}/mcp`;

/** The protected resource metadata URL, for WWW-Authenticate on a 401 from /mcp. @param {string} issuer */
export const resourceMetadataUrl = (issuer) => `${issuer}/.well-known/oauth-protected-resource/mcp`;

/** The WWW-Authenticate header of a 401 from /mcp (RFC 9728 section 5.1). @param {string} issuer @param {boolean} invalid a token came and was not valid */
export const mcpChallenge = (issuer, invalid) => `Bearer realm="storyforge", resource_metadata="${resourceMetadataUrl(issuer)}"${invalid ? ', error="invalid_token"' : ''}`;

/** The resource indicator a client sent names this server's MCP service (RFC 8707). Absent is accepted. @param {unknown} resource @param {string} issuer */
function resourceOk(resource, issuer) {
  if (resource === undefined || resource === null || resource === '') return true;
  if (typeof resource !== 'string') return false;
  const r = resource.replace(/\/+$/, '');
  return r === resourceOf(issuer) || r === issuer;
}

/** @param {string} issuer */
function protectedResource(issuer) {
  return { resource: resourceOf(issuer), authorization_servers: [issuer], scopes_supported: [...OAUTH_PERMISSIONS], bearer_methods_supported: ['header'], resource_name: 'StoryForge' };
}

/** @param {string} issuer */
function authorizationServer(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...OAUTH_PERMISSIONS],
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/crown-crabapple/StoryForgeHub/blob/v2/docs/mcp.md',
  };
}

/** An OAuth error body (RFC 6749 section 5.2). */
const oauthError = (/** @type {number} */ status, /** @type {string} */ error, /** @type {string} */ description, /** @type {Record<string, string>} */ headers = {}) => ({
  status, body: { error, error_description: description }, headers: { ...JSON_HEADERS, ...CORS, ...headers },
});

/** Parse a form or JSON request body into a plain object of strings (and arrays for JSON). @param {Buffer} buffer @param {string} type */
function parseBody(buffer, type) {
  const text = buffer.toString('utf8');
  if (type === 'application/x-www-form-urlencoded') {
    const out = /** @type {Record<string, string>} */ ({});
    for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v;
    return out;
  }
  if (type === 'application/json') {
    const v = JSON.parse(text || '{}');
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }
  return null;
}

/**
 * How the client authenticated: HTTP Basic (RFC 6749 section 2.3.1, form-encoded id and secret), or client_id (and client_secret) in the body.
 * @param {import('node:http').IncomingMessage} req @param {Record<string, any>} body
 * @returns {{ id: unknown, secret: unknown, method: 'none' | 'client_secret_post' | 'client_secret_basic' } | null} null: a malformed Basic header
 */
function clientCredentials(req, body) {
  const h = req.headers.authorization;
  if (typeof h === 'string' && /^Basic /i.test(h.trim())) {
    const raw = Buffer.from(h.trim().slice(6), 'base64').toString('utf8');
    const at = raw.indexOf(':');
    if (at < 0) return null;
    try {
      const id = decodeURIComponent(raw.slice(0, at).replace(/\+/g, ' '));
      const secret = decodeURIComponent(raw.slice(at + 1).replace(/\+/g, ' '));
      if (body.client_id !== undefined && body.client_id !== id) return null;
      return { id, secret, method: 'client_secret_basic' };
    } catch {
      return null;
    }
  }
  return { id: body.client_id, secret: body.client_secret, method: body.client_secret !== undefined ? 'client_secret_post' : 'none' };
}

/**
 * The public OAuth endpoints (metadata, register, token, revoke) and their CORS preflights. Null when the path is not one of them.
 * @param {{ req: import('node:http').IncomingMessage, pathname: string, issuer: string, service: any, readBody: () => Promise<{ tooLarge: boolean, buffer?: Buffer }>,
 *   audit?: ((e: Record<string, unknown>) => Promise<void>) | null, limiter: ReturnType<typeof createOAuthLimiter> }} p
 * @returns {Promise<{ status: number, body?: unknown, headers: Record<string, string> } | null>}
 */
export async function handleOAuthPublic({ req, pathname, issuer, service, readBody, audit = null, limiter }) {
  if (!PUBLIC_PATHS.has(pathname)) return null;
  const method = req.method ?? 'GET';
  const record = async (/** @type {Record<string, unknown>} */ e) => {
    if (audit) await audit(e).catch((err) => process.stderr.write(`storyforge: audit write failed: ${err?.message ?? err}\n`));
  };
  if (method === 'OPTIONS') {
    req.resume();
    return { status: 204, headers: { ...CORS } };
  }
  if (pathname.startsWith('/.well-known/')) {
    if (method !== 'GET') {
      req.resume();
      return { status: 405, body: { error: 'method_not_allowed' }, headers: { ...CORS, allow: 'GET' } };
    }
    const body = pathname === '/.well-known/oauth-authorization-server' ? authorizationServer(issuer) : protectedResource(issuer);
    return { status: 200, body, headers: { ...CORS, 'cache-control': 'public, max-age=300' } };
  }
  if (method !== 'POST') {
    req.resume();
    return { status: 405, body: { error: 'method_not_allowed' }, headers: { ...CORS, allow: 'POST' } };
  }
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const read = await readBody();
  if (read.tooLarge || !read.buffer) return oauthError(413, 'invalid_request', 'the request body is too large');
  let body;
  try {
    body = parseBody(read.buffer, type);
  } catch {
    body = null;
  }
  if (body === null) return oauthError(400, 'invalid_request', pathname === '/oauth/register' ? 'send the client metadata as application/json' : 'send application/x-www-form-urlencoded parameters');
  let store;
  let tokens;
  try {
    store = await service.oauth();
    tokens = await service.tokens();
  } catch {
    return oauthError(503, 'temporarily_unavailable', 'the OAuth or plugin token file cannot be read on this server');
  }

  if (pathname === '/oauth/register') {
    const who = String(req.socket?.remoteAddress ?? 'unknown');
    if (limiter.register.blocked('all') || limiter.register.blocked(who)) return oauthError(429, 'temporarily_unavailable', 'too many client registrations; try again later');
    limiter.register.fail('all');
    limiter.register.fail(who);
    const grantTypes = body.grant_types ?? ['authorization_code'];
    const responseTypes = body.response_types ?? ['code'];
    if (!Array.isArray(grantTypes) || !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) return oauthError(400, 'invalid_client_metadata', 'grant_types may be authorization_code and refresh_token');
    if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === 'code')) return oauthError(400, 'invalid_client_metadata', 'response_types may only be code');
    const r = await store.register({ name: body.client_name, redirect_uris: body.redirect_uris, auth_method: body.token_endpoint_auth_method ?? 'none' });
    if (!r.ok) return oauthError(r.code === 'temporarily_unavailable' ? 503 : 400, r.code, r.message);
    await record({ actor: `oauth:${r.client.id}`, event: 'oauth.register', target: r.client.name.slice(0, 64), result: 201 });
    return {
      status: 201,
      headers: { ...JSON_HEADERS, ...CORS },
      body: {
        client_id: r.client.id,
        client_id_issued_at: Math.floor(r.client.created / 1000),
        client_name: r.client.name,
        redirect_uris: r.client.redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: r.client.auth_method,
        ...(r.secret ? { client_secret: r.secret, client_secret_expires_at: 0 } : {}),
      },
    };
  }

  const cred = clientCredentials(req, body);
  const client = cred ? store.authenticate(cred.id, cred.secret, cred.method) : null;
  if (!client) {
    await record({ actor: 'oauth:unknown', event: pathname === '/oauth/token' ? 'oauth.token' : 'oauth.revoke', result: 401, ip: String(req.socket?.remoteAddress ?? '') });
    return oauthError(401, 'invalid_client', 'unknown client, or wrong client authentication', cred?.method === 'client_secret_basic' ? { 'www-authenticate': 'Basic realm="storyforge"' } : {});
  }

  if (pathname === '/oauth/revoke') {
    const r = await store.revoke(body.token, client.id);
    if (r.revoked === 'refresh' && r.grant) await tokens.revoke(r.grant); // the client disconnected: the AI connection goes with it
    if (r.revoked !== 'none') await record({ actor: `oauth:${client.id}`, event: 'oauth.revoke', target: r.grant, result: 200 });
    return { status: 200, body: {}, headers: { ...JSON_HEADERS, ...CORS } };
  }

  // the token endpoint
  if (!resourceOk(body.resource, issuer)) return oauthError(400, 'invalid_target', `this server's resource is ${resourceOf(issuer)}`);
  if (body.grant_type === 'authorization_code') {
    const taken = store.takeCode({ code: body.code, client: client.id, redirect_uri: body.redirect_uri, verifier: body.code_verifier });
    if (!taken.ok) {
      await record({ actor: `oauth:${client.id}`, event: 'oauth.token', result: 400 });
      return oauthError(400, 'invalid_grant', taken.message);
    }
    const grant = await tokens.resolveId(taken.grant);
    if (!grant) return oauthError(400, 'invalid_grant', 'the AI connection was revoked');
    const pair = await store.issue(client.id, grant.id);
    await record({ actor: `oauth:${client.id}`, event: 'oauth.token', target: grant.id, result: 200 });
    return { status: 200, headers: { ...JSON_HEADERS, ...CORS }, body: { ...pair, token_type: 'Bearer', scope: grant.permissions.join(' ') } };
  }
  if (body.grant_type === 'refresh_token') {
    const r = await store.refresh(body.refresh_token, client.id, async (/** @type {string} */ id) => (await tokens.resolveId(id)) !== null);
    if (!r.ok) {
      await record({ actor: `oauth:${client.id}`, event: 'oauth.refresh', result: 400 });
      return oauthError(400, 'invalid_grant', r.message);
    }
    const grant = await tokens.resolveId(r.grant);
    return { status: 200, headers: { ...JSON_HEADERS, ...CORS }, body: { ...r.pair, token_type: 'Bearer', scope: (grant?.permissions ?? []).join(' ') } };
  }
  return oauthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
}

/** The rate limits of the public endpoints (in memory). Registration: 30 an hour in all, 10 an hour per address. */
export function createOAuthLimiter() {
  const all = createLimiter({ max: 30, windowMs: 60 * 60 * 1000 });
  const one = createLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
  return { register: { blocked: (/** @type {string} */ k) => (k === 'all' ? all : one).blocked(k), fail: (/** @type {string} */ k) => (k === 'all' ? all : one).fail(k) } };
}

/**
 * Check an authorization request (the query of /oauth/authorize). A bad client or redirect URI is fatal: nothing is sent back to an address we cannot trust. Any
 * other problem is reported to the client at its redirect URI.
 * @param {URLSearchParams} q @param {any} store @param {string} issuer
 */
export function checkAuthorizeRequest(q, store, issuer) {
  const client = store.client(q.get('client_id'));
  if (!client) return { ok: /** @type {const} */ (false), fatal: true, message: 'This app is not registered with this StoryForge server. Start the connection again from the app.' };
  const asked = q.get('redirect_uri');
  const explicit = asked !== null;
  const redirect = explicit ? asked : client.redirect_uris.length === 1 ? client.redirect_uris[0] : null;
  if (redirect === null || !client.redirect_uris.includes(redirect)) return { ok: /** @type {const} */ (false), fatal: true, message: 'The return address of this request does not match the app. Start the connection again from the app.' };
  const state = q.get('state');
  const back = (/** @type {string} */ error, /** @type {string} */ description) => {
    const u = new URL(redirect);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (state !== null) u.searchParams.set('state', state);
    u.searchParams.set('iss', issuer);
    return { ok: /** @type {const} */ (false), fatal: false, message: description, redirect: u.href };
  };
  if (q.get('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code');
  const challenge = q.get('code_challenge');
  if (challenge === null || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return back('invalid_request', 'a PKCE code_challenge is required');
  if ((q.get('code_challenge_method') ?? 'plain') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
  if (!resourceOk(q.get('resource') ?? undefined, issuer)) return back('invalid_target', `this server's resource is ${resourceOf(issuer)}`);
  const scope = (q.get('scope') ?? '').split(' ').filter(Boolean);
  return { ok: /** @type {const} */ (true), client, redirect, explicit, challenge, state, scope, resource: resourceOf(issuer) };
}

/** A free connection name from the app's name: claude, claude-2, ... @param {string} appName @param {Set<string>} taken plugin slugs of live grants */
export function suggestedName(appName, taken) {
  const base = String(appName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'ai-app';
  if (!taken.has(`mcp-${base}`)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`mcp-${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now()}`;
}

/**
 * GET /api/oauth/request?<the /oauth/authorize query>: what the consent page shows.
 * @param {URLSearchParams} query @param {{ repository: any, service: any, issuer: string }} ctx
 */
export async function handleOAuthRequestInfo(query, { repository, service, issuer }) {
  let store;
  let tokens;
  try {
    store = await service.oauth();
    tokens = await service.tokens();
  } catch {
    return { status: 503, body: { error: 'unavailable', code: 'UNAVAILABLE', message: 'the OAuth or plugin token file cannot be read on this server' } };
  }
  const c = checkAuthorizeRequest(query, store, issuer);
  if (!c.ok) return { status: 400, body: { error: 'bad_request', code: c.fatal ? 'BAD_CLIENT' : 'BAD_REQUEST', message: c.message, ...(c.fatal ? {} : { redirect: c.redirect }) } };
  const taken = new Set(tokens.list().filter((/** @type {any} */ g) => !g.revoked).map((/** @type {any} */ g) => g.plugin));
  const asked = c.scope.filter((s) => OAUTH_PERMISSIONS.includes(s));
  const ticked = asked.length > 0 ? DEFAULT_PERMISSIONS.filter((p) => p === 'read' || asked.includes(p)) : [...DEFAULT_PERMISSIONS];
  const books = (await repository.listBooks()).map((/** @type {any} */ b) => ({ id: b.id, slug: b.slug, title: b.title }));
  return {
    status: 200,
    body: {
      client: { name: c.client.name, redirect_host: new URL(c.redirect).host },
      name: suggestedName(c.client.name, taken),
      taken: [...taken],
      permissions: { available: [...OAUTH_PERMISSIONS], ticked, asked },
      books,
    },
  };
}

/**
 * POST /api/oauth/approve { request, name, books, permissions } and POST /api/oauth/deny { request }: `request` is the /oauth/authorize query string as the page
 * received it. The answer is { redirect }: where the page sends the browser (the client's redirect URI with a code, or with error=access_denied).
 * @param {{ route: string }} match @param {Record<string, any>} body @param {{ repository: any, service: any, issuer: string }} ctx
 */
export async function handleOAuthDecision(match, body, { repository, service, issuer }) {
  if (typeof body.request !== 'string' || body.request.length > 8000) return { status: 400, body: { error: 'bad_request', code: 'BAD_ARGS', message: 'request must be the query string of the authorization request' } };
  let store;
  let tokens;
  try {
    store = await service.oauth();
    tokens = await service.tokens();
  } catch {
    return { status: 503, body: { error: 'unavailable', code: 'UNAVAILABLE', message: 'the OAuth or plugin token file cannot be read on this server' } };
  }
  const c = checkAuthorizeRequest(new URLSearchParams(body.request.replace(/^\?/, '')), store, issuer);
  if (!c.ok) return { status: 400, body: { error: 'bad_request', code: c.fatal ? 'BAD_CLIENT' : 'BAD_REQUEST', message: c.message, ...(c.fatal ? {} : { redirect: c.redirect }) } };
  const back = new URL(c.redirect);
  if (c.state !== null) back.searchParams.set('state', c.state);
  back.searchParams.set('iss', issuer);
  if (match.route === 'oauth-deny') {
    back.searchParams.set('error', 'access_denied');
    back.searchParams.set('error_description', 'the owner did not allow the connection');
    return { status: 200, body: { redirect: back.href } };
  }

  // approve: the same checks as Settings -> AI connections
  const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : '';
  const plugin = `mcp-${name}`;
  if (name === '' || !SLUG_RE.test(plugin) || plugin.length > 64) return { status: 400, body: { error: 'bad_request', code: 'BAD_ARGS', message: 'name: lower-case letters, digits and single hyphens, for example claude' } };
  if (tokens.list().some((/** @type {any} */ g) => g.plugin === plugin && !g.revoked)) return { status: 409, body: { error: 'conflict', code: 'NAME_TAKEN', message: `a live connection is already named ${name}; pick another name` } };
  const perms = Array.isArray(body.permissions) ? [...new Set(body.permissions)] : [];
  if (!perms.includes('read') || !perms.every((p) => OAUTH_PERMISSIONS.includes(/** @type {string} */ (p)))) {
    return { status: 400, body: { error: 'bad_request', code: 'BAD_ARGS', message: `permissions must include read and may add ${OAUTH_PERMISSIONS.filter((p) => p !== 'read').join(', ')}` } };
  }
  if (body.books !== 'all') {
    const known = new Set((await repository.listBooks()).map((/** @type {any} */ b) => b.slug));
    if (!Array.isArray(body.books) || body.books.length === 0 || body.books.some((/** @type {unknown} */ s) => !known.has(s))) return { status: 400, body: { error: 'bad_request', code: 'UNKNOWN_BOOK', message: 'books must be "all" or a list of this library\'s book slugs' } };
  }
  const g = await tokens.grant({ plugin, permissions: perms, books: body.books });
  if (!g.ok) return { status: 400, body: { error: 'bad_request', code: g.code, message: g.message } };
  // the grant's own key is never shown: this connection is reached only with the OAuth tokens that point at it
  const code = store.issueCode({ client: c.client.id, redirect_uri: c.redirect, explicit: c.explicit, challenge: c.challenge, grant: g.grant.id, resource: c.resource, scope: perms.join(' ') });
  back.searchParams.set('code', code);
  return { status: 200, body: { redirect: back.href, grant: g.grant } };
}
