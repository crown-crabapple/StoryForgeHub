// M08-J04 section 3 (acceptance 2): the offline save queue of shared mode. The network is faked (it can be switched off); the server is the REAL shared server of
// shared-collab.test.mjs (loopback only, a copy of salt-orchard), so the answers are the ones the app gets: 200, or 409 STALE with the text kept as a suggestion.
// Storage is the in-memory adapter ("reload" = a second queue over the same adapter) plus a small fake IndexedDB for the browser adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, describe, test } from 'node:test';
import { createSaveController } from '../src/editor/save-controller.js';
import { QUEUE_DB, RESTORED_NOTICE, createOfflineQueue, decideRestore, idbAdapter, memoryAdapter, queueKey, queueLabel, saveRequest, sendEntry } from '../src/editor/offline-queue.js';
import { BOOK, SCENE, boot, closeAll, loadScene, sceneFile } from '../../server/test/shared-helpers.mjs';

after(closeAll);

const FERRY = 'The ferry nudged the jetty';
const DUNES = 'half under water';
const sceneUrl = `/api/books/${BOOK}/scenes/${SCENE}`;

/** A `fetch` that reaches the real server as `role`, unless the network is switched off (then it fails the way a browser's does). */
function network(t, role) {
  const net = { down: false, calls: [] };
  net.fetch = async (url, init = {}) => {
    net.calls.push(`${init.method ?? 'GET'} ${url}`);
    if (net.down) throw new TypeError('Failed to fetch');
    const r = await t.call(init.method ?? 'GET', url, { cookie: t.c[role], body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.json };
  };
  return net;
}

/** Timers the test fires by hand, so a retry happens when the test says the network is back. */
function manualTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) {
      id += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(i) {
      pending.delete(i);
    },
    /** Run the timers that are waiting (once). */
    async fire(maxMs = Infinity) {
      for (const [k, v] of [...pending]) {
        if (v.ms <= maxMs) {
          pending.delete(k);
          v.fn();
        }
      }
      await tick();
    },
    count: () => pending.size,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 25));
