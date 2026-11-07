// The Series section of the Plan Overview (Story Planner M8): the request URL and the pure projections of GET /series-plan into table rows. Read-only.

const enc = encodeURIComponent;

/** @param {string} bookId */
export const seriesPlanUrl = (bookId) => `/api/books/${enc(bookId)}/series-plan`;

/** The books in series order (by number, those without a number last, then by title). @param {any} plan @returns {any[]} */
export function orderedBooks(plan) {
  return [...(plan?.books ?? [])].sort((a, b) => {
    const na = typeof a.series_number === 'number' ? a.series_number : Infinity;
    const nb = typeof b.series_number === 'number' ? b.series_number : Infinity;
    if (na !== nb) return na < nb ? -1 : 1;
    return String(a.title ?? '').localeCompare(String(b.title ?? ''));
  });
}

/**
 * One row per book in order: number, title, whether it is the book being planned, logline and the overview synopsis body (null when there is none).
 * @param {any} plan @param {string} currentBookId
 */
export function bookRows(plan, currentBookId) {
  return orderedBooks(plan).map((b) => ({
    id: b.id,
    number: typeof b.series_number === 'number' ? b.series_number : null,
    title: b.title || b.slug || 'Untitled book',
    current: b.id === currentBookId,
    logline: b.logline ?? '',
    synopsis: b.synopsis && typeof b.synopsis.body === 'string' && b.synopsis.body.trim() !== '' ? b.synopsis.body : null,
  }));
}

/** "start → end" with "…" for what is not written; "Arc planned" when neither is. @param {{ start?: string | null, end?: string | null } | undefined} arc */
export function arcText(arc) {
  const start = arc?.start ?? '';
  const end = arc?.end ?? '';
  if (!start && !end) return 'Arc planned';
  return `${start || '…'} → ${end || '…'}`;
}

/**
 * The shared characters: one row per character with an entry per book where it has an arc, in series order, each with that book's start → end.
 * @param {any} plan
 * @returns {{ id: string, name: string, books: { id: string, title: string, text: string }[] }[]}
 */
export function characterRows(plan) {
  const books = orderedBooks(plan);
  const position = new Map(books.map((b, i) => [b.id, i]));
  const byBook = new Map(books.map((b) => [b.id, b]));
  return (plan?.characters ?? []).map((c) => ({
    id: c.id,
    name: c.name || 'Unnamed character',
    books: [...(c.books ?? [])]
      .sort((x, y) => (position.get(x.id) ?? Infinity) - (position.get(y.id) ?? Infinity))
      .map((cb) => {
        const arc = (byBook.get(cb.id)?.arcs ?? []).find((a) => a.character?.id === c.id);
        return { id: cb.id, title: cb.title || byBook.get(cb.id)?.title || 'Untitled book', text: arcText(arc) };
      }),
  }));
}

/** The note about books the viewer may not read; '' when there are none. @param {number | undefined} hidden */
export function hiddenNote(hidden) {
  const n = typeof hidden === 'number' ? hidden : 0;
  if (n <= 0) return '';
  return `${n} ${n === 1 ? 'book you cannot see is' : 'books you cannot see are'} left out.`;
}
