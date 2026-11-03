// Loading a book through @storyforge/format and the rule-5 / rule-6 error checks.
// A book that sits directly inside a series folder is validated together with its series (the series folder is the validated root),
// because a single-book validation cannot see the series' shared entries: every bare link to one would read as E301.
// The result is then shown from the book's own point of view: paths relative to the book root, only this book's diagnostics.
import path from 'node:path';
import { extractDocs, extractLinks, extractShared, isFile, validate } from '@storyforge/format';

/** Strip the `<folder>/` a series-root validation puts in front of a book's paths. */
const strip = (prefix, p) => (typeof p === 'string' && p.startsWith(prefix) ? p.slice(prefix.length) : p);

/**
 * @param {string} bookRoot
 * @returns {Promise<{root:string, diagnostics:object[], book:any, docs:any[], links:any[], shared:any} | {error:{code:string, message:string}}>}
 *   `docs` / `links` are what the validator read for this book (paths relative to the book root); `shared` is the series' shared world the book sees (or null).
 */
export async function loadBook(bookRoot) {
  if (typeof bookRoot !== 'string' || bookRoot === '') {
    return { error: { code: 'REFUSED_NOT_A_BOOK', message: 'bookRoot must be a path' } };
  }
  const root = path.resolve(bookRoot);
  let result;
  try {
    result = await validate(root);
  } catch (e) {
    return { error: { code: 'REFUSED_NOT_A_BOOK', message: String(e?.message ?? e) } };
  }
  if (result.books.length !== 1 || result.books[0].path !== '') {
    return { error: { code: 'REFUSED_NOT_A_BOOK', message: `${bookRoot} is not a single book root (book.md missing)` } };
  }
  const folder = path.basename(root);
  const parent = path.dirname(root);
  if (await isFile(path.join(parent, 'series.md')).catch(() => false)) {
    try {
      const inSeries = await validate(parent);
      const book = inSeries.books.find((b) => b.path === folder);
      if (book) {
        const prefix = `${folder}/`;
        const own = inSeries.diagnostics.filter((d) => d.file.startsWith(prefix)).map((d) => ({ ...d, file: strip(prefix, d.file) }));
        const view = {
          ...book,
          path: '',
          order: book.order.map((s) => ({ ...s, path: strip(prefix, s.path) })),
          excluded: book.excluded.map((s) => ({ ...s, path: strip(prefix, s.path) })),
        };
        return { root, diagnostics: own, book: view, docs: extractDocs(inSeries, folder), links: extractLinks(inSeries, folder), shared: extractShared(inSeries, folder) };
      }
    } catch {
      // fall back to the book on its own
    }
  }
  return { root, diagnostics: result.diagnostics, book: result.books[0], docs: extractDocs(result, ''), links: extractLinks(result, ''), shared: null };
}

/**
 * The shared world of the series whose folder is `seriesRoot`, validated with its books (a change to a shared file can break a book's link).
 * @param {string} seriesRoot
 * @returns {Promise<{root:string, diagnostics:object[], docs:any[], links:any[], series:any, books:any[]} | {error:{code:string, message:string}}>}
 *   `docs` / `links` are the shared entries and type files and the links they make; paths are relative to the series folder.
 */
export async function loadSeries(seriesRoot) {
  if (typeof seriesRoot !== 'string' || seriesRoot === '') return { error: { code: 'REFUSED_NOT_A_SERIES', message: 'seriesRoot must be a path' } };
  const root = path.resolve(seriesRoot);
  let result;
  try {
    result = await validate(root);
  } catch (e) {
    return { error: { code: 'REFUSED_NOT_A_SERIES', message: String(e?.message ?? e) } };
  }
  const first = result.books[0];
  const shared = first ? extractShared(result, first.path) : null;
  if (!shared) return { error: { code: 'REFUSED_NOT_A_SERIES', message: `${seriesRoot} is not a series folder with books in it (series.md missing)` } };
  return { root, diagnostics: result.diagnostics, docs: shared.docs, links: shared.links, series: shared.series, books: result.books };
}

/** Rule 5: errors E1xx/E2xx on files under manuscript/ (optionally excluding some codes). */
export function manuscriptErrors(diagnostics, allowCodes = []) {
  return diagnostics.filter(
    (d) =>
      d.severity === 'error' &&
      /^E[12]\d\d$/.test(d.code) &&
      d.file.startsWith('manuscript/') &&
      !allowCodes.includes(d.code),
  );
}

export const errorKey = (d) => `${d.code}\0${d.file}\0${d.location}`;

/** Errors present in `after` that were not in `before` (rule 6). */
export function newErrors(before, after) {
  const known = new Set(before.filter((d) => d.severity === 'error').map(errorKey));
  return after.filter((d) => d.severity === 'error' && !known.has(errorKey(d)));
}
