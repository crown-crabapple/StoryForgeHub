// Comments (M07-J03b, FORMAT-v1 9.5): create, reply to, resolve and list the documents under comments/<YYYY>/. Everything is written through @storyforge/store.
// A comment never changes the file it is about, is never exported, and is part of a book backup (it is an ordinary file of the book folder).
// The text of the documents (build, parse, locate the anchor) is @storyforge/suggestions; nothing here touches the filesystem.
import path from 'node:path';
import { extractDocs, validate } from '@storyforge/format';
import { slugify, ulid } from '@storyforge/manuscript';
import { openStore } from '@storyforge/store';
import { MAX_COMMENT_CHARS, MAX_QUOTE_CHARS, addReply, anchorSha, buildComment, commentPath, locateAnchor, parseComment, setCommentStatus, splitLines } from '@storyforge/suggestions';
import { currentBy } from './actor.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const TARGET_KINDS = ['scene', 'entry', 'thread', 'event'];
/** The name a comment carries when nobody is signed in (personal mode: author notes with anchors). */
export const PERSONAL_NAME = 'Author';
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * @param {{ root: string, afterWrite?: (bookPath: string) => void, reconcile?: (bookPath: string) => Promise<any>, now?: () => number | Date, readValidate?: () => Promise<any> }} p
 */
