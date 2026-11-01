// Validate one book folder: load every document, run the per-book checks, build the Book result.
import path from 'node:path';
import { walkMarkdown } from './fs.mjs';
import { checkDuplicateSlugs } from './ids.mjs';
import { analyzeScenes } from './scenes.mjs';
import { resolveLinks } from './links.mjs';
import { buildTimeline } from './timeline.mjs';
import { loadDoc } from './load.mjs';
import { checkFields } from './schema.mjs';

/** @typedef {import('./load.mjs').Doc} Doc */

/** @param {string} bookPath @param {string} rel */
const join = (bookPath, rel) => (bookPath ? `${bookPath}/${rel}` : rel);

/**
 * @param {{rootDir:string, bookPath:string, series:{slug:string|null}|null,
 *          add:(code:string,file:string,loc:string,msg:string)=>void}} opts
 *   bookPath is relative to rootDir ("" when rootDir is the book)
 * @returns {Promise<{book: object, docs: Doc[], bookDoc: Doc|undefined}>}
 */
export async function validateBook({ rootDir, bookPath, series, add }) {
  const bookDir = bookPath ? path.join(rootDir, ...bookPath.split('/')) : rootDir;
  const files = await walkMarkdown(bookDir);

  /** @type {Doc[]} */
  const docs = [];
  /** @type {{id:string|null,path:string,reason:string}[]} */
  const unsupported = [];
  for (const rel of files) {
    const file = join(bookPath, rel);
    const { doc, unsupported: isUnsupported } = await loadDoc(path.join(bookDir, ...rel.split('/')), rel, file, add);
    if (isUnsupported) unsupported.push({ id: null, path: file, reason: 'unsupported-schema' });
    if (doc) docs.push(doc);
  }

  const typed = docs.filter((d) => d.kind);
  for (const d of typed) checkFields(d, { inSeries: series !== null }, add);
  checkDuplicateSlugs(typed, add);
  const { order, excluded, positions } = analyzeScenes(typed, bookPath, add);
  const { eventScenes } = await resolveLinks(typed, bookDir, add);
  const timeline = buildTimeline(typed, eventScenes, positions);

  const bookDoc = typed.find((d) => d.kind === 'book' && d.rel === 'book.md');
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
  return { book, docs: typed, bookDoc };
}
