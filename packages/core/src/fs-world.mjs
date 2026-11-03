// Series shared worlds, labels, link targets across books and templates (M07-J01b): the FileRepository methods that deal with
// a book's series. No filesystem access here: reads come from validate() / the store, every write goes through @storyforge/store
// (the shared files with a store opened at the series folder).
//
// An entry that lives in a series' codex is a "shared entry". Every write route that takes an entry id works for one: the
// wrappers below look the entry up first (the book's own entries win, as they do for links) and send a shared entry to the
// series folder. Receipts stay per book, so a series-file edit gets none. A change to a series file reconciles the index of
// every book of that series.
import path from 'node:path';
import { extractDocs, extractShared, validate } from '@storyforge/format';
import { archiveEntry, changeEntrySlug, createCodexType, createEntry, editFrontMatterLine, restoreEntry, setEntryFields, setLabels, slugify, ulid } from '@storyforge/manuscript';
import { openStore, writeNewTree } from '@storyforge/store';
import { templateFromBook } from '@storyforge/templates';
import { frontMatterEnd } from './fs-writes.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const NOT_FOUND = fail('NOT_FOUND');
const errKey = (d) => `${d.code}\0${d.file}\0${d.location}`;
const str = (v) => (typeof v === 'string' ? v : null);
const KINDS = ['text', 'number', 'date', 'link', 'choice', 'list'];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NOT_FOUND_CODES = ['REFUSED_UNKNOWN_ENTRY', 'REFUSED_UNKNOWN_SCENE', 'REFUSED_UNKNOWN_OP'];

/**
 * A type file's `fields` as [{ label, kind, choices }] in file order: a plain string is a `text` field, a typed item keeps its kind.
 * An item that is neither is left out (the validator reports it as E102).
 * @param {any} fields
 * @returns {{ label: string, kind: string, choices: string[] }[]}
 */
export function fieldDefsOf(fields) {
  if (!Array.isArray(fields)) return [];
  const out = [];
  for (const f of fields) {
    if (typeof f === 'string' && f.trim() !== '') out.push({ label: f, kind: 'text', choices: [] });
    else if (f && typeof f === 'object' && !Array.isArray(f) && typeof f.label === 'string' && f.label.trim() !== '') {
      out.push({ label: f.label, kind: KINDS.includes(f.kind) ? f.kind : 'text', choices: Array.isArray(f.choices) ? f.choices.filter((c) => typeof c === 'string') : [] });
    }
  }
  return out;
}

/** The `labels` a book.md / series.md defines: [{ name, color }]. @param {any} fm */
export function labelDefsOf(fm) {
  if (!Array.isArray(fm?.labels)) return [];
  return fm.labels.filter((l) => l && typeof l === 'object' && typeof l.name === 'string' && l.name.trim() !== '').map((l) => ({ name: l.name, color: typeof l.color === 'string' ? l.color : null }));
}

/** The label names a document lists. @param {any} fm @returns {string[]} */
export const labelsOfDoc = (fm) => (Array.isArray(fm?.labels) ? fm.labels.filter((l) => typeof l === 'string') : []);

/**
 * The series of a book as the API tells it: { id, slug, title, path } or null.
 * @param {any} result validate() @param {{ path: string }} book
 */
export function seriesOfBook(result, book) {
  return extractShared(result, book.path)?.series ?? null;
}

/**
 * The `{ slug, title, kind, type, id }` rows a link picker needs from some documents: live entries, threads and events that have a slug.
 * @param {any[]} docs @param {(row: any) => any} [extra]
 */
function targetRows(docs, extra = (r) => r) {
  return docs
    .filter((d) => !d.archived && ['entry', 'thread', 'event'].includes(d.kind) && typeof d.fm.id === 'string' && typeof d.fm.slug === 'string')
    .map((d) => extra({ id: d.fm.id, kind: d.kind, slug: d.fm.slug, title: str(d.fm.name) ?? str(d.fm.title) ?? d.fm.slug, type: str(d.fm.type) }))
    .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.title.toLowerCase().localeCompare(b.title.toLowerCase())));
}