export function createCommentMethods({ root, afterWrite = () => {}, reconcile, now = () => Date.now(), readValidate = () => validate(root) }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));
  const nowMs = () => Number(now());
  const byOf = (given) => given ?? currentBy() ?? { name: PERSONAL_NAME };

  /** `cached`: for reads only; anything that goes on to write looks at the disk. */
  async function findBook(bookId, cached = false) {
    const result = await (cached ? readValidate() : validate(root));
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, result } : null;
  }
  const live = (found) => extractDocs(found.result, found.book.path).filter((d) => !d.archived);
  async function refresh(book) {
    if (reconcile) await reconcile(book.path);
    else afterWrite(book.path);
  }

  /** The comment as the API shows it. `targetBytes`: the target as it is now (null: gone), for finding the anchor again. */
  function shape(rel, parsed, targetBytes) {
    const located = targetBytes ? locateAnchor(targetBytes, parsed.anchor) : { ok: false };
    return {
      id: parsed.id,
      path: rel,
      target: parsed.target,
      status: parsed.status,
      by: parsed.by,
      created: parsed.created,
      text: parsed.text,
      replies: parsed.replies,
      anchor: { line: parsed.anchor.line, lines: parsed.anchor.lines, quote: parsed.anchor.quote },
      anchored: located.ok,
      line: located.ok ? located.line : null,
    };
  }

  /**
   * Make a comment about lines of a scene (or entry, thread, event). `line` / `lines` are 1-based lines of the file (front matter included, as suggestion hunks count).
   * `quote` is the selected text (optional; the anchored lines are used when it is left out). `by` defaults to the request's actor, else `{ name: "Author" }`.
   * Refusals: NOT_FOUND, BAD_ARGS (a missing text, a text over 20000 characters, lines outside the file).
   * @param {string} bookId @param {{ target?: string, line?: number, lines?: number, quote?: string, text?: string, by?: { id?: string, name: string } }} args
   */
  async function createComment(bookId, args = {}) {
    const { target, line, lines = 1, quote, text } = args ?? {};
    if (typeof target !== 'string' || target === '') return fail('BAD_ARGS', { message: 'target must be the id of a scene, entry, thread or event' });
    if (typeof text !== 'string' || text.trim() === '') return fail('BAD_ARGS', { message: 'a comment needs text' });
    if (text.length > MAX_COMMENT_CHARS) return fail('BAD_ARGS', { message: `a comment can be at most ${MAX_COMMENT_CHARS} characters` });
    if (!Number.isInteger(line) || line < 1 || !Number.isInteger(lines) || lines < 1 || lines > 10_000) return fail('BAD_ARGS', { message: 'line and lines must be whole numbers of 1 or more' });
    if (quote !== undefined && typeof quote !== 'string') return fail('BAD_ARGS', { message: 'quote must be text' });
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const doc = live(found).find((d) => TARGET_KINDS.includes(/** @type {string} */ (d.kind)) && d.fm.id === target);
    if (!doc) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const cur = await store.read(doc.rel);
    if (!cur) return fail('NOT_FOUND');
    const all = splitLines(cur.bytes).lines;
    if (line - 1 + lines > all.length) return fail('BAD_ARGS', { message: 'those lines are not in the file' });
    const anchored = all.slice(line - 1, line - 1 + lines).join(' ');
    const created = isoSeconds(nowMs());
    const id = `note_${ulid()}`;
    const built = buildComment({
      id,
      targetId: target,
      anchor: { line, lines, quote: (quote?.trim() ? quote : anchored).slice(0, MAX_QUOTE_CHARS), sha256: anchorSha(cur.bytes, line, lines) },
      by: byOf(args.by),
      created,
      text,
    });
    const first = commentPath(created, slugify(text.split(/\s+/).slice(0, 6).join(' ')));
    let rel = first;
    for (let n = 2; await store.exists(rel); n++) rel = first.replace(/\.md$/, `-${n}.md`);
    const r = await store.create(rel, Buffer.from(built, 'utf8'));
    if (!r.ok) return fail(r.code, r.message ? { message: r.message } : {});
    await refresh(found.book);
    return { ok: true, code: 'OK', id, path: rel, comment: shape(rel, parseComment(built), cur.bytes) };
  }

  /** Change one comment file in a single store batch (the text is read inside it, so two replies at once both land). */
  async function change(bookId, commentId, name, edit) {
    const found = await findBook(bookId);
    const doc = found && typeof commentId === 'string' ? live(found).find((d) => d.kind === 'comment' && d.fm.id === commentId) : null;
    if (!found || !doc) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book));
    const r = await store.batch(name, { commentId, path: doc.rel }, async (tx) => {
      const cur = await tx.read(doc.rel);
      if (!cur) return fail('NOT_FOUND');
      const before = cur.bytes.toString('utf8');
      let next;
      try {
        next = edit(before);
      } catch (e) {
        return fail('BAD_ARGS', { message: String(/** @type {any} */ (e)?.message ?? e) });
      }
      if (next === before) return { ok: true, unchanged: true, text: next };
      const w = await tx.write(doc.rel, Buffer.from(next, 'utf8'), { baseSha256: cur.sha256 });
      if (!w.ok) return w;
      return { ok: true, text: next };
    });
    if (!r.ok) return fail(r.code, r.message ? { message: r.message } : {});
    if (!r.value.ok) return r.value;
    if (!r.value.unchanged) await refresh(found.book);
    const targetDoc = live(found).find((d) => d.fm.id === doc.fm.target);
    const targetBytes = targetDoc ? (await store.read(targetDoc.rel))?.bytes ?? null : null;
    return { ok: true, code: 'OK', comment: shape(doc.rel, parseComment(r.value.text), targetBytes) };
  }

  /**
   * Append a reply to a comment. Refusals: NOT_FOUND, BAD_ARGS.
   * @param {string} bookId @param {string} commentId @param {{ text?: string, by?: { id?: string, name: string } }} args
   */
  async function replyToComment(bookId, commentId, args = {}) {
    const { text } = args ?? {};
    if (typeof text !== 'string' || text.trim() === '') return fail('BAD_ARGS', { message: 'a reply needs text' });
    if (text.length > MAX_COMMENT_CHARS) return fail('BAD_ARGS', { message: `a reply can be at most ${MAX_COMMENT_CHARS} characters` });
    const by = byOf(args.by);
    const at = isoSeconds(nowMs());
    return change(bookId, commentId, 'replyToComment', (t) => addReply(t, { name: by.name, at, text }));
  }

  /**
   * Resolve (or reopen) a comment: a single-line edit of its `status:`. Refusals: NOT_FOUND, BAD_ARGS.
   * @param {string} bookId @param {string} commentId @param {{ status?: string }} args
   */
  async function setCommentState(bookId, commentId, args = {}) {
    const status = args?.status;
    if (status !== 'open' && status !== 'resolved') return fail('BAD_ARGS', { message: "status must be 'open' or 'resolved'" });
    return change(bookId, commentId, 'setCommentStatus', (t) => setCommentStatus(t, status));
  }

  /**
   * The comments of a book, newest first. `target` limits them to one document id, `status` to open or resolved.
   * @param {string} bookId @param {{ target?: string, status?: 'open' | 'resolved' }} [args]
   */
  async function listComments(bookId, args = {}) {
    const { target, status } = args ?? {};
    const found = await findBook(bookId, true);
    if (!found) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const docs = live(found);
    const byId = new Map(docs.filter((d) => typeof d.fm.id === 'string').map((d) => [d.fm.id, d]));
    const out = [];
    const bytesOf = new Map();
    for (const doc of docs.filter((d) => d.kind === 'comment')) {
      if (target !== undefined && doc.fm.target !== target) continue;
      if (status !== undefined && doc.fm.status !== status) continue;
      const cur = await store.read(doc.rel);
      if (!cur) continue;
      let parsed;
      try {
        parsed = parseComment(cur.bytes);
      } catch {
        continue;
      }
      if (!bytesOf.has(parsed.target)) {
        const t = byId.get(parsed.target);
        bytesOf.set(parsed.target, t ? (await store.read(t.rel))?.bytes ?? null : null);
      }
      out.push(shape(doc.rel, parsed, bytesOf.get(parsed.target)));
    }
    out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? 1 : -1));
    return { ok: true, code: 'OK', comments: out };
  }

  return { createComment, replyToComment, setCommentState, listComments };
}
