// Book interior snapshots (contract M13-J05 section 4), modelled on the EPUB validations (epub-validations.mjs): in memory, per book, never saved. A snapshot is the rendered
// interior (html and css), the layout it was made from, its fingerprint and its report. The latest five of a book are kept, each for 30 minutes.
import { randomBytes } from 'node:crypto';

export const KEEP_SNAPSHOT_MS = 30 * 60 * 1000;
export const KEEP_SNAPSHOTS_PER_BOOK = 5;

/** @typedef {{ html: string, css: string, layout: Record<string, any>, fingerprint: string, report: Record<string, any>, language?: string, title?: string }} SnapshotContent */

/**
 * The snapshots of this process. `now` (milliseconds), `keepMs` and `perBook` are injectable for tests.
 * @param {{ now?: () => number, keepMs?: number, perBook?: number }} [options]
 */
export function createInteriorSnapshots(options = {}) {
  const hooks = { now: options.now ?? (() => Date.now()), keepMs: options.keepMs ?? KEEP_SNAPSHOT_MS, perBook: options.perBook ?? KEEP_SNAPSHOTS_PER_BOOK };
  /** @type {Map<string, any>} */
  const snapshots = new Map();

  function sweep() {
    const t = hooks.now();
    for (const [id, s] of snapshots) if (t - s.createdMs > hooks.keepMs) snapshots.delete(id);
  }

  return {
    /** Replace the injectable parts (tests). @param {{ now?: (() => number) | null, keepMs?: number | null, perBook?: number | null }} next */
    setHooks(next) {
      hooks.now = next.now ?? options.now ?? (() => Date.now());
      hooks.keepMs = next.keepMs ?? options.keepMs ?? KEEP_SNAPSHOT_MS;
      hooks.perBook = next.perBook ?? options.perBook ?? KEEP_SNAPSHOTS_PER_BOOK;
    },

    /**
     * Keep a snapshot of a book; the oldest of that book beyond the limit are forgotten.
     * @param {string} bookId @param {SnapshotContent} content @returns {{ snapshotId: string, createdAt: string }}
     */
    add(bookId, content) {
      sweep();
      const snapshotId = `snap_${randomBytes(9).toString('hex')}`;
      const createdMs = hooks.now();
      snapshots.set(snapshotId, { ...content, bookId, createdMs, createdAt: new Date(createdMs).toISOString() });
      const mine = [...snapshots.entries()].filter(([, s]) => s.bookId === bookId);
      for (const [id] of mine.slice(0, Math.max(0, mine.length - hooks.perBook))) snapshots.delete(id);
      return { snapshotId, createdAt: new Date(createdMs).toISOString() };
    },

    /** @param {string} bookId @param {string} snapshotId @returns {(SnapshotContent & { createdAt: string }) | null} null when unknown, expired or another book's */
    get(bookId, snapshotId) {
      sweep();
      const s = snapshots.get(snapshotId);
      return s && s.bookId === bookId ? s : null;
    },
  };
}

/** The snapshots of this server process (router.mjs uses `state.interiorSnapshots` when a caller supplies its own). */
export const interiorSnapshots = createInteriorSnapshots();
