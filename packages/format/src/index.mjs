// @storyforge/format - validator for the StoryForge Markdown format v1.
import path from 'node:path';
import { Collector } from './diagnostics.mjs';
import { isDirectory, isFile, mapOrdered } from './fs.mjs';
import { checkDuplicateIds } from './ids.mjs';
import { loadDoc } from './load.mjs';
import { checkFields } from './schema.mjs';
import { validateBook } from './book.mjs';
import { checkBookUniqueness, checkPenNames, discover } from './library.mjs';

/**
 * Validate a book root, series root or library root. Read-only; never follows `.storyforge/`.
 * Problems in the files themselves are diagnostics, never exceptions; only a `rootDir` that is
 * not a directory throws.
 * @param {string} rootDir
 * @returns {Promise<{diagnostics: object[], books: object[]}>}
 */
export async function validate(rootDir) {
  const root = path.resolve(rootDir);
  if (!(await isDirectory(root))) throw new Error(`not a directory: ${rootDir}`);

  const collector = new Collector();
  const add = collector.add.bind(collector);
  /** @type {any[]} every parsed document in the run, for E201 */
  const allDocs = [];

  const isBookRoot = await isFile(path.join(root, 'book.md'));
  const isSeriesRoot = !isBookRoot && (await isFile(path.join(root, 'series.md')));

  /** @type {{path:string, seriesPath:string|null}[]} */
  let bookPlans;
  /** @type {string[]} */
  let seriesPaths = [];
  /** @type {any|null} */
  let libraryDoc = null;
  if (isBookRoot) {
    bookPlans = [{ path: '', seriesPath: null }];
  } else {
    const found = await discover(root, isSeriesRoot ? 'series' : 'library', add);
    bookPlans = found.books;
    seriesPaths = isSeriesRoot ? [''] : found.series;
    if (!isSeriesRoot && (await isFile(path.join(root, 'library.md')))) {
      const { doc } = await loadDoc(path.join(root, 'library.md'), 'library.md', 'library.md', add);
      if (doc && doc.kind) {
        checkFields(doc, {}, add);
        allDocs.push(doc);
        if (doc.kind === 'library') libraryDoc = doc;
      }
    }
  }

  /** @type {Map<string, {slug:string|null}>} */
  const seriesInfo = new Map();
  const seriesLoaded = await mapOrdered(
    seriesPaths,
    (sp, bufferedAdd) =>
      loadDoc(path.join(root, ...(sp ? sp.split('/') : []), 'series.md'), 'series.md', sp ? `${sp}/series.md` : 'series.md', bufferedAdd),
    add,
  );
  for (const [i, sp] of seriesPaths.entries()) {
    const { doc } = seriesLoaded[i];
    let slug = null;
    if (doc && doc.kind) {
      checkFields(doc, {}, add);
      allDocs.push(doc);
      if (doc.kind === 'series' && typeof doc.fm.slug === 'string') slug = doc.fm.slug;
    }
    seriesInfo.set(sp, { slug });
  }

  const books = [];
  /** @type {{path:string,file:string,seriesPath:string|null,fm:any}[]} */
  const bookEntries = [];
  for (const plan of bookPlans) {
    const series = plan.seriesPath !== null ? (seriesInfo.get(plan.seriesPath) ?? { slug: null }) : null;
    const { book, docs, bookDoc, links } = await validateBook({ rootDir: root, bookPath: plan.path, series, add });
    books.push(book);
    DETAIL.set(book, { docs, links });
    allDocs.push(...docs);
    if (bookDoc) {
      bookEntries.push({ path: plan.path, file: bookDoc.file, seriesPath: plan.seriesPath, fm: bookDoc.fm });
    }
  }

  checkDuplicateIds(allDocs, add);
  checkBookUniqueness(bookEntries, add);
  if (libraryDoc) checkPenNames(libraryDoc, bookEntries, add);

  books.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const result = { diagnostics: collector.sorted(), books };
  return result;
}

/** @type {WeakMap<object, {docs: any[], links: import('./links.mjs').LinkRecord[]}>} book object -> what validate() read and resolved */
const DETAIL = new WeakMap();

const detailOf = (result, bookPath) =>
  (result?.books ?? []).filter((b) => bookPath === undefined || b.path === bookPath).map((b) => DETAIL.get(b)).filter(Boolean);

/**
 * Every explicit reference found by validate(), as the records validate() itself used to emit E301, E302,
 * W301, W303 and I402: { src_id, src_path, location, raw, target_id, target_kind, resolution }. src_path is
 * relative to the book root. With `bookPath` (as in `result.books[i].path`) only that book's records.
 * @param {{books: object[]}} result what validate() returned
 * @param {string} [bookPath]
 * @returns {import('./links.mjs').LinkRecord[]}
 */
export function extractLinks(result, bookPath) {
  return detailOf(result, bookPath).flatMap((d) => d.links);
}

/**
 * The typed documents (kind, fm, body, rel, archived, ...) validate() read for a book, in file order.
 * @param {{books: object[]}} result what validate() returned
 * @param {string} [bookPath]
 * @returns {import('./load.mjs').Doc[]}
 */
export function extractDocs(result, bookPath) {
  return detailOf(result, bookPath).flatMap((d) => d.docs);
}

// Building blocks for derived projections (@storyforge/index). Re-exports only; behaviour unchanged.
export { loadDoc } from './load.mjs';
export { discover } from './library.mjs';
export { isFile, walkMarkdown } from './fs.mjs';
export { proseLines, REFERENCES, NAMED, WIKI_RE, CITE_RE, MDLINK_RE } from './links.mjs';
export { ID_PREFIX_RE } from './ids.mjs';
export { escapesRoot } from './schema.mjs';
// Building blocks for the continuity engine (@storyforge/continuity). Re-exports only.
export { readText } from './fs.mjs';
export { STATE_EVENTS, FINGERPRINT_RE } from './schema.mjs';