async function until(cond, what) {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A controller the way SceneEditorPage makes one in shared mode. */
function editor({ queue, net, timers, scene }) {
  return createSaveController({ bookId: BOOK, sceneId: SCENE, text: scene.body, sha256: scene.sha256, shared: true, offlineQueue: queue, fetch: net.fetch, timers });
}

describe('the queue itself', () => {
  test('one entry per scene: { bookId, sceneId, baseSha256, text, savedAt }; a second put replaces the first; the label counts scenes', async () => {
    const q = createOfflineQueue({ now: () => Date.parse('2026-11-02T10:00:00Z') });
    await q.put({ bookId: 'b1', sceneId: 's1', baseSha256: 'x', text: 'one' });
    await q.put({ bookId: 'b1', sceneId: 's1', baseSha256: 'x', text: 'one, and more' });
    await q.put({ bookId: 'b1', sceneId: 's2', baseSha256: 'y', text: 'two' });
    const list = await q.list();
    assert.equal(list.length, 2);
    assert.deepEqual(list[0], { bookId: 'b1', sceneId: 's1', baseSha256: 'x', text: 'one, and more', savedAt: '2026-11-02T10:00:00.000Z' });
    assert.deepEqual(Object.keys(list[0]).sort(), ['baseSha256', 'bookId', 'savedAt', 'sceneId', 'text']);
    assert.equal(queueLabel(2), 'Offline: 2 scenes waiting to save');
    assert.equal(queueLabel(1), 'Offline: 1 scene waiting to save');
    assert.equal(queueKey('b1', 's1'), 'b1/s1');
  });

  test('subscribers hear the count change on put and remove', async () => {
    const q = createOfflineQueue();
    const seen = [];
    q.subscribe((n) => seen.push(n));
    await q.put({ bookId: 'b', sceneId: 's', baseSha256: 'x', text: 't' });
    await q.put({ bookId: 'b', sceneId: 's2', baseSha256: 'x', text: 't' });
    await q.remove('b', 's');
    assert.deepEqual(seen, [1, 2, 1]);
  });

  test('the request is the normal save route with the stored base sha', () => {
    const { url, init } = saveRequest({ bookId: 'b 1', sceneId: 's/1', baseSha256: 'abc', text: 'hello', savedAt: 'x' });
    assert.equal(url, '/api/books/b%201/scenes/s%2F1/body');
    assert.equal(init.method, 'PUT');
    assert.deepEqual(JSON.parse(init.body), { body: 'hello', base_sha256: 'abc' });
    assert.equal(init.headers['x-storyforge'], '1');
  });

  test('decideRestore: only an entry made against the version the server has is content; every other one is stale; none is none', () => {
    const entry = { bookId: 'b', sceneId: 's', baseSha256: 'v1', text: 't', savedAt: 'x' };
    assert.equal(decideRestore(entry, 'v1'), 'restore');
    assert.equal(decideRestore(entry, 'v2'), 'stale');
    assert.equal(decideRestore(entry, null), 'stale');
    assert.equal(decideRestore({ ...entry, baseSha256: null }, null), 'stale');
    assert.equal(decideRestore(null, 'v1'), 'none');
  });

  test('a storage that fails never throws (typing must go on) and the queue reads as empty', async () => {
    const boom = { getAll: async () => { throw new Error('x'); }, get: async () => { throw new Error('x'); }, put: async () => { throw new Error('x'); }, delete: async () => { throw new Error('x'); } };
    const q = createOfflineQueue({ adapter: boom });
    await q.put({ bookId: 'b', sceneId: 's', baseSha256: 'x', text: 't' });
    await q.remove('b', 's');
    assert.deepEqual(await q.list(), []);
    assert.equal(await q.get('b', 's'), null);
  });
});

describe('acceptance: queue, reconnect, saved, and the queue is emptied once confirmed', () => {
  test('offline edit -> entry with the base sha -> network back -> the editor retries through the normal route -> saved, file changed, entry gone', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'editor');
    const queue = createOfflineQueue();
    const net = network(t, 'editor');
    const timers = manualTimers();
    const ctl = editor({ t, role: 'editor', queue, net, timers, scene });
    const text = scene.body.replace(FERRY, 'The ferry bumped the jetty');

    net.down = true;
    ctl.edit(text);
    await ctl.saveNow();
    assert.equal(ctl.snapshot().state, 'offline');
    const entries = await queue.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].baseSha256, scene.sha256, 'the entry carries the version the text was written against');
    assert.equal(entries[0].text, text);
    assert.equal(await sceneFile(t).then((f) => f.includes('bumped')), false, 'nothing reached the file');

    net.down = false;
    await timers.fire();
    await until(() => ctl.snapshot().state === 'saved', 'the retry to save');
    assert.ok((await sceneFile(t)).includes('The ferry bumped the jetty'));
    assert.equal((await queue.list()).length, 0, 'deleted on confirm');
    assert.ok(net.calls.filter((c) => c.startsWith('PUT') && c.endsWith('/body')).length >= 2, 'it went through the normal save route');
    ctl.dispose();
  });

  test('more edits while offline replace the entry (one per scene); the retry sends the latest text', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'editor');
    const queue = createOfflineQueue();
    const net = network(t, 'editor');
    const timers = manualTimers();
    const ctl = editor({ t, role: 'editor', queue, net, timers, scene });
    net.down = true;
    ctl.edit(`${scene.body}\nFirst offline line.\n`);
    await ctl.saveNow();
    ctl.edit(`${scene.body}\nFirst offline line.\nSecond offline line.\n`);
    await ctl.flush(50); // leaving the scene: the buffer is put in the queue
    assert.equal((await queue.list()).length, 1);
    assert.match((await queue.get(BOOK, SCENE)).text, /Second offline line/);
    ctl.dispose();
  });

  test('editor closed while offline: the drain sends the waiting entries when the network is back, oldest first, and deletes each on confirm', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'editor');
    const queue = createOfflineQueue();
    const net = network(t, 'editor');
    const text = scene.body.replace(FERRY, 'The ferry bumped the jetty');
    await queue.put({ bookId: BOOK, sceneId: SCENE, baseSha256: scene.sha256, text });

    net.down = true;
    const offline = await queue.drain({ fetch: net.fetch });
    assert.deepEqual(offline.map((r) => r.outcome), ['offline']);
    assert.equal((await queue.list()).length, 1, 'still waiting: nothing is lost while the network is down');

    net.down = false;
    const back = await queue.drain({ fetch: net.fetch });
    assert.deepEqual(back.map((r) => r.outcome), ['saved']);
    assert.equal((await queue.list()).length, 0);
    assert.ok((await sceneFile(t)).includes('The ferry bumped the jetty'));
    assert.deepEqual(await queue.drain({ fetch: net.fetch }), [], 'nothing left to send');
  });

  test('a scene an open editor looks after is left to that editor (no double send)', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'editor');
    const queue = createOfflineQueue();
    const net = network(t, 'editor');
    await queue.put({ bookId: BOOK, sceneId: SCENE, baseSha256: scene.sha256, text: `${scene.body}\nx\n` });
    queue.hold(BOOK, SCENE);
    const r = await queue.drain({ fetch: net.fetch });
    assert.deepEqual(r.map((x) => x.outcome), ['skipped']);
    assert.equal(net.calls.length, 0);
    queue.release(BOOK, SCENE);
    assert.deepEqual((await queue.drain({ fetch: net.fetch })).map((x) => x.outcome), ['saved']);
  });

  test('a refusal that is not "offline" (a viewer, a scene that is gone) keeps the entry: nothing is lost and nothing is forced', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'viewer');
    const queue = createOfflineQueue();
    const net = network(t, 'viewer');
    await queue.put({ bookId: BOOK, sceneId: SCENE, baseSha256: scene.sha256, text: `${scene.body}\nx\n` });
    const r = await queue.drain({ fetch: net.fetch });
    assert.equal(r[0].outcome, 'kept');
    assert.ok([401, 403].includes(r[0].status), String(r[0].status));
    assert.equal((await queue.list()).length, 1);
  });
});

