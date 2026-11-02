// The JSON API. Maps GET /api/... paths to FileRepository reads and the guarded write routes to
// FileRepository write methods.
import pkg from '../package.json' with { type: 'json' };

/** @typedef {import('@storyforge/core').FileRepository} FileRepository */
/** @typedef {{ status: number, body: unknown, raw?: { bytes: Buffer, headers: Record<string, string> } }} ApiResult  `raw` (cover images) is sent as is instead of `body`. */
/** @typedef {{ lastRecover: any, instance?: { pid: number, started_at: string, lock: string }, host?: ReturnType<typeof import('@storyforge/core').createLibraryHost> | null }} ApiState  Report of the most recent recover() run; what this process knows about itself; the library host (which library is open, recent libraries, switching). */

const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const NOT_SUPPORTED = { status: 501, body: { error: 'not_supported' } };

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
  const [api, a, b, c, d, e, f, ...rest] = /** @type {string[]} */ (parts);
  if (api !== 'api' || rest.length > 0) return NOT_FOUND;
  // only the revisions routes (scenes/:s/revisions[/:file]) are longer than five segments
  if (e !== undefined && !(a === 'books' && ((c === 'scenes' && d !== undefined && e === 'revisions') || (c === 'entries' && d !== undefined && e === 'image')))) return NOT_FOUND;

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
  if (a === 'library' && b === 'recent' && c === undefined) {
    if (!state?.host) return NOT_SUPPORTED;
    return { status: 200, body: await state.host.recent() };
  }
  if (a === 'templates' && b === undefined) {
    return { status: 200, body: await repository.listTemplates() };
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
    // M05-J01: continuity findings, computed from the files on every call (read-only)
    if (c === 'continuity' && d === undefined) {
      const continuity = await repository.getContinuity(b);
      return continuity ? { status: 200, body: continuity } : NOT_FOUND;
    }
    // M05-J02: the lines around a finding's evidence ("Show both"): ?file=<book-relative>&line=N&radius=3 (radius at most 10)
    if (c === 'continuity' && d === 'context' && e === undefined) {
      const line = params.get('line');
      const radius = params.get('radius');
      const r = await repository.getContinuityContext(b, { file: params.get('file') ?? undefined, line: line === null ? undefined : /^[0-9]+$/.test(line) ? Number(line) : NaN, ...(radius === null ? {} : { radius: /^[0-9]+$/.test(radius) ? Number(radius) : NaN }) });
      if (r.ok) return { status: 200, body: { lines: r.lines } };
      if (r.code === 'NOT_FOUND') return NOT_FOUND;
      return { status: 400, body: { error: 'bad_request', code: r.code, message: r.message } };
    }
    if (c === 'repair' && d === 'plan' && e === undefined) {
      const plan = await repository.planRepair(b);
      return plan ? { status: 200, body: plan } : NOT_FOUND;
    }
    if (c === 'raw' && d === undefined) {
      const file = params.get('path');
      if (file === null) return badRequest('path is required');
      const raw = await repository.getRawFile(b, file);
      return raw ? { status: 200, body: raw } : NOT_FOUND;
    }
    if (c === 'objects' && d === undefined) {
      const kindsParam = params.get('kinds');
      let kinds;
      if (kindsParam !== null) {
        kinds = kindsParam.split(',').map((k) => k.trim()).filter(Boolean);
        if (kinds.length === 0 || kinds.some((k) => !OBJECT_KINDS.includes(k))) return badRequest(`kinds must be a comma-separated list of: ${OBJECT_KINDS.join(', ')}`);
      }
      const objects = await repository.getObjects(b, kinds);
      return objects ? { status: 200, body: objects } : NOT_FOUND;
    }
    if (c === 'scenes' && d !== undefined && e === undefined) {
      const scene = await repository.getScene(b, d);
      return scene ? { status: 200, body: scene } : NOT_FOUND;
    }
    // M03-J04: scene revisions, writing activity, entry preview
    if (c === 'scenes' && d !== undefined && e === 'revisions' && f === undefined) {
      const r = await repository.listRevisions(b, d);
      return r.ok ? { status: 200, body: r.revisions } : NOT_FOUND;
    }
    if (c === 'scenes' && d !== undefined && e === 'revisions') {
      const r = await repository.getRevision(b, d, f);
      return r.ok ? { status: 200, body: r.revision } : NOT_FOUND;
    }
    if (c === 'activity' && d === undefined) {
      const daysParam = params.get('days');
      if (daysParam !== null && (!/^[0-9]+$/.test(daysParam) || Number(daysParam) < 1 || Number(daysParam) > 366)) return badRequest('days must be an integer from 1 to 366');
      const r = await repository.getActivity(b, daysParam !== null ? { days: Number(daysParam) } : {});
      if (!r.ok) return NOT_FOUND;
      const { added, removed, net, minutes, sessions } = r.today;
      return { status: 200, body: { goal: r.goal, today: { added, removed, net, minutes, sessions }, days: r.days, streak: r.streak } };
    }
    if (c === 'entries' && d !== undefined && e === undefined) {
      const entry = await repository.getEntry(b, d);
      return entry ? { status: 200, body: entry } : NOT_FOUND;
    }
    if (c === 'entries' && d !== undefined && e === 'image' && f === undefined) return handleEntryImage(repository, b, d, params);
    // M04-J03: threads with their scene lists and the scenes' planning fields; one thread with its text
    if (c === 'threads' && d === undefined) {
      const planning = await repository.listThreads(b);
      return planning ? { status: 200, body: planning } : NOT_FOUND;
    }
    if (c === 'threads' && d !== undefined && e === undefined) {
      const thread = await repository.getThread(b, d);
      return thread ? { status: 200, body: thread } : NOT_FOUND;
    }
    // M04-J04: the timeline, events, notes (research, planning docs, sources), scene notes and attachments
    if (c === 'timeline' && d === undefined) {
      const timeline = await repository.getTimeline(b);
      return timeline ? { status: 200, body: timeline } : NOT_FOUND;
    }
    if (c === 'events' && d !== undefined && e === undefined) {
      const event = await repository.getEvent(b, d);
      return event ? { status: 200, body: event } : NOT_FOUND;
    }
    if (c === 'notes' && d === undefined) {
      const notes = await repository.listNotes(b);
      return notes ? { status: 200, body: notes } : NOT_FOUND;
    }
    if (c === 'notes' && d !== undefined && e === undefined) {
      const note = await repository.getNote(b, d);
      return note ? { status: 200, body: note } : NOT_FOUND;
    }
    if (c === 'scene-notes' && d === undefined) {
      const notes = await repository.getSceneNotes(b);
      return notes ? { status: 200, body: notes } : NOT_FOUND;
    }
    if (c === 'attachments' && d === undefined) return handleAttachment(repository, b, params);
    if (c === 'graph' && d === undefined) {
      const kindsParam = params.get('kinds');
      let kinds;
      if (kindsParam !== null) {
        kinds = kindsParam.split(',').map((k) => k.trim()).filter(Boolean);
        if (kinds.length === 0 || kinds.some((k) => !GRAPH_EDGE_KINDS.includes(k))) return badRequest(`kinds must be a comma-separated list of: ${GRAPH_EDGE_KINDS.join(', ')}`);
      }
      const node = params.get('node');
      const graph = await repository.getGraph(b, { ...(node !== null ? { node } : {}), ...(kinds ? { kinds } : {}) });
      return graph ? { status: 200, body: graph } : NOT_FOUND;
    }
    if (c === 'codex' && d === 'types' && e === undefined) {
      const types = await repository.getCodexTypes(b);
      return types ? { status: 200, body: types } : NOT_FOUND;
    }
    if (c === 'codex' && d === 'entries' && e === undefined) {
      const list = await repository.listCodexEntries(b);
      return list ? { status: 200, body: list } : NOT_FOUND;
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

/**
 * GET /api/books/:b/attachments?path=assets/...: a file of the book's assets/ folder. Only an allowlisted extension (png jpg jpeg webp gif pdf txt md csv; never SVG)
 * whose real path is inside assets/ is served; images inline, everything else as a download; always nosniff and a sandboxing CSP. Anything else is 404.
 */
async function handleAttachment(repository, bookId, params) {
  const file = params.get('path');
  if (file === null) return badRequest('path is required');
  const a = await repository.getAttachment(bookId, file);
  if (!a || 'error' in a) return NOT_FOUND;
  const name = a.name.replace(/[^A-Za-z0-9._-]/g, '_');
  return {
    status: 200,
    body: null,
    raw: {
      bytes: a.bytes,
      headers: {
        'content-type': a.contentType,
        'x-content-type-options': 'nosniff',
        'content-disposition': a.inline ? `inline; filename="${name}"` : `attachment; filename="${name}"`,
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'no-cache',
      },
    },
  };
}

/** GET /api/books/:b/entries/:id/image[?v=<sha8>]: the image bytes of an entry's `image` field (only a supported image under assets/). */
async function handleEntryImage(repository, bookId, ref, params) {
  const image = await repository.getEntryImage(bookId, ref);
  if (!image) return NOT_FOUND;
  if ('error' in image) return { status: 404, body: { error: 'too_large' } };
  const current = params.get('v') === image.sha256.slice(0, 8);
  return {
    status: 200,
    body: null,
    raw: {
      bytes: image.bytes,
      headers: {
        'content-type': image.contentType,
        'x-content-type-options': 'nosniff',
        'cache-control': current ? 'private, max-age=31536000, immutable' : 'no-cache',
      },
    },
  };
}

const OBJECT_KINDS = ['entry', 'thread', 'event'];
const GRAPH_EDGE_KINDS = ['explicit', 'inferred'];
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
 * @returns {{ route: string, bookId?: string, sceneId?: string, entryId?: string, threadId?: string, eventId?: string, noteId?: string, n?: string, opId?: string, file?: string } | null}
 */
export function matchWriteRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean).map(decode);
  if (parts.some((p) => p === null) || parts[0] !== 'api') return null;
  const [, a, b, c, d, e, f, g, ...rest] = /** @type {string[]} */ (parts);
  if (rest.length > 0) return null;
  if ((f !== undefined || g !== undefined) && !(a === 'books' && c === 'scenes' && e === 'revisions')) return null;
  if (method === 'POST' && a === 'recover' && b === undefined) return { route: 'recover' };
  if (method === 'POST' && a === 'index' && b === 'rebuild' && c === undefined) return { route: 'index-rebuild' };
  if (method === 'POST' && a === 'books' && b === undefined) return { route: 'book-create' };
  if (method === 'POST' && a === 'library' && b === 'open' && c === undefined) return { route: 'library-open' };
  if (method === 'POST' && a === 'library' && b === 'recent' && c === 'remove' && d === undefined) return { route: 'recent-remove' };
  if (a !== 'books' || b === undefined || c === undefined) return null;
  if (method === 'POST' && c === 'repair' && d === undefined) return { route: 'repair', bookId: b };
  // M03-J04
  if (method === 'POST' && c === 'activity' && d === 'session' && e === undefined) return { route: 'activity-session', bookId: b };
  if (method === 'POST' && c === 'goal' && d === undefined) return { route: 'goal', bookId: b };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'revisions' && f === undefined) return { route: 'revision-save', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'revisions' && f !== undefined && g === 'restore') return { route: 'revision-restore', bookId: b, sceneId: d, file: f };
  if (method === 'PUT' && c === 'scenes' && d !== undefined && e === 'body') return { route: 'body', bookId: b, sceneId: d };
  if (method === 'PUT' && c === 'scenes' && d !== undefined && e === 'raw') return { route: 'scene-raw', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d === undefined) return { route: 'create', bookId: b };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'archive') return { route: 'archive', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'archive' && d === 'restore' && e === undefined) return { route: 'restore', bookId: b };
  // M03-J01 structure commands (all POST; `dryRun: true` in the body previews without writing)
  if (method === 'POST' && c === 'scenes' && d === 'merge' && e === undefined) return { route: 'scene-merge', bookId: b };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'fields') return { route: 'scene-fields', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'move') return { route: 'scene-move', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'scenes' && d !== undefined && e === 'split') return { route: 'scene-split', bookId: b, sceneId: d };
  if (method === 'POST' && c === 'chapters' && d === undefined) return { route: 'chapter-create', bookId: b };
  if (method === 'POST' && c === 'chapters' && d === 'renumber' && e === undefined) return { route: 'chapters-renumber', bookId: b };
  if (method === 'POST' && c === 'chapters' && d !== undefined && e === 'fields') return { route: 'chapter-fields', bookId: b, n: d };
  if (method === 'POST' && c === 'chapters' && d !== undefined && e === 'archive') return { route: 'chapter-archive', bookId: b, n: d };
  if (method === 'POST' && c === 'acts' && d === undefined) return { route: 'act-create', bookId: b };
  if (method === 'POST' && c === 'acts' && d !== undefined && e === 'fields') return { route: 'act-fields', bookId: b, n: d };
  if (method === 'POST' && c === 'ops' && d !== undefined && e === 'restore') return { route: 'op-restore', bookId: b, opId: d };
  // M04-J02 Codex entries and types
  if (method === 'POST' && c === 'entries' && d === undefined) return { route: 'entry-create', bookId: b };
  if (method === 'POST' && c === 'entries' && d === 'restore' && e === undefined) return { route: 'entry-restore', bookId: b };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'fields') return { route: 'entry-fields', bookId: b, entryId: d };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'slug') return { route: 'entry-slug', bookId: b, entryId: d };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'archive') return { route: 'entry-archive', bookId: b, entryId: d };
  if (method === 'POST' && c === 'entries' && d !== undefined && e === 'restore') return { route: 'entry-restore', bookId: b, entryId: d };
  if (method === 'PUT' && c === 'entries' && d !== undefined && e === 'body') return { route: 'entry-body', bookId: b, entryId: d };
  if (method === 'POST' && c === 'codex' && d === 'types' && e === undefined) return { route: 'codex-type-create', bookId: b };
  // M04-J03 plot threads
  if (method === 'POST' && c === 'threads' && d === undefined) return { route: 'thread-create', bookId: b };
  if (method === 'POST' && c === 'threads' && d !== undefined && e === 'fields') return { route: 'thread-fields', bookId: b, threadId: d };
  if (method === 'PUT' && c === 'threads' && d !== undefined && e === 'body') return { route: 'thread-body', bookId: b, threadId: d };
  // M04-J04 timeline events, notes / planning docs / sources, attachments
  if (method === 'POST' && c === 'events' && d === undefined) return { route: 'event-create', bookId: b };
  if (method === 'POST' && c === 'events' && d === 'restore' && e === undefined) return { route: 'event-restore', bookId: b };
  if (method === 'POST' && c === 'events' && d !== undefined && e === 'fields') return { route: 'event-fields', bookId: b, eventId: d };
  if (method === 'POST' && c === 'events' && d !== undefined && e === 'archive') return { route: 'event-archive', bookId: b, eventId: d };
  if (method === 'POST' && c === 'events' && d !== undefined && e === 'restore') return { route: 'event-restore', bookId: b, eventId: d };
  if (method === 'PUT' && c === 'events' && d !== undefined && e === 'body') return { route: 'event-body', bookId: b, eventId: d };
  if (method === 'POST' && c === 'notes' && d === undefined) return { route: 'note-create', bookId: b };
  if (method === 'POST' && c === 'notes' && d !== undefined && e === 'fields') return { route: 'note-fields', bookId: b, noteId: d };
  if (method === 'POST' && c === 'notes' && d !== undefined && e === 'archive') return { route: 'note-archive', bookId: b, noteId: d };
  if (method === 'POST' && c === 'notes' && d !== undefined && e === 'restore') return { route: 'note-restore', bookId: b, noteId: d };
  if (method === 'PUT' && c === 'notes' && d !== undefined && e === 'body') return { route: 'note-body', bookId: b, noteId: d };
  // M05-J02 continuity exceptions
  if (method === 'POST' && c === 'continuity' && d === 'exceptions' && e === undefined) return { route: 'continuity-exception-create', bookId: b };
  if (method === 'DELETE' && c === 'continuity' && d === 'exceptions' && e !== undefined && f === undefined) return { route: 'continuity-exception-archive', bookId: b, slug: e };
  if (method === 'POST' && c === 'attachments' && d === undefined) return { route: 'attachment-upload', bookId: b };
  return null;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Map a core write result to an HTTP result. @param {any} r @param {number} okStatus @param {(r: any) => unknown} okBody */
