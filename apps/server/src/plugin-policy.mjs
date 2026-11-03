// Plugin access policy (contract M08-J02 sections 2-3). A request with `Authorization: Bearer` is a plugin request: it may reach only /api/v1/*, only
// what its grant's permissions allow, and only the books it was granted. It never reaches the member routes, writes, admin, AI, export, backup or receipts.
// Decided before (and instead of) the member policy; a bearer request never carries a member's cookie authority.

/** The v1 routes and the permission each needs. Anything else under /api/v1 is refused. */
const V1 = [
  { method: 'GET', re: /^\/api\/v1$/, need: 'read', book: false },
  { method: 'GET', re: /^\/api\/v1\/books$/, need: 'read', book: false },
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)$/, need: 'read', book: true },
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/scenes\/[^/]+$/, need: 'read', book: true },
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/(entries|threads|events)$/, need: 'read', book: true },
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/entries\/[^/]+$/, need: 'read', book: true },
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/(search|graph|diagnostics)$/, need: 'read', book: true },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/proposals$/, need: 'propose', book: true },
  { method: 'GET', re: /^\/api\/v1\/webhooks$/, need: 'events', book: false },
  { method: 'POST', re: /^\/api\/v1\/webhooks$/, need: 'events', book: false },
  { method: 'DELETE', re: /^\/api\/v1\/webhooks\/[^/]+$/, need: 'events', book: false },
];

/** @param {import('node:http').IncomingMessage} req @returns {string | null} the bearer token, or null when the request has none */
export function bearerOf(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(h.trim());
  return m ? m[1] : '';
}

/**
 * Decide a plugin request.
 * @param {import('@storyforge/shared/src/plugin-tokens.mjs').PluginGrant | null} grant the live grant, or null (unknown or revoked token)
 * @param {string} method @param {string} pathname
 * @param {(bookIdOrSlug: string) => string | null} slugOf the slug of a book id (or the slug itself), null for an unknown book
 * @returns {{ ok: true, need: string, book: string | null } | { ok: false, status: number, body: unknown }}
 */
export function decidePlugin(grant, method, pathname, slugOf) {
  if (!grant) return { ok: false, status: 401, body: { error: 'unauthorized', code: 'TOKEN', message: 'the plugin token is not valid (unknown or revoked)' } };
  if (!pathname.startsWith('/api/v1/') && pathname !== '/api/v1') return { ok: false, status: 403, body: { error: 'forbidden', code: 'PLUGIN_SCOPE', message: 'plugin tokens reach /api/v1 only' } };
  const route = V1.find((r) => r.method === method && r.re.test(pathname));
  if (!route) return { ok: false, status: 403, body: { error: 'forbidden', code: 'PLUGIN_SCOPE', message: 'not a plugin API route' } };
  if (!grant.permissions.includes(route.need)) return { ok: false, status: 403, body: { error: 'forbidden', code: 'PLUGIN_SCOPE', message: `this token lacks the "${route.need}" permission` } };
  if (!route.book) return { ok: true, need: route.need, book: null };
  let raw;
  try {
    raw = decodeURIComponent(/** @type {RegExpExecArray} */ (route.re.exec(pathname))[1]);
  } catch {
    return { ok: false, status: 400, body: { error: 'bad_request', message: 'malformed book in the path' } };
  }
  const slug = slugOf(raw);
  if (slug === null || (grant.books !== 'all' && !grant.books.includes(slug))) return { ok: false, status: 403, body: { error: 'forbidden', code: 'PLUGIN_SCOPE', message: 'this token was not granted that book' } };
  return { ok: true, need: route.need, book: slug };
}
