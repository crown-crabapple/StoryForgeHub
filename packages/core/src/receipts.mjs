// The receipt writer (M05-J07, contract sections 1-3, 6, 7). Receipts are records kept in the book folder: provenance/<YYYY>/<MM>/<rcpt_id>.md plus the
// content objects they name (provenance/objects/<xx>/<sha256>). Everything is written through @storyforge/store, and where an operation also writes a
// file (a suggestion accepted, an AI rewrite applied, a revision restored, an Undo, a publish) the receipts are staged in the SAME store batch: the target
// change and its receipt(s) land together or not at all (the batch journal lists every file up front, so a fault between them rolls both back).
// Receipts are never edited or deleted here. No filesystem access: reads and writes use the store.
import path from 'node:path';
import { extractDocs, validate } from '@storyforge/format';
import { ulid } from '@storyforge/manuscript';
import { blame as blameLines, buildReceipt, compareReceipts, lineDiff, lineage, objectPath, parseReceipt, receiptPath, sha256Hex, verifyChain } from '@storyforge/receipts';
import { openStore } from '@storyforge/store';
import { applyHunk, parseSuggestion } from '@storyforge/suggestions';

/** An author's unflushed saves are flushed when this long has passed since the last receipt of the scene (contract section 2 d). */
export const FLUSH_AFTER_MS = 10 * 60 * 1000;

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const EMPTY = Buffer.alloc(0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Every receipt file below provenance/ (book-relative paths). @param {any} store */
async function listReceiptFiles(store) {
  const out = [];
  for (const y of await store.list('provenance')) {
    if (!y.isDirectory || !/^\d{4}$/.test(y.name)) continue;
    for (const m of await store.list(`provenance/${y.name}`)) {
      if (!m.isDirectory || !/^\d{2}$/.test(m.name)) continue;
      for (const f of await store.list(`provenance/${y.name}/${m.name}`)) {
        if (!f.isDirectory && /^rcpt_.+\.md$/.test(f.name)) out.push(`provenance/${y.name}/${m.name}/${f.name}`);
      }
    }
  }
  return out.sort();
}

/** Parsed receipts are immutable, so a parsed file is remembered by (root, path) and only unseen files are read. */
const parsedCache = new Map();

/** All readable receipts of the book, oldest first: `{ rel, receipt }`. @param {any} store */
async function scanReceipts(store) {
  const out = [];
  for (const rel of await listReceiptFiles(store)) {
    const key = `${store.root}|${rel}`;
    let receipt = parsedCache.get(key);
    if (receipt === undefined) {
      const f = await store.read(rel);
      try {
        receipt = f ? parseReceipt(f.bytes) : null;
      } catch {
        receipt = null;
      }
      if (receipt) parsedCache.set(key, receipt);
    }
    if (receipt) out.push({ rel, receipt });
  }
  return out.sort((a, b) => compareReceipts(a.receipt, b.receipt));
}

const hashOf = (bytes) => sha256Hex(bytes);

/** The block of text a receipt keeps when the author ticked "Keep the full prompt": the messages that were sent. */
export function promptText(messages) {
  return Array.isArray(messages) ? messages.map((m) => `[${m.role}]\n${m.content}`).join('\n\n') : String(messages ?? '');
}

/**
 * @param {{ root: string, now?: () => number | Date }} p `root` is the library (or one-book) root; `now` is the clock the repository uses
 */
export function createReceiptEngine({ root, now = () => Date.now() }) {
  const nowMs = () => Number(now());
  let lastStamp = 0;
  /** Strictly increasing milliseconds, so receipts written in one tick still have a clear order. */
  const stamp = (floor = 0) => {
    lastStamp = Math.max(nowMs(), lastStamp + 1, floor + 1);
    return lastStamp;
  };
  /** AI proposals announced by the J04 `ai.proposal` event, waiting for the suggestion that follows (keyed bookId|sceneId). */
  const announced = new Map();
  /** Scenes the author saved since their last flush (an outside change event on these is not claimed as external). */
  const pending = new Map();
  /** Scenes seen to differ from their last receipt when watching started (changed while StoryForge was closed): their next flush is an `external.change`. */
  const externalMarks = new Set();
  /** The last bytes StoryForge itself wrote to a scene since its last receipt (key bookRoot|sceneId). Attribution does not depend on watcher timing: a flush compares
   *  the file with these bytes, so an outside write right after one of our saves is still told apart from it. */
  const ownBytes = new Map();

  const bookRootOf = (book) => (book.path === '' ? root : path.join(root, ...book.path.split('/')));

  async function findBook(bookId) {
    const result = await validate(root);
    const book = result.books.find((/** @type {any} */ b) => b.id === bookId);
    return book ? { book, result, bookRoot: bookRootOf(book) } : null;
  }
  /** A one-book view of `bookRoot` (used when only the book folder is known, e.g. the adapter). */
  async function findBookAt(bookRoot) {
    const result = await validate(bookRoot);
    const book = result.books[0];
    return book ? { book, result, bookRoot } : null;
  }
  const liveDocs = (found) => extractDocs(found.result, found.book.path).filter((d) => !d.archived && typeof d.fm.id === 'string');
  const toBookRel = (book, p) => (book.path === '' ? p : p.startsWith(`${book.path}/`) ? p.slice(book.path.length + 1) : null);

  // ------------------------------------------------------------------ a staging session (one store batch)

  /**
   * Stage receipts and objects into the open batch `tx`. Nothing here writes outside it.
   * @param {any} store @param {any} tx
   */
  async function session(store, tx) {
    const all = await scanReceipts(store);
    /** @type {Map<string, any>} last receipt per target id */
    const last = new Map();
    for (const { rel, receipt } of all) {
      if (receipt.target.id !== '') last.set(receipt.target.id, { rel, receipt, sha256: null });
    }
    /** own-write records this session used up; put back when its batch is rolled back */
    const consumedOwn = new Map();
    const putObject = async (bytes) => {
      const sha = hashOf(bytes);
      const rel = objectPath(sha);
      if (!(await tx.read(rel))) {
        const r = await tx.create(rel, Buffer.from(bytes));
        if (!r.ok) throw Object.assign(new Error(`could not stage ${rel}`), { code: r.code });
      }
      return sha;
    };
    const objectBytes = async (sha) => (sha === '' ? EMPTY : (await tx.read(objectPath(sha)))?.bytes ?? null);
    const fileSha = async (entry) => entry.sha256 ?? (entry.sha256 = (await store.read(entry.rel))?.sha256 ?? '');

    const api = {
      restoreOwn: () => {
        for (const [k, v] of consumedOwn) ownBytes.set(k, v);
      },
      has: (targetId) => last.has(targetId),
      last: (targetId) => last.get(targetId)?.receipt ?? null,
      all: () => all,
      /** The last ai.proposal receipt of a suggestion, with its file hash. */
      async proposalOf(suggestionId) {
        const hit = [...all].reverse().find((x) => x.receipt.operation === 'ai.proposal' && x.receipt.ai?.suggestion === suggestionId);
        return hit ? { receipt: hit.receipt, parent: { id: hit.receipt.id, sha256: (await store.read(hit.rel))?.sha256 ?? '' } } : null;
      },
      objectBytes,

      /**
       * Write one receipt (and the objects it names) into the batch.
       * @param {{ operation: string, actor: string, workflow: string, target?: { id: string, path: string }, before?: Buffer | null, after?: Buffer | null,
       *   beforeSha?: string, afterSha?: string, noBeforeObject?: boolean, ai?: Record<string, any>, summary?: string, extraParents?: { id: string, sha256: string }[],
       *   diff?: string, ranges?: object[], prompt?: string }} s
       */
      async add(s) {
        const target = s.target ?? { id: '', path: '' };
        const before = s.before ?? null;
        const after = s.after ?? null;
        const before_sha256 = s.beforeSha ?? (before === null || s.noBeforeObject ? '' : hashOf(before));
        const after_sha256 = s.afterSha ?? (after === null ? before_sha256 : hashOf(after));
        if (before !== null && !s.noBeforeObject) await putObject(before);
        if (after !== null) await putObject(after);
        const prev = target.id === '' ? null : last.get(target.id) ?? null;
        const at = new Date(stamp(prev ? Date.parse(prev.receipt.at) : 0)).toISOString();
        const id = `rcpt_${ulid(Date.parse(at))}`;
        const parents = [];
        if (prev) parents.push({ id: prev.receipt.id, sha256: await fileSha(prev) });
        for (const p of s.extraParents ?? []) if (!parents.some((x) => x.id === p.id)) parents.push(p);
        const built = buildReceipt({
          id,
          at,
          actor: s.actor,
          operation: s.operation,
          workflow: s.workflow,
          target,
          before_sha256,
          after_sha256,
          parents,
          ...(s.ai ? { ai: s.ai } : {}),
          ...(s.summary ? { summary: s.summary } : {}),
          ...(s.diff !== undefined ? { diff: s.diff, ranges: s.ranges ?? [] } : before !== null && after !== null ? { beforeBytes: before, afterBytes: after } : {}),
          ...(s.prompt ? { prompt: s.prompt } : {}),
        });
        const rel = receiptPath(at, id);
        const r = await tx.create(rel, Buffer.from(built.text, 'utf8'));
        if (!r.ok) throw Object.assign(new Error(`could not stage ${rel}`), { code: r.code });
        const parsed = parseReceipt(built.text);
        const entry = { rel, receipt: parsed, sha256: built.sha256 };
        all.push({ rel, receipt: parsed });
        if (target.id !== '') last.set(target.id, entry);
        return entry;
      },

      /**
       * Attribute everything that changed in `current` since the target's last receipt: a `baseline` when there is none, else an `author.edit`
       * (or `external.change` when `as` is 'external'). Returns what it wrote, or null when nothing differed.
       * @param {string} targetId @param {string} targetPath @param {Buffer} current @param {'author' | 'external'} [as]
       */
      async ensureCurrent(targetId, targetPath, current, as = 'author', { author: forced = false } = {}) {
        const markKey = `${store.root}|${targetId}`;
        if (as === 'author' && externalMarks.has(markKey)) as = 'external';
        externalMarks.delete(markKey);
        const own = forced ? null : ownBytes.get(markKey) ?? null;
        if (!forced) {
          ownBytes.delete(markKey);
          if (own !== null) consumedOwn.set(markKey, own);
        }
        const prev = last.get(targetId)?.receipt;
        const target = { id: targetId, path: targetPath };
        if (!prev) return { kind: 'baseline', entry: await api.add({ operation: 'baseline', actor: 'system', workflow: 'editor', target, before: EMPTY, noBeforeObject: true, after: current }) };
        if (prev.after_sha256 === hashOf(current)) return null;
        const before = await objectBytes(prev.after_sha256);
        if (as === 'author' && !forced) {
          const ownSha = own === null ? null : hashOf(own);
          if (ownSha === null || ownSha === prev.after_sha256) as = 'external'; // nothing of ours since the last receipt: someone else wrote it
          else if (ownSha !== hashOf(current)) {
            // our save, then an outside write over it: two receipts in this batch
            await api.add({ operation: 'author.edit', actor: 'author', workflow: 'editor', target, before, beforeSha: prev.after_sha256, after: own });
            const entry = await api.add({ operation: 'external.change', actor: 'external', workflow: 'watcher', target, before: own, after: current });
            return { kind: 'external', entry };
          }
        }
        const external = as === 'external';
        const entry = await api.add({
          operation: external ? 'external.change' : 'author.edit',
          actor: external ? 'external' : 'author',
          workflow: external ? 'watcher' : 'editor',
          target,
          before,
          beforeSha: prev.after_sha256,
          after: current,
        });
        return { kind: external ? 'external' : 'author', entry };
      },
    };
    return api;
  }

  /** `tx.read` of a book-relative path, as Buffer or null. */
  const readIn = async (tx, rel) => (await tx.read(rel))?.bytes ?? null;

  // ------------------------------------------------------------------ writes with receipts in the same batch

  /**
   * An author save of a scene body (the editor): the file write and the receipts (a baseline the first time, a flush when `flushFirst`, a flush
   * after the write when 10 minutes have passed) are one batch. Same result shape as `store.write`.
   * @param {any} store @param {{ rel: string, sceneId: string, next: Buffer, baseSha256: string | undefined, flushFirst?: boolean }} a
   */
  async function saveWithReceipts(store, { rel, sceneId, next, baseSha256, flushFirst = false }) {
    // The author's own save stays the plain single-file store write it always was (its crash semantics are unchanged); what it changed is recorded right
    // after it, from the bytes at hand: the baseline of the state it replaced (first save), the flush when a revision was saved, the flush after 10 minutes.
    const before = await store.read(rel);
    const w = await store.write(rel, next, { baseSha256 });
    if (!w.ok || !before || before.sha256 !== baseSha256) return w;
    /** @type {any} */
    let used = null;
    await store
      .batch('receipt', { rel }, async (tx) => {
        const s = (used = await session(store, tx));
        if (flushFirst || !s.has(sceneId) || externalMarks.has(`${store.root}|${sceneId}`)) await s.ensureCurrent(sceneId, rel, before.bytes, 'author', { author: !ownBytes.has(`${store.root}|${sceneId}`) });
        const prev = s.last(sceneId);
        if (prev && nowMs() - Date.parse(prev.at) >= FLUSH_AFTER_MS) {
          await s.ensureCurrent(sceneId, rel, next, 'author', { author: true });
          pending.delete(`${store.root}|${sceneId}`);
          ownBytes.delete(`${store.root}|${sceneId}`);
        } else {
          pending.set(`${store.root}|${sceneId}`, { bookRoot: store.root, sceneId, rel });
          ownBytes.set(`${store.root}|${sceneId}`, next);
        }
        return null;
      })
      .then((r) => {
        if (!r.ok) used?.restoreOwn();
      })
      .catch(() => used?.restoreOwn());
    return w;
  }

  /**
   * The body of an author save inside an open batch: baseline (first time) or flush (`flushFirst`) before the write, the write, then a flush of the new
   * state when 10 minutes have passed since the last receipt. A receipt problem never costs the author a save.
   * @param {any} store @param {any} tx @param {{ rel: string, sceneId: string, next: Buffer, baseSha256: string | undefined, flushFirst?: boolean }} a
   */
  async function authorWrite(store, tx, { rel, sceneId, next, baseSha256, flushFirst = false }) {
    const cur = await tx.read(rel);
    // the file is queued first (the store's crash point after the first change then means "the author's save landed"), the receipts after it
    const w = await tx.write(rel, next, { baseSha256 });
    if (!w.ok || !cur || cur.sha256 !== baseSha256) return w;
    /** @type {any} */
    let s;
    try {
      s = await session(store, tx);
      if (flushFirst || !s.has(sceneId) || externalMarks.has(`${store.root}|${sceneId}`)) await s.ensureCurrent(sceneId, rel, cur.bytes, 'author', { author: !ownBytes.has(`${store.root}|${sceneId}`) });
    } catch {
      return w;
    }
    try {
      const prev = s.last(sceneId);
      if (prev && nowMs() - Date.parse(prev.at) >= FLUSH_AFTER_MS) {
        await s.ensureCurrent(sceneId, rel, next, 'author', { author: true });
        pending.delete(`${store.root}|${sceneId}`);
        ownBytes.delete(`${store.root}|${sceneId}`);
      } else {
        pending.set(`${store.root}|${sceneId}`, { bookRoot: store.root, sceneId, rel });
        ownBytes.set(`${store.root}|${sceneId}`, next);
      }
    } catch {
      // as above
    }
    return w;
  }

  /** What the last `ai.proposal` event announced for a scene (provider, settings and prompt hashes), as an `ai` block; {} when nothing was announced. */
  function hintFor(book, sceneId) {
    const hint = announced.get(`${bookRootOf(book)}|${sceneId}`);
    return hint ? aiBlock(hint) : {};
  }

  /**
   * Write a file of the book and the receipt(s) for it in one batch (AI rewrite apply, revision restore, the adapter's publish).
   * The batch refuses (CONFLICT) when the file is not `baseSha256` any more.
   * @param {any} store @param {{ opName: string, args?: object, rel: string, targetId: string, baseSha256: string, after: Buffer,
   *   receipt: Record<string, any>, verify?: () => Promise<any> }} a
   */
  async function writeWithReceipt(store, { opName, args = {}, rel, targetId, baseSha256, after, receipt, verify }) {
    const r = await store.batch(
      opName,
      args,
      async (tx) => {
        const cur = await tx.read(rel);
        if (!cur || cur.sha256 !== baseSha256) return fail('CONFLICT', { current: cur });
        const w = await tx.write(rel, after, { baseSha256 });
        if (!w.ok) return w;
        const s = await session(store, tx);
        await s.ensureCurrent(targetId, rel, cur.bytes, 'author');
        await s.add({ ...receipt, target: { id: targetId, path: rel }, before: cur.bytes, after });
        pending.delete(`${store.root}|${targetId}`);
        return w;
      },
      verify ? { verify } : undefined,
    );
    if (!r.ok) return r;
    return { ...r.value, opId: r.opId };
  }

  /** Flush one document's pending changes (baseline or author.edit) in a batch of its own. */
  async function flushDoc(store, targetId, rel, as = 'author') {
    let result = null;
    /** @type {any} */
    let s = null;
    const r = await store.batch('flushReceipts', { rel }, async (tx) => {
      const cur = await readIn(tx, rel);
      if (!cur) return null;
      s = await session(store, tx);
      result = await s.ensureCurrent(targetId, rel, cur, as);
      return null;
    });
    if (!r.ok) {
      s?.restoreOwn();
      return r;
    }
    pending.delete(`${store.root}|${targetId}`);
    return { ok: true, code: 'OK', flushed: result !== null, baseline: result?.kind === 'baseline', receipt: result?.entry.receipt.id ?? null };
  }

  // ------------------------------------------------------------------ repository reads and flush

  async function sceneOf(bookId, sceneId) {
    const found = await findBook(bookId);
    if (!found || typeof sceneId !== 'string') return null;
    const doc = liveDocs(found).find((d) => d.fm.id === sceneId);
    if (!doc) return null;
    return { ...found, doc, store: await openStore(found.bookRoot, { recover: false }) };
  }

  /** Verify every receipt of a book folder (contract section 6). Read-only; nothing is repaired. */
  async function verifyAt(found) {
    const store = await openStore(found.bookRoot, { recover: false });
    const files = [];
    for (const rel of await listReceiptFiles(store)) {
      const f = await store.read(rel);
      if (f) files.push({ path: rel, bytes: f.bytes });
    }
    const objects = new Map();
    for (const f of files) {
      let p;
      try {
        p = parseReceipt(f.bytes);
      } catch {
        continue;
      }
      for (const sha of [p.before_sha256, p.after_sha256]) if (sha !== '' && !objects.has(sha)) objects.set(sha, (await store.read(objectPath(sha)))?.bytes ?? null);
    }
    const chain = verifyChain({ receipts: files, objectBytes: (sha) => objects.get(sha) ?? null });
    const problems = chain.problems.map((p) => ({ ...p, severity: 'error' }));
    // info: a document whose bytes are not what its last receipt says (pending author edits, or an edit made while StoryForge was closed)
    const scanned = [];
    for (const f of files) {
      try {
        scanned.push({ rel: f.path, receipt: parseReceipt(f.bytes) });
      } catch {
        // reported above as RCPT_MALFORMED
      }
    }
    scanned.sort((a, b) => compareReceipts(a.receipt, b.receipt));
    const lastBy = new Map();
    for (const x of scanned) if (x.receipt.target.id !== '') lastBy.set(x.receipt.target.id, x);
    for (const doc of liveDocs(found)) {
      const l = lastBy.get(doc.fm.id);
      if (!l) continue;
      const cur = await store.read(doc.rel);
      if (cur && cur.sha256 !== l.receipt.after_sha256) {
        problems.push({ code: 'RCPT_UNRECORDED', file: doc.rel, receipt: l.receipt.id, severity: 'info', detail: `${doc.rel} is not as its last receipt left it (unsaved author edits, or changed while StoryForge was closed)` });
      }
    }
    return { ok: problems.every((p) => p.severity === 'info'), receipts: chain.receipts, problems };
  }

  const methods = {
    /** @param {string} bookId */
    async verifyReceipts(bookId) {
      const found = await findBook(bookId);
      return found ? verifyAt(found) : null;
    },

    /** The receipts of one document, its lineage in plain words and the integrity status. */
    async getReceipts(bookId, sceneId) {
      const ctx = await sceneOf(bookId, sceneId);
      if (!ctx) return fail('NOT_FOUND');
      let mine = (await scanReceipts(ctx.store)).filter((x) => x.receipt.target.id === sceneId);
      if (mine.length === 0) {
        // the first time StoryForge sees the document (the Inspector opens it): the baseline, "Author-written as first seen"
        await flushDoc(ctx.store, sceneId, ctx.doc.rel).catch(() => {});
        mine = (await scanReceipts(ctx.store)).filter((x) => x.receipt.target.id === sceneId);
      }
      const receipts = [];
      for (const x of mine) receipts.push({ ...x.receipt, path: x.rel, sha256: (await ctx.store.read(x.rel))?.sha256 ?? '' });
      const verified = await verifyAt(ctx);
      const ids = new Set(receipts.map((r) => r.id));
      const problems = verified.problems.filter((p) => (p.receipt !== undefined && ids.has(p.receipt)) || p.file === ctx.doc.rel);
      return {
        ok: true,
        code: 'OK',
        receipts,
        lineage: lineage(receipts),
        status: {
          ok: problems.every((p) => p.severity === 'info'),
          receipts: receipts.length,
          unrecorded: problems.some((p) => p.code === 'RCPT_UNRECORDED'),
          problems,
          book: { ok: verified.ok, receipts: verified.receipts, problems: verified.problems.length },
        },
      };
    },

    /** Line-level lineage of lines `from`..`to` (1-based file lines) of a scene as it is now. */
    async blame(bookId, sceneId, from, to) {
      const ctx = await sceneOf(bookId, sceneId);
      if (!ctx) return fail('NOT_FOUND');
      const cur = await ctx.store.read(ctx.doc.rel);
      if (!cur) return fail('NOT_FOUND');
      const mine = (await scanReceipts(ctx.store)).filter((x) => x.receipt.target.id === sceneId).map((x) => x.receipt);
      const objects = new Map();
      for (const r of mine) for (const sha of [r.before_sha256, r.after_sha256]) if (sha !== '' && !objects.has(sha)) objects.set(sha, (await ctx.store.read(objectPath(sha)))?.bytes ?? null);
      const lines = blameLines({ receipts: mine, objectBytes: (sha) => objects.get(sha) ?? null, currentBytes: cur.bytes, fromLine: from, toLine: to });
      return { ok: true, code: 'OK', lines };
    },

    /** Record the author's pending changes to a scene now ("Record now", scene closed, another scene opened): a baseline the first time, else an author.edit. */
    async flushReceipts(bookId, sceneId) {
      const ctx = await sceneOf(bookId, sceneId);
      if (!ctx) return fail('NOT_FOUND');
      return flushDoc(ctx.store, sceneId, ctx.doc.rel);
    },
  };

  /**
   * Graceful shutdown: record every scene the author saved since its last receipt as an `author.edit`, so a restart does not mistake those saves for outside
   * changes. Bounded by `timeoutMs`; errors are ignored (the next flush attributes what is left).
   */
  async function flushPending(timeoutMs = 5000) {
    const work = (async () => {
      for (const p of [...pending.values()]) {
        try {
          await flushDoc(await openStore(p.bookRoot, { recover: false }), p.sceneId, p.rel);
        } catch {
          // left for the next flush
        }
      }
    })();
    let timer;
    await Promise.race([work, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
    clearTimeout(timer);
  }

  // ------------------------------------------------------------------ the watcher's external changes

  /**
   * The watcher saw `rels` (book-relative paths) change outside StoryForge: write an `external.change` for each scene that has receipts and whose bytes
   * differ from its last one. Scenes the author saved here and has not flushed are left to the next flush. `rels` null is the catch-up when watching starts: it
   * only marks the scenes that changed while StoryForge was closed (nothing is written by looking; their next flush is the `external.change`).
   * @param {string} bookPath library-relative book folder @param {string[] | null} rels
   */
  async function externalCheck(bookPath, rels) {
    const bookRoot = bookPath === '' ? root : path.join(root, ...bookPath.split('/'));
    const found = await findBookAt(bookRoot);
    if (!found) return;
    const store = await openStore(bookRoot, { recover: false });
    for (const doc of liveDocs(found)) {
      if (doc.kind !== 'scene') continue;
      if (rels !== null && !rels.includes(doc.rel)) continue;
      if (pending.has(`${store.root}|${doc.fm.id}`)) continue;
      const cur = await store.read(doc.rel);
      if (!cur) continue;
      const scanned = (await scanReceipts(store)).filter((x) => x.receipt.target.id === doc.fm.id);
      const last = scanned.at(-1);
      if (!last || last.receipt.after_sha256 === cur.sha256) continue;
      if (rels === null) externalMarks.add(`${store.root}|${doc.fm.id}`);
      else await flushDoc(store, doc.fm.id, doc.rel, 'external').catch(() => {});
    }
  }

  // ------------------------------------------------------------------ recordProvenance events

  const aiBlock = (event, extra = {}) => ({
    ...(event.provider ? { provider: event.provider.name, model: event.provider.model, locality: event.provider.locality } : {}),
    ...(event.settings ? { settings_sha256: sha256Hex(JSON.stringify(event.settings)) } : {}),
    ...(event.promptSha256 ? { prompt_sha256: event.promptSha256 } : {}),
    ...(event.contextSha256 ? { context_sha256: event.contextSha256 } : {}),
    ...extra,
  });

  /** Minimal hunks of a suggestion's decided hunks, as receipt diff text and ranges (the proposed lines; nothing was applied). */
  function proposedDiff(parsed, ids) {
    const out = [];
    const ranges = [];
    for (const h of parsed.hunks.filter((x) => ids.includes(x.id))) {
      const o = h.originalLines;
      const n = h.newLines;
      let pre = 0;
      while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++;
      let suf = 0;
      while (suf < o.length - pre && suf < n.length - pre && o[o.length - 1 - suf] === n[n.length - 1 - suf]) suf++;
      const removed = o.slice(pre, o.length - suf);
      const added = n.slice(pre, n.length - suf);
      const s = h.line + pre;
      out.push(`@@ -${s},${removed.length} +${s},${added.length} @@`, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`));
      ranges.push({ before: [s, s + removed.length - 1], after: [s, s + added.length - 1] });
    }
    return { diff: out.join('\n'), ranges };
  }

  /** Accept/decline receipts for a decision on a suggestion, staged in the caller's batch. Returns nothing the caller must keep. */
  async function stageDecision(store, tx, { decision, parsed, ids, suggestionId, source, targetId, targetRel, before, after, fullPrompt }) {
    const s = await session(store, tx);
    const proposal = await s.proposalOf(suggestionId);
    const statuses = new Map(parsed.hunks.map((h) => [h.id, h.status]));
    for (const id of ids) statuses.set(id, decision === 'accept' ? 'accepted' : 'declined');
    const vals = [...statuses.values()];
    const acceptance = vals.includes('accepted') && vals.includes('declined') ? 'partial' : decision === 'accept' ? 'accepted' : 'declined';
    const fm = parsed.fm.ai && typeof parsed.fm.ai === 'object' ? parsed.fm.ai : {};
    const pAi = proposal?.receipt.ai ?? {};
    const ai = {
      ...(fm.provider || pAi.provider ? { provider: pAi.provider ?? fm.provider, model: pAi.model ?? fm.model, locality: pAi.locality ?? fm.locality } : {}),
      ...(pAi.settings_sha256 ? { settings_sha256: pAi.settings_sha256 } : {}),
      ...(pAi.prompt_sha256 ? { prompt_sha256: pAi.prompt_sha256 } : {}),
      ...(fm.context_sha256 || pAi.context_sha256 ? { context_sha256: pAi.context_sha256 ?? fm.context_sha256 } : {}),
      suggestion: suggestionId,
      hunks: ids,
      acceptance,
    };
    const actor = source === 'ai' ? 'ai' : source === 'claude-book' ? 'system' : 'author';
    const workflow = source === 'ai' ? 'ai-rewrite' : source === 'claude-book' ? 'claude-book' : 'suggestion';
    const origin = source === 'ai' ? 'AI-suggested ' : source === 'claude-book' ? 'Claude-Book-suggested ' : 'suggested ';
    const total = parsed.hunks.length;
    const withAi = source === 'author' ? {} : { ai };
    const extraParents = proposal ? [proposal.parent] : [];
    const target = { id: targetId, path: targetRel };
    if (decision === 'accept') {
      if (targetId !== '' && before) await s.ensureCurrent(targetId, targetRel, before, 'author');
      const d = lineDiff(before ?? EMPTY, after);
      const lines = d.ranges.length > 0 ? ` (lines ${d.ranges.map((r) => `${(r.after[1] >= r.after[0] ? r.after : r.before)[0]}–${(r.after[1] >= r.after[0] ? r.after : r.before)[1]}`).join(', ')})` : '';
      await s.add({
        operation: 'suggestion.accept',
        actor,
        workflow,
        target,
        before: before ?? EMPTY,
        noBeforeObject: before === null,
        after,
        ...withAi,
        extraParents,
        summary: `Author accepted ${ids.length} of ${plural(total, `${origin}change`, `${origin}changes`)}${lines}.`,
        ...(fullPrompt ? { prompt: fullPrompt } : {}),
      });
      return;
    }
    if (targetId === '' || !before) return;
    await s.ensureCurrent(targetId, targetRel, before, 'author');
    const p = proposedDiff(parsed, ids);
    await s.add({
      operation: 'suggestion.decline',
      actor,
      workflow,
      target,
      before,
      after: before,
      ...withAi,
      extraParents,
      diff: p.diff,
      ranges: p.ranges,
      summary: `Author declined ${ids.length} of ${plural(total, `${origin}change`, `${origin}changes`)}.`,
    });
  }

  /**
   * Write receipts for a provenance event in a batch of their own (events whose receipts could not ride along with a file write).
   * @param {Record<string, any>} event @param {{ bookRoot?: string }} [ctx]
   */
  async function record(event, ctx = {}) {
    const found = ctx.bookRoot ? await findBookAt(ctx.bookRoot) : await findBook(event.bookId);
    if (!found) return null;
    const store = await openStore(found.bookRoot, { recover: false });
    const docs = liveDocs(found);
    const docOf = (id) => docs.find((d) => d.fm.id === id);
    const run = (name, fn) => store.batch(name, { kind: event.kind }, fn);

    switch (event.kind) {
      case 'ai.proposal': {
        // announced for the suggestion that follows (the J06 suggestion.create event); the receipt is written with that one
        if (event.sceneId) announced.set(`${found.bookRoot}|${event.sceneId}`, event);
        return null;
      }
      case 'ai.apply':
      case 'ai.discard':
      case 'suggestion.accept':
      case 'suggestion.decline':
        return null; // written in the batch of the change itself (suggestion decisions, AI apply)
      case 'ai.chat':
        return run('receipt', async (tx) => {
          const s = await session(store, tx);
          await s.add({
            operation: 'ai.chat',
            actor: 'ai',
            workflow: 'ai-chat',
            ai: { ...aiBlock(event), ...(Array.isArray(event.files) && event.files.length > 0 ? { files_sha256: event.files } : {}) },
            summary: `An AI chat was sent${event.provider ? ` (${event.provider.name}, ${event.provider.model}, ${event.provider.locality})` : ''}.`,
            ...(event.fullPrompt ? { prompt: event.fullPrompt } : {}),
          });
          return null;
        });
      case 'check.report': {
        const doc = event.sceneId ? docOf(event.sceneId) : null;
        const c = event.summary ?? {};
        const counts = typeof c.total === 'number' ? c.total : (c.errors ?? 0) + (c.warnings ?? 0) + (c.infos ?? c.info ?? 0);
        const summary = `A check found ${plural(counts, 'finding', 'findings')} (${c.errors ?? 0} errors, ${c.warnings ?? 0} warnings).`;
        return run('receipt', async (tx) => {
          const s = await session(store, tx);
          if (!doc) {
            await s.add({ operation: 'check.report', actor: 'system', workflow: 'check', summary });
            return null;
          }
          const cur = await readIn(tx, doc.rel);
          if (!cur) return null;
          await s.ensureCurrent(doc.fm.id, doc.rel, cur, 'author');
          await s.add({ operation: 'check.report', actor: 'system', workflow: 'check', target: { id: doc.fm.id, path: doc.rel }, before: cur, after: cur, summary });
          return null;
        });
      }
      case 'suggestion.create': {
        if (event.source !== 'ai') return null;
        const doc = docOf(event.target);
        const sug = await store.read(event.path);
        if (!doc || !sug) return null;
        const hint = announced.get(`${found.bookRoot}|${event.target}`) ?? null;
        announced.delete(`${found.bookRoot}|${event.target}`);
        let parsed;
        try {
          parsed = parseSuggestion(sug.bytes.toString('utf8'));
        } catch {
          return null;
        }
        return run('receipt', async (tx) => {
          const s = await session(store, tx);
          const cur = await readIn(tx, doc.rel);
          if (!cur) return null;
          await s.ensureCurrent(doc.fm.id, doc.rel, cur, 'author');
          // the whole proposal as text, to show where its changes would land
          let proposed = cur;
          const view = { ...parsed, hunks: parsed.hunks.map((h) => ({ ...h })) };
          for (const h of [...parsed.hunks].sort((a, b) => b.line - a.line)) {
            const a = applyHunk(proposed, view, h.id);
            if (a.ok) proposed = a.bytes;
          }
          const d = lineDiff(cur, proposed);
          const e = event.ai ?? {};
          await s.add({
            operation: 'ai.proposal',
            actor: 'ai',
            workflow: 'ai-rewrite',
            target: { id: doc.fm.id, path: doc.rel },
            before: cur,
            after: cur,
            ai: {
              provider: e.provider ?? hint?.provider?.name,
              model: e.model ?? hint?.provider?.model,
              locality: e.locality ?? hint?.provider?.locality,
              ...(hint?.settings ? { settings_sha256: sha256Hex(JSON.stringify(hint.settings)) } : {}),
              ...(hint?.promptSha256 ? { prompt_sha256: hint.promptSha256 } : {}),
              ...(e.context_sha256 ?? hint?.contextSha256 ? { context_sha256: e.context_sha256 ?? hint.contextSha256 } : {}),
              suggestion: event.suggestionId,
              hunks: event.hunkIds,
              acceptance: 'proposed',
            },
            diff: d.diff,
            ranges: d.ranges,
            summary: `AI suggested ${plural(event.hunkIds.length, 'change', 'changes')}${e.provider ? ` (${e.provider}, ${e.model}, ${e.locality})` : ''}. Nothing was changed in the scene.`,
            ...(hint?.fullPrompt ? { prompt: hint.fullPrompt } : {}),
          });
          return null;
        });
      }
      case 'ai.generation': {
        // the adapter's co-write draft: it lives in .work, outside the book, so the receipt has no target; the draft text is kept as an object
        const text = typeof event.text === 'string' ? Buffer.from(event.text, 'utf8') : null;
        return run('receipt', async (tx) => {
          const s = await session(store, tx);
          await s.add({
            operation: 'ai.generation',
            actor: 'ai',
            workflow: 'claude-book',
            target: { id: '', path: typeof event.draft === 'string' ? event.draft : '' },
            before: null,
            after: text,
            ...(text === null && typeof event.draft_sha256 === 'string' ? { afterSha: event.draft_sha256 } : {}),
            summary: `AI drafted text for chapter ${event.chapter ?? '?'} (co-write); the draft was recorded.`,
          });
          return null;
        });
      }
      case 'publish': {
        // The adapter normally writes the scene and this receipt in one batch (publishWithReceipt). This path records an already-made publish by its hashes.
        if (event.recorded === true) return null; // the adapter wrote the scene and this receipt in one batch (publishWithReceipt)
        const doc = docOf(event.target ?? event.sceneId);
        if (!doc) return null;
        return run('receipt', async (tx) => {
          const s = await session(store, tx);
          const cur = await readIn(tx, doc.rel);
          const prev = s.last(doc.fm.id);
          const extra = [];
          for (const x of s.all()) {
            if (x.receipt.operation === 'ai.generation' && [event.from_sha256, event.from_body_sha256].includes(x.receipt.after_sha256)) extra.push({ id: x.receipt.id, sha256: (await store.read(x.rel))?.sha256 ?? '' });
          }
          const sameBefore = prev && prev.after_sha256 === event.before_sha256;
          await s.add({
            operation: 'publish',
            actor: 'author',
            workflow: 'claude-book',
            target: { id: doc.fm.id, path: doc.rel },
            before: sameBefore ? await s.objectBytes(event.before_sha256) : null,
            beforeSha: event.before_sha256,
            after: cur && cur.length > 0 && hashOf(cur) === event.after_sha256 ? cur : null,
            afterSha: event.after_sha256,
            extraParents: extra,
          });
          return null;
        });
      }
      default:
        return null;
    }
  }

  /**
   * The adapter's `publish --confirm`: the scene write and its receipts (baseline, flush, `publish`, the link to the co-write draft) in one batch.
   * @param {string} bookRoot absolute book folder
   * @param {{ rel: string, sceneId: string, before: Buffer, beforeSha: string, after: Buffer, fromSha256?: string, fromBodySha256?: string }} a
   */
  async function publishWithReceipt(bookRoot, { rel, sceneId, before, beforeSha, after, fromSha256, fromBodySha256 }) {
    const store = await openStore(bookRoot);
    const r = await store.batch('publish', { rel }, async (tx) => {
      const cur = await tx.read(rel);
      if (!cur || cur.sha256 !== beforeSha) return fail('CONFLICT', { current: cur });
      const w = await tx.write(rel, after, { baseSha256: beforeSha });
      if (!w.ok) return w;
      const s = await session(store, tx);
      await s.ensureCurrent(sceneId, rel, cur.bytes, 'author');
      const extra = [];
      for (const x of s.all()) {
        if (x.receipt.operation === 'ai.generation' && [fromSha256, fromBodySha256].includes(x.receipt.after_sha256)) extra.push({ id: x.receipt.id, sha256: (await store.read(x.rel))?.sha256 ?? '' });
      }
      await s.add({ operation: 'publish', actor: 'author', workflow: 'claude-book', target: { id: sceneId, path: rel }, before, after, extraParents: extra });
      return w;
    });
    if (!r.ok) return r;
    return { ...r.value, opId: r.opId };
  }

  /**
   * Undo (restoreOp): stage an `undo` receipt per restored document that has an id, in the undo's own batch. `moves` come from the restore plan.
   * @param {string} bookRoot @returns {(tx: any, changes: { from: string | null, to: string | null, content: Buffer | null, before: Buffer }[]) => Promise<void>}
   */
  async function undoStager(bookRoot) {
    const found = await findBookAt(bookRoot);
    const byPath = new Map(found ? liveDocs(found).filter((d) => d.kind === 'scene' || d.kind === 'entry' || d.kind === 'thread' || d.kind === 'event').map((d) => [d.rel, d]) : []);
    const store = await openStore(bookRoot, { recover: false });
    return async (tx, changes) => {
      const s = await session(store, tx);
      for (const c of changes) {
        if (c.to === null || c.content === null || c.from === null) continue;
        const doc = byPath.get(c.from);
        if (!doc || c.content.equals(c.before)) continue;
        await s.ensureCurrent(doc.fm.id, c.from, c.before, 'author');
        await s.add({ operation: 'undo', actor: 'author', workflow: 'undo', target: { id: doc.fm.id, path: c.to }, before: c.before, after: c.content });
      }
    };
  }

  return {
    ...methods,
    root,
    session,
    findBook,
    findBookAt,
    stamp,
    announced,
    pending,
    externalCheck,
    flushPending,
    record,
    stageDecision,
    saveWithReceipts,
    authorWrite,
    hintFor,
    writeWithReceipt,
    flushDoc,
    publishWithReceipt,
    undoStager,
    bookRootOf,
    toBookRel,
  };
}