describe('acceptance: queue, reconnect after another user saved -> 409 STALE, suggestion and compare, nothing lost (real shared server)', () => {
  test('drain: the buffer becomes a suggestion, the file keeps the other author\'s text, the entry is deleted, and both texts exist', async () => {
    const t = await boot();
    const old = await loadScene(t, 'editor2'); // B loads, then goes offline
    const queue = createOfflineQueue();
    const bodyB = old.body.replace(DUNES, 'waist-deep in water');
    await queue.put({ bookId: BOOK, sceneId: SCENE, baseSha256: old.sha256, text: bodyB });
    // A saves while B is away
    const bodyA = old.body.replace(FERRY, 'The ferry bumped the jetty');
    const a = await t.call('PUT', `${sceneUrl}/body`, { cookie: t.c.editor, body: { body: bodyA, base_sha256: old.sha256 } });
    assert.equal(a.status, 200, a.text);
    const onDisk = await sceneFile(t);

    const net = network(t, 'editor2');
    const [result] = await queue.drain({ fetch: net.fetch });
    assert.equal(result.outcome, 'stale');
    assert.equal(result.status, 409);
    assert.ok(result.suggestionId, 'the server kept the text as a suggestion');
    assert.equal((await queue.list()).length, 0, 'deleted: the suggestion is the record now');
    assert.equal(await sceneFile(t), onDisk, "A's text is on disk and B's offline text did not overwrite it");
    assert.ok(onDisk.includes('The ferry bumped the jetty'));

    const sug = (await t.call('GET', `/api/books/${BOOK}/suggestions/${result.suggestionId}`, { cookie: t.c.editor2 })).json;
    assert.equal(sug.status, 'pending');
    assert.equal(sug.target, SCENE);
    assert.equal(sug.base_sha256, a.json.sha256, 'made against the current file, so the compare view can show both');
    const file = await fs.readFile(`${t.root}/${sug.path}`, 'utf8');
    assert.ok(file.includes('waist-deep in water'), "B's text is kept in the suggestion");
    assert.ok(sug.hunks.length > 0, 'there is something to compare');
  });

  test('the open editor: sendBuffered from an old base opens the stale panel state (conflict + stale + suggestion id) and keeps the server text on screen', async () => {
    const t = await boot();
    const old = await loadScene(t, 'editor2');
    const bodyB = old.body.replace(DUNES, 'waist-deep in water');
    const bodyA = old.body.replace(FERRY, 'The ferry bumped the jetty');
    assert.equal((await t.call('PUT', `${sceneUrl}/body`, { cookie: t.c.editor, body: { body: bodyA, base_sha256: old.sha256 } })).status, 200);
    const current = await loadScene(t, 'editor2');
    const queue = createOfflineQueue();
    const net = network(t, 'editor2');
    // the page reloads: the scene is loaded as it is now (the server's text), and the queue holds B's buffer from the old base
    const ctl = editor({ t, role: 'editor2', queue, net, timers: manualTimers(), scene: current });
    await queue.put({ bookId: BOOK, sceneId: SCENE, baseSha256: old.sha256, text: bodyB });
    const entry = await queue.get(BOOK, SCENE);
    assert.equal(decideRestore(entry, current.sha256), 'stale');
    await ctl.sendBuffered({ text: entry.text, baseSha256: entry.baseSha256 });
    const snap = ctl.snapshot();
    assert.equal(snap.state, 'conflict');
    assert.equal(snap.conflict.stale, true);
    assert.ok(snap.conflict.suggestionId);
    assert.equal(snap.conflict.currentText, bodyA, "the compare shows the other author's text");
    assert.equal(snap.savedText, current.body, 'the editor was never given the queued text as content');
    assert.equal((await queue.list()).length, 0);
    ctl.dispose();
  });

  test('an offline buffer identical to the server text still reports STALE, keeps nothing and loses nothing; the entry is deleted', async () => {
    const t = await boot();
    const old = await loadScene(t, 'editor2');
    const bodyA = old.body.replace(FERRY, 'The ferry bumped the jetty');
    assert.equal((await t.call('PUT', `${sceneUrl}/body`, { cookie: t.c.editor, body: { body: bodyA, base_sha256: old.sha256 } })).status, 200);
    const queue = createOfflineQueue();
    await queue.put({ bookId: BOOK, sceneId: SCENE, baseSha256: old.sha256, text: bodyA });
    const [r] = await queue.drain({ fetch: network(t, 'editor2').fetch });
    assert.equal(r.outcome, 'stale');
    assert.equal(r.suggestionId, null);
    assert.equal(r.kept, true, 'nothing to keep: the texts are the same');
    assert.equal((await queue.list()).length, 0);
  });
});

