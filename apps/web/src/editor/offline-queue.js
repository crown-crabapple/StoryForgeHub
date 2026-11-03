// The offline save queue of shared mode (M08-J04 contract section 3). Pure logic: the storage is an adapter (IndexedDB in the browser, a Map in tests) and the
// network is a `fetch` that is passed in, so every case runs under `node --test` with fakes.
//
// What it is: at most ONE pending buffer per scene, { bookId, sceneId, baseSha256, text, savedAt }: text that could not be sent yet, with the file version it was written
// against. It is a queue of unsent saves, never a second authoritative copy:
//   - an entry is deleted the moment the server confirms the save (200), or turns it into a stale-save suggestion (409 STALE);
//   - it is sent only through the normal save route (PUT .../scenes/:id/body) with the stored base sha, so the server decides, exactly as for a live save;
//   - it is never used as content when the server has newer text (`decideRestore`), never exported, never read by the server. It lives in this browser only.

export const QUEUE_DB = 'storyforge-offline-queue';
const STORE = 'queue';

/**
 * @typedef {{ bookId: string, sceneId: string, baseSha256: string | null, text: string, savedAt: string }} QueueEntry
 * @typedef {{ getAll: () => Promise<QueueEntry[]>, get: (key: string) => Promise<QueueEntry | null>, put: (key: string, entry: QueueEntry) => Promise<void>, delete: (key: string) => Promise<void> }} QueueAdapter
 * @typedef {{ status: number | null, json: any }} SendResult  `status` null: no answer at all (offline)
 * @typedef {{ key: string, bookId: string, sceneId: string, outcome: 'saved' | 'stale' | 'offline' | 'kept' | 'skipped', status: number | null, suggestionId?: string | null, kept?: boolean }} DrainResult
 */

/** The key of a scene's entry. @param {string} bookId @param {string} sceneId */
export const queueKey = (bookId, sceneId) => `${bookId}/${sceneId}`;

/** The text under the banner while entries wait. @param {number} count */
export const queueLabel = (count) => `Offline: ${count} ${count === 1 ? 'scene' : 'scenes'} waiting to save`;

/** What the editor says about a buffer it restored from the queue. */
export const RESTORED_NOTICE = 'Not saved yet — will save when back online';

/**
 * What to do with an entry when its scene is opened (after a reload, say). The queue is never content when the server has newer text:
 * only an entry made against the version that is on the server now goes back into the editor; any other is sent (the server answers 409 STALE and keeps it as a suggestion).
 * @param {QueueEntry | null} entry @param {string | null} serverSha256 the scene's current sha256 from the server @returns {'none' | 'restore' | 'stale'}
 */
export function decideRestore(entry, serverSha256) {
  if (!entry) return 'none';
  return entry.baseSha256 !== null && entry.baseSha256 === serverSha256 ? 'restore' : 'stale';
}

/** The normal save request of a scene, as save-controller.js sends it. @param {QueueEntry} e */
export function saveRequest(e) {
  return {
    url: `/api/books/${encodeURIComponent(e.bookId)}/scenes/${encodeURIComponent(e.sceneId)}/body`,
    init: {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' },
      body: JSON.stringify({ body: e.text, base_sha256: e.baseSha256 }),
    },
  };
}

