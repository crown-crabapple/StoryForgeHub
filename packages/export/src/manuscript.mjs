// assembleManuscript: the reader's view of a book, built from the canonical files (read-only).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { extractDocs, loadDoc, validate } from '@storyforge/format';
import { ExportError, cleanBody, sceneKey } from './text.mjs';

/**
 * @typedef {{ id: string, title: string, markdown: string }} MScene
 * @typedef {{ label: string, title: string, scenes: MScene[] }} MChapter
 * @typedef {{ label: string, chapters: MChapter[], act?: number, title?: string }} MPart
 * @typedef {{ title: string, subtitle: string, author: string, parts: MPart[], excluded: { id: string | null, reason: string }[],
 *             slug: string, bookId: string, language: string, modified: string, options: Required<ManuscriptOptions> }} Manuscript
 * @typedef {{ excludeStatuses?: string[], sceneTitles?: boolean, includeActs?: boolean, titlePage?: boolean, page?: 'letter' | 'a4' }} ManuscriptOptions
 */

/** Search keys of the scenes a manuscript left out (used by verification to prove they are absent). @type {WeakMap<object, { id: string | null, markdown: string }[]>} */
const EXCLUDED_TEXT = new WeakMap();

/** Text of the excluded scenes of a manuscript built here, if known. @param {object} manuscript */
export const excludedText = (manuscript) => EXCLUDED_TEXT.get(manuscript) ?? [];

const str = (v) => (typeof v === 'string' ? v : '');

/** Fill in option defaults and reject bad values. @param {ManuscriptOptions | undefined} o @param {number} actCount */
export function normaliseOptions(o = {}, actCount = 1) {
  const excludeStatuses = o.excludeStatuses ?? [];
  if (!Array.isArray(excludeStatuses) || excludeStatuses.some((s) => typeof s !== 'string')) throw new ExportError('BAD_OPTION', 'excludeStatuses must be a list of strings');
  const page = o.page ?? 'letter';
  if (page !== 'letter' && page !== 'a4') throw new ExportError('BAD_OPTION', 'page must be "letter" or "a4"');
  for (const k of ['sceneTitles', 'includeActs', 'titlePage']) {
    if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new ExportError('BAD_OPTION', `${k} must be true or false`);
  }
  return {
    excludeStatuses,
    sceneTitles: o.sceneTitles ?? false,
    includeActs: o.includeActs ?? actCount > 1,
    titlePage: o.titlePage ?? true,
    page,
  };
}

/** The pen name's display name from a library.md that sits above the book, or the slug as written. @param {string} bookRoot @param {string} slug */
async function penNameOf(bookRoot, slug) {
  for (const up of ['..', path.join('..', '..')]) {
    const { doc } = await loadDoc(path.join(bookRoot, up, 'library.md'), 'library.md', 'library.md', () => {});
    const hit = Array.isArray(doc?.fm.pen_names) ? doc.fm.pen_names.find((p) => p && p.slug === slug) : null;
    if (hit && typeof hit.name === 'string' && hit.name !== '') return hit.name;
  }
  return slug;
}

/**
 * @param {string} bookRoot absolute path of the book folder
 * @param {ManuscriptOptions} [options]
 * @returns {Promise<Manuscript>}
 */
