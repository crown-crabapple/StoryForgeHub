// Filtering, sorting, grouping and content-search merging for the library page. Pure functions.

export const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'planning', label: 'Planning' },
  { key: 'drafting', label: 'Drafting' },
  { key: 'revising', label: 'Revising' },
  { key: 'complete', label: 'Complete' },
];

export const SORTS = [
  { key: 'series', label: 'Series order' },
  { key: 'title', label: 'Title A–Z' },
];

/** Lower-case, no accents. @param {unknown} s */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const titleOf = (b) => fold(b.title ?? b.slug ?? b.id);

/** Series books first (by series slug, number, title), standalone last by title. */
function bySeriesOrder(a, b) {
  if ((a.series == null) !== (b.series == null)) return a.series == null ? 1 : -1;
  return cmp(a.series ?? '', b.series ?? '') || cmp(a.series_number ?? Infinity, b.series_number ?? Infinity) || cmp(titleOf(a), titleOf(b));
}

/** Does every word of `query` appear in the book's title, series or pen name? */
function matchesText(book, query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = fold([book.title, book.slug, book.series_title, book.series, book.pen_name_display, book.pen_name].filter(Boolean).join(' '));
  return terms.every((t) => hay.includes(t));
}

/**
 * The books the library shows, in order. Never changes its input.
 * @param {any[]} books /api/books
 * @param {{ query?: string, status?: string, showArchived?: boolean, sort?: 'series' | 'title', hits?: Record<string, any> | null }} [opts]
 *   `query` filters by title, series or pen name; `hits` (from mergeSearchHits) keeps only the books that
 *   have content matches (or are still being indexed); null/undefined means no content search is active.
 * @returns {any[]}
 */
export function filterBooks(books, { query = '', status = 'all', showArchived = false, sort = 'series', hits = null } = {}) {
  const kept = (books ?? []).filter(
    (b) =>
      (showArchived || !b.archived) &&
      (status === 'all' || b.status === status) &&
      matchesText(b, query) &&
      (!hits || Object.hasOwn(hits, b.id)),
  );
  return kept.sort(sort === 'title' ? (a, b) => cmp(titleOf(a), titleOf(b)) || cmp(a.id, b.id) : bySeriesOrder);
}

/**
 * Sections for the page: one per series, then the standalone books. Empty sections do not exist.
 * Books keep the order they came in; sections are ordered by series slug (by series title when sorting by title).
 * @param {any[]} books already filtered and sorted
 * @param {{ slug: string, title: string | null, status: string | null }[]} [series] from /api/library
 * @param {'series' | 'title'} [sort]
 * @returns {{ sections: { slug: string, title: string, status: string | null, books: any[] }[], standalone: any[] }}
 */
export function groupBooks(books, series = [], sort = 'series') {
  /** @type {Map<string, any[]>} */
  const bySeries = new Map();
  const standalone = [];
  for (const b of books) {
    if (b.series == null) standalone.push(b);
    else bySeries.set(b.series, [...(bySeries.get(b.series) ?? []), b]);
  }
  const sections = [...bySeries].map(([slug, list]) => {
    const info = (series ?? []).find((s) => s.slug === slug);
    return { slug, title: info?.title ?? list.find((b) => b.series_title)?.series_title ?? slug, status: info?.status ?? null, books: list };
  });
  sections.sort(sort === 'title' ? (a, b) => cmp(fold(a.title), fold(b.title)) || cmp(a.slug, b.slug) : (a, b) => cmp(a.slug, b.slug));
  return { sections, standalone };
}

/** "Book 2" for a book with a series number, else null. */
export const bookLabel = (b) => (b.series_number != null ? `Book ${b.series_number}` : null);

/** An index that can answer a search now (an invalid book still serves its last valid index). */
const searchable = (state) => state === undefined || state === 'fresh' || state === 'invalid';

/**
 * Turn /api/search results into per-book content matches for the library cards.
 * @param {{ book_id: string | null, snippet: string }[]} results
 * @param {any[]} books
 * @param {Record<string, string>} [indexStates] book id -> index state from /api/status
 * @returns {Record<string, { count: number, snippet: string | null, indexing: boolean }>} books without matches are
 *   absent, except books whose index is not fresh: those are `indexing` (shown, not hidden).
 */
export function mergeSearchHits(results, books, indexStates = {}) {
  /** @type {Record<string, { count: number, snippet: string | null, indexing: boolean }>} */
  const out = {};
  for (const r of results ?? []) {
    if (!r.book_id) continue;
    const prev = out[r.book_id];
    if (prev) prev.count += 1;
    else out[r.book_id] = { count: 1, snippet: r.snippet ?? null, indexing: false };
  }
  for (const b of books ?? []) {
    if (!out[b.id] && !searchable(indexStates[b.id])) out[b.id] = { count: 0, snippet: null, indexing: true };
  }
  return out;
}
