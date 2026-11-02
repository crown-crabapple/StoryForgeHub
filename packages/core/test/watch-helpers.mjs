// Helpers shared by the J04 watcher/reconcile tests. No clock or network: waits are bounded polls.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as core from '../src/index.mjs';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

export const BOOK = 'book_01S5000000000000000000000A';
export const PROLOGUE = 'scene_01S50000000000000000000001';
export const ARRIVAL = 'scene_01S50000000000000000000002';
export const FERRY = 'scene_01S50000000000000000000005';
export const GRAFTING = 'scene_01S50000000000000000000006';
export const ARRIVAL_REL = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
export const FERRY_REL = 'manuscript/act-01-low-water/ch-002-the-grafting/0010-ferry.md';
export const GRAFTING_REL = 'manuscript/act-01-low-water/ch-002-the-grafting/0020-the-grafting.md';

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const plain = (v) => JSON.parse(JSON.stringify(v));
export const rowsOf = (v) => (Array.isArray(v) ? v : v?.results ?? v?.rows ?? []);
export const abs = (root, rel) => path.join(root, ...rel.split('/'));

/** Poll `fn` until it returns a truthy value (bounded). Throws with the last error/value on timeout. */
export async function waitFor(fn, { timeout = 5000, interval = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${what}; last: ${last instanceof Error ? last.stack : JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Scene summaries of a getBook() result in reading order. */
export function flatScenes(book) {
  return book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));
}

export const idsOf = (book) => flatScenes(book).map((s) => s.id);

/**
 * Copy a fixture, open a repository over it (short debounce, long poll so only the watcher can
 * notice changes unless `opts` says otherwise), build the index, and register cleanup.
 */
export async function setup(t, { fixture = 'valid/salt-orchard', opts = {}, wait = true } = {}) {
  const root = await copyFixture(fixture);
  const repo = createFsRepository(root, { debounceMs: 50, pollMs: 60000, ...opts });
  t.after(async () => {
    await repo.close();
  });
  await repo.rebuildIndex();
  if (wait && fixture === 'valid/salt-orchard') {
    await waitFor(async () => (await repo.indexStatus(BOOK)).state === 'fresh', { what: 'initial fresh index' });
  }
  return { root, repo };
}

export const stateOf = async (repo) => (await repo.indexStatus(BOOK)).state;

/**
 * Count reconcile calls through the core test hook (`__hooks.onReconcile`). The hook is restored
 * by t.after. Fails loudly if the hook is not exported.
 */
export function countReconciles(t) {
  const hooks = core.__hooks;
  if (!hooks || !('onReconcile' in hooks)) {
    throw new Error('@storyforge/core must export __hooks with an onReconcile slot (test hook for J04 acceptance 8)');
  }
  const previous = hooks.onReconcile;
  let n = 0;
  const calls = [];
  hooks.onReconcile = (...args) => {
    n++;
    calls.push(args[0]);
    return previous?.(...args);
  };
  t.after(() => {
    hooks.onReconcile = previous;
  });
  return { count: () => n, calls: () => calls.slice(), reset: () => { n = 0; calls.length = 0; } };
}

/** Break a scene's YAML (unterminated flow sequence in `title`). Returns the exact bytes written. */
export async function breakScene(root, rel) {
  const file = abs(root, rel);
  const text = await fs.readFile(file, 'utf8');
  const broken = text.replace(/^title:.*$/m, 'title: [unclosed');
  if (broken === text) throw new Error(`no title line to break in ${rel}`);
  await fs.writeFile(file, broken);
  return Buffer.from(broken);
}
