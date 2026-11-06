// FsRepository write methods. No filesystem access here: every change goes through
// @storyforge/store (the single writer) or @storyforge/manuscript (which uses the store).
import path from 'node:path';
import { extractDocs, validate } from '@storyforge/format';
import {
  archiveChapter,
  archiveEntry,
  archiveEvent,
  archiveLink,
  archiveNote,
  changeEntrySlug,
  createAct,
  createChapter,
  createCodexType,
  createEntry,
  createEvent,
  createLink,
  createNote,
  createThread,
  editFrontMatterLine,
  insertScene,
  mergeScenes,
  moveScene,
  renumberChapters,
  restoreEntry,
  restoreEvent,
  restoreLink,
  restoreNote,
  restoreOp,
  setActFields,
  setChapterFields,
  setEntryFields,
  setEventFields,
  setNoteFields,
  setSceneFields,
  saveScenePlan,
  setThreadFields,
  slugify,
  splitScene,
  ulid,
  updateLink,
  uploadAttachment,
} from '@storyforge/manuscript';
import { countWords } from '@storyforge/index';
import { openStore } from '@storyforge/store';
import { recordPath, renderAiRecord, selectRange, spliceReplacement } from './ai-rewrite.mjs';
import { createCheckMethods } from './check-scene.mjs';
import { createContinuityExceptionMethods } from './continuity-exceptions.mjs';
import { createCommentMethods } from './comments.mjs';
import { createCoverMethods } from './cover-drafts.mjs';
import { createSuggestionMethods } from './suggestions.mjs';
import { createReceiptEngine } from './receipts.mjs';
import { recordProvenance } from './provenance.mjs';
import { createSnapshotTracker, planRetention, splitRevision } from './revisions.mjs';
import { localDate } from './writing-log.mjs';
import { wordDelta } from './word-delta.mjs';