function respond(r, okStatus, okBody) {
  if (r.ok) return { status: okStatus, body: okBody(r) };
  if (r.code === 'NOT_FOUND') return NOT_FOUND;
  if (r.code === 'CONFLICT') return { status: 409, body: { error: 'conflict', current: r.current ?? null } };
  const detail = { code: r.code, ...(r.message ? { message: r.message } : {}), ...(r.diagnostics?.length ? { diagnostics: r.diagnostics } : {}) };
  const conflicting = ['EXISTS', 'ROLLED_BACK', 'REFUSED_PATH_TAKEN', 'REFUSED_DUPLICATE_ID', 'REFUSED_STALE_ACTION', 'NO_CHAPTER_GAP', 'REFUSED_FILES_CHANGED', 'REFUSED_TRASH_MISSING', 'REFUSED_NOT_UNDOABLE', 'SLUG_TAKEN', 'TYPE_EXISTS', 'CITE_KEY_TAKEN'].includes(r.code);
  return { status: conflicting ? 409 : 400, body: { error: conflicting ? 'conflict' : 'refused', ...detail } };
}

/** Like respond(), with the continuity refusals named by their codes: 404 FINDING_NOT_FOUND, 409 ALREADY_EXCEPTED, 400 RATIONALE_REQUIRED. */
function respondContinuity(r, okStatus, okBody) {
  if (r.ok) return { status: okStatus, body: okBody(r) };
  const named = { FINDING_NOT_FOUND: 404, ALREADY_EXCEPTED: 409, RATIONALE_REQUIRED: 400 };
  if (named[r.code]) return { status: named[r.code], body: { error: r.code, code: r.code, message: r.message } };
  return respond(r, okStatus, okBody);
}

