// Small pure helpers for the manuscript tree and its structure commands.
import { postJson } from '../api.js';

export const STATUSES = ['outline', 'drafting', 'revised', 'final'];

export const bookUrl = (bookId, tail = '') => `/api/books/${encodeURIComponent(bookId)}${tail}`;

/** POST that never throws: a network failure is status 0. @returns {Promise<{ status: number, json: any }>} */
export async function send(url, body) {
  try {
    return await postJson(url, body);
  } catch {
    return { status: 0, json: null };
  }
}

/** A sentence for a failed write: why it was refused, in words the author can act on. */
export function explainFailure(status, json) {
  if (status === 0) return 'The server could not be reached.';
  if (status === 403) return 'The server refused the request.';
  const detail = json?.message ? `${json.message}` : null;
  if (json?.code === 'NO_CHAPTER_GAP') return detail ?? 'There is no free chapter number there. Renumber the chapters first.';
  if (json?.code === 'REFUSED_INVALID_BOOK') return 'This book has errors in its manuscript files; fix them first (see Diagnostics).';
  if (json?.code === 'CONFLICT') return 'A file changed on disk since it was read; nothing was written. Reload the page and try again.';
  if (json?.code === 'ROLLED_BACK') return `${detail ?? 'The change would have broken the book'}; nothing was changed.`;
  if (status === 404) return 'That item is not there any more. Reload the page.';
  return detail ?? `The change was not made (${json?.code ?? status}).`;
}

/** Lower-case ASCII slug (1-60 chars), 'untitled' if nothing usable is left. */
export function slugify(text) {
  const s = String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'untitled';
}

/** First letter of a POV slug, upper case ("maren-hollis" -> "M"). */
export const povInitial = (pov) => (typeof pov === 'string' && pov !== '' ? pov[0].toUpperCase() : '');

/** Words in a list of scenes. */
export const wordsOf = (scenes) => scenes.reduce((n, s) => n + s.word_count, 0);

/** "Chapter One: The Drowned Rows" */
export const chapterName = (ch) => (ch.title ? `${ch.label}: ${ch.title}` : ch.label);

/** "Act 1: Low Water" */
export const actName = (act) => (act.title ? `${act.label}: ${act.title}` : act.label);

/** A readable name for an archived scene file: its filename without number prefix and extension. */
export function archivedName(path) {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '').replace(/^\d+-/, '').replace(/-/g, ' ') || base;
}

/** The archived scenes of a book: excluded with reason 'archived'. */
export const archivedScenes = (book) => (book.excluded ?? []).filter((e) => e.reason === 'archived');

/** Path relative to the book root and relative to the library root, for a path the API gave. */
export function pathsOf(book, p) {
  const prefix = book.path ? `${book.path}/` : '';
  const inLibrary = prefix === '' || p.startsWith(prefix);
  return { bookRel: inLibrary && prefix ? p.slice(prefix.length) : p, libRel: inLibrary ? p : `${prefix}${p}` };
}
