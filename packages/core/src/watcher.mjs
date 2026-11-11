// Watcher (contract M01-J04 section 1): notices changes made outside the app and has the index reconciled.
// One recursive watch per book, plus non-recursive watches on the library root and series folders for
// library.md / series.md. Falls back to polling index.status() when watching is off or fails.
// No filesystem access here: the OS watch lives in @storyforge/store (store.watch).
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '@storyforge/store';

const noop = () => {};

export const DEFAULTS = { pollMs: 30_000, debounceMs: 300, maxWaitMs: 2000, fallbackPollMs: 5000 };

/**
 * @typedef {{ watch?: boolean | 'fail', pollMs?: number, debounceMs?: number, maxWaitMs?: number }} WatchOptions
 *   `watch: false` never uses fs.watch; `'fail'` behaves as if fs.watch had thrown (both: poll mode).
 *   `pollMs` is the poll interval while watching (default 30000); in poll mode it is the smaller of `pollMs`
 *   and 5000; 0 turns polling off. `debounceMs` (300) and `maxWaitMs` (2000) shape the event debounce.
 */

/** True for events that cannot change the book's Markdown (the lock file and `.storyforge/` included). */
export function isIgnored(rel, eventType = 'rename') {
  if (rel === null) return false;
  const segs = rel.split('/');
  if (segs[0] === '.storyforge' || segs[0] === '.storyforge-lock') return true;
  const base = segs[segs.length - 1];
  if (base.endsWith('.sf-tmp')) return true;
  // Markdown files, and names without an extension (a folder may have been renamed or moved with scenes in it).
  // (Only a 'rename' event can mean that; a plain 'change' on a folder is just its contents changing.)
  return !(/\.md$/i.test(base) || (eventType === 'rename' && !base.includes('.')));
}

/**
 * @param {{ root: string, manager: ReturnType<typeof import('./index-manager.mjs').createIndexManager>, options?: WatchOptions,
 *   onExternalChange?: (bookPath: string, rels: string[] | null) => Promise<void>,
 *   onRawEvent?: (e: { rel: string | null, eventType: string, own: boolean } | { live: boolean }) => void }} p
 *   `onRawEvent` runs synchronously for EVERY watch event (own writes and ignored files included), before the debounce, and with `{ live }` whenever
 *   the watcher starts or stops delivering events (see `isLive()`).
 *   `onExternalChange(bookPath, rels)` (M05-J07) runs before the index is reconciled for changes made outside the app: `rels` are the book-relative files the
 *   watch event named, or null for the catch-up when watching starts (every scene).
 */