/**
 * @param {FileRepository} repository
 * @param {{ route: string, bookId?: string, sceneId?: string, entryId?: string, threadId?: string, n?: string, opId?: string, file?: string }} match from matchWriteRoute
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
    case 'book-create': {
      const r = await repository.createBook(body);
      if (r.ok) return { status: 201, body: { ok: true, bookId: r.bookId, path: r.path } };
      const taken = ['FOLDER_EXISTS', 'SLUG_TAKEN', 'SERIES_NUMBER_TAKEN'].includes(r.code);
      const mine = ['BAD_TITLE', 'BAD_SLUG', 'NO_SUCH_SERIES', 'NO_SUCH_PEN_NAME', 'NO_SUCH_TEMPLATE', 'OUTSIDE_ROOT'].includes(r.code);
      return {
        status: taken ? 409 : mine ? 400 : 500,
        body: { ok: false, code: r.code, field: r.field ?? null, message: r.message ?? '', ...(r.diagnostics?.length ? { diagnostics: r.diagnostics } : {}) },
      };
    }
    case 'library-open': {
      if (!state?.host) return NOT_SUPPORTED;
      if (typeof body.path !== 'string' || body.path.trim() === '') return badRequest('path is required');
      const r = await state.host.open(body.path);
      if (r.ok) {
        if (r.recover) state.lastRecover = r.recover;
        state.instance = { ...(state.instance ?? { pid: process.pid, started_at: new Date().toISOString() }), lock: r.lock };
        return { status: 200, body: { ok: true, library: r.library } };
      }
      const status = r.code === 'LOCKED' ? 409 : r.code === 'OPEN_FAILED' ? 500 : 400;
      return { status, body: { ok: false, code: r.code, message: r.message, ...(r.holder !== undefined ? { holder: r.holder } : {}) } };
    }
    case 'recent-remove': {
      if (!state?.host) return NOT_SUPPORTED;
      if (typeof body.path !== 'string' || body.path.trim() === '') return badRequest('path is required');
      await state.host.removeRecent(body.path);
      return { status: 200, body: { ok: true } };
    }
    case 'repair': {
      if (!Array.isArray(body.actions)) return badRequest('expected { actions: [...] }');
      const r = await repository.applyRepair(bookId, body.actions);
      return respond(r, 200, (x) => ({ ok: true, changes: x.changes ?? [], opId: x.opId ?? null }));
    }
    case 'body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateSceneBody(bookId, /** @type {string} */ (match.sceneId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: x.words ?? { added: 0, removed: 0 } }));
    }
    case 'entry-body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateEntryBody(bookId, /** @type {string} */ (match.entryId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: { added: 0, removed: 0 } }));
    }
    case 'thread-body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateThreadBody(bookId, /** @type {string} */ (match.threadId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: { added: 0, removed: 0 } }));
    }
    case 'event-body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateEventBody(bookId, /** @type {string} */ (match.eventId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: { added: 0, removed: 0 } }));
    }
    case 'note-body': {
      if (typeof body.body !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { body: string, base_sha256: string }');
      const r = await repository.updateNoteBody(bookId, /** @type {string} */ (match.noteId), body.body, { baseSha256: body.base_sha256 });
      return respond(r, 200, (x) => ({ sha256: x.sha256, words: { added: 0, removed: 0 } }));
    }
    case 'activity-session': {
      if (!Number.isInteger(body.minutes)) return badRequest('expected { minutes: integer >= 1 }');
      const r = await repository.recordSession(bookId, /** @type {number} */ (body.minutes));
      return respond(r, 200, () => ({ ok: true }));
    }
    case 'goal': {
      if (body.daily_word_goal === undefined || (body.daily_word_goal !== null && !Number.isInteger(body.daily_word_goal))) {
        return badRequest('expected { daily_word_goal: integer >= 1 }');
      }
      const r = await repository.setDailyGoal(bookId, body.daily_word_goal);
      return respond(r, 200, (x) => ({ ok: true, daily_word_goal: x.daily_word_goal }));
    }
    case 'revision-save': {
      if (body.label !== undefined && typeof body.label !== 'string') return badRequest('label must be a string');
      if (body.reason !== undefined && body.reason !== 'manual' && body.reason !== 'external') return badRequest("reason must be 'manual' or 'external'");
      const r = await repository.saveRevision(bookId, /** @type {string} */ (match.sceneId), { label: body.label, ...(body.reason !== undefined ? { reason: body.reason } : {}) });
      return respond(r, r.ok && r.stored ? 201 : 200, (x) => ({ ok: true, stored: x.stored, revision: x.revision }));
    }
    case 'revision-restore': {
      if (body.mode !== 'into' && body.mode !== 'new') return badRequest("mode must be 'into' or 'new'");
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      if (body.mode === 'into' && body.base_sha256 === undefined) return badRequest('expected { mode, base_sha256: string }');
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const dryRun = body.dryRun === true;
      const r = await repository.restoreRevision(bookId, /** @type {string} */ (match.sceneId), /** @type {string} */ (match.file), { mode: body.mode, baseSha256: body.base_sha256, dryRun });
      return respond(r, body.mode === 'new' && !dryRun ? 201 : 200, structureBody);
    }
    case 'scene-raw': {
      if (typeof body.content !== 'string' || typeof body.base_sha256 !== 'string') return badRequest('expected { content: string, base_sha256: string }');
      const r = await repository.writeSceneRaw(bookId, /** @type {string} */ (match.sceneId), body.content, { baseSha256: body.base_sha256 });
      if (!r.ok && r.code === 'ROLLED_BACK') {
        // the edit would leave the book with new errors: nothing was kept
        return { status: 422, body: { error: 'invalid', code: r.code, message: r.message ?? 'the change would introduce new errors', diagnostics: r.diagnostics ?? [] } };
      }
      return respond(r, 200, (x) => ({ sha256: x.sha256 }));
    }
    case 'create': {
      const { chapter, act, after, title, slug, body: text, status, summary } = body;
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const dryRun = body.dryRun === true;
      const r = await repository.createScene(bookId, { chapter, act, after, title, slug, body: text, ...(status !== undefined ? { status } : {}), ...(summary !== undefined ? { summary } : {}), dryRun });
      return dryRun ? respond(r, 200, structureBody) : respond(r, 201, (x) => ({ id: x.id, path: x.path }));
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
      return handleStructure(repository, match, body);
  }
}