/**
 * @param {{ root: string, repository: any, readValidate: () => Promise<any>, reconcile: (bookPath: string) => Promise<any>, afterWrite: (bookPath: string) => void,
 *           libraryKind: () => Promise<'library' | 'book' | 'series'>, exists: (relDir: string) => Promise<boolean>, readDoc: (libRel: string) => Promise<any | null> }} deps
 *   `repository` is the repository being built: the wrappers keep the methods it has now (the book-only ones) and replace them.
 *   `readDoc(libRel)` loads one document (front matter, body) of the library, or null.
 */
export function createWorldMethods({ root, repository, readValidate, reconcile, afterWrite, libraryKind, exists, readDoc }) {
  const abs = (rel) => (rel === '' ? root : path.join(root, ...rel.split('/')));
  /** The methods this module wraps, as the repository has them now. */
  const base = {
    createEntry: repository.createEntry,
    setEntryFields: repository.setEntryFields,
    changeEntrySlug: repository.changeEntrySlug,
    archiveEntry: repository.archiveEntry,
    restoreEntry: repository.restoreEntry,
    createCodexType: repository.createCodexType,
    updateEntryBody: repository.updateEntryBody,
    getEntry: repository.getEntry,
  };

  /** A fresh validation, the book, and the series it sits in (or null). */
  async function freshContext(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book) return null;
    const shared = extractShared(result, book.path);
    return { result, book, shared, docs: extractDocs(result, book.path), seriesRoot: shared ? abs(shared.series.path) : null };
  }

  /** Bring every book of the series up to date (a shared file changed). */
  async function reconcileSeries(ctx) {
    for (const b of ctx.result.books.filter((/** @type {any} */ x) => x.series === ctx.shared.series.slug)) {
      if (typeof reconcile === 'function') await reconcile(b.path);
      else afterWrite(b.path);
    }
  }

  /** Run one manuscript command on the series folder; a real change reconciles every book of the series. */
  async function seriesOp(ctx, run) {
    const r = await run(ctx.seriesRoot);
    if (!r.ok) return NOT_FOUND_CODES.includes(r.code) ? NOT_FOUND : r;
    if (!r.dryRun && Array.isArray(r.changes) && r.changes.length > 0) await reconcileSeries(ctx);
    return { ...r, series: { slug: ctx.shared.series.slug, path: ctx.shared.series.path } };
  }

  /**
   * Is `ref` a shared entry of the book's series (and not shadowed by one of the book's own)? Reads the cached validation: nothing is
   * written from this answer, and the command itself validates afresh.
   * @param {string} bookId @param {string} ref @param {{ archived?: boolean }} [opts]
   */
  async function sharedEntry(bookId, ref, { archived = false } = {}) {
    if (typeof ref !== 'string' || ref === '') return null;
    const result = await readValidate();
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    if (!book) return null;
    const shared = extractShared(result, book.path);
    if (!shared) return null;
    const lib = (d) => `${shared.series.path === '' ? '' : `${shared.series.path}/`}${d.rel}`;
    const matches = (d) => d.kind === 'entry' && d.archived === archived && (d.fm.id === ref || (!archived && d.fm.slug === ref) || (archived && (d.fm.slug === ref || lib(d) === ref || d.file === ref)));
    const local = extractDocs(result, book.path).find(matches);
    if (local) return null;
    const doc = shared.docs.find(matches);
    return doc ? { doc } : null;
  }

  const world = {
    // ---------------------------------------------------------------- entry writes: the book's own, or the series' shared ones

    /** `where: 'series'` makes a shared entry (the book must be in a series); anything else is the book's own. */
    async createEntry(bookId, args = {}) {
      const where = args?.where;
      if (where !== undefined && where !== 'book' && where !== 'series') return fail('BAD_ARGS', { message: "where must be 'book' or 'series'" });
      if (where !== 'series') return base.createEntry(bookId, args);
      const ctx = await freshContext(bookId);
      if (!ctx) return NOT_FOUND;
      if (!ctx.shared) return fail('REFUSED_NO_SERIES', { message: 'this book is not in a series, so it has no shared codex' });
      const rest = { ...args };
      delete rest.where;
      return seriesOp(ctx, (seriesRoot) => createEntry(seriesRoot, { ...rest, scope: 'series' }));
    },

    async createCodexType(bookId, args = {}) {
      if (args?.where !== 'series') return base.createCodexType(bookId, args);
      const ctx = await freshContext(bookId);
      if (!ctx) return NOT_FOUND;
      if (!ctx.shared) return fail('REFUSED_NO_SERIES', { message: 'this book is not in a series, so it has no shared codex' });
      const rest = { ...args };
      delete rest.where;
      return seriesOp(ctx, (seriesRoot) => createCodexType(seriesRoot, { ...rest, scope: 'series' }));
    },

    async setEntryFields(bookId, ref, args = {}) {
      const hit = await sharedEntry(bookId, ref);
      if (!hit) return base.setEntryFields(bookId, ref, args);
      const ctx = await freshContext(bookId);
      return ctx ? seriesOp(ctx, (seriesRoot) => setEntryFields(seriesRoot, ref, { ...args, scope: 'series' })) : NOT_FOUND;
    },

    async changeEntrySlug(bookId, ref, args = {}) {
      const hit = await sharedEntry(bookId, ref);
      if (!hit) return base.changeEntrySlug(bookId, ref, args);
      const ctx = await freshContext(bookId);
      return ctx ? seriesOp(ctx, (seriesRoot) => changeEntrySlug(seriesRoot, ref, { ...args, scope: 'series' })) : NOT_FOUND;
    },

    async archiveEntry(bookId, ref, args = {}) {
      const hit = await sharedEntry(bookId, ref);
      if (!hit) return base.archiveEntry(bookId, ref, args);
      const ctx = await freshContext(bookId);
      return ctx ? seriesOp(ctx, (seriesRoot) => archiveEntry(seriesRoot, ref, { ...args, scope: 'series' })) : NOT_FOUND;
    },

    async restoreEntry(bookId, ref, args = {}) {
      const hit = await sharedEntry(bookId, ref, { archived: true });
      if (!hit) return base.restoreEntry(bookId, ref, args);
      const ctx = await freshContext(bookId);
      return ctx ? seriesOp(ctx, (seriesRoot) => restoreEntry(seriesRoot, hit.doc.rel, { ...args, scope: 'series' })) : NOT_FOUND;
    },

    /** The text of an entry. A shared entry's file is the series' file: the same conflict rule as for any entry body (`baseSha256` is the file as seen). */
    async updateEntryBody(bookId, ref, body, { baseSha256 } = {}) {
      const hit = await sharedEntry(bookId, ref);
      if (!hit) return base.updateEntryBody(bookId, ref, body, { baseSha256 });
      if (typeof body !== 'string') return fail('BAD_ARGS', { message: 'body must be a string' });
      const ctx = await freshContext(bookId);
      if (!ctx?.shared) return NOT_FOUND;
      const doc = ctx.shared.docs.find((/** @type {any} */ d) => d.kind === 'entry' && !d.archived && d.fm.id === hit.doc.fm.id);
      if (!doc) return NOT_FOUND;
      const store = await openStore(/** @type {string} */ (ctx.seriesRoot));
      const cur = await store.read(doc.rel);
      if (!cur) return NOT_FOUND;
      const end = frontMatterEnd(cur.bytes);
      if (end < 0) return fail('NOT_AN_ENTRY', { message: 'front matter is not terminated' });
      const next = Buffer.concat([cur.bytes.subarray(0, end), Buffer.from(body, 'utf8')]);
      const r = await store.write(doc.rel, next, { baseSha256 });
      if (r.ok) {
        await reconcileSeries(ctx);
        return { ok: true, code: 'OK', sha256: r.sha256 };
      }
      if (r.code === 'CONFLICT') {
        const now = r.current?.bytes ?? cur.bytes;
        const e = frontMatterEnd(now);
        return fail('CONFLICT', { current: { sha256: r.current?.sha256 ?? cur.sha256, body: now.subarray(e < 0 ? 0 : e).toString('utf8') } });
      }
      return fail(r.code, r.message ? { message: r.message } : {});
    },

    // ---------------------------------------------------------------- move to the series, copy into the book

    /**
     * Move a book's entry into its series' codex: the file moves, its `id` is kept, so every link (by id or slug) keeps resolving. Refused when the
     * series already has an entry with that slug (SLUG_TAKEN), or when the move would add a validation error (ROLLED_BACK, nothing changed).
     * `dryRun` shows the move without making it.
     */
    async moveEntryToSeries(bookId, ref, { dryRun = false, baseSha256 } = {}) {
      if (typeof ref !== 'string' || ref === '') return fail('BAD_ARGS', { message: 'the entry must be an id or slug' });
      const ctx = await freshContext(bookId);
      if (!ctx) return NOT_FOUND;
      if (!ctx.shared) return fail('REFUSED_NO_SERIES', { message: 'this book is not in a series' });
      const doc = ctx.docs.find((/** @type {any} */ d) => d.kind === 'entry' && !d.archived && (d.fm.id === ref || d.fm.slug === ref));
      if (!doc) return fail('NOT_FOUND', { message: `no entry ${ref} in this book` });
      const slug = doc.fm.slug;
      const taken = ctx.shared.docs.some((/** @type {any} */ d) => d.kind === 'entry' && ((typeof slug === 'string' && d.fm.slug === slug) || (Array.isArray(d.fm.previous_slugs) && d.fm.previous_slugs.includes(slug))));
      if (taken) return fail('SLUG_TAKEN', { slug, message: `the series ${ctx.shared.series.slug} already has an entry with the slug "${slug}"` });
      const seriesPath = ctx.shared.series.path;
      const bookRel = seriesPath === '' ? ctx.book.path : ctx.book.path.slice(seriesPath.length + 1);
      const from = `${bookRel}/${doc.rel}`;
      const to = doc.rel;
      const store = await openStore(/** @type {string} */ (ctx.seriesRoot));
      const cur = await store.read(from);
      if (!cur) return NOT_FOUND;
      if (typeof baseSha256 === 'string' && baseSha256 !== cur.sha256) return fail('CONFLICT', { message: `${doc.rel} changed on disk since it was read` });
      if (await store.exists(to)) return fail('SLUG_TAKEN', { slug, message: `the series already has a file at ${to}` });
      const libTo = seriesPath === '' ? to : `${seriesPath}/${to}`;
      const change = { from: `${ctx.book.path}/${doc.rel}`, to: libTo, before_sha256: cur.sha256, after_sha256: cur.sha256 };
      if (dryRun) return { ok: true, code: 'OK', dryRun: true, id: doc.fm.id, slug, path: libTo, changes: [change] };
      const known = new Set(ctx.result.diagnostics.filter((/** @type {any} */ d) => d.severity === 'error').map(errKey));
      const r = await store.batch('moveEntryToSeries', { id: doc.fm.id, from, to }, (tx) => tx.move(from, to, { baseSha256: cur.sha256 }), {
        verify: async () => {
          const after = (await validate(root)).diagnostics.filter((/** @type {any} */ d) => d.severity === 'error' && !known.has(errKey(d)));
          if (after.length) throw Object.assign(new Error('the move would introduce new errors'), { diagnostics: after });
        },
      });
      if (!r.ok) return r.code === 'ROLLED_BACK' ? fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [] }) : r.code === 'CONFLICT' ? fail('CONFLICT', { current: null }) : fail(r.code, r.message ? { message: r.message } : {});
      await reconcileSeries(ctx);
      return { ok: true, code: 'OK', id: doc.fm.id, slug, path: libTo, changes: [change], opId: r.opId ?? null };
    },

    /**
     * Copy a shared entry into the book: a file of its own with a NEW id and the same slug. It shadows the shared entry in this book (links here reach the copy), which
     * the validator reports as W309; the answer carries that warning (`warnings`). Refused when the book already has an entry, thread or event with that slug.
     */
    async copyEntryIntoBook(bookId, ref, { dryRun = false } = {}) {
      if (typeof ref !== 'string' || ref === '') return fail('BAD_ARGS', { message: 'the entry must be an id or slug' });
      const ctx = await freshContext(bookId);
      if (!ctx) return NOT_FOUND;
      if (!ctx.shared) return fail('REFUSED_NO_SERIES', { message: 'this book is not in a series' });
      const doc = ctx.shared.docs.find((/** @type {any} */ d) => d.kind === 'entry' && !d.archived && (d.fm.id === ref || d.fm.slug === ref));
      if (!doc) return fail('NOT_FOUND', { message: `no shared entry ${ref}` });
      const slug = doc.fm.slug;
      if (ctx.docs.some((/** @type {any} */ d) => ['entry', 'thread', 'event'].includes(d.kind) && !d.archived && d.fm.slug === slug)) {
        return fail('SLUG_TAKEN', { slug, message: `this book already has an entry, thread or event with the slug "${slug}"` });
      }
      const sstore = await openStore(/** @type {string} */ (ctx.seriesRoot), { recover: false });
      const src = await sstore.read(doc.rel);
      if (!src) return NOT_FOUND;
      const id = `entry_${ulid()}`;
      const edit = editFrontMatterLine(src.bytes, 'id', id, { plain: true });
      if (!edit.ok) return fail(edit.code, { message: `${doc.rel}: ${edit.message}` });
      const to = doc.rel;
      const bookStore = await openStore(abs(ctx.book.path));
      if (await bookStore.exists(to)) return fail('SLUG_TAKEN', { slug, message: `this book already has a file at ${to}` });
      const libTo = `${ctx.book.path}/${to}`;
      const change = { from: null, to: libTo, before_sha256: null, after_sha256: null };
      if (dryRun) return { ok: true, code: 'OK', dryRun: true, id, slug, path: libTo, changes: [change], warnings: [{ code: 'W309', location: 'slug', message: `this entry shadows the series entry ${slug}; links in this book reach this one` }] };
      const known = new Set(ctx.result.diagnostics.filter((/** @type {any} */ d) => d.severity === 'error').map(errKey));
      const r = await bookStore.batch('copyEntryIntoBook', { id, slug, from: doc.fm.id }, (tx) => tx.create(to, edit.buf), {
        verify: async () => {
          const after = (await validate(root)).diagnostics.filter((/** @type {any} */ d) => d.severity === 'error' && !known.has(errKey(d)));
          if (after.length) throw Object.assign(new Error('the copy would introduce new errors'), { diagnostics: after });
        },
      });
      if (!r.ok) return r.code === 'ROLLED_BACK' ? fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [] }) : fail(r.code, r.message ? { message: r.message } : {});
      if (typeof reconcile === 'function') await reconcile(ctx.book.path);
      else afterWrite(ctx.book.path);
      const after = await validate(root);
      const warnings = after.diagnostics.filter((/** @type {any} */ d) => d.file === libTo && d.severity === 'warning').map((/** @type {any} */ d) => ({ code: d.code, location: d.location, message: d.message }));
      return { ok: true, code: 'OK', id, slug, path: libTo, changes: [{ ...change, after_sha256: null }], warnings, opId: r.opId ?? null };
    },

    // ---------------------------------------------------------------- labels

    /** The labels a book and its series define: { book: { labels }, series: { slug, title, labels } | null }. Null for an unknown book. */
    async getLabels(bookId) {
      const result = await readValidate();
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return null;
      const bookDoc = extractDocs(result, book.path).find((/** @type {any} */ d) => d.kind === 'book');
      const series = seriesOfBook(result, book);
      const seriesDoc = series ? await readDoc(series.path === '' ? 'series.md' : `${series.path}/series.md`) : null;
      return {
        book: { id: book.id, slug: book.slug, title: book.title, labels: labelDefsOf(bookDoc?.fm) },
        series: series ? { id: series.id, slug: series.slug, title: series.title, labels: labelDefsOf(seriesDoc?.fm) } : null,
      };
    },

    /**
     * Replace the labels of the book (`scope: 'book'`) or of its series (`scope: 'series'`). Only the `labels` block of book.md / series.md changes.
     * @param {string} bookId @param {{ scope?: 'book' | 'series', labels: { name: string, color: string }[], dryRun?: boolean }} args
     */
    async setLabels(bookId, args = /** @type {any} */ ({})) {
      const scope = args?.scope ?? 'book';
      if (scope !== 'book' && scope !== 'series') return fail('BAD_ARGS', { message: "scope must be 'book' or 'series'" });
      const ctx = await freshContext(bookId);
      if (!ctx) return NOT_FOUND;
      const rest = { labels: args.labels, dryRun: args.dryRun === true };
      if (scope === 'series') {
        if (!ctx.shared) return fail('REFUSED_NO_SERIES', { message: 'this book is not in a series' });
        return seriesOp(ctx, (seriesRoot) => setLabels(seriesRoot, { ...rest, scope: 'series' }));
      }
      const r = await setLabels(abs(ctx.book.path), { ...rest, scope: 'book' });
      if (r.ok && !r.dryRun && r.changes.length > 0) {
        if (typeof reconcile === 'function') await reconcile(ctx.book.path);
        else afterWrite(ctx.book.path);
      }
      return r;
    },

    // ---------------------------------------------------------------- link targets

    /**
     * What a link picker offers, in the order the contract gives: this book's entries, threads and events; the series' shared entries; then the
     * other books' (written `[[book-slug:slug]]`). Null for an unknown book.
     * { book: [{ id, kind, slug, title, type, link }], series: { slug, title, items } | null, books: [{ id, slug, title, items }] }
     */
    async getLinkTargets(bookId) {
      const result = await readValidate();
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return null;
      const shared = extractShared(result, book.path);
      const own = targetRows(extractDocs(result, book.path), (r) => ({ ...r, link: `[[${r.slug}]]` }));
      const series = shared
        ? { slug: shared.series.slug, title: shared.series.title, items: targetRows(shared.docs.filter((/** @type {any} */ d) => d.kind === 'entry'), (r) => ({ ...r, link: `[[${r.slug}]]` })) }
        : null;
      const books = [];
      for (const other of result.books) {
        if (other.id === book.id || typeof other.slug !== 'string' || !other.id) continue;
        const items = targetRows(extractDocs(result, other.path), (r) => ({ ...r, link: `[[${other.slug}:${r.slug}]]` }));
        books.push({ id: other.id, slug: other.slug, title: other.title, series: other.series, items });
      }
      books.sort((a, b) => (a.title ?? a.slug).toLowerCase().localeCompare((b.title ?? b.slug).toLowerCase()));
      return { book: own, series, books };
    },

    // ---------------------------------------------------------------- templates

    /**
     * Save a book as a library template: <library>/_templates/<name>/ (see templateFromBook for what it keeps). Refused when that folder exists
     * (TEMPLATE_EXISTS) or the library root is not a library of books. The files are written with writeNewTree: all of them or none.
     * @param {string} bookId @param {{ name: string, title: string, description?: string }} meta
     */
    async saveAsTemplate(bookId, meta = /** @type {any} */ ({})) {
      const result = await readValidate();
      const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
      if (!book) return NOT_FOUND;
      if (typeof meta?.title !== 'string' || meta.title.trim() === '') return fail('BAD_TITLE', { field: 'title', message: 'Give the template a title.' });
      const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : slugify(meta.title);
      if (!NAME_RE.test(name) || name.length > 60) return fail('BAD_NAME', { field: 'name', message: 'The template name can use only lower-case letters a-z, digits and single hyphens (1 to 60 characters).' });
      if ((await libraryKind()) !== 'library') return fail('NOT_A_LIBRARY', { message: 'Templates are kept in the library folder; this folder is a single book or a series.' });
      if (await exists(`_templates/${name}`)) return fail('TEMPLATE_EXISTS', { field: 'name', message: `A template named "${name}" already exists. Nothing was changed.` });
      const series = seriesOfBook(result, book);
      const seriesDoc = series ? await readDoc(series.path === '' ? 'series.md' : `${series.path}/series.md`) : null;
      let files;
      try {
        files = await templateFromBook(abs(book.path), {
          name,
          title: meta.title,
          description: typeof meta.description === 'string' ? meta.description : '',
          seriesLabels: labelDefsOf(seriesDoc?.fm).filter((l) => l.color !== null),
        });
      } catch (e) {
        const code = /** @type {any} */ (e)?.code;
        return fail(typeof code === 'string' ? code : 'TEMPLATE_FAILED', { message: String(/** @type {any} */ (e)?.message ?? e) });
      }
      const written = await writeNewTree(path.join(root, '_templates', name), () => files.entries());
      if (!written.ok) return fail('TEMPLATE_EXISTS', { field: 'name', message: `A template named "${name}" already exists. Nothing was changed.` });
      return { ok: true, code: 'OK', name, path: `_templates/${name}`, files: written.files };
    },
  };
  return world;
}
