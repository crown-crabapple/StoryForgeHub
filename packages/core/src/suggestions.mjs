// Suggestions (M05-J06): create, list, read and decide the documents under suggestions/<YYYY>/. Everything is written through @storyforge/store.
// A suggestion changes a canonical file only when the author accepts a hunk, and then only that hunk's lines. Creating or declining never reads
// the target for writing. The text of the documents (diff, parse, apply) is @storyforge/suggestions; nothing here touches the filesystem.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { extractDocs, validate } from '@storyforge/format';
import { slugify, ulid } from '@storyforge/manuscript';
import { openStore } from '@storyforge/store';
import { applyHunk, buildSuggestion, parseSuggestion, setHunkStatus, suggestionPath } from '@storyforge/suggestions';
import { currentBy } from './actor.mjs';
import { selectRange, spliceReplacement } from './ai-rewrite.mjs';
import { notifyProvenance, recordProvenance } from './provenance.mjs';
import { createReceiptEngine } from './receipts.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const errKey = (d) => `${d.code}|${d.file}|${d.location ?? ''}`;
const TARGET_KINDS = ['scene', 'entry', 'thread', 'event'];
const SOURCES = ['ai', 'claude-book', 'author', 'reviewer', 'plugin'];
const PLUGIN_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MODES = ['suggest', 'state', 'canon'];
/** Folders a new-file suggestion may not create files in. */
const NEW_FILE_BLOCKED = ['suggestions/', 'ai/', 'archive/', 'provenance/', 'activity/', '.storyforge/'];

