// @storyforge/format - validator for the StoryForge Markdown format v1.
import path from 'node:path';
import { Collector } from './diagnostics.mjs';
import { isDirectory, isFile, mapOrdered } from './fs.mjs';
import { checkDuplicateIds } from './ids.mjs';
import { loadDoc } from './load.mjs';
import { checkFields } from './schema.mjs';
import { finishBook, loadBook } from './book.mjs';
import { checkBookUniqueness, checkPenNames, discover } from './library.mjs';
import { makeNamespace, resolveLinks } from './links.mjs';
import { checkTemplates, labelNames, loadShared } from './world.mjs';

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

  /**
   * One series: its series.md, and its shared world (entries and type files under codex/ and archive/).
   * @typedef {{ path:string, slug:string|null, id:string|null, title:string|null, shared:any[], labels:Set<string>, ns:any, links:any[] }} SeriesCtx
   * @type {Map<string, SeriesCtx>}
   */
  const seriesInfo = new Map();
  /** @type {{file:string, fm:any}[]} */
  const seriesEntries = [];
  const seriesLoaded = await mapOrdered(
    seriesPaths,
    (sp, bufferedAdd) =>
      loadDoc(path.join(root, ...(sp ? sp.split('/') : []), 'series.md'), 'series.md', sp ? `${sp}/series.md` : 'series.md', bufferedAdd),
    add,
  );
  for (const [i, sp] of seriesPaths.entries()) {
    const { doc } = seriesLoaded[i];
    /** @type {SeriesCtx} */
    const ctx = { path: sp, slug: null, id: null, title: null, shared: [], labels: new Set(), ns: null, links: [] };
    if (doc && doc.kind) {
      checkFields(doc, {}, add);
      allDocs.push(doc);
      if (doc.kind === 'series') {
        if (typeof doc.fm.slug === 'string') ctx.slug = doc.fm.slug;
        ctx.id = typeof doc.fm.id === 'string' ? doc.fm.id : null;
        ctx.title = typeof doc.fm.title === 'string' ? doc.fm.title : null;
        ctx.labels = labelNames(doc);
        seriesEntries.push({ file: doc.file, fm: doc.fm });
      }
    }
    ctx.shared = await loadShared(root, sp, add);
    ctx.ns = makeNamespace(ctx.shared, { entriesOnly: true });
    allDocs.push(...ctx.shared);
    seriesInfo.set(sp, ctx);
  }

  // phase 1: read every book and run the checks that need no other book
  const plans = [];
  for (const plan of bookPlans) {
    const series = plan.seriesPath !== null ? (seriesInfo.get(plan.seriesPath) ?? { slug: null }) : null;
    const loaded = await loadBook({ rootDir: root, bookPath: plan.path, series, add });
    plans.push({ plan, series, loaded });
    allDocs.push(...loaded.typed);
  }

  // phase 2: the library as cross-book links see it, then every book's links (and every shared entry's)
  const libIds = new Map();
  for (const d of allDocs) if (typeof d.fm.id === 'string' && !libIds.has(d.fm.id)) libIds.set(d.fm.id, d);
  /** @type {import('./links.mjs').CrossWorld|null} */
  let cross = null;
  if (!isBookRoot) {
    cross = { complete: !isSeriesRoot, books: new Map(), series: new Map() };
    for (const sctx of seriesInfo.values()) {
      if (sctx.slug && !cross.series.has(sctx.slug)) {
        cross.series.set(sctx.slug, { kind: 'series', slug: sctx.slug, id: sctx.id, title: sctx.title, path: sctx.path, layers: [sctx.ns], series: null });
      }
    }
    for (const { series, loaded } of plans) {
      const slug = loaded.bookDoc?.fm.slug;
      if (typeof slug !== 'string' || cross.books.has(slug)) continue;
      const seriesTarget = series?.slug && series.ns ? cross.series.get(series.slug) ?? null : null;
      cross.books.set(slug, {
        kind: 'book', slug, id: typeof loaded.bookDoc?.fm.id === 'string' ? loaded.bookDoc.fm.id : null,
        title: typeof loaded.bookDoc?.fm.title === 'string' ? loaded.bookDoc.fm.title : null, path: loaded.bookPath,
        layers: series?.ns ? [makeNamespace(loaded.typed), series.ns] : [makeNamespace(loaded.typed)],
        series: seriesTarget,
      });
    }
  }
  for (const sctx of seriesInfo.values()) {
    const seriesDir = path.join(root, ...(sctx.path ? sctx.path.split('/') : []));
    const { links } = await resolveLinks(sctx.shared, seriesDir, add, { sharedMode: true, libIds, cross });
    sctx.links = links;
  }

  const books = [];
  /** @type {{path:string,file:string,seriesPath:string|null,fm:any}[]} */
  const bookEntries = [];
  for (const { plan, series, loaded } of plans) {
    const { book, docs, bookDoc, links } = await finishBook(loaded, { shared: series?.ns ?? null, cross }, add);
    books.push(book);
    DETAIL.set(book, {
      docs, links,
      shared: series && series.ns ? { series: { id: series.id, slug: series.slug, title: series.title, path: series.path }, docs: series.shared, links: series.links } : null,
    });
    if (bookDoc) {
      bookEntries.push({ path: plan.path, file: bookDoc.file, seriesPath: plan.seriesPath, fm: bookDoc.fm });
    }
  }

  checkDuplicateIds(allDocs, add);
  checkBookUniqueness(bookEntries, add, seriesEntries);
  if (!isBookRoot && !isSeriesRoot) await checkTemplates(root, add);
  if (libraryDoc) checkPenNames(libraryDoc, bookEntries, add);

  books.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const result = { diagnostics: collector.sorted(), books };
  return result;
}

/** @type {WeakMap<object, {docs: any[], links: import('./links.mjs').LinkRecord[], shared: {series: {id:string|null, slug:string|null, title:string|null, path:string}, docs: any[], links: import('./links.mjs').LinkRecord[]}|null}>} book object -> what validate() read and resolved */
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

/**
 * The shared world a book sees (FORMAT 3.2 shared codex): its series, the shared entries and type files (typed documents, `file`
 * relative to the validated root) and the link records those entries make. Null for a book outside a series.
 * @param {{books: object[]}} result what validate() returned
 * @param {string} bookPath as in `result.books[i].path`
 * @returns {{series: {id:string|null, slug:string|null, title:string|null, path:string}, docs: import('./load.mjs').Doc[], links: import('./links.mjs').LinkRecord[]}|null}
 */
export function extractShared(result, bookPath) {
  return detailOf(result, bookPath)[0]?.shared ?? null;
}

// Building blocks for derived projections (@storyforge/index). Re-exports only; behaviour unchanged.
export { loadDoc } from './load.mjs';
export { discover } from './library.mjs';
export { isFile, walkMarkdown, walkSharedMarkdown } from './fs.mjs';
export { proseLines, REFERENCES, NAMED, WIKI_RE, CITE_RE, MDLINK_RE } from './links.mjs';
export { ID_PREFIX_RE } from './ids.mjs';
export { escapesRoot } from './schema.mjs';
// Building blocks for the continuity engine (@storyforge/continuity). Re-exports only.
export { readText } from './fs.mjs';
export { STATE_EVENTS, FINGERPRINT_RE } from './schema.mjs';
