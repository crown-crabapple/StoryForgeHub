// Validate one book folder: load every document, run the per-book checks, build the Book result.
// Two phases, so cross-book links can see every other book: loadBook() reads and checks one book,
// finishBook() resolves its links once the whole library has been loaded.
import path from 'node:path';
import { mapOrdered, walkMarkdown } from './fs.mjs';
import { checkDuplicateSlugs } from './ids.mjs';
import { analyzeScenes } from './scenes.mjs';
import { resolveLinks } from './links.mjs';
import { buildTimeline } from './timeline.mjs';
import { loadDoc } from './load.mjs';
import { checkPlacement } from './placement.mjs';
import { checkFields } from './schema.mjs';
import { checkCodex } from './codex.mjs';
import { checkExceptions } from './exceptions.mjs';
import { checkSuggestions } from './suggestions.mjs';
import { checkLabelRefs, checkShadows, checkTypedValues, labelNames, typeNames } from './world.mjs';

/** @typedef {import('./load.mjs').Doc} Doc */
/**
 * What a book knows of its series: the shared entries and type files (typed documents), and the label names the series defines.
 * @typedef {{ slug: string|null, shared?: Doc[], labels?: Set<string> }} SeriesContext
 */

/** @param {string} bookPath @param {string} rel */
const join = (bookPath, rel) => (bookPath ? `${bookPath}/${rel}` : rel);

/**
 * Read one book and run every check that needs no other book.
 * @param {{rootDir:string, bookPath:string, series:SeriesContext|null,
 *          add:(code:string,file:string,loc:string,msg:string)=>void}} opts
 *   bookPath is relative to rootDir ("" when rootDir is the book)
 */
export async function loadBook({ rootDir, bookPath, series, add }) {
  const bookDir = bookPath ? path.join(rootDir, ...bookPath.split('/')) : rootDir;
  const files = await walkMarkdown(bookDir);

  /** @type {Doc[]} */
  const docs = [];
  /** @type {{id:string|null,path:string,reason:string}[]} */
  const unsupported = [];
  const loaded = await mapOrdered(
    files,
    (rel, bufferedAdd) => loadDoc(path.join(bookDir, ...rel.split('/')), rel, join(bookPath, rel), bufferedAdd),
    add,
  );
  for (const [i, { doc, unsupported: isUnsupported }] of loaded.entries()) {
    const file = join(bookPath, files[i]);
    if (isUnsupported) unsupported.push({ id: null, path: file, reason: 'unsupported-schema' });
    if (doc) docs.push(doc);
  }

  const shared = series?.shared ?? [];
  const typed = docs.filter((d) => d.kind);
  for (const d of typed) checkFields(d, { inSeries: series !== null }, add);
  checkDuplicateSlugs(typed, add);
  checkPlacement(typed, add);
  checkCodex(typed, add, typeNames(shared));
  checkExceptions(typed, add);
  checkSuggestions(typed, add);
  const bookDoc = typed.find((d) => d.kind === 'book' && d.rel === 'book.md');
  checkShadows(typed, shared, add);
  checkLabelRefs(typed, new Set([...labelNames(bookDoc), ...(series?.labels ?? [])]), add);
  checkTypedValues(typed, typed, shared, add);
  const { order, excluded, positions } = analyzeScenes(typed, bookPath, add);
  return { bookPath, bookDir, series, typed, bookDoc, order, excluded, positions, unsupported };
}

/**
 * Resolve a loaded book's links and build its Book result.
 * @param {Awaited<ReturnType<typeof loadBook>>} loaded
 * @param {import('./links.mjs').ResolveContext} context how this book sees the rest of the library
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 * @returns {Promise<{book: object, docs: Doc[], bookDoc: Doc|undefined, links: import('./links.mjs').LinkRecord[]}>}
 */
export async function finishBook(loaded, context, add) {
  const { bookPath, bookDir, series, typed, bookDoc, order, excluded, positions, unsupported } = loaded;
  const { eventScenes, links } = await resolveLinks(typed, bookDir, add, context);
  const timeline = buildTimeline(typed, eventScenes, positions);

  const str = (v) => (typeof v === 'string' ? v : null);
  const book = {
    path: bookPath,
    id: str(bookDoc?.fm.id),
    slug: str(bookDoc?.fm.slug),
    title: str(bookDoc?.fm.title),
    series: series ? series.slug : null,
    order,
    excluded: [...excluded, ...unsupported].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    timeline,
  };
  return { book, docs: typed, bookDoc, links };
}
