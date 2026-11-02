// The JSON API. Maps GET /api/... paths to FileRepository reads and the guarded write routes to
// FileRepository write methods.
import pkg from '../package.json' with { type: 'json' };

/** @typedef {import('@storyforge/core').FileRepository} FileRepository */
/** @typedef {{ status: number, body: unknown, raw?: { bytes: Buffer, headers: Record<string, string> } }} ApiResult  `raw` (cover images) is sent as is instead of `body`. */
/** @typedef {{ lastRecover: any, instance?: { pid: number, started_at: string, lock: string } }} ApiState  Report of the most recent recover() run; what this process knows about itself. */

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
 * @param {URLSearchParams} [params] the query string
 * @returns {Promise<ApiResult>}
 */
export async function handleApi(repository, pathname, state, params = new URLSearchParams()) {
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
  if (a === 'status' && b === undefined) {
    const status = await repository.getStatus();
    const last = state?.lastRecover;
    return {
      status: 200,
      body: {
        instance: state?.instance ?? { pid: process.pid, started_at: null, lock: 'none' },
        watch: status.watch,
        books: status.books,
        recover: { needsAttention: last?.needsAttention ?? [], rolledBack: last?.rolledBack ?? [] },
      },
    };
  }
  if (a === 'search' && b === undefined) return handleSearch(repository, params);
  if (a === 'index' && b === 'status' && c === undefined) {
    return { status: 200, body: await repository.indexStatus() };
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
    if (c === 'cover' && d === undefined) return handleCover(repository, b, params);
    if (c === 'diagnostics' && d === undefined) {
      return { status: 200, body: await repository.getDiagnostics(b) };
    }
    if (c === 'repair' && d === 'plan' && rest.length === 0) {
      const plan = await repository.planRepair(b);
      return plan ? { status: 200, body: plan } : NOT_FOUND;
    }
    if (c === 'raw' && d === undefined) {
      const file = params.get('path');
      if (file === null) return badRequest('path is required');
      const raw = await repository.getRawFile(b, file);
      return raw ? { status: 200, body: raw } : NOT_FOUND;
    }
    if (c === 'scenes' && d !== undefined && rest.length === 0) {
      const scene = await repository.getScene(b, d);
      return scene ? { status: 200, body: scene } : NOT_FOUND;
    }
    if (c === 'backlinks' && d !== undefined) {
      return fromIndex(() => repository.getBacklinks(b, d));
    }
    if (c === 'mentions' && d === undefined) {
      const entry = params.get('entry');
      const scene = params.get('scene');
      return fromIndex(() =>
        repository.getMentions(b, { ...(entry !== null ? { entryId: entry } : {}), ...(scene !== null ? { sceneId: scene } : {}) }),
      );
    }
  }
  return NOT_FOUND;
}

/** GET /api/books/:b/cover[?v=<sha8>]: the cover image bytes. Only a supported image under the book's assets/ is ever served. */
async function handleCover(repository, bookId, params) {
  const cover = await repository.getCover(bookId);
  if (!cover) return NOT_FOUND;
  if ('error' in cover) return { status: 404, body: { error: 'too_large' } };
  const current = params.get('v') === cover.sha256.slice(0, 8);
  return {
    status: 200,
    body: null,
    raw: {
      bytes: cover.bytes,
      headers: {
        'content-type': cover.contentType,
        'x-content-type-options': 'nosniff',
        'cache-control': current ? 'private, max-age=31536000, immutable' : 'no-cache',
      },
    },
  };
}

const SEARCH_KINDS = ['scene', 'entry', 'thread', 'event', 'doc', 'research'];
const badRequest = (message) => ({ status: 400, body: { error: 'bad_request', message } });

/** GET /api/search?q=&book=&kinds=scene,entry&limit= @param {FileRepository} repository @param {URLSearchParams} params */
async function handleSearch(repository, params) {
  const q = params.get('q');
  if (q === null || q.trim() === '' || q.length > 200) return badRequest('q is required and must be 1 to 200 characters');
  const kindsParam = params.get('kinds');
  let kinds;
  if (kindsParam !== null) {
    kinds = kindsParam.split(',').map((k) => k.trim()).filter(Boolean);
    if (kinds.length === 0 || kinds.some((k) => !SEARCH_KINDS.includes(k))) {
      return badRequest(`kinds must be a comma-separated list of: ${SEARCH_KINDS.join(', ')}`);
    }
  }
  let limit;
  const limitParam = params.get('limit');
  if (limitParam !== null) {
    if (!/^[0-9]+$/.test(limitParam) || Number(limitParam) < 1 || Number(limitParam) > 100) return badRequest('limit must be an integer from 1 to 100');
    limit = Number(limitParam);
  }
  const bookId = params.get('book');
  const hits = await repository.search(q, { ...(bookId !== null ? { bookId } : {}), ...(kinds ? { kinds } : {}), ...(limit !== undefined ? { limit } : {}) });
  return { status: 200, body: hits };
}

/** Index-backed reads: null means unknown book (404); no usable index yet means 503 (a rebuild has started). */
async function fromIndex(read) {
  try {
    const value = await read();
    return value === null ? NOT_FOUND : { status: 200, body: value };
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'INDEX_NOT_READY') return { status: 503, body: { error: 'index_not_ready' } };
    throw e;
  }
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
  if (method === 'POST' && a === 'index' && b === 'rebuild' && c === undefined) return { route: 'index-rebuild' };
  if (a !== 'books' || b === undefined || c === undefined) return null;
  if (method === 'POST' && c === 'repair' && d === undefined) return { route: 'repair', bookId: b };
  if (method === 'PUT' && c === 'scenes' && d !== undefined && e === 'body') return { route: 'body', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d === undefined) return { route: 'create', bookId: b };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'archive') return { route: 'archive', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'archive' && d === 'restore' && e === undefined) return { route: 'restore', bookId: b };
  return null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Map a core write result to an HTTP result. @param {any} r @param {number} okStatus @param {(r: any) => unknown} okBody */
function respond(r, okStatus, okBody) {
  if (r.ok) return { status: okStatus, body: okBody(r) };
  if (r.code === 'NOT_FOUND') return NOT_FOUND;
  if (r.code === 'CONFLICT') return { status: 409, body: { error: 'conflict', current: r.current ?? null } };
  const detail = { code: r.code, ...(r.message ? { message: r.message } : {}), ...(r.diagnostics?.length ? { diagnostics: r.diagnostics } : {}) };
  const conflicting = ['EXISTS', 'ROLLED_BACK', 'REFUSED_PATH_TAKEN', 'REFUSED_DUPLICATE_ID', 'REFUSED_STALE_ACTION'].includes(r.code);
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
    case 'index-rebuild': {
      if (body.book !== undefined && typeof body.book !== 'string') return badRequest('book must be a string');
      const r = await repository.rebuildIndex(body.book);
      if (r.code === 'NOT_FOUND') return NOT_FOUND;
      return { status: 200, body: r };
    }
    case 'repair': {
      if (!Array.isArray(body.actions)) return badRequest('expected { actions: [...] }');
      const r = await repository.applyRepair(bookId, body.actions);
      return respond(r, 200, (x) => ({ ok: true, changes: x.changes ?? [], opId: x.opId ?? null }));
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
