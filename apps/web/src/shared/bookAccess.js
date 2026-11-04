// Per-book access: pure helpers for the Members page (form rows <-> the `books` map the server uses). `null` means every book.

/** Per-book roles a member can hold, lowest to highest. */
export const BOOK_ROLES = ['viewer', 'reviewer', 'editor'];

/** The form value for "this book is not shared with them". */
export const NO_ACCESS = 'none';

/**
 * Form rows ({ <book id>: 'none' | role }) to the books map the server takes. "No access" rows are dropped; unknown values are ignored.
 * @param {Record<string, string>} rows @returns {Record<string, string>}
 */
export function booksFromRows(rows) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [id, role] of Object.entries(rows ?? {})) if (BOOK_ROLES.includes(role)) out[id] = role;
  return out;
}

/**
 * Form rows for every book, starting from a books map (null = no rows picked yet).
 * @param {{ id: string }[]} bookList @param {Record<string, string> | null | undefined} map @returns {Record<string, string>}
 */
export function rowsFromBooks(bookList, map) {
  /** @type {Record<string, string>} */
  const rows = {};
  for (const b of bookList) rows[b.id] = map && BOOK_ROLES.includes(map[b.id]) ? map[b.id] : NO_ACCESS;
  return rows;
}

/** The highest role in a books map, or null when it is empty. @param {Record<string, string> | null | undefined} map @returns {string | null} */
export function highestRole(map) {
  let best = -1;
  for (const role of Object.values(map ?? {})) best = Math.max(best, BOOK_ROLES.indexOf(role));
  return best < 0 ? null : BOOK_ROLES[best];
}

/** Short words for a books map: "All books" or "Only 2 books". @param {Record<string, string> | null | undefined} map */
export function accessSummary(map) {
  if (!map) return 'All books';
  const n = Object.keys(map).length;
  return `Only ${n} ${n === 1 ? 'book' : 'books'}`;
}
