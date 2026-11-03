// Library / series discovery (spec 3.1, 3.2) and the checks that span books: E202, E203, W101, pen names.
import path from 'node:path';
import { isFile, listDirs, mapLimit, getReadConcurrency } from './fs.mjs';

/** @param {string} a @param {string} b */
const join = (a, b) => (a ? `${a}/${b}` : b);

/**
 * Find the books and series below a library root or a series root.
 * Books live at most two levels below a library root (library/series/book) and one level
 * below a series root; a deeper `book.md` is ignored with W101.
 * @param {string} rootDir absolute
 * @param {'library'|'series'} mode
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 * @returns {Promise<{books: {path:string, seriesPath:string|null}[], series: string[]}>}
 */
export async function discover(rootDir, mode, add) {
  const maxLevel = mode === 'library' ? 2 : 1;
  /** @type {{path:string, seriesPath:string|null}[]} */
  const books = [];
  /** @type {string[]} */
  const series = [];

  /** @param {string} rel @param {number} level @param {string|null} seriesRel */
  async function scan(rel, level, seriesRel) {
    const dir = rel ? path.join(rootDir, ...rel.split('/')) : rootDir;
    const names = await listDirs(dir);
    // probe every child for book.md / series.md concurrently, then walk them in order
    const probes = await mapLimit(names, getReadConcurrency(), async (name) => {
      const childDir = path.join(dir, name);
      if (mode === 'library' && level === 0 && name === '_templates') return { isBook: false, isSeries: false, skip: true };
      const isBook = await isFile(path.join(childDir, 'book.md'));
      const isSeries = !isBook && mode === 'library' && level + 1 === 1 && (await isFile(path.join(childDir, 'series.md')));
      return { isBook, isSeries };
    });
    for (const [idx, name] of names.entries()) {
      const { isBook, isSeries, skip } = probes[idx];
      if (skip) continue; // `_templates/` is not a book or series (FORMAT 2)
      const childRel = join(rel, name);
      const childDir = path.join(dir, name);
      const childLevel = level + 1;
      if (isBook) {
        if (childLevel <= maxLevel) books.push({ path: childRel, seriesPath: seriesRel });
        else add('W101', `${childRel}/book.md`, '', `book.md is more than ${maxLevel} levels below the library root and is ignored`);
        continue;
      }
      if (isSeries) {
        series.push(childRel);
        await scan(childRel, childLevel, childRel);
        continue;
      }
      await scan(childRel, childLevel, null);
    }
  }

  await scan('', 0, mode === 'series' ? '' : null);
  return { books, series };
}

/**
 * E202 (duplicate series_number within a series) and E203 (duplicate book slug in the library).
 * @param {{path:string, file:string, seriesPath:string|null, fm:any}[]} entries one per book.md that parsed
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 * @param {{file:string, fm:any}[]} [seriesEntries] one per series.md that parsed (E210)
 */
export function checkBookUniqueness(entries, add, seriesEntries = []) {
  /** @param {string} code @param {string} field @param {(e:any)=>string|number|null} keyOf */
  const report = (code, field, keyOf) => {
    /** @type {Map<string, typeof entries>} */
    const groups = new Map();
    for (const e of entries) {
      const key = keyOf(e);
      if (key === null) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const [key, list] of groups) {
      if (list.length < 2) continue;
      for (const e of list) add(code, e.file, field, `duplicate ${field} ${key}`);
    }
  };
  report('E203', 'slug', (e) => (typeof e.fm.slug === 'string' ? e.fm.slug : null));
  // E210: a book slug equal to a series slug (a cross-book link prefix would be ambiguous)
  const seriesSlugs = new Map(seriesEntries.filter((s) => typeof s.fm.slug === 'string').map((s) => [s.fm.slug, s]));
  for (const e of entries) {
    const s = typeof e.fm.slug === 'string' ? seriesSlugs.get(e.fm.slug) : undefined;
    if (!s) continue;
    add('E210', e.file, 'slug', `book slug ${e.fm.slug} is also a series slug`);
    add('E210', s.file, 'slug', `series slug ${e.fm.slug} is also a book slug`);
  }
  report('E202', 'series_number', (e) =>
    e.seriesPath !== null && Number.isInteger(e.fm.series_number) ? `${e.seriesPath}#${e.fm.series_number}` : null);
}

/**
 * pen_name must name a pen name declared in library.md (only checked when library.md exists).
 * @param {{file:string, fm:any}} libraryDoc
 * @param {{file:string, fm:any}[]} bookEntries
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkPenNames(libraryDoc, bookEntries, add) {
  if (!Array.isArray(libraryDoc.fm.pen_names)) return;
  const known = new Set(
    libraryDoc.fm.pen_names.filter((p) => p && typeof p.slug === 'string').map((p) => p.slug),
  );
  for (const e of bookEntries) {
    const pen = e.fm.pen_name;
    if (typeof pen === 'string' && !known.has(pen)) {
      add('E301', e.file, 'pen_name', `pen name ${pen} is not declared in library.md`);
    }
  }
}
