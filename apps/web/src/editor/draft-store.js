// The local draft store: every unsaved buffer is mirrored here, so text typed while the server is away (or
// the tab closes) can be restored. IndexedDB first, localStorage as the fallback; every access is wrapped
// and failures are ignored (a missing store must never stop typing). Nothing is deleted silently: a draft the
// author discards moves to a "discarded" list that keeps it for 7 days.

export const DISCARD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const DB_NAME = 'storyforge-drafts';
const STORE_NAME = 'drafts';
const LS_DRAFT = 'sf:draft:';
const LS_DISCARDED = 'sf:discarded:';

/**
 * @typedef {{ key: string, text: string, base_sha256: string | null, at: string }} Draft  `at` is an ISO time.
 * @typedef {Draft & { discarded_at: string }} DiscardedDraft
 */

/** The key a scene's draft is stored under. @param {string} bookId @param {string} sceneId */
export const draftKey = (bookId, sceneId) => `${bookId}/${sceneId}`;

/** Run `fn`, return its result, or `fallback` if it throws. */
function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** A tiny promise wrapper over one IndexedDB request. */
const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * IndexedDB backend: records { k, value } in one object store. Opens lazily; if opening fails every call rejects
 * (the caller ignores that and relies on localStorage).
 * @param {IDBFactory} factory
 */
function idbBackend(factory) {
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null;
  const open = () => {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = factory.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME, { keyPath: 'k' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      });
      opening.catch(() => {
        opening = null;
      });
    }
    return opening;
  };
  const store = async (mode) => (await open()).transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  return {
    async get(k) {
      const row = await request((await store('readonly')).get(k));
      return row ? row.value : null;
    },
    async set(k, value) {
      await request((await store('readwrite')).put({ k, value }));
    },
    async remove(k) {
      await request((await store('readwrite')).delete(k));
    },
  };
}

/**
 * @param {{ indexedDB?: IDBFactory | null, localStorage?: Storage | null, now?: () => number }} [env]
 *   Defaults to the browser's own (each looked up inside a try/catch: some browsers throw on access). Pass fakes in tests.
 */
export function createDraftStore(env = {}) {
  const now = env.now ?? (() => Date.now());
  const ls = 'localStorage' in env ? env.localStorage : safe(() => globalThis.localStorage, null);
  const factory = 'indexedDB' in env ? env.indexedDB : safe(() => globalThis.indexedDB, null);
  const idb = factory ? safe(() => idbBackend(factory), null) : null;

  const lsGet = (k) => safe(() => JSON.parse(ls?.getItem(k) ?? 'null'), null);
  const lsSet = (k, v) => safe(() => ls?.setItem(k, JSON.stringify(v)), undefined);
  const lsRemove = (k) => safe(() => ls?.removeItem(k), undefined);
  const idbGet = (k) => (idb ? idb.get(k).catch(() => null) : Promise.resolve(null));

  /** Read a draft from both backends; the newer `at` wins. */
  async function read(k) {
    const found = [lsGet(k), await idbGet(k)];
    return found.filter(Boolean).sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))[0] ?? null;
  }
  async function write(k, value) {
    lsSet(k, value);
    if (idb) await idb.set(k, value).catch(() => {});
  }
  async function remove(k) {
    lsRemove(k);
    if (idb) await idb.remove(k).catch(() => {});
  }

  const isoNow = () => new Date(now()).toISOString();

  /** The discarded drafts of a scene, newest first, minus any older than 7 days. */
  async function readDiscarded(key) {
    const k = LS_DISCARDED + key;
    const kept = [];
    const seen = new Set();
    for (const list of [lsGet(k), await idbGet(k)]) {
      if (!Array.isArray(list)) continue;
      for (const d of list) {
        if (!d || typeof d.text !== 'string' || typeof d.discarded_at !== 'string') continue;
        if (now() - Date.parse(d.discarded_at) > DISCARD_KEEP_MS) continue;
        const id = `${d.discarded_at}|${d.text.length}|${d.at}`;
        if (seen.has(id)) continue;
        seen.add(id);
        kept.push(d);
      }
    }
    return kept.sort((a, b) => b.discarded_at.localeCompare(a.discarded_at));
  }

  return {
    /** Mirror the buffer. Never throws. @param {string} key @param {string} text @param {string | null} baseSha256 */
    async put(key, text, baseSha256) {
      await write(LS_DRAFT + key, { key, text, base_sha256: baseSha256, at: isoNow() }).catch(() => {});
    },
    /** Synchronous mirror (localStorage only), for when the page is being closed. */
    putNow(key, text, baseSha256) {
      lsSet(LS_DRAFT + key, { key, text, base_sha256: baseSha256, at: isoNow() });
    },
    /** @param {string} key @returns {Promise<Draft | null>} */
    async get(key) {
      return read(LS_DRAFT + key).catch(() => null);
    },
    /** The draft is no longer needed (it was saved). @param {string} key */
    async clear(key) {
      await remove(LS_DRAFT + key).catch(() => {});
    },
    /**
     * The author gave the draft up: move it to the discarded list (kept 7 days) instead of destroying it.
     * `text` / `baseSha256` keep a buffer that was never mirrored (or is newer than the mirror).
     * @param {string} key @param {{ text?: string, baseSha256?: string | null }} [extra] @returns {Promise<void>}
     */
    async discard(key, extra = {}) {
      const existing = await read(LS_DRAFT + key).catch(() => null);
      const draft = typeof extra.text === 'string' ? { key, text: extra.text, base_sha256: extra.baseSha256 ?? existing?.base_sha256 ?? null, at: isoNow() } : existing;
      if (!draft) return;
      const list = await readDiscarded(key).catch(() => []);
      await write(LS_DISCARDED + key, [{ ...draft, discarded_at: isoNow() }, ...list]).catch(() => {});
      await remove(LS_DRAFT + key).catch(() => {});
    },
    /** @param {string} key @returns {Promise<DiscardedDraft[]>} */
    listDiscarded(key) {
      return readDiscarded(key).catch(() => []);
    },
    /** Remove one entry of the discarded list (after the author restored it). @param {string} key @param {string} discardedAt */
    async removeDiscarded(key, discardedAt) {
      const list = await readDiscarded(key).catch(() => []);
      await write(LS_DISCARDED + key, list.filter((d) => d.discarded_at !== discardedAt)).catch(() => {});
    },
  };
}