const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f]`);
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/** Byte offset just past the closing front-matter `---` line (and its terminator), or -1. */
export function frontMatterEnd(buf) {
  let pos = buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const lineAt = (start) => {
    let nl = buf.indexOf(0x0a, start);
    const next = nl < 0 ? buf.length : nl + 1;
    const end = nl < 0 ? buf.length : nl;
    const text = buf.subarray(start, end).toString('latin1').replace(/\r$/, '');
    return { text, next };
  };
  const first = lineAt(pos);
  if (first.text !== '---' || pos >= buf.length) return -1;
  pos = first.next;
  while (pos < buf.length) {
    const line = lineAt(pos);
    if (line.text === '---') return line.next;
    pos = line.next;
  }
  return -1;
}

const errKey = (d) => `${d.code}\0${d.file}\0${d.location}`;

/**
 * @param {{ root: string, getScene: (bookId: string, sceneId: string) => Promise<any>,
 *           afterWrite?: (bookPath: string) => void, reconcile?: (bookPath: string) => Promise<any>,
 *           activity?: ReturnType<typeof import('./activity.mjs').createActivity>, now?: () => number | Date,
 *           receipts?: ReturnType<typeof import('./receipts.mjs').createReceiptEngine> }} deps
 *   `afterWrite` runs after every successful change; `reconcile` (structure commands) brings the book's index up to date before the call returns
 */
export function createWriteMethods({ root, getScene, afterWrite = () => {}, reconcile, activity, now = () => Date.now(), receipts = createReceiptEngine({ root, now }), readValidate }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));
  const toLibRel = (book, p) => (book.path === '' ? p : `${book.path}/${p}`);
  const toBookRel = (book, p) => (book.path === '' ? p : p.startsWith(`${book.path}/`) ? p.slice(book.path.length + 1) : null);

  async function findBook(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, diagnostics: result.diagnostics } : null;
  }

  /** The conflict result: the scene as it is on disk now (null if it is not a live scene). */
  async function conflict(r, bookId, sceneId) {
    const current = sceneId ? await getScene(bookId, sceneId) : null;
    return { ok: false, code: 'CONFLICT', current, ...(r.current ? { current_sha256: r.current.sha256 } : {}) };
  }

  /**
   * Run one store move (archive or restore), then undo it if the library gained a validation error.
   * @param {string} bookId
   * @param {{ op: string, bookRel: (book: any) => string | null, sceneId?: string,
   *           call: (tx: any, rel: string) => Promise<any> }} p
   */
  async function guardedMove(bookId, { op, bookRel, sceneId, call }) {
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const { book, diagnostics: before } = found;
    const rel = bookRel(book);
    if (rel === null) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(book));
    const known = new Set(before.filter((d) => d.severity === 'error').map(errKey));
    const r = await store.batch(op, { bookId, path: toLibRel(book, rel) }, (tx) => call(tx, rel), {
      verify: async () => {
        const after = (await validate(root)).diagnostics;
        const fresh = after.filter((d) => d.severity === 'error' && !known.has(errKey(d)));
        if (fresh.length) {
          const err = new Error('the change would introduce new errors');
          /** @type {any} */ (err).diagnostics = fresh;
          throw err;
        }
      },
    });
    if (r.ok) {
      await receipts.noteOwnWrites(book, [r.value.path]);
      afterWrite(book.path);
      return { ok: true, code: 'OK', path: toLibRel(book, r.value.path), sha256: r.value.sha256 };
    }
    if (r.code === 'CONFLICT') return conflict(r, bookId, sceneId);
    if (r.code === 'ROLLED_BACK') {
      return fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [], ...(r.rollbackErrors ? { rollbackErrors: r.rollbackErrors } : {}) });
    }
    return fail(r.code, r.message ? { message: r.message } : {});
  }

  const nowMs = () => Number(now());
  const tracker = createSnapshotTracker();

  /** Prune a scene's snapshots by the retention rules (moved to the trash, never deleted). */
  async function applyRetention(store, sceneId) {
    const files = planRetention((await store.listRevisions(sceneId)) ?? [], nowMs());
    if (files.length > 0) await store.pruneRevisions(sceneId, files);
  }

  /** Snapshot the scene file as it is, with `reason`. Returns the store result (`stored: false` when identical to the newest). */
  async function snapshot(store, sceneId, bytes, reason, extra = {}) {
    const end = frontMatterEnd(bytes);
    const words = countWords(end < 0 ? bytes.toString('utf8') : bytes.subarray(end).toString('utf8'));
    const r = await store.saveRevision(sceneId, bytes, { reason, at: new Date(nowMs()), words, ...extra });
    if (r.ok && r.stored) await applyRetention(store, sceneId);
    return r;
  }

  /** The book, the scene's file (null when it is not a live scene) and a store on the book. */
  async function sceneContext(bookId, sceneId, { live }) {
    const found = await findBook(bookId);
    if (!found) return null;
    const entry = found.book.order.find((/** @type {any} */ s) => s.id === sceneId) ?? null;
    if (live && !entry) return null;
    const rel = entry ? toBookRel(found.book, entry.path) : null;
    if (live && rel === null) return null;
    return { book: found.book, entry, rel, store: await openStore(bookRootOf(found.book), { recover: false }) };
  }

  async function createSceneImpl(bookId, args = {}) {
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const { chapter, act, after, title, slug, body, status, summary, dryRun } = args ?? {};
    const r = await insertScene(bookRootOf(found.book), { chapter, act, after, title, slug, body, ...(status !== undefined ? { status } : {}), ...(summary !== undefined ? { summary } : {}), dryRun: dryRun === true });
    if (!r.ok) return r;
    if (!r.dryRun) afterWrite(found.book.path);
    return { ...r, path: toLibRel(found.book, r.path) };
  }

  const PLANNER_CODES = ['REFUSED_UNKNOWN_SCENE', 'REFUSED_UNKNOWN_ENTRY'];
  const NOT_FOUND_CODES = ['REFUSED_UNKNOWN_SCENE', 'REFUSED_UNKNOWN_CHAPTER', 'REFUSED_UNKNOWN_ACT', 'REFUSED_UNKNOWN_OP', 'REFUSED_UNKNOWN_ENTRY', 'REFUSED_UNKNOWN_THREAD', 'REFUSED_UNKNOWN_EVENT', 'REFUSED_UNKNOWN_NOTE'];

  /**
   * Run one @storyforge/manuscript structure command on a book. A real change reconciles the index before
   * returning; unknown scene / chapter / act / op is NOT_FOUND (unless the code is in `keepCodes`). Change paths stay relative to the book root.
   * @param {string} bookId @param {(bookRoot: string) => Promise<any>} run @param {string[]} [keepCodes]
   */
  async function structure(bookId, run, keepCodes = []) {
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const r = await run(bookRootOf(found.book));
    if (!r.ok) return NOT_FOUND_CODES.includes(r.code) && !keepCodes.includes(r.code) ? fail('NOT_FOUND') : r;
    if (!r.dryRun && r.changes.length > 0) {
      await receipts.noteOwnWrites(found.book, r.changes.map((c) => c.to).filter((p) => typeof p === 'string'));
      if (reconcile) await reconcile(found.book.path);
      else afterWrite(found.book.path);
    }
    return r;
  }

  /** Body replacement for a live document of one of `kinds`, found by id (or slug when `bySlug`). */
  async function updateDocBody(bookId, kinds, ref, body, { baseSha256 } = {}, bySlug = false) {
    if (typeof body !== 'string') return fail('BAD_ARGS', { message: 'body must be a string' });
    const found = await findBook(bookId);
    if (!found || typeof ref !== 'string') return fail('NOT_FOUND');
    const result = await validate(root);
    const doc = extractDocs(result, found.book.path).find((d) => kinds.includes(d.kind) && !d.archived && (d.fm.id === ref || (bySlug && d.fm.slug === ref)));
    if (!doc) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book));
    const cur = await store.read(doc.rel);
    if (!cur) return fail('NOT_FOUND');
    const end = frontMatterEnd(cur.bytes);
    if (end < 0) return fail('NOT_A_DOCUMENT', { message: 'front matter is not terminated' });
    const next = Buffer.concat([cur.bytes.subarray(0, end), Buffer.from(body, 'utf8')]);
    const r = await store.write(doc.rel, next, { baseSha256 });
    if (r.ok) {
      afterWrite(found.book.path);
      return { ok: true, code: 'OK', sha256: r.sha256 };
    }
    if (r.code === 'CONFLICT') {
      const now = r.current?.bytes ?? cur.bytes;
      const e = frontMatterEnd(now);
      return fail('CONFLICT', { current: { sha256: r.current?.sha256 ?? cur.sha256, body: now.subarray(e < 0 ? 0 : e).toString('utf8') } });
    }
    return fail(r.code, r.message ? { message: r.message } : {});
  }

  return {
    async updateSceneBody(bookId, sceneId, body, { baseSha256, count = true } = {}) {
      if (typeof body !== 'string') return fail('BAD_ARGS', { message: 'body must be a string' });
      const found = await findBook(bookId);
      const entry = found?.book.order.find((/** @type {any} */ s) => s.id === sceneId);
      if (!found || !entry) return fail('NOT_FOUND');
      const rel = toBookRel(found.book, entry.path);
      if (rel === null) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(found.book));
      const cur = await store.read(rel);
      if (!cur) return fail('NOT_FOUND');
      const end = frontMatterEnd(cur.bytes);
      if (end < 0) return fail('NOT_A_SCENE', { message: 'front matter is not terminated' });
      const next = Buffer.concat([cur.bytes.subarray(0, end), Buffer.from(body, 'utf8')]);
      const changing = !next.equals(cur.bytes);
      let revisionSaved = false;
      if (changing && cur.sha256 === baseSha256) {
        // a safety copy of the file as it is, before it is overwritten (never blocks the save)
        const reason = tracker.due(sceneId, nowMs());
        if (reason) {
          revisionSaved = true;
          await snapshot(store, sceneId, cur.bytes, reason).catch(() => {});
        }
      }
      // M05-J07: the save, the first-seen baseline and (when a revision was just saved, or 10 minutes have passed) the author's flush are one batch
      const r = changing ? await receipts.saveWithReceipts(store, { rel, sceneId, next, baseSha256, flushFirst: revisionSaved }) : await store.write(rel, next, { baseSha256 });
      if (r.ok) {
        const words = count && changing ? wordDelta(cur.bytes.subarray(end).toString('utf8'), body) : { added: 0, removed: 0 };
        activity?.record(found.book.path, words);
        afterWrite(found.book.path);
        return { ok: true, code: 'OK', sha256: r.sha256, words };
      }
      if (r.code === 'CONFLICT') return conflict(r, bookId, sceneId);
      return fail(r.code, r.message ? { message: r.message } : {});
    },

    /**
     * Replace a scene's whole file (front matter and body) with `content`, only if the book has no new validation
     * error afterwards (otherwise nothing is kept: ROLLED_BACK with the new diagnostics). Conflicts: CONFLICT.
     */
    async writeSceneRaw(bookId, sceneId, content, { baseSha256 } = {}) {
      if (typeof content !== 'string') return fail('BAD_ARGS', { message: 'content must be a string' });
      const found = await findBook(bookId);
      const entry = found?.book.order.find((/** @type {any} */ s) => s.id === sceneId);
      if (!found || !entry) return fail('NOT_FOUND');
      const rel = toBookRel(found.book, entry.path);
      if (rel === null) return fail('NOT_FOUND');
      const { book, diagnostics: before } = found;
      const store = await openStore(bookRootOf(book));
      const known = new Set(before.filter((d) => d.severity === 'error').map(errKey));
      const bytes = Buffer.from(content, 'utf8');
      const r = await store.batch('writeSceneRaw', { bookId, path: toLibRel(book, rel) }, (tx) => receipts.authorWrite(store, tx, { rel, sceneId, next: bytes, baseSha256 }), {
        verify: async () => {
          const result = await validate(root);
          const fresh = result.diagnostics.filter((d) => d.severity === 'error' && !known.has(errKey(d)));
          if (fresh.length) {
            const err = new Error('the change would introduce new errors');
            /** @type {any} */ (err).diagnostics = fresh;
            throw err;
          }
          // A raw edit must leave the file a readable scene with the same id in the manuscript.
          // Otherwise (front matter removed, schema or id changed, turned into a variant) the
          // scene would silently drop out of the book even though no error is reported.
          const stillHere = result.books
            .find((b) => b.path === book.path)
            ?.order.some((/** @type {any} */ s) => s.id === sceneId && s.path === entry.path);
          if (!stillHere) {
            const err = new Error('the scene would no longer be part of the manuscript (keep its front matter, schema and id)');
            /** @type {any} */ (err).diagnostics = [];
            throw err;
          }
        },
      });
      if (r.ok) {
        if (reconcile) await reconcile(book.path);
        else afterWrite(book.path);
        return { ok: true, code: 'OK', sha256: r.value.sha256 };
      }
      if (r.code === 'CONFLICT') return conflict(r, bookId, sceneId);
      if (r.code === 'ROLLED_BACK') {
        return fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [], ...(r.rollbackErrors ? { rollbackErrors: r.rollbackErrors } : {}) });
      }
      return fail(r.code, r.message ? { message: r.message } : {});
    },

    createScene: createSceneImpl,

    // ---- M03-J04: writing log, goal, revisions

    /** Today's totals, the last `days` days and the streak for a book. */
    async getActivity(bookId, { days = 30 } = {}) {
      const found = await findBook(bookId);
      if (!found || !activity) return fail('NOT_FOUND');
      return { ok: true, code: 'OK', ...(await activity.read(found.book.path, { days })) };
    },

    /** The client reports a finished writing session of `minutes` (a whole number >= 1). */
    async recordSession(bookId, minutes) {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return fail('BAD_ARGS', { message: 'minutes must be a whole number from 1 to 1440' });
      const found = await findBook(bookId);
      if (!found || !activity) return fail('NOT_FOUND');
      activity.session(found.book.path, minutes);
      return { ok: true, code: 'OK' };
    },

    /** Write everything the activity log holds in memory to activity/writing-log.md now. */
    async flushActivity() {
      await activity?.flush();
    },

    /** Set book.md `daily_word_goal` (a whole number >= 1) with a single-line edit; nothing else in the file changes. */
    async setDailyGoal(bookId, goal) {
      if (goal === null) return fail('NOT_SUPPORTED', { message: 'removing the daily goal is not supported; edit book.md by hand' });
      if (!Number.isInteger(goal) || goal < 1 || goal > 999_999_999) return fail('BAD_ARGS', { message: 'daily_word_goal must be a whole number >= 1' });
      const found = await findBook(bookId);
      if (!found) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(found.book));
      const cur = await store.read('book.md');
      if (!cur) return fail('NOT_FOUND');
      const edit = editFrontMatterLine(cur.bytes, 'daily_word_goal', String(goal), { integer: true, anchors: ['word_target', 'status', 'profile', 'title', 'id'] });
      if (!edit.ok) return fail(edit.code, { message: edit.message });
      if (edit.changed) {
        const r = await store.write('book.md', edit.buf, { baseSha256: cur.sha256 });
        if (!r.ok) return r.code === 'CONFLICT' ? fail('CONFLICT', { current: null }) : fail(r.code, r.message ? { message: r.message } : {});
        if (reconcile) await reconcile(found.book.path);
        else afterWrite(found.book.path);
      }
      return { ok: true, code: 'OK', daily_word_goal: goal };
    },

    /** Snapshots of a scene, newest first. */
    async listRevisions(bookId, sceneId) {
      const ctx = await sceneContext(bookId, sceneId, { live: false });
      const list = ctx ? await ctx.store.listRevisions(sceneId) : null;
      // a scene that is not in the book (archived) is known only while it still has snapshots
      return list && (ctx?.entry || list.length > 0) ? { ok: true, code: 'OK', revisions: list } : fail('NOT_FOUND');
    },

    /** One snapshot: its index entry plus `front_matter` (parsed), `front_matter_text` and `body`. */
    async getRevision(bookId, sceneId, file) {
      const ctx = await sceneContext(bookId, sceneId, { live: false });
      if (!ctx) return fail('NOT_FOUND');
      const entry = ((await ctx.store.listRevisions(sceneId)) ?? []).find((e) => e.file === file);
      const bytes = entry ? await ctx.store.readRevision(sceneId, file) : null;
      if (!entry || !bytes) return fail('NOT_FOUND');
      const parts = splitRevision(bytes, frontMatterEnd(bytes));
      return { ok: true, code: 'OK', revision: { ...entry, front_matter: parts.frontMatter, front_matter_text: parts.frontMatterText, body: parts.body } };
    },

    /** Snapshot the scene file as it is now: `manual` ("Save a revision", optional label) or `external` (the editor is about to reload). */
    async saveRevision(bookId, sceneId, { label, reason = 'manual' } = {}) {
      if (reason !== 'manual' && reason !== 'external') return fail('BAD_ARGS', { message: 'reason must be manual or external' });
      if (label !== undefined && (typeof label !== 'string' || label.length > 200 || CONTROL_RE.test(label))) return fail('BAD_ARGS', { message: 'label must be text of up to 200 characters' });
      const ctx = await sceneContext(bookId, sceneId, { live: true });
      if (!ctx || ctx.rel === null) return fail('NOT_FOUND');
      const cur = await ctx.store.read(ctx.rel);
      if (!cur) return fail('NOT_FOUND');
      await receipts.flushDoc(ctx.store, sceneId, ctx.rel).catch(() => {}); // a revision is saved: the author's pending changes become a receipt first
      const r = await snapshot(ctx.store, sceneId, cur.bytes, reason, reason === 'manual' && label ? { label } : {});
      return r.ok ? { ok: true, code: 'OK', stored: r.stored, revision: r.entry } : fail(r.code, r.message ? { message: r.message } : {});
    },

    /**
     * Bring a snapshot back. `into`: the current file is snapshotted first (`restore`), then the snapshot's body replaces the
     * body (the current front matter stays). `new`: a new scene right after this one, titled "<title> (revision <date>)".
     * `baseSha256` must be the file as the author saw it (`into` requires it; `new` checks it when given): otherwise CONFLICT and nothing is written.
     * `dryRun` previews: nothing is written.
     */
    async restoreRevision(bookId, sceneId, file, { mode, baseSha256, dryRun = false } = {}) {
      if (mode !== 'into' && mode !== 'new') return fail('BAD_ARGS', { message: "mode must be 'into' or 'new'" });
      if (mode === 'into' && typeof baseSha256 !== 'string') return fail('BAD_ARGS', { message: 'base_sha256 is required' });
      if (baseSha256 !== undefined && typeof baseSha256 !== 'string') return fail('BAD_ARGS', { message: 'base_sha256 must be a string' });
      const ctx = await sceneContext(bookId, sceneId, { live: true });
      if (!ctx || ctx.rel === null) return fail('NOT_FOUND');
      const { store, rel } = ctx;
      const entry = ((await store.listRevisions(sceneId)) ?? []).find((e) => e.file === file);
      const revBytes = entry ? await store.readRevision(sceneId, file) : null;
      if (!entry || !revBytes) return fail('NOT_FOUND');
      const cur = await store.read(rel);
      if (!cur) return fail('NOT_FOUND');
      if (baseSha256 !== undefined && cur.sha256 !== baseSha256) return conflict({ current: cur }, bookId, sceneId);
      const curEnd = frontMatterEnd(cur.bytes);
      const revEnd = frontMatterEnd(revBytes);
      if (curEnd < 0) return fail('NOT_A_SCENE', { message: 'front matter is not terminated' });
      const revBody = revEnd < 0 ? revBytes : revBytes.subarray(revEnd);
      const norm = (b) => b.toString('utf8').replace(/\r\n/g, '\n');
      const curHead = cur.bytes.subarray(0, curEnd);
      const revHead = revEnd < 0 ? Buffer.alloc(0) : revBytes.subarray(0, revEnd);
      const title = `${ctx.entry?.title ?? 'Scene'} (revision ${localDate(new Date(entry.at))})`;
      if (dryRun) {
        return {
          ok: true,
          code: 'OK',
          dryRun: true,
          mode,
          revision: entry,
          current_sha256: cur.sha256,
          body_differs: !cur.bytes.subarray(curEnd).equals(revBody),
          front_matter_differs: norm(curHead) !== norm(revHead),
          front_matter: { revision: revHead.toString('utf8'), current: curHead.toString('utf8') },
          ...(mode === 'new' ? { title } : {}),
        };
      }
      if (mode === 'new') {
        const scene = await getScene(bookId, sceneId);
        if (!scene) return fail('NOT_FOUND');
        const r = await createSceneImpl(bookId, { chapter: scene.chapter, act: scene.act, after: sceneId, title, slug: slugify(title) || 'revision', body: revBody.toString('utf8') });
        return r.ok ? { ok: true, code: 'OK', mode, id: r.id, path: r.path, title } : r;
      }
      const saved = await snapshot(store, sceneId, cur.bytes, 'restore');
      if (!saved.ok) return fail(saved.code, saved.message ? { message: saved.message } : {});
      const next = Buffer.concat([curHead, revBody]);
      const w = await receipts.writeWithReceipt(store, {
        opName: 'write',
        args: { rel },
        rel,
        targetId: sceneId,
        baseSha256: cur.sha256,
        after: next,
        receipt: { operation: 'revision.restore', actor: 'author', workflow: 'revision', summary: `Author restored the revision saved ${entry.at}.` },
      });
      if (!w.ok) return w.code === 'CONFLICT' ? conflict(w, bookId, sceneId) : fail(w.code, w.message ? { message: w.message } : {});
      afterWrite(ctx.book.path);
      return { ok: true, code: 'OK', mode, sha256: w.sha256, snapshot: saved.entry };
    },

    async archiveScene(bookId, sceneId, { baseSha256 } = {}) {
      const found = await findBook(bookId);
      const entry = found?.book.order.find((/** @type {any} */ s) => s.id === sceneId);
      if (!found || !entry) return fail('NOT_FOUND');
      return guardedMove(bookId, {
        op: 'archiveScene',
        bookRel: (book) => toBookRel(book, entry.path),
        sceneId,
        call: (tx, rel) => tx.archive(rel, { baseSha256 }),
      });
    },

    restoreScene(bookId, archivedPath, { baseSha256 } = {}) {
      return guardedMove(bookId, {
        op: 'restoreScene',
        bookRel: (book) => (typeof archivedPath === 'string' ? toBookRel(book, archivedPath) : null),
        call: (tx, rel) => tx.restore(rel, { baseSha256 }),
      });
    },

    setSceneFields: (bookId, sceneId, args = {}) => structure(bookId, (b) => setSceneFields(b, sceneId, args ?? {})),
    /**
     * Move a scene. `expect: [{ path, sha256 }]` (book-relative paths) is the state the author saw: if any listed file
     * differs now, nothing is written and the result is CONFLICT with `changed: [paths]`.
     */
    moveScene: (bookId, sceneId, args = {}) =>
      structure(bookId, async (b) => {
        const { expect, ...rest } = args ?? {};
        if (expect !== undefined) {
          if (!Array.isArray(expect) || expect.some((e) => !e || typeof e.path !== 'string' || typeof e.sha256 !== 'string')) {
            return fail('REFUSED_BAD_ARGS', { message: 'expect must be a list of { path, sha256 }' });
          }
          const store = await openStore(b);
          const changed = [];
          for (const e of expect) {
            const now = await store.read(e.path);
            if (!now || now.sha256 !== e.sha256) changed.push(e.path);
          }
          if (changed.length) return fail('CONFLICT', { changed, message: `changed on disk since you looked: ${changed.join(', ')}` });
        }
        return moveScene(b, sceneId, rest);
      }),
    splitScene: (bookId, sceneId, args = {}) => structure(bookId, (b) => splitScene(b, sceneId, args ?? {})),
    mergeScenes: (bookId, args = {}) => structure(bookId, (b) => mergeScenes(b, args?.first, args?.second, { dryRun: args?.dryRun })),
    createChapter: (bookId, args = {}) => structure(bookId, (b) => createChapter(b, args ?? {})),
    setChapterFields: (bookId, chapter, args = {}) => structure(bookId, (b) => setChapterFields(b, chapter, args ?? {})),
    archiveChapter: (bookId, chapter, args = {}) => structure(bookId, (b) => archiveChapter(b, chapter, args ?? {})),
    renumberChapters: (bookId, args = {}) => structure(bookId, (b) => renumberChapters(b, args ?? {})),
    createAct: (bookId, args = {}) => structure(bookId, (b) => createAct(b, args ?? {})),
    setActFields: (bookId, act, args = {}) => structure(bookId, (b) => setActFields(b, act, args ?? {})),
    restoreOp: (bookId, opId, args = {}) => structure(bookId, async (b) => restoreOp(b, opId, args ?? {}, { stage: await receipts.undoStager(b) })),

    // ---- M04-J02: Codex entries and types (canonical files only; dryRun previews with diffs)
    createEntry: (bookId, args = {}) => structure(bookId, (b) => createEntry(b, args ?? {})),
    setEntryFields: (bookId, ref, args = {}) => structure(bookId, (b) => setEntryFields(b, ref, args ?? {})),
    changeEntrySlug: (bookId, ref, args = {}) => structure(bookId, (b) => changeEntrySlug(b, ref, args ?? {})),
    archiveEntry: (bookId, ref, args = {}) => structure(bookId, (b) => archiveEntry(b, ref, args ?? {})),
    /** `ref`: an archived entry's id or slug, or its archived path (library-relative, archive/codex/...). */
    async restoreEntry(bookId, ref, args = {}) {
      const found = await findBook(bookId);
      if (!found) return fail('NOT_FOUND');
      const rel = typeof ref === 'string' && ref.includes('/') ? toBookRel(found.book, ref) : ref;
      if (rel === null) return fail('NOT_FOUND');
      return structure(bookId, (b) => restoreEntry(b, rel, args ?? {}));
    },
    createCodexType: (bookId, args = {}) => structure(bookId, (b) => createCodexType(b, args ?? {})),

    // ---- M04-J03: plot threads (canonical files only; dryRun previews with diffs)
    createThread: (bookId, args = {}) => structure(bookId, (b) => createThread(b, args ?? {})),
    setThreadFields: (bookId, ref, args = {}) => structure(bookId, (b) => setThreadFields(b, ref, args ?? {})),

    // ---- Story Planner M1: causal links and scene plans (planning/links, planning/scene-plans). REFUSED_UNKNOWN_SCENE / REFUSED_UNKNOWN_ENTRY are kept (not turned into NOT_FOUND).
    createLink: (bookId, args = {}) => structure(bookId, (b) => createLink(b, args ?? {}), PLANNER_CODES),
    updateLink: (bookId, slug, args = {}) => structure(bookId, (b) => updateLink(b, slug, args ?? {}), PLANNER_CODES),
    archiveLink: (bookId, slug, args = {}) => structure(bookId, (b) => archiveLink(b, slug, args ?? {}), PLANNER_CODES),
    restoreLink: (bookId, slug, args = {}) => structure(bookId, (b) => restoreLink(b, slug, args ?? {}), PLANNER_CODES),
    saveScenePlan: (bookId, sceneId, args = {}) => structure(bookId, (b) => saveScenePlan(b, sceneId, args ?? {}), PLANNER_CODES),

    // ---- M04-J04: timeline events, research notes / planning docs / sources, attachments (canonical files only; dryRun previews with diffs)
    createEvent: (bookId, args = {}) => structure(bookId, (b) => createEvent(b, args ?? {})),
    setEventFields: (bookId, ref, args = {}) => structure(bookId, (b) => setEventFields(b, ref, args ?? {})),
    archiveEvent: (bookId, ref, args = {}) => structure(bookId, (b) => archiveEvent(b, ref, args ?? {})),
    /** `ref`: an archived event's id, slug or archived path (library-relative, archive/planning/timeline/...). */
    async restoreEvent(bookId, ref, args = {}) {
      const found = await findBook(bookId);
      if (!found) return fail('NOT_FOUND');
      const rel = typeof ref === 'string' && ref.includes('/') ? toBookRel(found.book, ref) : ref;
      if (rel === null) return fail('NOT_FOUND');
      return structure(bookId, (b) => restoreEvent(b, rel, args ?? {}));
    },
    // ---- M05-J02: continuity exceptions (planning/continuity/<slug>.md, through the store) and the context lines of a finding
    ...createContinuityExceptionMethods({ root, afterWrite, reconcile, now }),
    // ---- M05-J06: suggestions (suggestions/<YYYY>/*.md, through the store; a target changes only on accept) and the read-only scene check
    ...createSuggestionMethods({ root, afterWrite, reconcile, now, receipts, readValidate }),
    // ---- M07-J03b: comments (comments/<YYYY>/*.md, through the store; they never change the file they are about)
    ...createCommentMethods({ root, afterWrite, reconcile, now, readValidate }),
    ...createCheckMethods({ root, now, receipts }),
    // ---- M08-J03: AI cover drafts (assets/drafts/, through the store; a draft becomes the cover only by a single-line book.md edit) and activity/ai-usage.md
    ...createCoverMethods({ root, afterWrite, reconcile, now }),
    // ---- M05-J07: receipts (provenance ledger): reads, flush and verification; the writer is shared with the changes above
    getReceipts: receipts.getReceipts,
    blame: receipts.blame,
    flushReceipts: receipts.flushReceipts,
    verifyReceipts: receipts.verifyReceipts,
    /** Write the receipt(s) of a provenance event (the AI routes report through here). */
    recordProvenance: (event) => recordProvenance(event, { engine: receipts }),

    createNote: (bookId, args = {}) => structure(bookId, (b) => createNote(b, args ?? {})),
    setNoteFields: (bookId, id, args = {}) => structure(bookId, (b) => setNoteFields(b, id, args ?? {})),
    archiveNote: (bookId, id, args = {}) => structure(bookId, (b) => archiveNote(b, id, args ?? {})),
    restoreNote: (bookId, id, args = {}) => structure(bookId, (b) => restoreNote(b, id, args ?? {})),
    /**
     * Store an uploaded file as assets/research/<safe-name> (the store is the only writer; a taken name gets -2, -3). `notePath` is the note's book-relative path
     * (or its id): the returned `markdown` is the link to insert relative to that note's folder. Refusals: BAD_NAME / BAD_ARGS (400), UNSUPPORTED_TYPE (415), TOO_LARGE (413).
     */
    async uploadAttachment(bookId, { name, bytes, note, purpose } = {}) {
      let notePath = note;
      if (typeof note === 'string' && /^note_/.test(note)) {
        const found = await findBook(bookId);
        const doc = found ? extractDocs(await validate(root), found.book.path).find((d) => d.fm.id === note && !d.archived) : null;
        notePath = doc ? doc.rel : undefined;
      }
      return structure(bookId, (b) => uploadAttachment(b, { name, bytes, ...(typeof notePath === 'string' ? { notePath } : {}), ...(purpose !== undefined ? { purpose } : {}) }));
    },

    /** Replace the body of a live event / research note / planning doc / source (the text after its front matter), keeping the front matter bytes. Same conflict rule as an entry body. */
    updateEventBody: (bookId, ref, body, opts) => updateDocBody(bookId, ['event'], ref, body, opts, true),
    updateNoteBody: (bookId, id, body, opts) => updateDocBody(bookId, ['research', 'doc', 'source'], id, body, opts, false),

    /**
     * Replace the body of a live thread (the text after its front matter), keeping the front matter bytes. Same conflict rule as an entry body:
     * baseSha256 must be the file the author saw, else CONFLICT with current: { sha256, body }. ref is the thread id or slug.
     */
    async updateThreadBody(bookId, ref, body, { baseSha256 } = {}) {
      if (typeof body !== 'string') return fail('BAD_ARGS', { message: 'body must be a string' });
      const found = await findBook(bookId);
      if (!found || typeof ref !== 'string') return fail('NOT_FOUND');
      const result = await validate(root);
      const doc = extractDocs(result, found.book.path).find((d) => d.kind === 'thread' && !d.archived && (d.fm.id === ref || d.fm.slug === ref));
      if (!doc) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(found.book));
      const cur = await store.read(doc.rel);
      if (!cur) return fail('NOT_FOUND');
      const end = frontMatterEnd(cur.bytes);
      if (end < 0) return fail('NOT_A_THREAD', { message: 'front matter is not terminated' });
      const next = Buffer.concat([cur.bytes.subarray(0, end), Buffer.from(body, 'utf8')]);
      const r = await store.write(doc.rel, next, { baseSha256 });
      if (r.ok) {
        afterWrite(found.book.path);
        return { ok: true, code: 'OK', sha256: r.sha256 };
      }
      if (r.code === 'CONFLICT') {
        const now = r.current?.bytes ?? cur.bytes;
        const e = frontMatterEnd(now);
        return fail('CONFLICT', { current: { sha256: r.current?.sha256 ?? cur.sha256, body: now.subarray(e < 0 ? 0 : e).toString('utf8') } });
      }
      return fail(r.code, r.message ? { message: r.message } : {});
    },

    /**
     * Replace the body of a live entry (the text after its front matter), keeping the front matter bytes. Same conflict rule as a scene
     * body: baseSha256 must be the file the author saw, else CONFLICT with current: { sha256, body }. ref is the entry id or slug.
     */
    async updateEntryBody(bookId, ref, body, { baseSha256 } = {}) {
      if (typeof body !== 'string') return fail('BAD_ARGS', { message: 'body must be a string' });
      const found = await findBook(bookId);
      if (!found || typeof ref !== 'string') return fail('NOT_FOUND');
      const result = await validate(root);
      const doc = extractDocs(result, found.book.path).find((d) => d.kind === 'entry' && !d.archived && (d.fm.id === ref || d.fm.slug === ref));
      if (!doc) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(found.book));
      const cur = await store.read(doc.rel);
      if (!cur) return fail('NOT_FOUND');
      const end = frontMatterEnd(cur.bytes);
      if (end < 0) return fail('NOT_AN_ENTRY', { message: 'front matter is not terminated' });
      const next = Buffer.concat([cur.bytes.subarray(0, end), Buffer.from(body, 'utf8')]);
      const r = await store.write(doc.rel, next, { baseSha256 });
      if (r.ok) {
        afterWrite(found.book.path);
        return { ok: true, code: 'OK', sha256: r.sha256 };
      }
      if (r.code === 'CONFLICT') {
        const now = r.current?.bytes ?? cur.bytes;
        const e = frontMatterEnd(now);
        return fail('CONFLICT', { current: { sha256: r.current?.sha256 ?? cur.sha256, body: now.subarray(e < 0 ? 0 : e).toString('utf8') } });
      }
      return fail(r.code, r.message ? { message: r.message } : {});
    },

    // ---- M05-J04: optional AI workshop. Nothing here talks to a provider; it only reads a selection and writes through the store.

    /**
     * The text of a selection in a live scene (`from` / `to` are editor offsets into the body, line breaks counting 1), with the file hash it was read at.
     * Refusals: NOT_FOUND, BAD_SELECTION, NOT_UTF8.
     */
    async readAiSelection(bookId, sceneId, { from, to } = {}) {
      const ctx = await sceneContext(bookId, sceneId, { live: true });
      if (!ctx || ctx.rel === null) return fail('NOT_FOUND');
      const cur = await ctx.store.read(ctx.rel);
      if (!cur) return fail('NOT_FOUND');
      const end = frontMatterEnd(cur.bytes);
      if (end < 0) return fail('NOT_A_SCENE', { message: 'front matter is not terminated' });
      const sel = selectRange(cur.bytes, end, from, to);
      if (!sel.ok) return fail(sel.code, { message: sel.message });
      return { ok: true, code: 'OK', path: ctx.rel, sha256: cur.sha256, text: sel.text };
    },

    /**
     * Replace one selected range of a live scene with `replacement`, only if the scene is still exactly as it was when the context was built
     * (`baseSha256`) and the range still holds `original`: otherwise SCENE_CHANGED and nothing is written. Everything outside the range stays
     * byte-identical. One journaled atomic write; `opId` undoes it (POST /ops/:opId/restore).
     */
    async applyAiRewrite(bookId, sceneId, { baseSha256, from, to, original, replacement } = {}) {
      if (typeof baseSha256 !== 'string' || typeof original !== 'string' || typeof replacement !== 'string') return fail('BAD_ARGS', { message: 'baseSha256, original and replacement must be strings' });
      const ctx = await sceneContext(bookId, sceneId, { live: true });
      if (!ctx || ctx.rel === null) return fail('NOT_FOUND');
      const cur = await ctx.store.read(ctx.rel);
      if (!cur) return fail('NOT_FOUND');
      const changed = fail('SCENE_CHANGED', { message: 'the scene changed after the preview; nothing was written' });
      if (cur.sha256 !== baseSha256) return changed;
      const end = frontMatterEnd(cur.bytes);
      if (end < 0) return fail('NOT_A_SCENE', { message: 'front matter is not terminated' });
      const sel = selectRange(cur.bytes, end, from, to);
      if (!sel.ok || sel.text !== original) return changed;
      const next = spliceReplacement(cur.bytes, sel, replacement);
      const hint = receipts.hintFor(ctx.book, sceneId);
      const r = await receipts.writeWithReceipt(ctx.store, {
        opName: 'write',
        args: { rel: ctx.rel },
        rel: ctx.rel,
        targetId: sceneId,
        baseSha256: cur.sha256,
        after: next,
        receipt: {
          operation: 'suggestion.accept',
          actor: 'ai',
          workflow: 'ai-rewrite',
          ai: { ...hint, acceptance: 'accepted' },
          summary: 'Author applied an AI rewrite of a selected passage.',
        },
      });
      if (!r.ok) return r.code === 'CONFLICT' ? changed : fail(r.code, r.message ? { message: r.message } : {});
      afterWrite(ctx.book.path);
      return { ok: true, code: 'OK', sha256: r.sha256, opId: r.opId ?? null, path: ctx.rel };
    },

    /**
     * Save (or, with `existing`, rewrite) one AI record file ai/<YYYY>/<YYYYMMDD-HHMMSS>-<task>.md through the store.
     * `record` is what renderAiRecord() takes without `id` / `created`; `existing` is { path, id, created } from the first save.
     */
    async saveAiRecord(bookId, record, existing = undefined) {
      const found = await findBook(bookId);
      if (!found) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(found.book));
      let rel;
      let id;
      let created;
      let base = null;
      if (existing) {
        if (typeof existing.path !== 'string' || !/^ai\/\d{4}\/[0-9a-z-]+\.md$/.test(existing.path)) return fail('BAD_ARGS', { message: 'not an AI record path' });
        const cur = await store.read(existing.path);
        if (!cur) return fail('NOT_FOUND');
        ({ path: rel, id, created } = existing);
        base = cur.sha256;
      } else {
        const at = new Date(nowMs());
        const first = recordPath(at, record.task);
        rel = first;
        for (let n = 2; await store.read(rel); n++) rel = first.replace(/\.md$/, `-${n}.md`);
        id = `note_${ulid()}`;
        created = at.toISOString();
      }
      const bytes = Buffer.from(renderAiRecord({ ...record, id, created }), 'utf8');
      const r = await store.write(rel, bytes, { baseSha256: base });
      if (!r.ok) return fail(r.code, r.message ? { message: r.message } : {});
      afterWrite(found.book.path);
      return { ok: true, code: 'OK', path: rel, id, created, sha256: r.sha256 };
    },

    async recover() {
      const result = await validate(root);
      const report = { completed: [], rolledBack: [], needsAttention: [] };
      const seen = new Set();
      // the library folder has a journal of its own (a new book that was being put in place)
      if (!result.books.some((/** @type {any} */ b) => b.path === '')) {
        seen.add('');
        const r = await (await openStore(root, { recover: false })).recover();
        for (const key of /** @type {const} */ (['completed', 'rolledBack', 'needsAttention'])) {
          for (const item of r[key]) report[key].push({ ...item, book: '' });
        }
      }
      for (const book of result.books) {
        if (seen.has(book.path)) continue;
        seen.add(book.path);
        const store = await openStore(bookRootOf(book), { recover: false });
        const r = await store.recover();
        for (const key of /** @type {const} */ (['completed', 'rolledBack', 'needsAttention'])) {
          for (const item of r[key]) report[key].push({ ...item, book: book.path });
        }
      }
      return report;
    },
  };
}
