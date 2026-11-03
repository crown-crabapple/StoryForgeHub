// The per-library validate cache: shared in-flight calls, generations, never stale, never cached without a live watcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createFsRepository } from '../src/index.mjs';
import { createValidateCache, deepFreeze } from '../src/validate-cache.mjs';
import { ARRIVAL, ARRIVAL_REL, BOOK, abs, setup, waitFor } from './watch-helpers.mjs';

/** A validate() whose calls are counted and finished by hand. */
function manual() {
  const calls = [];
  const validate = () =>
    new Promise((resolve) => {
      calls.push({ done: (v) => resolve(v) });
    });
  return { calls, validate };
}
const topology = async () => 'same';
const tick = () => new Promise((r) => setImmediate(r));

test('concurrent get() calls share one validate', async () => {
  const m = manual();
  const cache = createValidateCache({ root: '/x', validate: m.validate, isLive: () => true, topology });
  const a = cache.get();
  const b = cache.get();
  const c = cache.get();
  await tick();
  assert.equal(m.calls.length, 1);
  m.calls[0].done({ id: 'r1' });
  assert.deepEqual(await Promise.all([a, b, c]), [{ id: 'r1' }, { id: 'r1' }, { id: 'r1' }]);
  assert.equal(m.calls.length, 1);
});

test('live: the result is kept until invalidate()', async () => {
  let n = 0;
  const cache = createValidateCache({ root: '/x', validate: async () => ({ n: ++n }), isLive: () => true, topology });
  const first = await cache.get();
  assert.equal(await cache.get(), first);
  assert.equal(n, 1);
  cache.invalidate();
  assert.notEqual(await cache.get(), first);
  assert.equal(n, 2);
});

test('invalidate() during an in-flight validate: a get() after the bump validates again and never returns the old result', async () => {
  const m = manual();
  const cache = createValidateCache({ root: '/x', validate: m.validate, isLive: () => true, topology });
  const early = cache.get();
  await tick();
  cache.invalidate();
  const late = cache.get(); // after the bump: must not share the earlier validate
  await tick();
  assert.equal(m.calls.length, 2, 'a get() after a bump starts its own validate');
  m.calls[1].done({ id: 'new' });
  assert.deepEqual(await late, { id: 'new' });
  m.calls[0].done({ id: 'old' });
  assert.deepEqual(await early, { id: 'old' }, 'the caller that started before the bump still gets what it asked for');
  // the old result finishing last must not have replaced the newer one
  assert.deepEqual(await cache.get(), { id: 'new' });
  assert.equal(m.calls.length, 2);
});

test('invalidate() while the only validate is in flight: nothing is stored', async () => {
  const m = manual();
  const cache = createValidateCache({ root: '/x', validate: m.validate, isLive: () => true, topology });
  const p = cache.get();
  await tick();
  cache.invalidate();
  m.calls[0].done({ id: 'old' });
  await p;
  const next = cache.get();
  await tick();
  assert.equal(m.calls.length, 2);
  m.calls[1].done({ id: 'fresh' });
  assert.deepEqual(await next, { id: 'fresh' });
});

test('not live (poll mode, degraded, watch: false, not started): never cached, in-flight calls still shared', async () => {
  const m = manual();
  const cache = createValidateCache({ root: '/x', validate: m.validate, isLive: () => false, topology });
  const a = cache.get();
  const b = cache.get();
  await tick();
  assert.equal(m.calls.length, 1);
  m.calls[0].done({ id: 1 });
  await Promise.all([a, b]);
  const c = cache.get();
  await tick();
  assert.equal(m.calls.length, 2, 'a later get() validates afresh');
  m.calls[1].done({ id: 2 });
  assert.deepEqual(await c, { id: 2 });
});

test('a change in the set of books on disk drops the cached result', async () => {
  let n = 0;
  let topo = 'a';
  const cache = createValidateCache({ root: '/x', validate: async () => ({ n: ++n }), isLive: () => true, topology: async () => topo });
  const first = await cache.get();
  assert.equal(await cache.get(), first);
  topo = 'b';
  assert.notEqual(await cache.get(), first);
});

test('freeze mode: the shared result cannot be mutated', async () => {
  const cache = createValidateCache({
    root: '/x',
    validate: async () => ({ diagnostics: [{ code: 'E1' }], books: [{ order: [{ id: 's' }] }] }),
    isLive: () => true,
    topology,
    freeze: true,
  });
  const r = await cache.get();
  assert.throws(() => r.diagnostics.push({}), TypeError);
  assert.throws(() => {
    r.books[0].order[0].id = 'x';
  }, TypeError);
  assert.equal(Object.isFrozen(deepFreeze({ a: { b: [1] } }).a.b), true);
});

// ---- through the repository -------------------------------------------------------------------------------------------------------------------

const titleOf = async (repo) => (await repo.getScene(BOOK, ARRIVAL)).title;
const retitle = async (root, title) => {
  const file = abs(root, ARRIVAL_REL);
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace(/^title: .*$/m, `title: ${title}`));
};

async function warmLive(repo) {
  await waitFor(
    async () => {
      const a = await repo.__validateCache.get();
      return a === (await repo.__validateCache.get());
    },
    { what: 'the watcher to go live and the cache to hold a result' },
  );
}

test('an edit made outside the app is seen by the very next read once its watch event has arrived', async (t) => {
  // the debounce is far longer than the test: only the raw event can help
  const { root, repo } = await setup(t, { opts: { watch: true, debounceMs: 5000, maxWaitMs: 5000 } });
  await warmLive(repo);
  assert.equal(await titleOf(repo), 'Arrival');
  const gen = repo.__validateCache.generation;
  await retitle(root, 'Landfall');
  await waitFor(() => repo.__validateCache.generation > gen, { what: 'the raw watch event' });
  assert.equal(await titleOf(repo), 'Landfall', 'one read, no waiting');
});

test('a read right after a write made through the app returns the new content', async (t) => {
  const { repo } = await setup(t, { opts: { watch: true, debounceMs: 5000, maxWaitMs: 5000 } });
  await warmLive(repo);
  assert.equal(await titleOf(repo), 'Arrival');
  const r = await repo.setSceneFields(BOOK, ARRIVAL, { title: 'Landfall' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await titleOf(repo), 'Landfall');
  const d = await repo.getBook(BOOK);
  assert.ok(d.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).some((s) => s.title === 'Landfall'));
});

for (const watch of [false, 'fail']) {
  test(`watch: ${JSON.stringify(watch)} (poll mode): a read never serves a cached result`, async (t) => {
    const { root, repo } = await setup(t, { opts: { watch, pollMs: 0 } });
    assert.equal(await titleOf(repo), 'Arrival');
    const a = await repo.__validateCache.get();
    const b = await repo.__validateCache.get();
    assert.notEqual(a, b, 'every get() is a fresh validate');
    await retitle(root, 'Landfall'); // no event reaches the app in this mode
    assert.equal(await titleOf(repo), 'Landfall');
  });
}

test('the cache is told about writes made through any store handle on the library', async (t) => {
  const { root, repo } = await setup(t, { opts: { watch: true, debounceMs: 5000, maxWaitMs: 5000 } });
  await warmLive(repo);
  const gen = repo.__validateCache.generation;
  const other = createFsRepository(root, { watch: false, pollMs: 0 });
  t.after(() => other.close());
  const r = await other.setSceneFields(BOOK, ARRIVAL, { title: 'Landfall' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(repo.__validateCache.generation > gen);
});
