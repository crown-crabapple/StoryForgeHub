// FsRepository: the only core module that reads project files. Reads only; caches nothing.
// Every change goes through fs-writes.mjs -> @storyforge/store.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { validate } from '@storyforge/format';
import { createWriteMethods } from './fs-writes.mjs';
import { countWords } from './word-count.mjs';

/** @typedef {import('./repository.mjs').FileRepository} FileRepository */
/** @typedef {import('./repository.mjs').Diagnostic} Diagnostic */
/** @typedef {import('./repository.mjs').BookSummary} BookSummary */
/** @typedef {import('./repository.mjs').BookDetail} BookDetail */
/** @typedef {import('./repository.mjs').SceneSummary} SceneSummary */

/**
 * Split a file into parsed front matter and the raw body that follows it.
 * The body is returned byte-for-byte (no line-ending changes).
 * @param {string} text
 * @returns {{ fm: Record<string, any>, body: string }}
 */
function splitFile(text) {
  const t = text.startsWith('﻿') ? text.slice(1) : text;
  const firstEnd = t.indexOf('\n');
  if (firstEnd < 0 || t.slice(0, firstEnd).replace(/\r$/, '') !== '---') return { fm: {}, body: t };
  let pos = firstEnd + 1;
  while (pos <= t.length) {
    const e = t.indexOf('\n', pos);
    const lineEnd = e < 0 ? t.length : e;
    if (t.slice(pos, lineEnd).replace(/\r$/, '') === '---') {
      const yamlText = t.slice(firstEnd + 1, pos);
      let fm = {};
      try {
        const v = parse(yamlText, { version: '1.2', schema: 'core' });
        if (v && typeof v === 'object' && !Array.isArray(v)) fm = v;
      } catch {
        fm = {};
      }
      return { fm, body: e < 0 ? '' : t.slice(e + 1) };
    }
    if (e < 0) break;
    pos = e + 1;
  }
  return { fm: {}, body: t };
}

/** @param {string} file @returns {Promise<{ fm: Record<string, any>, body: string, sha256: string } | null>} */
async function readParsed(file) {
  try {
    const bytes = await readFile(file);
    return { ...splitFile(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return null;
  }
}

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' ? v : null);
/** @param {unknown} v @returns {number | null} */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** @param {string} a @param {string} b */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {string} libraryRoot
 * @returns {FileRepository}
 */
export function createFsRepository(libraryRoot) {
  const root = path.resolve(libraryRoot);
  /** @param {string} rel */
  const abs = (rel) => path.join(root, ...rel.split('/').filter(Boolean));

  /** @param {Diagnostic[]} diagnostics @param {string} bookPath */
  function forBook(diagnostics, bookPath) {
    if (bookPath === '') return diagnostics;
    return diagnostics.filter((d) => d.file === bookPath || d.file.startsWith(`${bookPath}/`));
  }

  /**
   * Scene summaries (and file contents) for scenes of a book, in the order given.
   * @param {any[]} order
   */
  async function loadScenes(order) {
    return Promise.all(
      order.map(async (s) => {
        const parsed = await readParsed(abs(s.path));
        const body = parsed ? parsed.body : '';
        const fm = parsed ? parsed.fm : {};
        const sha256 = parsed ? parsed.sha256 : null;
        /** @type {SceneSummary} */
        const summary = {
          id: s.id,
          title: s.title,
          position: s.position,
          act: s.act,
          chapter: s.chapter,
          sequence: s.sequence,
          status: str(fm.status),
          pov: str(fm.pov),
          word_count: countWords(body),
          path: s.path,
        };
        return { summary, fm, body, sha256 };
      }),
    );
  }

  /**
   * @param {any} book @param {Diagnostic[]} diagnostics
   * @param {{ summary: SceneSummary }[]} scenes
   * @returns {Promise<BookSummary>}
   */
  async function summarise(book, diagnostics, scenes) {
    const bookFile = book.path ? `${book.path}/book.md` : 'book.md';
    const parsed = await readParsed(abs(bookFile));
    const fm = parsed ? parsed.fm : {};
    const own = forBook(diagnostics, book.path);
    return {
      id: book.id,
      slug: book.slug,
      title: book.title,
      series: book.series,
      series_number: num(fm.series_number),
      status: str(fm.status),
      path: book.path,
      scene_count: scenes.length,
      word_count: scenes.reduce((n, s) => n + s.summary.word_count, 0),
      error_count: own.filter((d) => d.severity === 'error').length,
      warning_count: own.filter((d) => d.severity === 'warning').length,
    };
  }

  /** Books in a series first (by series slug, number, title); standalone books last. */
  /** @param {BookSummary} a @param {BookSummary} b */
  function compareBooks(a, b) {
    if ((a.series === null) !== (b.series === null)) return a.series === null ? 1 : -1;
    const bySeries = cmp(a.series ?? '', b.series ?? '');
    if (bySeries) return bySeries;
    const na = a.series_number ?? Infinity;
    const nb = b.series_number ?? Infinity;
    if (na !== nb) return na < nb ? -1 : 1;
    return cmp(a.title ?? '', b.title ?? '');
  }

  /** @type {FileRepository} */
  const repository = {
    async libraryInfo() {
      const result = await validate(root);
      const lib = await readParsed(path.join(root, 'library.md'));
      return { root, title: lib ? str(lib.fm.title) : null, diagnostics: result.diagnostics };
    },

    async listBooks() {
      const result = await validate(root);
      const books = result.books.filter((/** @type {any} */ b) => b.id);
      const out = await Promise.all(
        books.map(async (/** @type {any} */ b) => summarise(b, result.diagnostics, await loadScenes(b.order))),
      );
      return out.sort(compareBooks);
    },

    async getBook(bookId) {
      const result = await validate(root);
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return null;
      const scenes = await loadScenes(book.order);
      const summary = await summarise(book, result.diagnostics, scenes);

      /** @type {BookDetail['acts']} */
      const acts = [];
      for (let i = 0; i < book.order.length; i++) {
        const s = book.order[i];
        let act = acts.find((a) => a.act === s.act);
        if (!act) {
          act = { act: s.act, label: s.act_label, chapters: [] };
          acts.push(act);
        }
        let chapter = act.chapters.find((c) => c.chapter === s.chapter);
        if (!chapter) {
          const dir = path.posix.dirname(s.path);
          let title = null;
          if (path.posix.basename(dir).startsWith('ch-')) {
            const ch = await readParsed(abs(`${dir}/chapter.md`));
            title = ch ? str(ch.fm.title) : null;
          }
          chapter = { chapter: s.chapter, label: s.chapter_label, title, scenes: [] };
          act.chapters.push(chapter);
        }
        chapter.scenes.push(scenes[i].summary);
      }
      return { ...summary, acts, excluded: book.excluded };
    },

    async getScene(bookId, sceneId) {
      const result = await validate(root);
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return null;
      const entry = book.order.find((/** @type {any} */ s) => s.id === sceneId);
      if (!entry) return null;
      const [{ summary, fm, body, sha256 }] = await loadScenes([entry]);
      return { ...summary, front_matter: fm, body, sha256 };
    },

    async getDiagnostics(bookId) {
      const result = await validate(root);
      if (bookId === undefined) return result.diagnostics;
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      return book ? forBook(result.diagnostics, book.path) : [];
    },
  };
  Object.assign(repository, createWriteMethods({ root, getScene: (b, s) => repository.getScene(b, s) }));
  return repository;
}