describe('acceptance: reload while offline restores the buffer; the queue is never content when the server has newer text', () => {
  test('a second queue over the same storage (a reload) finds the entry; made against the server version it is restored and then saves when the network is back', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'editor');
    const adapter = memoryAdapter();
    const before = createOfflineQueue({ adapter });
    const net = network(t, 'editor');
    const timers = manualTimers();
    const first = editor({ t, role: 'editor', queue: before, net, timers, scene });
    const text = scene.body.replace(FERRY, 'The ferry bumped the jetty');
    net.down = true;
    first.edit(text);
    await first.saveNow();
    assert.equal(first.snapshot().state, 'offline');
    first.dispose(); // the tab closes

    // ---- reload: new queue, new controller, the scene loaded from the server (unchanged), the network still down
    const reloaded = createOfflineQueue({ adapter });
    const entry = await reloaded.get(BOOK, SCENE);
    assert.ok(entry, 'the buffer survived the reload');
    assert.equal(entry.text, text);
    assert.equal(decideRestore(entry, scene.sha256), 'restore');
    const timers2 = manualTimers();
    const second = editor({ t, role: 'editor', queue: reloaded, net, timers: timers2, scene });
    assert.equal(second.restoreDraft({ text: entry.text, base_sha256: entry.baseSha256 }), 'dirty', 'back in the editor, not a conflict');
    assert.equal(second.snapshot().text, text);
    assert.equal(RESTORED_NOTICE, 'Not saved yet — will save when back online');
    await second.saveNow();
    assert.equal(second.snapshot().state, 'offline', 'still offline: the entry stays');
    assert.equal((await reloaded.list()).length, 1);

    net.down = false;
    await timers2.fire();
    await until(() => second.snapshot().state === 'saved', 'the restored buffer to save');
    assert.ok((await sceneFile(t)).includes('The ferry bumped the jetty'));
    assert.equal((await reloaded.list()).length, 0, 'deleted on confirm');
    second.dispose();
  });

  test('the queue is never used as content when the server has newer text: the file stays the other author\'s, only a suggestion is made', async () => {
    const t = await boot();
    const old = await loadScene(t, 'editor2');
    const queue = createOfflineQueue();
    await queue.put({ bookId: BOOK, sceneId: SCENE, baseSha256: old.sha256, text: old.body.replace(DUNES, 'waist-deep in water') });
    const a = await t.call('PUT', `${sceneUrl}/body`, { cookie: t.c.editor, body: { body: old.body.replace(FERRY, 'The ferry bumped the jetty'), base_sha256: old.sha256 } });
    assert.equal(a.status, 200);
    const serverNow = await loadScene(t, 'editor2');
    assert.equal(decideRestore(await queue.get(BOOK, SCENE), serverNow.sha256), 'stale');
    const before = await sceneFile(t);
    await queue.drain({ fetch: network(t, 'editor2').fetch });
    assert.equal(await sceneFile(t), before, 'the file did not change');
    assert.equal((await loadScene(t, 'owner')).sha256, a.json.sha256, 'and the version is still the other author\'s');
    assert.ok(!(await sceneFile(t)).includes('waist-deep'));
  });

  test('the draft store and the queue do not clash: a queue entry is the only restore offer (the editor reads both together)', async () => {
    const src = await fs.readFile(new URL('../src/editor/SceneEditorPage.jsx', import.meta.url), 'utf8');
    assert.match(src, /Promise\.all\(\[drafts\.get\(key\), queue \? queue\.get\(book\.id, scene\.id\) : null\]\)/);
    assert.match(src, /decideRestore\(entry, scene\.sha256/);
    assert.match(src, /const queue = sharedMode && !resource \? getOfflineQueue\(\) : null;/, 'personal mode and entries never use the queue');
  });
});