/** Byte offset just past the closing front-matter `---` line, or -1. */
function frontMatterEnd(buf) {
  let pos = buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0;
  const lineAt = (start) => {
    const nl = buf.indexOf(0x0a, start);
    const next = nl < 0 ? buf.length : nl + 1;
    const end = nl < 0 ? buf.length : nl;
    return { text: buf.subarray(start, end).toString('latin1').replace(/\r$/, ''), next };
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

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The `diff` of a provenance event: the decided hunks as they stand in the suggestion. */
function diffOf(parsed, ids) {
  const out = [];
  for (const h of parsed.hunks.filter((x) => ids.includes(x.id))) {
    out.push(`@@ -${h.line},${h.lines} @@ ${h.id}`, ...h.originalLines.map((l) => `-${l}`), ...h.newLines.map((l) => `+${l}`));
  }
  return out.join('\n');
}

/** A provenance event must never break the change it reports on. `bookRoot` (with the engine) says where its receipt goes. */
async function emit(event, ctx) {
  try {
    await recordProvenance(event, ctx);
  } catch {
    // the hook is advisory
  }
}

/**
 * @param {{ root: string, afterWrite?: (bookPath: string) => void, reconcile?: (bookPath: string) => Promise<any>, now?: () => number | Date,
 *   receipts?: ReturnType<typeof createReceiptEngine> }} p
 */
export function createSuggestionMethods({ root, afterWrite = () => {}, reconcile, now = () => Date.now(), receipts = createReceiptEngine({ root, now }), readValidate = () => validate(root) }) {
  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));
  const nowMs = () => Number(now());

  /** `cached`: for reads only; anything that goes on to write looks at the disk. */
  async function findBook(bookId, cached = false) {
    const result = await (cached ? readValidate() : validate(root));
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, result } : null;
  }

  const live = (found) => extractDocs(found.result, found.book.path).filter((d) => !d.archived);
  const titleOf = (d) => (typeof d.fm.title === 'string' ? d.fm.title : typeof d.fm.name === 'string' ? d.fm.name : path.posix.basename(d.rel, '.md'));

  async function refresh(book) {
    if (reconcile) await reconcile(book.path);
    else afterWrite(book.path);
  }

  /** A summary of one suggestion (no text of the hunks). */
  function summary(doc, parsed, byId) {
    const target = typeof doc.fm.target === 'string' ? doc.fm.target : '';
    const targetDoc = target ? byId.get(target) : null;
    return {
      id: String(doc.fm.id),
      path: doc.rel,
      target,
      target_path: typeof doc.fm.target_path === 'string' ? doc.fm.target_path : '',
      target_title: targetDoc ? titleOf(targetDoc) : null,
      target_kind: targetDoc ? targetDoc.kind : null,
      target_missing: target !== '' && !targetDoc,
      base_sha256: typeof doc.fm.base_sha256 === 'string' ? doc.fm.base_sha256 : '',
      source: String(doc.fm.source),
      plugin: typeof doc.fm.plugin === 'string' ? doc.fm.plugin : null,
      by: doc.fm.by && typeof doc.fm.by === 'object' && typeof doc.fm.by.name === 'string' ? { ...(typeof doc.fm.by.id === 'string' ? { id: doc.fm.by.id } : {}), name: doc.fm.by.name } : null,
      mode: String(doc.fm.mode),
      created: String(doc.fm.created ?? ''),
      status: String(parsed.fm.status ?? ''),
      ai: parsed.fm.ai && typeof parsed.fm.ai === 'object' ? parsed.fm.ai : null,
      rationale: parsed.rationale,
      hunks: parsed.hunks.map((h) => ({ id: h.id, line: h.line, lines: h.lines, status: h.status, ...(h.decided ? { decided: h.decided } : {}) })),
      pending: parsed.hunks.filter((h) => h.status === 'pending').length,
    };
  }

  async function readParsed(store, doc) {
    const cur = await store.read(doc.rel);
    if (!cur) return null;
    try {
      return { cur, parsed: parseSuggestion(cur.bytes.toString('utf8')) };
    } catch {
      return null;
    }
  }

  /**
   * Make a suggestion for one live document (scene, entry, thread or event) from proposed text: `proposedText` is the whole file as it would be, or
   * `proposedRange` { from, to, replacement } replaces one range of the body (editor offsets, as the AI rewrite sends them). Writes only the new
   * suggestions/<YYYY>/<stamp>-<slug>.md; the target is never written. Refusals: NOT_FOUND, BAD_ARGS, BAD_SELECTION, SCENE_CHANGED (`expectSha256` given and
   * the target differs), NO_CHANGE (the proposal equals the target).
   * @param {string} bookId
   * @param {{ target?: string, proposedText?: string, proposedRange?: { from: number, to: number, replacement: string }, source?: string, mode?: string,
   *   rationale?: string, ai?: Record<string, any>, expectSha256?: string }} args
   */
  async function createSuggestion(bookId, args = {}) {
    const { target, proposedText, proposedRange, source, mode = 'suggest', rationale, ai, expectSha256, plugin } = args ?? {};
    const by = args?.by ?? currentBy(); // shared mode: who made it (FORMAT 9.3)
    if (typeof target !== 'string' || target === '') return fail('BAD_ARGS', { message: 'target must be the id of a scene, entry, thread or event' });
    if (!SOURCES.includes(/** @type {string} */ (source))) return fail('BAD_ARGS', { message: `source must be one of ${SOURCES.join(', ')}` });
    if (source === 'plugin' ? typeof plugin !== 'string' || !PLUGIN_SLUG_RE.test(plugin) : plugin !== undefined) return fail('BAD_ARGS', { message: 'plugin is the plugin slug, and only for source plugin' });
    if (!MODES.includes(mode)) return fail('BAD_ARGS', { message: `mode must be one of ${MODES.join(', ')}` });
    if ((proposedText === undefined) === (proposedRange === undefined)) return fail('BAD_ARGS', { message: 'give exactly one of proposedText and proposedRange' });
    if (proposedText !== undefined && typeof proposedText !== 'string') return fail('BAD_ARGS', { message: 'proposedText must be a string' });
    if (rationale !== undefined && (typeof rationale !== 'string' || rationale.length > 20_000)) return fail('BAD_ARGS', { message: 'rationale must be text (up to 20000 characters)' });
    if (ai !== undefined && (ai === null || typeof ai !== 'object' || Array.isArray(ai))) return fail('BAD_ARGS', { message: 'ai must be an object' });
    const found = await findBook(bookId);
    if (!found) return fail('NOT_FOUND');
    const doc = live(found).find((d) => TARGET_KINDS.includes(/** @type {string} */ (d.kind)) && d.fm.id === target);
    if (!doc) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const cur = await store.read(doc.rel);
    if (!cur) return fail('NOT_FOUND');
    if (expectSha256 !== undefined && cur.sha256 !== expectSha256) return fail('SCENE_CHANGED', { message: 'the file changed after the text was read; nothing was suggested' });

    let proposed;
    if (proposedText !== undefined) proposed = Buffer.from(proposedText, 'utf8');
    else {
      const r = proposedRange;
      if (r === null || typeof r !== 'object' || typeof r.replacement !== 'string') return fail('BAD_ARGS', { message: 'proposedRange must be { from, to, replacement }' });
      const end = frontMatterEnd(cur.bytes);
      if (end < 0) return fail('BAD_ARGS', { message: 'front matter is not terminated' });
      const sel = selectRange(cur.bytes, end, r.from, r.to);
      if (!sel.ok) return fail(sel.code, { message: sel.message });
      proposed = spliceReplacement(cur.bytes, sel, r.replacement);
    }

    const at = nowMs();
    const created = isoSeconds(at);
    const id = `note_${ulid()}`;
    const slugBase = slugify(`${titleOf(doc)} ${source === 'ai' ? 'rewrite' : 'change'}`).slice(0, 40).replace(/-+$/g, '') || 'suggestion';
    let built;
    try {
      built = buildSuggestion({ id, targetId: target, targetPath: doc.rel, baseBytes: cur.bytes, proposedBytes: proposed, source, mode, ...(rationale?.trim() ? { rationale } : {}), ...(source === 'ai' && ai ? { ai } : {}), ...(source === 'plugin' ? { plugin } : {}), ...(by ? { by } : {}), created });
    } catch (e) {
      if (/** @type {any} */ (e)?.code === 'NO_CHANGE') return fail('NO_CHANGE', { message: 'the proposal is identical to the current text' });
      throw e;
    }
    const first = suggestionPath(created, slugBase);
    let rel = first;
    for (let n = 2; await store.exists(rel); n++) rel = first.replace(/\.md$/, `-${n}.md`);
    const r = await store.create(rel, Buffer.from(built.text, 'utf8'));
    if (!r.ok) return fail(r.code, r.message ? { message: r.message } : {});
    await refresh(found.book);
    await emit({ kind: 'suggestion.create', bookId, suggestionId: id, target, source, mode, path: rel, hunkIds: built.hunks.map((h) => h.id), base_sha256: cur.sha256, after_sha256: r.sha256, ...(source === 'ai' && ai ? { ai } : {}) }, { engine: receipts, bookRoot: bookRootOf(found.book) });
    return { ok: true, code: 'OK', id, path: rel, status: 'pending', created, hunks: built.hunks.map((h) => ({ id: h.id, line: h.line, lines: h.lines, status: h.status })), opId: r.opId ?? null };
  }

  /**
   * The suggestions of a book, newest first. `target` limits them to one document id; `state` is 'open' (a hunk is still pending) or 'decided'.
   * @param {string} bookId @param {{ target?: string, state?: 'open' | 'decided' }} [args]
   */
  async function listSuggestions(bookId, args = {}) {
    const { target, state } = args ?? {};
    const found = await findBook(bookId, true);
    if (!found) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const docs = live(found);
    const byId = new Map(docs.filter((d) => typeof d.fm.id === 'string').map((d) => [d.fm.id, d]));
    const out = [];
    for (const doc of docs.filter((d) => d.kind === 'suggestion')) {
      if (target !== undefined && doc.fm.target !== target) continue;
      const read = await readParsed(store, doc);
      if (!read) continue;
      const s = summary(doc, read.parsed, byId);
      if (state === 'open' && s.pending === 0) continue;
      if (state === 'decided' && s.pending > 0) continue;
      out.push(s);
    }
    out.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? 1 : -1));
    return { ok: true, code: 'OK', suggestions: out };
  }

  /** One suggestion with the text of every hunk; each pending hunk says whether it is `stale` against the target as it is now. */
  async function getSuggestion(bookId, suggestionId) {
    const found = await findBook(bookId, true);
    if (!found || typeof suggestionId !== 'string') return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const docs = live(found);
    const doc = docs.find((d) => d.kind === 'suggestion' && d.fm.id === suggestionId);
    if (!doc) return fail('NOT_FOUND');
    const read = await readParsed(store, doc);
    if (!read) return fail('NOT_FOUND');
    const byId = new Map(docs.filter((d) => typeof d.fm.id === 'string').map((d) => [d.fm.id, d]));
    const s = summary(doc, read.parsed, byId);
    const targetDoc = s.target ? byId.get(s.target) : null;
    const targetNow = s.target === '' ? { bytes: Buffer.alloc(0) } : targetDoc ? await store.read(targetDoc.rel) : null;
    const targetBytes = targetNow ? targetNow.bytes : null;
    const hunks = read.parsed.hunks.map((h) => {
      let stale = null;
      if (h.status === 'pending' && targetBytes !== null) stale = !applyHunk(targetBytes, shifted(read.parsed, h.id), h.id).ok;
      return { id: h.id, line: h.line, lines: h.lines, status: h.status, ...(h.decided ? { decided: h.decided } : {}), originalLines: h.originalLines, newLines: h.newLines, stale };
    });
    return { ok: true, code: 'OK', suggestion: { ...s, hunks, new_file: s.target === '', text: read.cur.bytes.toString('utf8') } };
  }

  /**
   * `parsed` with the expected line of each pending hunk moved by the net size change of the accepted hunks above it, so a partly accepted suggestion
   * still finds its remaining hunks where they are (otherwise the hash search has to find them, which fails on repeated lines).
   */
  function shifted(parsed, only) {
    const accepted = parsed.hunks.filter((h) => h.status === 'accepted');
    return {
      ...parsed,
      hunks: parsed.hunks.map((h) => {
        if (only !== undefined && h.id !== only) return h;
        const shift = accepted.filter((a) => a.line < h.line).reduce((n, a) => n + a.newLines.length - a.lines, 0);
        return shift === 0 ? h : { ...h, line: h.line + shift };
      }),
    };
  }

  /**
   * Accept or decline one hunk (`hunkId`) or every pending hunk of a suggestion. Accept locates the hunk's original lines in the target now (SUGGESTION_STALE,
   * nothing written, when they are gone or ambiguous), replaces exactly those lines, and writes the target and the suggestion in one journaled store batch; the
   * returned `opId` undoes both (POST /ops/:opId/restore). Decline writes only the suggestion. Refusals: NOT_FOUND, BAD_ARGS, ALREADY_DECIDED, SUGGESTION_STALE,
   * TARGET_MISSING, ROLLED_BACK (the change would introduce validation errors).
   * @param {string} bookId @param {string} suggestionId @param {{ decision?: string, hunkId?: string }} args
   */
  async function decideSuggestion(bookId, suggestionId, args = {}) {
    const { decision, hunkId } = args ?? {};
    if (decision !== 'accept' && decision !== 'decline') return fail('BAD_ARGS', { message: "decision must be 'accept' or 'decline'" });
    if (hunkId !== undefined && typeof hunkId !== 'string') return fail('BAD_ARGS', { message: 'hunkId must be a string' });
    const found = await findBook(bookId);
    if (!found || typeof suggestionId !== 'string') return fail('NOT_FOUND');
    const docs = live(found);
    const doc = docs.find((d) => d.kind === 'suggestion' && d.fm.id === suggestionId);
    if (!doc) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book));
    const known = new Set(found.result.diagnostics.filter((d) => d.severity === 'error').map(errKey));
    const decidedAt = isoSeconds(nowMs());
    const targetId = typeof doc.fm.target === 'string' ? doc.fm.target : '';
    const targetDoc = targetId ? docs.find((d) => d.fm.id === targetId && TARGET_KINDS.includes(/** @type {string} */ (d.kind))) : null;

    const r = await store.batch(
      'decideSuggestion',
      { suggestionId, decision, ...(hunkId ? { hunkId } : {}), path: doc.rel },
      async (tx) => {
        const sugCur = await tx.read(doc.rel);
        if (!sugCur) return fail('NOT_FOUND');
        let parsed;
        try {
          parsed = parseSuggestion(sugCur.bytes.toString('utf8'));
        } catch {
          return fail('BAD_ARGS', { message: 'the suggestion file is malformed' });
        }
        let ids;
        if (hunkId !== undefined) {
          const h = parsed.hunks.find((x) => x.id === hunkId);
          if (!h) return fail('NOT_FOUND', { message: `no hunk ${hunkId}` });
          if (h.status !== 'pending') return fail('ALREADY_DECIDED', { message: `hunk ${hunkId} was already ${h.status}` });
          ids = [hunkId];
        } else {
          ids = parsed.hunks.filter((h) => h.status === 'pending').map((h) => h.id);
          if (ids.length === 0) return fail('ALREADY_DECIDED', { message: 'every hunk is already decided' });
        }

        if (decision === 'decline') {
          const text = setHunkStatus(sugCur.bytes.toString('utf8'), ids, 'declined', decidedAt);
          await tx.write(doc.rel, Buffer.from(text, 'utf8'), { baseSha256: sugCur.sha256 });
          // M05-J07: the decline receipt (and the flush of the target's pending author changes) is part of this batch
          if (targetDoc) {
            try {
              const t = await tx.read(targetDoc.rel);
              if (t) await receipts.stageDecision(store, tx, { decision: 'decline', parsed, ids, suggestionId, source: String(doc.fm.source), plugin: doc.fm.plugin, targetId, targetRel: targetDoc.rel, before: t.bytes, after: t.bytes });
            } catch {
              // a receipt problem never blocks the author's decision
            }
          }
          return { ok: true, ids, parsed, before: null, after: null, target: targetId };
        }

        // accept
        let targetRel;
        let bytes;
        let before = null;
        let beforeBytes = null;
        if (targetId === '') {
          targetRel = typeof doc.fm.target_path === 'string' ? doc.fm.target_path : '';
          if (!/\.md$/i.test(targetRel) || targetRel.startsWith('/') || targetRel.includes('..') || targetRel.includes('\\') || NEW_FILE_BLOCKED.some((p) => targetRel.startsWith(p))) {
            return fail('BAD_ARGS', { message: 'the new file path is not one a suggestion may create' });
          }
          if (await tx.read(targetRel)) return fail('SUGGESTION_STALE', { message: `${targetRel} already exists`, hunkId: ids[0] });
          bytes = Buffer.alloc(0);
        } else {
          if (!targetDoc) return fail('TARGET_MISSING', { message: 'the file this suggestion is for is no longer part of the book' });
          targetRel = targetDoc.rel;
          const cur = await tx.read(targetRel);
          if (!cur) return fail('TARGET_MISSING', { message: 'the file this suggestion is for is gone' });
          before = cur.sha256;
          beforeBytes = cur.bytes;
          bytes = cur.bytes;
        }
        // the last hunk first, so the lines of the hunks still to apply keep their numbers
        const order = [...ids].sort((a, b) => parsed.hunks.find((h) => h.id === b).line - parsed.hunks.find((h) => h.id === a).line);
        const view = shifted(parsed);
        for (const id of order) {
          const a = applyHunk(bytes, view, id);
          if (!a.ok) return fail('SUGGESTION_STALE', { message: `the lines of hunk ${id} changed or moved; nothing was written`, hunkId: id });
          bytes = a.bytes;
        }
        if (targetId === '') await tx.create(targetRel, bytes);
        else await tx.write(targetRel, bytes, { baseSha256: /** @type {string} */ (before) });
        const text = setHunkStatus(sugCur.bytes.toString('utf8'), ids, 'accepted', decidedAt);
        await tx.write(doc.rel, Buffer.from(text, 'utf8'), { baseSha256: sugCur.sha256 });
        // M05-J07: the accept receipt (and the flush of the author's pending changes before it) is part of this batch: target and receipt land together
        try {
          await receipts.stageDecision(store, tx, { decision: 'accept', parsed, ids, suggestionId, source: String(doc.fm.source), plugin: doc.fm.plugin, targetId, targetRel, before: beforeBytes, after: bytes });
        } catch {
          // a receipt problem never blocks the author's decision
        }
        const sha = createHash('sha256').update(bytes).digest('hex');
        return { ok: true, ids, parsed, before, after: sha, target: targetId === '' ? targetRel : targetId, targetRel };
      },
      {
        verify: async () => {
          if (decision !== 'accept') return;
          const after = (await validate(root)).diagnostics;
          const fresh = after.filter((d) => d.severity === 'error' && !known.has(errKey(d)));
          if (fresh.length) {
            const err = new Error('the change would introduce new errors');
            /** @type {any} */ (err).diagnostics = fresh;
            throw err;
          }
        },
      },
    );
    if (!r.ok) {
      if (r.code === 'ROLLED_BACK') return fail('ROLLED_BACK', { message: r.message, diagnostics: r.diagnostics ?? [] });
      return fail(r.code, r.message ? { message: r.message } : {});
    }
    const v = r.value;
    if (!v.ok) return v;
    await refresh(found.book);
    const base = typeof doc.fm.base_sha256 === 'string' && doc.fm.base_sha256 !== '' ? doc.fm.base_sha256 : null;
    notifyProvenance({
      kind: decision === 'accept' ? 'suggestion.accept' : 'suggestion.decline',
      bookId,
      suggestionId,
      hunkIds: v.ids,
      target: v.target,
      before_sha256: decision === 'accept' ? v.before : base,
      after_sha256: decision === 'accept' ? v.after : base,
      diff: diffOf(v.parsed, v.ids),
    });
    const again = await getSuggestion(bookId, suggestionId);
    return { ok: true, code: 'OK', decision, hunkIds: v.ids, sha256: decision === 'accept' ? v.after : null, opId: r.opId ?? null, undo: r.opId ? { op: r.opId } : null, ...(again.ok ? { suggestion: again.suggestion } : {}) };
  }

  /**
   * A save that arrived on an out-of-date base (shared mode, contract M07-J03 section 7): the saved buffer is kept as a suggestion against the file as it is now
   * (`source: author`, `mode: suggest`, `by`, the rationale "Saved over a newer version"), so both versions exist. The file is never written. Returns
   * `{ ok: true, suggestion: null }` when the buffer equals the current text (nothing to keep). Refusals: NOT_FOUND, NOT_A_SCENE, BAD_ARGS.
   * @param {string} bookId @param {string} sceneId @param {string} body the scene body that was being saved
   */
  async function suggestFromStaleSave(bookId, sceneId, body, tries = 3) {
    if (typeof body !== 'string') return fail('BAD_ARGS', { message: 'body must be a string' });
    const found = await findBook(bookId);
    const doc = found ? live(found).find((d) => d.kind === 'scene' && d.fm.id === sceneId) : null;
    if (!found || !doc) return fail('NOT_FOUND');
    const store = await openStore(bookRootOf(found.book), { recover: false });
    const cur = await store.read(doc.rel);
    if (!cur) return fail('NOT_FOUND');
    const end = frontMatterEnd(cur.bytes);
    if (end < 0) return fail('NOT_A_SCENE', { message: 'front matter is not terminated' });
    const proposedText = Buffer.concat([cur.bytes.subarray(0, end), Buffer.from(body, 'utf8')]).toString('utf8');
    const r = await createSuggestion(bookId, { target: sceneId, proposedText, source: 'author', mode: 'suggest', rationale: 'Saved over a newer version', expectSha256: cur.sha256 });
    if (!r.ok && r.code === 'NO_CHANGE') return { ok: true, code: 'OK', suggestion: null };
    if (!r.ok && r.code === 'SCENE_CHANGED' && tries > 1) return suggestFromStaleSave(bookId, sceneId, body, tries - 1); // the file moved again while we looked: diff against the newest
    return r.ok ? { ok: true, code: 'OK', suggestion: { id: r.id, path: r.path, hunks: r.hunks } } : r;
  }

  return { createSuggestion, listSuggestions, getSuggestion, decideSuggestion, suggestFromStaleSave };
}