/** Send one entry through the normal save route. Never throws. @param {QueueEntry} e @param {typeof fetch} fetchImpl @returns {Promise<SendResult>} */
export async function sendEntry(e, fetchImpl) {
  const { url, init } = saveRequest(e);
  try {
    const res = await fetchImpl(url, init);
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch {
    return { status: null, json: null };
  }
}

/** A Map-backed adapter (tests, and the fallback when the browser has no IndexedDB). @returns {QueueAdapter} */
export function memoryAdapter() {
  const map = new Map();
  return {
    getAll: async () => [...map.values()].map((e) => ({ ...e })),
    get: async (key) => (map.has(key) ? { ...map.get(key) } : null),
    put: async (key, entry) => void map.set(key, { ...entry }),
    delete: async (key) => void map.delete(key),
  };
}

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** The IndexedDB adapter: its own small database, so the draft store's is not touched. @param {IDBFactory} factory @returns {QueueAdapter} */
export function idbAdapter(factory) {
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null;
  const open = () => {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const req = factory.open(QUEUE_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'k' });
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
  const store = async (mode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    async getAll() {
      const rows = await request((await store('readonly')).getAll());
      return rows.map((r) => r.value);
    },
    async get(key) {
      const row = await request((await store('readonly')).get(key));
      return row ? row.value : null;
    },
    async put(key, entry) {
      await request((await store('readwrite')).put({ k: key, value: entry }));
    },
    async delete(key) {
      await request((await store('readwrite')).delete(key));
    },
  };
}

/**
 * The browser's adapter: IndexedDB when there is one, else memory (the queue then lasts until the tab closes; the draft store's localStorage mirror still keeps the text).
 * @returns {QueueAdapter}
 */
export function browserAdapter() {
  try {
    if (globalThis.indexedDB) return idbAdapter(globalThis.indexedDB);
  } catch {
    // some browsers throw on access
  }
  return memoryAdapter();
}

/**
 * @param {{ adapter?: QueueAdapter, now?: () => number }} [options]
 */
export function createOfflineQueue(options = {}) {
  const adapter = options.adapter ?? memoryAdapter();
  const now = options.now ?? (() => Date.now());
  /** @type {Set<(count: number) => void>} */
  const listeners = new Set();
  /** Scenes an open editor is looking after: its own save controller retries them, so the drain leaves them alone. */
  const held = new Set();
  /** @type {Promise<DrainResult[]> | null} */
  let draining = null;

  const changed = async () => {
    if (listeners.size === 0) return;
    const count = (await adapter.getAll().catch(() => [])).length;
    for (const fn of listeners) {
      try {
        fn(count);
      } catch {
        // a listener must not break the queue
      }
    }
  };

  const api = {
    /**
     * Keep this scene's unsent buffer (replacing the one it had). Never throws: a store that fails must not stop typing.
     * @param {{ bookId: string, sceneId: string, baseSha256: string | null, text: string }} e @returns {Promise<void>}
     */
    async put(e) {
      try {
        await adapter.put(queueKey(e.bookId, e.sceneId), { bookId: e.bookId, sceneId: e.sceneId, baseSha256: e.baseSha256, text: e.text, savedAt: new Date(now()).toISOString() });
      } catch {
        // see above
      }
      await changed();
    },
    /** @param {string} bookId @param {string} sceneId @returns {Promise<QueueEntry | null>} */
    async get(bookId, sceneId) {
      return adapter.get(queueKey(bookId, sceneId)).catch(() => null);
    },
    /** Every entry, oldest first (the order the drain sends them in). @returns {Promise<QueueEntry[]>} */
    async list() {
      const rows = await adapter.getAll().catch(() => []);
      return rows.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)) || queueKey(a.bookId, a.sceneId).localeCompare(queueKey(b.bookId, b.sceneId)));
    },
    async count() {
      return (await api.list()).length;
    },
    /** The server confirmed the save (or kept it as a suggestion): the entry is no longer needed. @param {string} bookId @param {string} sceneId */
    async remove(bookId, sceneId) {
      try {
        await adapter.delete(queueKey(bookId, sceneId));
      } catch {
        // see put
      }
      await changed();
    },
    /** Delete the entry only if it is still the one that was sent (the author may have typed more while the save was in flight). @param {QueueEntry} sent */
    async removeSent(sent) {
      const now = await api.get(sent.bookId, sent.sceneId);
      if (now && (now.text !== sent.text || now.baseSha256 !== sent.baseSha256)) return;
      await api.remove(sent.bookId, sent.sceneId);
    },
    /** @param {(count: number) => void} fn @returns {() => void} */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** An open editor looks after this scene. @param {string} bookId @param {string} sceneId */
    hold(bookId, sceneId) {
      held.add(queueKey(bookId, sceneId));
    },
    /** @param {string} bookId @param {string} sceneId */
    release(bookId, sceneId) {
      held.delete(queueKey(bookId, sceneId));
    },

    /**
     * Send the waiting entries, oldest first, each through the normal save route with its stored base sha.
     *   200: saved, entry deleted. 409 STALE: the server kept the text as a suggestion (or found nothing to keep), entry deleted; the result carries `suggestionId`.
     *   no answer or 5xx: still offline, the drain stops and every remaining entry stays. Any other answer (a role that changed, a scene that is gone): the entry stays and the drain goes on.
     * Only one drain runs at a time; a second call returns the running one.
     * @param {{ fetch?: typeof fetch }} [opts] @returns {Promise<DrainResult[]>}
     */
    drain(opts = {}) {
      if (draining) return draining;
      const fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
      draining = (async () => {
        /** @type {DrainResult[]} */
        const results = [];
        for (const entry of await api.list()) {
          const key = queueKey(entry.bookId, entry.sceneId);
          const base = { key, bookId: entry.bookId, sceneId: entry.sceneId };
          if (held.has(key)) {
            results.push({ ...base, outcome: 'skipped', status: null });
            continue;
          }
          const { status, json } = await sendEntry(entry, fetchImpl);
          if (status === 200) {
            await api.removeSent(entry);
            results.push({ ...base, outcome: 'saved', status });
          } else if (status === 409 && json?.error === 'STALE') {
            await api.removeSent(entry);
            results.push({ ...base, outcome: 'stale', status, suggestionId: json?.suggestion?.id ?? null, kept: json?.kept !== false });
          } else if (status === null || status >= 500) {
            results.push({ ...base, outcome: 'offline', status });
            break;
          } else {
            results.push({ ...base, outcome: 'kept', status });
          }
        }
        return results;
      })().finally(() => {
        draining = null;
      });
      return draining;
    },
  };
  return api;
}

/** @type {ReturnType<typeof createOfflineQueue> | null} */
let shared = null;
/** The one queue of this browser tab (IndexedDB). Everything that needs the queue (the editor, the offline bar) shares it. */
export function getOfflineQueue() {
  if (!shared) shared = createOfflineQueue({ adapter: browserAdapter() });
  return shared;
}