export async function assembleManuscript(bookRoot, options = {}) {
  const root = path.resolve(bookRoot);
  const result = await validate(root);
  const book = result.books[0];
  const docs = extractDocs(result);
  const bookDoc = docs.find((d) => d.kind === 'book' && d.rel === 'book.md');
  if (!book || !bookDoc) throw new ExportError('NOT_A_BOOK', `no book.md in ${root}`);

  const actDocs = new Map();
  const chapterDocs = new Map();
  for (const d of docs) {
    if (d.archived) continue;
    if (d.kind === 'act' && Number.isInteger(d.fm.act) && !actDocs.has(d.fm.act)) actDocs.set(d.fm.act, d);
    if (d.kind === 'chapter' && Number.isInteger(d.fm.chapter) && !chapterDocs.has(d.fm.chapter)) chapterDocs.set(d.fm.chapter, d);
  }
  const actCount = new Set(book.order.map((s) => s.act)).size;
  const opts = normaliseOptions(options, actCount);

  // [[target]] -> display name (entries: name, threads and events: title); slugs, previous slugs and ids all resolve
  /** @type {Map<string, string>} */
  const names = new Map();
  const live = docs.filter((d) => !d.archived);
  for (const pass of [live, docs]) {
    for (const d of pass) {
      if (d.kind !== 'entry' && d.kind !== 'thread' && d.kind !== 'event') continue;
      const name = d.kind === 'entry' ? str(d.fm.name) : str(d.fm.title);
      if (name === '') continue;
      for (const key of [d.fm.slug, d.fm.id, ...(Array.isArray(d.fm.previous_slugs) ? d.fm.previous_slugs : [])]) {
        if (typeof key === 'string' && !names.has(key)) names.set(key, name);
      }
    }
  }
  const nameOf = (target) => names.get(target) ?? null;

  const sceneDocs = new Map(docs.filter((d) => d.kind === 'scene').map((d) => [d.file, d]));
  /** @type {Manuscript['excluded']} */
  const excluded = [];
  /** @type {{ id: string | null, markdown: string }[]} */
  const excludedBodies = [];
  for (const e of book.excluded) {
    excluded.push({ id: e.id, reason: e.reason });
    const d = sceneDocs.get(e.path);
    if (d) excludedBodies.push({ id: e.id, markdown: cleanBody(d.body, nameOf) });
  }

  /** @type {MPart[]} */
  const parts = [];
  let newest = 0;
  let lastChapter = -1;
  for (const s of book.order) {
    const doc = sceneDocs.get(s.path);
    if (!doc) continue;
    const status = str(doc.fm.status);
    const markdown = cleanBody(doc.body, nameOf);
    if (opts.excludeStatuses.includes(status)) {
      excluded.push({ id: s.id, reason: 'status' });
      excludedBodies.push({ id: s.id, markdown });
      continue;
    }
    try {
      newest = Math.max(newest, Math.floor((await stat(path.join(root, ...s.path.split('/')))).mtimeMs / 1000));
    } catch {
      // unreadable mtime: the date stays at its default
    }
    let part = parts[parts.length - 1];
    if (!part || part.act !== s.act) {
      part = { label: s.act_label, act: s.act, title: str(actDocs.get(s.act)?.fm.title), chapters: [] };
      parts.push(part);
    }
    let chapter = part.chapters[part.chapters.length - 1];
    if (!chapter || lastChapter !== s.chapter) {
      chapter = { label: s.chapter_label, title: str(chapterDocs.get(s.chapter)?.fm.title), scenes: [] };
      part.chapters.push(chapter);
      lastChapter = s.chapter;
    }
    chapter.scenes.push({ id: s.id, title: s.title, markdown });
  }

  const fm = bookDoc.fm;
  const author = str(fm.author) || (str(fm.pen_name) ? await penNameOf(root, fm.pen_name) : '');
  const manuscript = {
    title: str(fm.title),
    subtitle: str(fm.subtitle),
    author,
    parts,
    excluded,
    slug: str(fm.slug) || path.basename(root),
    bookId: str(fm.id),
    language: str(fm.language) || 'en',
    modified: new Date((newest || 315532800) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
    options: opts,
  };
  EXCLUDED_TEXT.set(manuscript, excludedBodies);
  return manuscript;
}

/** Every included scene in reading order, with its search key per format. @param {Manuscript} m @param {string} format */
export function sceneList(m, format) {
  return m.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes)).map((s) => ({ id: s.id, key: sceneKey(s.markdown, format) }));
}
