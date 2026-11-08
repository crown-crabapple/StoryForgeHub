// Plugin access policy (contract M08-J02 sections 2-3). A request with `Authorization: Bearer` is a plugin request: it may reach only /api/v1/*, only
// what its grant's permissions allow, and only the books it was granted. It never reaches the member routes, writes, admin, AI, export, backup or receipts.
// Writes: with 'canvas' it may change a canvas (planning/canvases/*.canvas) of a granted book; with 'plan' (M11) the Story Planner files of a granted book; with 'workspace' (M12) the workspace docs under planning/.
// Both go through the same store, sha checks and module gates as the app. Nothing a token does can change prose, scenes or Codex entries.
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
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/proposals$/, need: 'propose', book: true, level: 'advisor' },
  // Story Planner M8: read-only planner projections (no writes, no file paths, no sha256); the planner module must be on
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/plan$/, need: 'read', book: true },
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/plan\/(links|arcs|structures|relationships|synopses|clues)$/, need: 'read', book: true },
  // M11: more planner reads (one scene plan, the plan check, the structure templates)
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/plan\/scene-plans\/[^/]{1,120}$/, need: 'read', book: true },
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/plan\/(check|templates)$/, need: 'read', book: true },
  // M11: planner writes need 'plan', which writes only the Story Planner files under planning/ (never prose, scenes or Codex entries), through the app's own planner routes
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/plan\/story$/, need: 'plan', book: true, level: 'planner' },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/plan\/scene-plans\/[^/]{1,120}$/, need: 'plan', book: true, level: 'planner' },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/plan\/(links|arcs|structures|relationships|clues|synopses)$/, need: 'plan', book: true, level: 'planner' },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/plan\/(links|arcs|structures|relationships|clues|synopses)\/[a-z0-9-]{1,120}$/, need: 'plan', book: true, level: 'planner' },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/plan\/(links|arcs|structures|relationships|clues|synopses)\/[a-z0-9-]{1,120}\/(archive|restore)$/, need: 'plan', book: true, level: 'planner' },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/plan\/(arcs\/[a-z0-9-]{1,120}\/milestones|structures\/[a-z0-9-]{1,120}\/beats|relationships\/[a-z0-9-]{1,120}\/developments|clues\/[a-z0-9-]{1,120}\/knowers)$/, need: 'plan', book: true, level: 'planner' },
  // canvases: reading needs 'read'; changing one needs 'canvas', the only permission that writes a file, and only planning/canvases/<slug>.canvas (never prose)
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/canvases$/, need: 'read', book: true },
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/canvases\/[a-z0-9-]{1,60}$/, need: 'read', book: true },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/canvases$/, need: 'canvas', book: true, level: 'planner' },
  { method: 'PUT', re: /^\/api\/v1\/books\/([^/]+)\/canvases\/[a-z0-9-]{1,60}$/, need: 'canvas', book: true, level: 'planner' },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/canvases\/[a-z0-9-]{1,60}\/(archive|restore)$/, need: 'canvas', book: true, level: 'planner' },
  // M12 W2 workspace docs (book, style, state): reading needs 'read'; writing needs 'workspace' at book AI level planner, through the app's own workspace-* routes (planning material, never prose)
  { method: 'GET', re: /^\/api\/v1\/books\/([^/]+)\/workspace\/docs$/, need: 'read', book: true },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/workspace\/docs(\/(append|lock|archive|restore))?$/, need: 'workspace', book: true, level: 'planner' },
  { method: 'POST', re: /^\/api\/v1\/books\/([^/]+)\/workspace\/setup$/, need: 'workspace', book: true, level: 'planner' },
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
 * @returns {{ ok: true, need: string, book: string | null, level: string } | { ok: false, status: number, body: unknown }}
 *   `level` (M12): the lowest book AI level the route needs ('off' = any); handlePluginRequest compares it with the book's level.
 */
export function decidePlugin(grant, method, pathname, slugOf) {
  if (!grant) return { ok: false, status: 401, body: { error: 'unauthorized', code: 'TOKEN', message: 'the plugin token is not valid (unknown or revoked)' } };
  if (!pathname.startsWith('/api/v1/') && pathname !== '/api/v1') return { ok: false, status: 403, body: { error: 'forbidden', code: 'PLUGIN_SCOPE', message: 'plugin tokens reach /api/v1 only' } };
  const route = V1.find((r) => r.method === method && r.re.test(pathname));
  if (!route) return { ok: false, status: 403, body: { error: 'forbidden', code: 'PLUGIN_SCOPE', message: 'not a plugin API route' } };
  if (!grant.permissions.includes(route.need)) return { ok: false, status: 403, body: { error: 'forbidden', code: 'PLUGIN_SCOPE', message: `this token lacks the "${route.need}" permission` } };
  if (!route.book) return { ok: true, need: route.need, book: null, level: 'off' };
  let raw;
  try {
    raw = decodeURIComponent(/** @type {RegExpExecArray} */ (route.re.exec(pathname))[1]);
  } catch {
    return { ok: false, status: 400, body: { error: 'bad_request', message: 'malformed book in the path' } };
  }
  const slug = slugOf(raw);
  if (slug === null || (grant.books !== 'all' && !grant.books.includes(slug))) return { ok: false, status: 403, body: { error: 'forbidden', code: 'PLUGIN_SCOPE', message: 'this token was not granted that book' } };
  return { ok: true, need: route.need, book: slug, level: route.level ?? 'off' };
}