describe('personal mode keeps the existing local draft behaviour', () => {
  test('a controller without a queue never touches one, and goes offline exactly as before', async () => {
    const t = await boot();
    const scene = await loadScene(t, 'editor');
    const net = network(t, 'editor');
    const timers = manualTimers();
    const ctl = createSaveController({ bookId: BOOK, sceneId: SCENE, text: scene.body, sha256: scene.sha256, fetch: net.fetch, timers });
    net.down = true;
    ctl.edit(`${scene.body}x`);
    await ctl.saveNow();
    assert.equal(ctl.snapshot().state, 'offline');
    ctl.dispose();
  });
});

describe('the IndexedDB adapter (a small fake IDBFactory)', () => {
  /** Just enough of IndexedDB for one object store with a key path, persisted across open() calls like a real database. */
  function fakeIndexedDB() {
    const dbs = new Map(); // name -> Map(storeName -> Map(key -> row))
    const done = (result) => {
      const req = { result, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => setTimeout(() => req.onsuccess?.(), 0));
      return req;
    };
    return {
      opened: [],
      open(name, version) {
        const factory = this;
        factory.opened.push([name, version]);
        const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
        setTimeout(() => {
          const fresh = !dbs.has(name);
          if (fresh) dbs.set(name, new Map());
          const stores = dbs.get(name);
          const db = {
            createObjectStore(storeName) {
              stores.set(storeName, new Map());
            },
            transaction(storeName) {
              const rows = stores.get(storeName);
              return {
                objectStore: () => ({
                  getAll: () => done([...rows.values()]),
                  get: (k) => done(rows.get(k)),
                  put: (row) => (rows.set(row.k, row), done(undefined)),
                  delete: (k) => (rows.delete(k), done(undefined)),
                }),
              };
            },
          };
          req.result = db;
          if (fresh) req.onupgradeneeded?.();
          req.onsuccess?.();
        }, 0);
        return req;
      },
    };
  }

  test('put, get, getAll and delete; the entry is still there after a "reload" (a new adapter on the same database); its own database name', async () => {
    const factory = fakeIndexedDB();
    const q1 = createOfflineQueue({ adapter: idbAdapter(factory) });
    await q1.put({ bookId: 'b', sceneId: 's1', baseSha256: 'x', text: 'one' });
    await q1.put({ bookId: 'b', sceneId: 's2', baseSha256: 'y', text: 'two' });
    const q2 = createOfflineQueue({ adapter: idbAdapter(factory) });
    assert.equal((await q2.list()).length, 2);
    assert.equal((await q2.get('b', 's1')).text, 'one');
    await q2.remove('b', 's1');
    assert.deepEqual((await q2.list()).map((e) => e.sceneId), ['s2']);
    assert.equal(QUEUE_DB, 'storyforge-offline-queue');
    assert.ok(factory.opened.every(([name]) => name === QUEUE_DB), 'the draft store\'s database is not touched');
  });
});

describe('sendEntry never throws', () => {
  test('a network failure is status null; a non-JSON answer still has a status', async () => {
    const entry = { bookId: 'b', sceneId: 's', baseSha256: 'x', text: 't', savedAt: 'x' };
    assert.deepEqual(await sendEntry(entry, async () => { throw new TypeError('x'); }), { status: null, json: null });
    assert.deepEqual(await sendEntry(entry, async () => ({ status: 502, json: async () => { throw new Error('html'); } })), { status: 502, json: null });
  });
});
