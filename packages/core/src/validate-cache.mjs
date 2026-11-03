// A per-library, always-fresh cache of validate(): reads share one validate() result until something may have changed it.
// Never time based. A result is kept only while the watcher is in live fs.watch mode, and is dropped (a) on every raw watch event
// (before the watcher's debounce, own writes included), (b) after every write the app makes through @storyforge/store (see onWrite there),
// (c) when the set of books on disk changed (a book folder appearing where no watch exists yet).
// Without a live watcher (poll mode, degraded, `watch: false`, not started) every get() validates afresh (still sharing a call already in flight).
// Callers must not mutate the result; set STORYFORGE_FREEZE_VALIDATE=1 (or `freeze: true`) to deep-freeze it and make any mutation throw.
import path from 'node:path';
import { discover, isFile, validate as plainValidate } from '@storyforge/format';

const noop = () => {};

/** @param {any} v @returns {any} v, deep-frozen */
export function deepFreeze(v, seen = new Set()) {
  if (v === null || typeof v !== 'object' || seen.has(v) || ArrayBuffer.isView(v)) return v;
  seen.add(v);
  for (const k of Reflect.ownKeys(v)) deepFreeze(v[k], seen);
  return Object.freeze(v);
}

/** A string that changes when the books or series found on disk change (a handful of directory probes). */
async function topologyOf(root) {
  if (await isFile(path.join(root, 'book.md'))) return 'book';
  const mode = (await isFile(path.join(root, 'series.md'))) ? 'series' : 'library';
  const found = await discover(root, mode, noop);
  return JSON.stringify([mode, found.books, found.series]);
}

/**
 * @param {{ root: string, validate?: (root: string) => Promise<any>, isLive?: () => boolean, freeze?: boolean,
 *   topology?: (root: string) => Promise<string> }} p
 *   `isLive()` says whether the watcher is delivering events right now. `validate` and `topology` are replaceable for tests.
 * @returns {{ get(): Promise<any>, invalidate(): void, readonly generation: number }}
 */
export function createValidateCache({ root, validate = plainValidate, isLive = () => false, freeze = process.env.STORYFORGE_FREEZE_VALIDATE === '1', topology = topologyOf }) {
  let generation = 0;
  /** @type {{ gen: number, result: any, topo: string } | null} */
  let entry = null;
  /** @type {{ gen: number, promise: Promise<any> } | null} */
  let inflight = null;

  function invalidate() {
    generation++;
    entry = null;
  }

  function run() {
    if (inflight && inflight.gen === generation) return inflight.promise;
    const gen = generation;
    const mine = { gen, promise: /** @type {Promise<any>} */ (/** @type {unknown} */ (null)) };
    mine.promise = (async () => {
      try {
        const topo = await topology(root).catch(() => '');
        const result = await validate(root);
        if (freeze) deepFreeze(result);
        // keep it only if nothing was invalidated while it ran and events are being delivered
        if (gen === generation && isLive()) entry = { gen, result, topo };
        return result;
      } finally {
        if (inflight === mine) inflight = null;
      }
    })();
    inflight = mine;
    return mine.promise;
  }

  return {
    get generation() {
      return generation;
    },
    invalidate,
    async get() {
      if (!isLive()) {
        entry = null;
        return run();
      }
      const hit = entry;
      if (hit && hit.gen === generation) {
        const topo = await topology(root).catch(() => null);
        if (entry === hit && hit.gen === generation) {
          if (topo === hit.topo) return hit.result;
          invalidate(); // the books on disk changed without an event we hold a watch for
        }
      }
      return run();
    },
  };
}
