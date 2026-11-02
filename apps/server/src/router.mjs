// The JSON API. Maps GET /api/... paths to FileRepository reads and the guarded write routes to
// FileRepository write methods.
import pkg from '../package.json' with { type: 'json' };

/** @typedef {import('@storyforge/core').FileRepository} FileRepository */
/** @typedef {{ status: number, body: unknown }} ApiResult */
/** @typedef {{ lastRecover: unknown }} ApiState  Report of the most recent recover() run. */

const NOT_FOUND = { status: 404, body: { error: 'not_found' } };

/** @param {string} s @returns {string | null} */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * True when the path belongs to the API (handled here, never by static files).
 * @param {string} pathname
 */
export function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * @param {FileRepository} repository
 * @param {string} pathname raw (still percent-encoded) URL path
 * @param {ApiState} [state]
 * @returns {Promise<ApiResult>}
 */
export async function handleApi(repository, pathname, state) {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  if (parts.some((p) => p === null)) return NOT_FOUND;
  const [api, a, b, c, d, ...rest] = /** @type {string[]} */ (parts);
  if (api !== 'api' || rest.length > 0) return NOT_FOUND;

  if (a === 'health' && b === undefined) {
    const info = await repository.libraryInfo();
    return { status: 200, body: { ok: true, version: pkg.version, library: info.root } };
  }
  if (a === 'recover' && b === 'last' && c === undefined) {
    return { status: 200, body: state?.lastRecover ?? { completed: [], rolledBack: [], needsAttention: [] } };
  }
  if (a === 'library' && b === undefined) {
    return { status: 200, body: await repository.libraryInfo() };
  }
  if (a === 'books') {
    if (b === undefined) return { status: 200, body: await repository.listBooks() };
    if (c === undefined) {
      const book = await repository.getBook(b);
      return book ? { status: 200, body: book } : NOT_FOUND;
    }
    if (c === 'diagnostics' && d === undefined) {
      return { status: 200, body: await repository.getDiagnostics(b) };
    }
    if (c === 'scenes' && d !== undefined && rest.length === 0) {
      const scene = await repository.getScene(b, d);
      return scene ? { status: 200, body: scene } : NOT_FOUND;
    }
  }
  return NOT_FOUND;
}

// ---------------------------------------------------------------- write routes

/**
 * Which write route (if any) a method + path is. Anything else non-GET stays 405.
 * @param {string} method
 * @param {string} pathname
 * @returns {{ route: string, bookId?: string, sceneId?: string } | null}
 */
export function matchWriteRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  if (parts.some((p) => p === null) || parts[0] !== 'api') return null;
  const [, a, b, c, d, e, ...rest] = /** @type {string[]} */ (parts);
  if (rest.length > 0) return null;
  if (method === 'POST' && a === 'recover' && b === undefined) return { route: 'recover' };
  if (a !== 'books' || b === undefined || c === undefined) return null;
  if (method === 'PUT' && c === 'scenes' && d !== undefined && e === 'body') return { route: 'body', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d === undefined) return { route: 'create', bookId: b };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'archive') return { route: 'archive', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'archive' && d === 'restore' && e === undefined) return { route: 'restore', bookId: b };
  return null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const badRequest = (message) => ({ status: 400, body: { error: 'bad_request', message } });

/** Map a core write result to an HTTP result. @param {any} r @param {number} okStatus @param {(r: any) => unknown} okBody */
function respond(r, okStatus, okBody) {
  if (r.ok) return { status: okStatus, body: okBody(r) };
  if (r.code === 'NOT_FOUND') return NOT_FOUND;
  if (r.code === 'CONFLICT') return { status: 409, body: { error: 'conflict', current: r.current ?? null } };
  const detail = { code: r.code, ...(r.message ? { message: r.message } : {}), ...(r.diagnostics?.length ? { diagnostics: r.diagnostics } : {}) };
  const conflicting = ['EXISTS', 'ROLLED_BACK', 'REFUSED_PATH_TAKEN', 'REFUSED_DUPLICATE_ID'].includes(r.code);
  return { status: conflicting ? 409 : 400, body: { error: conflicting ? 'conflict' : 'refused', ...detail } };
}

/**
 * @param {FileRepository} repository
 * @param {{ route: string, bookId?: string, sceneId?: string }} match from matchWriteRoute
 * @param {unknown} body parsed JSON request body
 * @param {ApiState} [state] updated by POST /api/recover
 * @returns {Promise<ApiResult>}
 */
export async function handleWrite(repository, match, body, state) {
  if (!isObject(body)) return badRequest('body must be a JSON object');
  const bookId = /** @type {string} */ (match.bookId);
  switch (match.route) {
    case 'recover': {
      const report = await repository.recover();
      if (state) state.lastRecover = report;
      return { status: 200, body: report };
    }
    case 'body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateSceneBody(bookId, /** @type {string} */ (match.sceneId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256 }));
    }
    case 'create': {
      const { chapter, act, after, title, slug, body: text } = body;
      const r = await repository.createScene(bookId, { chapter, act, after, title, slug, body: text });
      return respond(r, 201, (x) => ({ id: x.id, path: x.path }));
    }
    case 'archive': {
      if (typeof body.base_sha256 !== 'string') return badRequest('expected { base_sha256: string }');
      const r = await repository.archiveScene(bookId, /** @type {string} */ (match.sceneId), { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ path: x.path }));
    }
    case 'restore': {
      if (typeof body.path !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { path: string, base_sha256: string }');
      const r = await repository.restoreScene(bookId, body.path, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ path: x.path }));
    }
    default:
      return NOT_FOUND;
  }
}
