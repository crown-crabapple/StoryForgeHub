// Per-book access for shared-mode members (a member with a book list; see policy.mjs isLimited). policy.mjs already refuses every route about a book the
// member has no role on, and every non-read route about no book. This file covers the rest:
//  1. the reads about no book: only a known list of them is open to a limited member, and each answer is narrowed to the member's books (fail closed: a row
//     without a recognisable book id is dropped);
//  2. a `book` query parameter must name one of the member's books;
//  3. series data: shared series entries, types and labels belong to every book of the series, so only a member with every book may change them.
// Owners, members with every book, share links and personal mode never reach this file's checks.
import { isLimited, roleOnBook } from './policy.mjs';

const FORBIDDEN = { status: 403, body: { error: 'forbidden', code: 'BOOK_ACCESS', message: 'you do not have access to that book' } };
const SERIES_ONLY_ALL = { status: 403, body: { error: 'forbidden', code: 'SERIES_ACCESS', message: 'shared series data changes every book of the series; only a member with access to all books can change it' } };

/** @param {any} p @param {unknown} id */
const has = (p, id) => typeof id === 'string' && roleOnBook(p, id) !== null;

/** The reads about no book that a limited member may make, and how each answer is narrowed. */
const NARROW = {
  /** GET /api/books: the member's books only */
  '/api/books': (/** @type {any} */ p, /** @type {any} */ body) => (Array.isArray(body) ? body.filter((b) => has(p, b?.id)) : []),
  /** GET /api/search: hits from the member's books only */
  '/api/search': (/** @type {any} */ p, /** @type {any} */ body) => (Array.isArray(body) ? body.filter((h) => has(p, h?.book_id)) : []),
  /** GET /api/status: the member's books; the recovery lists name files of any book, so they are left out */
  '/api/status': (/** @type {any} */ p, /** @type {any} */ body) => ({ ...body, books: (body?.books ?? []).filter((/** @type {any} */ b) => has(p, b?.book_id)), recover: { needsAttention: [], rolledBack: [] } }),
  /** GET /api/index/status */
  '/api/index/status': (/** @type {any} */ p, /** @type {any} */ body) => (Array.isArray(body) ? body.filter((b) => has(p, b?.book_id)) : []),
  /** GET /api/library: the series the member has a book in (with only those books); the library-wide diagnostics name files of any book, so they are left out */
  '/api/library': (/** @type {any} */ p, /** @type {any} */ body) => ({
    ...body,
    diagnostics: [],
    series: (body?.series ?? [])
      .map((/** @type {any} */ s) => ({ ...s, book_ids: (s?.book_ids ?? []).filter((/** @type {unknown} */ id) => has(p, id)) }))
      .filter((/** @type {any} */ s) => s.book_ids.length > 0),
  }),
  // library settings, prompt components, templates and the health probe carry no book content
  '/api/preferences': null,
  '/api/prompts': null,
  '/api/templates': null,
  '/api/health': null,
};

/**
 * Before a GET is answered: may this member make it, and how must the answer be narrowed?
 * @param {any} principal @param {string} pathname @param {URLSearchParams} params
 * @returns {{ ok: true, narrow: ((body: any) => any) | null } | { ok: false, status: number, body: unknown }}
 */
export function scopeRead(principal, pathname, params) {
  if (!isLimited(principal)) return { ok: true, narrow: null };
  for (const b of params.getAll('book')) if (!has(principal, b)) return { ok: false, ...FORBIDDEN };
  const m = /^\/api\/books\/([^/]+)\/link-targets$/.exec(pathname);
  if (m) {
    // the link picker lists the other books' entries: only the member's books
    return { ok: true, narrow: (body) => (body && Array.isArray(body.books) ? { ...body, books: body.books.filter((/** @type {any} */ b) => has(principal, b?.id)) } : body) };
  }
  if (/^\/api\/books\/[^/]+\/series-plan$/.test(pathname)) {
    // Story Planner M8: the series view reads every book of the series: only the member's books, and how many were left out
    return {
      ok: true,
      narrow: (body) => {
        if (!body || !Array.isArray(body.books)) return body;
        const books = body.books.filter((/** @type {any} */ b) => has(principal, b?.id));
        const characters = (body.characters ?? [])
          .map((/** @type {any} */ c) => ({ ...c, books: (c?.books ?? []).filter((/** @type {any} */ b) => has(principal, b?.id)) }))
          .filter((/** @type {any} */ c) => c.books.length > 0);
        return { ...body, books, characters, hidden: (body.hidden ?? 0) + (body.books.length - books.length) };
      },
    };
  }
  if (pathname.startsWith('/api/books/')) return { ok: true, narrow: null }; // about one book: policy.mjs checked the role on it
  if (!Object.hasOwn(NARROW, pathname)) return { ok: false, ...FORBIDDEN }; // an unlisted read about no book: refused for a limited member
  const fn = NARROW[/** @type {keyof typeof NARROW} */ (pathname)];
  return { ok: true, narrow: fn ? (body) => fn(principal, body) : null };
}

/**
 * Before a write runs: a limited member may not change shared series data.
 * @param {any} principal @param {{ route: string, bookId?: string, entryId?: string, suggestionId?: string }} match @param {any} body
 * @param {any} repository
 * @returns {Promise<{ status: number, body: unknown } | null>} a refusal, or null to go ahead
 */
export async function guardSeriesWrite(principal, match, body, repository) {
  if (!isLimited(principal) || !match.bookId) return null;
  const b = body !== null && typeof body === 'object' ? body : {};
  const isSharedEntry = async (/** @type {unknown} */ id) => {
    if (typeof id !== 'string' || id === '') return false;
    const e = await repository.getEntry(match.bookId, id);
    return Boolean(e && e.shared);
  };
  switch (match.route) {
    case 'entry-move-to-series':
      return SERIES_ONLY_ALL;
    case 'entry-create':
    case 'codex-type-create':
      return b.where !== undefined && b.where !== 'book' ? SERIES_ONLY_ALL : null;
    case 'labels-set':
      return b.scope !== undefined && b.scope !== 'book' ? SERIES_ONLY_ALL : null;
    case 'entry-restore':
      // an archived entry cannot be looked up to tell a book entry from a series one, so restoring one needs access to all books
      return SERIES_ONLY_ALL;
    case 'entry-fields':
    case 'entry-slug':
    case 'entry-archive':
    case 'entry-body':
      return (await isSharedEntry(match.entryId)) ? SERIES_ONLY_ALL : null;
    case 'suggestion-create':
      return (await isSharedEntry(b.target)) ? SERIES_ONLY_ALL : null;
    case 'suggestion-decide':
    case 'suggestion-hunk-decide': {
      const got = await repository.getSuggestion(match.bookId, match.suggestionId);
      return got?.ok && (await isSharedEntry(got.suggestion?.target)) ? SERIES_ONLY_ALL : null;
    }
    default:
      return null;
  }
}
