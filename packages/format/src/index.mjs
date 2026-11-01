// @storyforge/format - validator for the StoryForge Markdown format v1.
import path from 'node:path';
import { Collector } from './diagnostics.mjs';
import { isDirectory, isFile } from './fs.mjs';
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
  for (const sp of seriesPaths) {
    const file = sp ? `${sp}/series.md` : 'series.md';
    const { doc } = await loadDoc(path.join(root, ...(sp ? sp.split('/') : []), 'series.md'), 'series.md', file, add);
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
    const { book, docs, bookDoc } = await validateBook({ rootDir: root, bookPath: plan.path, series, add });
    books.push(book);
    allDocs.push(...docs);
    if (bookDoc) {
      bookEntries.push({ path: plan.path, file: bookDoc.file, seriesPath: plan.seriesPath, fm: bookDoc.fm });
    }
  }

  checkDuplicateIds(allDocs, add);
  checkBookUniqueness(bookEntries, add);
  if (libraryDoc) checkPenNames(libraryDoc, bookEntries, add);

  books.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { diagnostics: collector.sorted(), books };
}