/** A chapter / act number from a URL segment (digits only), or null. */
const numberOf = (n) => (typeof n === 'string' && /^\d+$/.test(n) ? Number(n) : null);

/** Body of a successful structure command: everything the command reported, without the code. */
const structureBody = (x) => {
  return { ...x, ok: true, code: undefined };
};

/**
 * POST structure commands (M03-J01). `dryRun: true` previews: { ok, changes: [{ from, to, before_sha256, after_sha256, diff }] }.
 * @param {FileRepository} repository @param {{ route: string, bookId?: string, sceneId?: string, n?: string, opId?: string }} match @param {Record<string, any>} body
 */
async function handleStructure(repository, match, body) {
  const bookId = /** @type {string} */ (match.bookId);
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
  const dryRun = body.dryRun === true;
  const created = dryRun ? 200 : 201;
  const num = numberOf(match.n);
  switch (match.route) {
    case 'scene-fields': {
      const { title, status, pov, summary, renameFile } = body;
      const r = await repository.setSceneFields(bookId, /** @type {string} */ (match.sceneId), { title, status, pov, summary, renameFile: renameFile === true, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'scene-move': {
      // M03-J03: { chapter, act?, after: sceneId | null, dryRun? } -> { ok, code, changes, undo }
      if (!Number.isInteger(body.chapter) || body.chapter < 0) return badRequest('expected { chapter: integer >= 0 }');
      if (body.act !== undefined && (!Number.isInteger(body.act) || body.act < 0)) return badRequest('act must be an integer >= 0');
      if (body.after === undefined || (body.after !== null && typeof body.after !== 'string')) return badRequest('after must be a scene id or null');
      const r = await repository.moveScene(bookId, /** @type {string} */ (match.sceneId), {
        chapter: body.chapter,
        ...(body.act !== undefined ? { act: body.act } : {}),
        after: body.after,
        ...(body.expect !== undefined ? { expect: body.expect } : {}),
        dryRun,
      });
      if (!r.ok && r.code === 'CONFLICT') return { status: 409, body: { error: 'conflict', code: 'CONFLICT', ...(r.changed ? { changed: r.changed } : {}), message: r.message ?? 'A file changed on disk since it was read; nothing was written.' } };
      if (!r.ok && r.code === 'REFUSED_INVALID_BOOK') {
        return { status: 409, body: { error: 'refused', code: r.code, message: r.message ?? 'book has manuscript errors', diagnostics: r.diagnostics ?? [] } };
      }
      return respond(r, 200, (x) => ({ ok: true, code: 'OK', ...(x.dryRun ? { dryRun: true } : {}), changes: x.changes ?? [], undo: x.undo ?? null, id: x.id, path: x.path, sequence: x.sequence, opId: x.opId ?? null }));
    }
    case 'scene-split': {
      if (!Number.isInteger(body.atLine)) return badRequest('expected { atLine: integer }');
      const r = await repository.splitScene(bookId, /** @type {string} */ (match.sceneId), { atLine: body.atLine, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'scene-merge': {
      if (typeof body.first !== 'string' || typeof body.second !== 'string') return badRequest('expected { first: string, second: string }');
      const r = await repository.mergeScenes(bookId, { first: body.first, second: body.second, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'chapter-create': {
      const { act, after, title } = body;
      const r = await repository.createChapter(bookId, { act, after, title, dryRun });
      return respond(r, created, structureBody);
    }
    case 'chapter-fields': {
      if (num === null) return NOT_FOUND;
      const r = await repository.setChapterFields(bookId, num, { title: body.title, label: body.label, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'chapter-archive': {
      if (num === null) return NOT_FOUND;
      const r = await repository.archiveChapter(bookId, num, { dryRun });
      return respond(r, 200, structureBody);
    }
    case 'chapters-renumber': {
      const r = await repository.renumberChapters(bookId, { step: body.step, dryRun });
      return respond(r, 200, structureBody);
    }
    case 'act-create': {
      const r = await repository.createAct(bookId, { title: body.title, dryRun });
      return respond(r, created, structureBody);
    }
    case 'act-fields': {
      if (num === null) return NOT_FOUND;
      const r = await repository.setActFields(bookId, num, { title: body.title, dryRun });
      return respond(r, 200, structureBody);
    }
    // ---- M04-J02 Codex. `base_sha256` (optional) is the file as the author saw it: a different file on disk is a 409.
    case 'entry-create': {
      const r = await repository.createEntry(bookId, { type: body.type, name: body.name, slug: body.slug, status: body.status, fields: body.fields, dryRun });
      return respond(r, created, structureBody);
    }
    case 'entry-fields': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.setEntryFields(bookId, /** @type {string} */ (match.entryId), { name: body.name, status: body.status, role: body.role, aliases: body.aliases, fields: body.fields, related: body.related, dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'entry-slug': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.changeEntrySlug(bookId, /** @type {string} */ (match.entryId), { slug: body.slug, dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'entry-archive': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.archiveEntry(bookId, /** @type {string} */ (match.entryId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'entry-restore': {
      // POST /entries/:id/restore, or POST /entries/restore with { path } (the archived file) or { id }
      const ref = match.entryId ?? body.path ?? body.id;
      if (typeof ref !== 'string' || ref === '') return badRequest('expected { path: string } or { id: string }');
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.restoreEntry(bookId, ref, { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'codex-type-create': {
      const r = await repository.createCodexType(bookId, { type: body.type, name: body.name, plural: body.plural, fields: body.fields, dryRun });
      return respond(r, created, structureBody);
    }
    // ---- M04-J03 plot threads. `base_sha256` (optional) is the file as the author saw it: a different file on disk is a 409.
    case 'thread-create': {
      const r = await repository.createThread(bookId, { title: body.title, slug: body.slug, kind: body.kind, status: body.status, dryRun });
      return respond(r, created, structureBody);
    }
    case 'thread-fields': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.setThreadFields(bookId, /** @type {string} */ (match.threadId), { status: body.status, setup: body.setup, develop: body.develop, payoff: body.payoff, characters: body.characters, add: body.add, remove: body.remove, dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    // ---- M04-J04 events and notes. `base_sha256` (optional) is the file as the author saw it: a different file on disk is a 409.
    case 'event-create': {
      const r = await repository.createEvent(bookId, { title: body.title, slug: body.slug, order: body.order, when: body.when, date: body.date, scenes: body.scenes, characters: body.characters, locations: body.locations, dryRun });
      return respond(r, created, structureBody);
    }
    case 'event-fields': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.setEventFields(bookId, /** @type {string} */ (match.eventId), {
        title: body.title,
        when: body.when,
        date: body.date,
        order: body.order,
        scenes: body.scenes,
        characters: body.characters,
        locations: body.locations,
        add: body.add,
        remove: body.remove,
        ...(body.two_sided !== undefined ? { twoSided: body.two_sided } : {}),
        dryRun,
        baseSha256: body.base_sha256,
      });
      return respond(r, 200, structureBody);
    }
    case 'event-archive': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.archiveEvent(bookId, /** @type {string} */ (match.eventId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'event-restore': {
      const ref = match.eventId ?? body.path ?? body.id;
      if (typeof ref !== 'string' || ref === '') return badRequest('expected { path: string } or { id: string }');
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.restoreEvent(bookId, ref, { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'note-create': {
      const { kind, title, slug, tags, links, sources, canon, cite_key: citeKey, type, author, year, publisher, url, accessed, locator } = body;
      const r = await repository.createNote(bookId, { kind, title, slug, tags, links, sources, canon, cite_key: citeKey, type, author, year, publisher, url, accessed, locator, dryRun });
      return respond(r, created, structureBody);
    }
    case 'note-fields': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const { title, canon, locked, tags, links, sources, type, author, year, publisher, url, accessed, locator } = body;
      const r = await repository.setNoteFields(bookId, /** @type {string} */ (match.noteId), { title, canon, locked, tags, links, sources, type, author, year, publisher, url, accessed, locator, dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'note-archive': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.archiveNote(bookId, /** @type {string} */ (match.noteId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    case 'note-restore': {
      if (body.base_sha256 !== undefined && typeof body.base_sha256 !== 'string') return badRequest('base_sha256 must be a string');
      const r = await repository.restoreNote(bookId, /** @type {string} */ (match.noteId), { dryRun, baseSha256: body.base_sha256 });
      return respond(r, 200, structureBody);
    }
    // ---- M05-J02 continuity exceptions: the only files these routes write are planning/continuity/<slug>.md (archive/ when removed)
    case 'continuity-exception-create': {
      for (const k of ['fingerprint', 'rationale', 'title']) if (body[k] !== undefined && typeof body[k] !== 'string') return badRequest(`${k} must be a string`);
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const r = await repository.createContinuityException(bookId, { fingerprint: body.fingerprint, rationale: body.rationale, title: body.title, dryRun: body.dryRun === true });
      return respondContinuity(r, body.dryRun === true ? 200 : 201, (x) => (x.dryRun ? { ok: true, dryRun: true, file: x.file, slug: x.slug, text: x.text, changes: x.changes } : { ok: true, file: x.file, slug: x.slug, opId: x.opId ?? null, undo: x.undo ?? null }));
    }
    case 'continuity-exception-archive': {
      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return badRequest('dryRun must be a boolean');
      const r = await repository.archiveContinuityException(bookId, /** @type {string} */ (match.slug), { dryRun: body.dryRun === true });
      return respondContinuity(r, 200, (x) => (x.dryRun ? { ok: true, dryRun: true, archived: x.archived, changes: x.changes } : { ok: true, archived: x.archived, opId: x.opId ?? null, undo: x.undo ?? null }));
    }
    case 'op-restore': {
      const r = await repository.restoreOp(bookId, /** @type {string} */ (match.opId), { dryRun });
      return respond(r, 200, structureBody);
    }
    default:
      return NOT_FOUND;
  }
}

/**
 * POST /api/books/:b/attachments?name=<file name>[&note=<book-relative note path or note id>]: the raw bytes of one file (at most 25 MB; the caller has already
 * limited the body). 201 { path, name, markdown } with the link to insert in the note; 400 bad name or empty; 413 too large; 415 type not allowed.
 * @param {FileRepository} repository @param {{ bookId?: string }} match @param {{ name: string | null, note: string | null, bytes: Buffer }} upload
 * @returns {Promise<ApiResult>}
 */
export async function handleUpload(repository, match, { name, note, bytes }) {
  if (name === null || name.trim() === '') return badRequest('name is required (the file name)');
  const r = await repository.uploadAttachment(/** @type {string} */ (match.bookId), { name, bytes, ...(note !== null ? { note } : {}) });
  if (r.ok) return { status: 201, body: { ok: true, path: r.path, name: r.name, markdown: r.markdown } };
  if (r.code === 'NOT_FOUND') return NOT_FOUND;
  const status = r.code === 'TOO_LARGE' ? 413 : r.code === 'UNSUPPORTED_TYPE' ? 415 : r.code === 'REFUSED_PATH_TAKEN' ? 409 : 400;
  const error = status === 413 ? 'too_large' : status === 415 ? 'unsupported_type' : status === 409 ? 'conflict' : 'refused';
  return { status, body: { error, code: r.code, ...(r.message ? { message: r.message } : {}) } };
}
