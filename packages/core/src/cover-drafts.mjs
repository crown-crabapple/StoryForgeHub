// AI cover drafts (M08-J03 contract section 3) and the per-book AI usage table (section 2). Everything is written through @storyforge/store.
//   assets/drafts/cover-<YYYYMMDD-HHMMSS>-<n>.png   the generated picture
//   assets/drafts/cover-<YYYYMMDD-HHMMSS>-<n>.md    its asset note (storyforge.asset-note/v1: prompt, provider, model, locality, created, sha256)
// A draft is a draft: it becomes the cover only through useCoverDraft, a single-line `cover:` edit of book.md. A deleted draft goes to the trash.
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '@storyforge/format';
import { editFrontMatterLine, ulid } from '@storyforge/manuscript';
import { openStore } from '@storyforge/store';
import { USAGE_PATH, applyAiUsage, newAiUsage } from './ai-usage.mjs';
import { parseFrontMatter } from './fm.mjs';
import { localDate } from './writing-log.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
export const DRAFT_DIR = 'assets/drafts';
const NAME_RE = /^cover-\d{8}-\d{6}-\d+\.png$/;
const MAX_PROMPT_CHARS = 4000;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const p2 = (n, w = 2) => String(n).padStart(w, '0');

/** @param {{ root: string, afterWrite?: (bookPath: string) => void, reconcile?: (bookPath: string) => Promise<any>, now?: () => number | Date }} p */
export function createCoverMethods({ root, afterWrite = () => {}, reconcile, now = () => Date.now() }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));
  const nowMs = () => Number(now());
  async function findBook(bookId) {
    const result = await validate(root);
    return result.books.find((/** @type {any} */ b) => b.id === bookId) ?? null;
  }
  async function refresh(book) {
    if (reconcile) await reconcile(book.path);
    else afterWrite(book.path);
  }
  /** One usage write at a time per process, so two quick requests cannot lose a count. */
  let usageQueue = Promise.resolve();

  /** The `cover` value of book.md (book-relative), or ''. @param {any} store */
  async function currentCover(store) {
    const cur = await store.read('book.md');
    const v = cur ? parseFrontMatter(cur.bytes.toString('utf8')).fm.cover : '';
    return typeof v === 'string' ? v.replace(/\\/g, '/') : '';
  }

  return {
    /**
     * Save a generated picture as a draft asset with its note. `meta`: { prompt, provider, model, locality }.
     * @param {string} bookId @param {{ bytes: Buffer, prompt: string, provider: string, model: string, locality: 'local' | 'cloud' }} draft
     */
    async saveCoverDraft(bookId, { bytes, prompt, provider, model, locality }) {
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) return fail('BAD_ARGS', { message: 'no picture' });
      if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) return fail('BAD_ARGS', { message: 'bad prompt' });
      const book = await findBook(bookId);
      if (!book) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(book));
      const at = new Date(nowMs());
      const stamp = `${p2(at.getFullYear(), 4)}${p2(at.getMonth() + 1)}${p2(at.getDate())}-${p2(at.getHours())}${p2(at.getMinutes())}${p2(at.getSeconds())}`;
      let n = 1;
      while (await store.exists(`${DRAFT_DIR}/cover-${stamp}-${n}.png`)) n++;
      const name = `cover-${stamp}-${n}.png`;
      const rel = `${DRAFT_DIR}/${name}`;
      const noteRel = `${DRAFT_DIR}/cover-${stamp}-${n}.md`;
      const id = `note_${ulid()}`;
      const created = at.toISOString();
      const digest = sha256(bytes);
      const fm = { schema: 'storyforge.asset-note/v1', id, title: `Cover draft ${stamp}-${n}`, asset: name, prompt, provider, model, locality, created, sha256: digest };
      const note = Buffer.from(`---\n${YAML.stringify(fm, { lineWidth: 0 })}---\nA draft cover made by an AI image provider. It is not the book's cover until you choose "Use as cover".\n`, 'utf8');
      const r = await store.batch('cover-draft', { bookId, path: rel }, async (tx) => {
        for (const [p, b] of [[rel, bytes], [noteRel, note]]) {
          const w = await tx.create(p, b);
          if (!w.ok) throw new Error(`could not stage ${p}`);
        }
      });
      if (!r.ok) return fail(r.code, r.message ? { message: r.message } : {});
      await refresh(book);
      return { ok: true, code: 'OK', name, path: rel, notePath: noteRel, id, sha256: digest, created };
    },

    /** The drafts of a book, newest first, each with what its note says and whether it is the cover now. @param {string} bookId */
    async listCoverDrafts(bookId) {
      const book = await findBook(bookId);
      if (!book) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(book), { recover: false });
      const cover = await currentCover(store);
      const drafts = [];
      for (const e of await store.list(DRAFT_DIR)) {
        if (e.isDirectory || !NAME_RE.test(e.name)) continue;
        const note = await store.read(`${DRAFT_DIR}/${e.name.replace(/\.png$/, '.md')}`);
        const fm = note ? parseFrontMatter(note.bytes.toString('utf8')).fm : {};
        drafts.push({
          name: e.name,
          path: `${DRAFT_DIR}/${e.name}`,
          created: typeof fm.created === 'string' ? fm.created : fm.created instanceof Date ? fm.created.toISOString() : null,
          prompt: typeof fm.prompt === 'string' ? fm.prompt : null,
          provider: typeof fm.provider === 'string' ? fm.provider : null,
          model: typeof fm.model === 'string' ? fm.model : null,
          locality: fm.locality === 'local' || fm.locality === 'cloud' ? fm.locality : null,
          sha256: typeof fm.sha256 === 'string' ? fm.sha256 : null,
          isCover: cover === `${DRAFT_DIR}/${e.name}`,
        });
      }
      drafts.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      return { ok: true, code: 'OK', drafts };
    },

    /** The bytes of one draft picture, or null. @param {string} bookId @param {string} name */
    async readCoverDraft(bookId, name) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
      const book = await findBook(bookId);
      if (!book) return null;
      const f = await (await openStore(bookRootOf(book), { recover: false })).read(`${DRAFT_DIR}/${name}`);
      return f ? f.bytes : null;
    },

    /** "Use as cover": a single-line edit of book.md (`cover:`). Nothing else in the file changes. @param {string} bookId @param {string} name */
    async useCoverDraft(bookId, name) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) return fail('BAD_ARGS', { message: 'not a cover draft' });
      const book = await findBook(bookId);
      if (!book) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(book));
      if (!(await store.exists(`${DRAFT_DIR}/${name}`))) return fail('NOT_FOUND', { message: 'no such draft' });
      const cur = await store.read('book.md');
      if (!cur) return fail('NOT_FOUND');
      const value = `${DRAFT_DIR}/${name}`;
      const edit = editFrontMatterLine(cur.bytes, 'cover', value, { plain: true, anchors: ['cover_color', 'language', 'word_target', 'status', 'profile', 'title', 'id'] });
      if (!edit.ok) return fail(edit.code, { message: edit.message });
      if (edit.changed) {
        const w = await store.write('book.md', edit.buf, { baseSha256: cur.sha256 });
        if (!w.ok) return w.code === 'CONFLICT' ? fail('CONFLICT') : fail(w.code, w.message ? { message: w.message } : {});
        await refresh(book);
      }
      return { ok: true, code: 'OK', cover: value };
    },

    /** Delete a draft and its note (both move to the trash). A draft that is the cover now is refused. @param {string} bookId @param {string} name */
    async deleteCoverDraft(bookId, name) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) return fail('BAD_ARGS', { message: 'not a cover draft' });
      const book = await findBook(bookId);
      if (!book) return fail('NOT_FOUND');
      const store = await openStore(bookRootOf(book));
      const rel = `${DRAFT_DIR}/${name}`;
      const png = await store.read(rel);
      if (!png) return fail('NOT_FOUND', { message: 'no such draft' });
      if ((await currentCover(store)) === rel) return fail('IN_USE', { message: 'this draft is the cover now; choose another cover first' });
      const noteRel = rel.replace(/\.png$/, '.md');
      const note = await store.read(noteRel);
      const r = await store.batch('cover-draft-delete', { bookId, path: rel }, async (tx) => {
        const a = await tx.remove(rel, { baseSha256: png.sha256 });
        if (!a.ok) throw new Error('could not remove the draft');
        if (note) {
          const b = await tx.remove(noteRel, { baseSha256: note.sha256 });
          if (!b.ok) throw new Error('could not remove the note');
        }
      });
      if (!r.ok) return fail(r.code, r.message ? { message: r.message } : {});
      await refresh(book);
      return { ok: true, code: 'OK', opId: r.opId ?? null };
    },

    /**
     * Add one request to activity/ai-usage.md (created on first use). Called only when AI records or usage tracking is on for the book.
     * @param {string} bookId @param {{ profile: string, locality: 'local' | 'cloud', promptTokens: number, completionTokens: number, estimated: boolean }} usage
     */
    recordAiUsage(bookId, usage) {
      const run = usageQueue.then(async () => {
        const book = await findBook(bookId);
        if (!book) return fail('NOT_FOUND');
        const store = await openStore(bookRootOf(book), { recover: false });
        const date = localDate(nowMs());
        for (let attempt = 0; attempt < 3; attempt++) {
          const cur = await store.read(USAGE_PATH);
          const text = applyAiUsage(cur ? cur.bytes.toString('utf8') : newAiUsage(), { ...usage, date });
          const w = await store.write(USAGE_PATH, Buffer.from(text, 'utf8'), { baseSha256: cur ? cur.sha256 : null });
          if (w.ok) {
            afterWrite(book.path);
            return { ok: true, code: 'OK' };
          }
          if (w.code !== 'CONFLICT') return fail(w.code, w.message ? { message: w.message } : {});
        }
        return fail('CONFLICT');
      });
      usageQueue = run.then(() => {}, () => {});
      return run;
    },
  };
}