export function createWatcher({ root, manager, options = {}, onExternalChange, onRawEvent }) {
  const watchOpt = options.watch ?? true;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  const debounceMs = options.debounceMs ?? DEFAULTS.debounceMs;
  const maxWaitMs = options.maxWaitMs ?? DEFAULTS.maxWaitMs;

  /** @type {'watch' | 'poll'} */
  let mode = 'poll';
  /** @type {string | null} */
  let reason = null;
  /** @type {string | null} */
  let lastEventAt = null;
  let closed = false;
  /** True while every watch is open and delivering events (fs.watch mode only). */
  let live = false;
  let running = 0;
  /** @type {{ close(): void }[]} */
  let handles = [];
  /** @type {Map<string, { first: number, timer: ReturnType<typeof setTimeout> }>} debounce state by key */
  const pending = new Map();
  /** @type {ReturnType<typeof setInterval> | null} */
  let pollTimer = null;
  let polling = false;
  /** @type {Map<string, string>} sha of library.md / series.md by dir path ('' = library root), for the poll check */
  let sigs = new Map();
  /** @type {string[]} */
  let books = [];
  /** @type {Promise<void>} */
  let ready = Promise.resolve();

  function setLive(v) {
    if (live === v) return;
    live = v;
    raw({ live: v });
  }

  /** @param {any} e */
  function raw(e) {
    try {
      onRawEvent?.(e);
    } catch {
      // a listener must never break the watcher
    }
  }

  const dirOf = (bookPath) => (bookPath === '' ? root : path.join(root, ...bookPath.split('/')));
  const under = (dir, bookPath) => dir === '' || bookPath === dir || bookPath.startsWith(`${dir}/`);

  /** Folders whose library.md / series.md matter: the root and every folder a book sits in below it. */
  function topDirs(bookPaths) {
    if (bookPaths.length === 1 && bookPaths[0] === '') return [];
    const dirs = new Set(['']);
    for (const b of bookPaths) {
      for (let d = path.posix.dirname(b); d !== '.' && d !== ''; d = path.posix.dirname(d)) dirs.add(d);
    }
    return [...dirs].sort();
  }

  /** Run `fn` after `ms` of quiet, but no later than `maxWaitMs` after the first call for this key. */
  function debounce(key, fn) {
    const now = Date.now();
    const prev = pending.get(key);
    if (prev) clearTimeout(prev.timer);
    const first = prev?.first ?? now;
    const wait = Math.max(0, Math.min(debounceMs, first + maxWaitMs - now));
    const timer = setTimeout(async () => {
      pending.delete(key);
      if (closed) return;
      running++;
      try {
        await fn();
      } catch {
        // reconcile never throws; anything else is not worth crashing the app for
      } finally {
        running--;
      }
    }, wait);
    timer.unref?.();
    pending.set(key, { first, timer });
  }

  const reconcileBooks = (bookPaths, why) => Promise.all(bookPaths.map((b) => manager.reconcile(b, why)));

  /** Files named by watch events since the last run, by book (for the external-change receipts). */
  const touched = new Map();

  function onBookEvent(bookPath, e) {
    raw(e);
    if (closed || e.own || isIgnored(e.rel, e.eventType)) return;
    lastEventAt = new Date().toISOString();
    if (e.rel !== null) (touched.get(bookPath) ?? touched.set(bookPath, new Set()).get(bookPath)).add(e.rel);
    debounce(`book:${bookPath}`, async () => {
      const rels = [...(touched.get(bookPath) ?? [])];
      touched.delete(bookPath);
      if (rels.length > 0) await onExternalChange?.(bookPath, rels).catch(noop); // receipts first: the change is attributed before anything else acts on it
      await manager.reconcile(bookPath, 'watch');
    });
  }

  function onTopEvent(dir, e) {
    raw(e);
    if (closed || e.own) return;
    const base = e.rel === null ? null : e.rel.split('/').pop();
    if (base === 'library.md' || base === 'series.md' || base === null) {
      lastEventAt = new Date().toISOString();
      debounce(`top:${dir}`, async () => {
        await reconcileBooks(books.filter((b) => under(dir, b)), 'series');
        sigs = await signatures(books);
      });
    } else if (!base.includes('.') && !base.startsWith('.')) {
      lastEventAt = new Date().toISOString();
      debounce('resync', resync); // a folder appeared or went: books may have come or gone
    }
  }

  async function bookList() {
    try {
      return await manager.bookPaths();
    } catch {
      return null;
    }
  }

  /** sha256 of every library.md / series.md that matters, by folder. */
  async function signatures(bookPaths) {
    const out = new Map();
    for (const dir of topDirs(bookPaths)) {
      try {
        const store = await openStore(dirOf(dir), { recover: false });
        for (const name of ['library.md', 'series.md']) {
          const r = await store.read(name);
          if (r) out.set(`${dir}/${name}`, createHash('sha256').update(r.bytes).digest('hex'));
        }
      } catch {
        // an unreadable folder just has no signature
      }
    }
    return out;
  }

  function degrade(why) {
    setLive(false);
    for (const h of handles) {
      try {
        h.close();
      } catch {
        // already closed
      }
    }
    handles = [];
    mode = 'poll';
    reason = why;
    startPolling();
  }

  async function openWatches(bookPaths) {
    for (const b of bookPaths) {
      const store = await manager.storeFor(b);
      handles.push(store.watch((e) => onBookEvent(b, e), { recursive: true, onError: (err) => degrade(`fs.watch error: ${err.message}`) }));
    }
    for (const dir of topDirs(bookPaths)) {
      const store = await openStore(dirOf(dir), { recover: false });
      handles.push(store.watch((e) => onTopEvent(dir, e), { recursive: false, onError: (err) => degrade(`fs.watch error: ${err.message}`) }));
    }
  }

  async function resync() {
    const next = await bookList();
    if (next === null || closed || mode !== 'watch') return;
    if (next.join('\n') === books.join('\n')) return;
    setLive(false);
    for (const h of handles) h.close();
    handles = [];
    books = next;
    try {
      await openWatches(books);
      if (!closed && mode === 'watch') setLive(true);
    } catch (e) {
      degrade(`fs.watch failed: ${e?.message ?? e}`);
    }
    sigs = await signatures(books);
  }

  /** Stat-based check: reconcile every book whose index is stale, and the books a changed library.md / series.md affects. */
  async function pollOnce() {
    if (polling || closed) return;
    polling = true;
    try {
      const list = await bookList();
      if (list === null || closed) return;
      books = list;
      const next = await signatures(list);
      const changedDirs = new Set();
      for (const [k, v] of next) {
        if (sigs.has(k) && sigs.get(k) !== v) changedDirs.add(k.slice(0, k.lastIndexOf('/')));
      }
      for (const k of sigs.keys()) if (!next.has(k)) changedDirs.add(k.slice(0, k.lastIndexOf('/')));
      sigs = next;
      const affected = new Set();
      for (const d of changedDirs) for (const b of list) if (under(d, b)) affected.add(b);
      for (const b of list) {
        if (closed) return;
        if (affected.has(b)) {
          await manager.reconcile(b, 'series');
          continue;
        }
        const st = await manager.indexStateOf(b);
        if (st.state === 'stale') await manager.reconcile(b, 'poll');
      }
    } catch {
      // the library may be gone or half-written; try again next time
    } finally {
      polling = false;
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (!(pollMs > 0)) return; // polling switched off (one-shot CLI commands)
    const every = mode === 'poll' ? Math.min(pollMs, DEFAULTS.fallbackPollMs) : pollMs;
    pollTimer = setInterval(() => {
      pollOnce().catch(noop);
    }, every);
    pollTimer.unref?.();
  }

  async function start() {
    const list = await bookList();
    if (closed) return;
    books = list ?? [];
    sigs = await signatures(books);
    if (watchOpt === false) {
      mode = 'poll';
      reason = 'watching is turned off';
    } else if (watchOpt === 'fail') {
      mode = 'poll';
      reason = 'fs.watch failed (forced by the watch: "fail" option)';
    } else if (list === null) {
      mode = 'poll';
      reason = 'fs.watch could not start: the library could not be scanned';
    } else {
      try {
        mode = 'watch';
        await openWatches(books);
        if (!closed && mode === 'watch') setLive(true);
      } catch (e) {
        degrade(`fs.watch failed: ${/** @type {any} */ (e)?.message ?? e}`);
      }
    }
    if (closed) {
      watcher.close();
      return;
    }
    startPolling();
    // catch anything that changed before the watches were in place
    if (onExternalChange) for (const b of books) await onExternalChange(b, null).catch(noop);
    if (pollMs > 0) pollOnce().catch(noop);
  }

  const watcher = {
    /** Resolves once the watches (or the poll) are in place. */
    start() {
      ready = start().catch(noop);
      return ready;
    },
    get ready() {
      return ready;
    },
    /** Look for books that appeared or went (after the app itself created one), now rather than at the next event or poll. */
    async rescan({ force = false } = {}) {
      await ready;
      if (closed) return;
      if (mode === 'watch') await resync(force);
      else await pollOnce();
    },
    /**
     * Close every fs.watch handle (a folder with open watches cannot be renamed on Windows) until the next
     * `rescan({ force: true })`. Events in that gap are caught by that rescan's resync and by the poll.
     */
    async release() {
      await ready;
      if (closed || mode !== 'watch') return;
      setLive(false);
      for (const h of handles) h.close();
      handles = [];
    },
    /** True while fs.watch is delivering events for every book (false in poll mode, when degraded, before start and after close). */
    isLive() {
      return live && !closed && mode === 'watch';
    },
    status() {
      return { mode, reason, last_event_at: lastEventAt, pending: pending.size + running };
    },
    close() {
      closed = true;
      setLive(false);
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      for (const h of handles) {
        try {
          h.close();
        } catch {
          // already closed
        }
      }
      handles = [];
    },
  };
  return watcher;
}
