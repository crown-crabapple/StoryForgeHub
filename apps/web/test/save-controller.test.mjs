// M03-J02 save state machine, draft store and conflict choices (acceptance 3b, 3c, 4), with a fake clock,
// fake fetch and fake storage: no timers, network or browser involved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDraftStore, DISCARD_KEEP_MS } from '../src/editor/draft-store.js';
import { diffLines, sameLines } from '../src/editor/line-diff.js';
import { BACKOFF_MS, createSaveController, DEBOUNCE_MS, DRAFT_MS, draftOffer, isUnsaved } from '../src/editor/save-controller.js';

const BOOK = 'book_B';
const SCENE = 'scene_S';
const KEY = `${BOOK}/${SCENE}`;
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

// ------------------------------------------------------------------ fakes

function fakeClock(start = Date.parse('2026-11-01T09:00:00.000Z')) {
  const clock = { now: start };
  let id = 0;
  const timers = new Map();
  clock.timers = {
    setTimeout(fn, ms) {
      id += 1;
      timers.set(id, { at: clock.now + ms, fn });
      return id;
    },
    clearTimeout(i) {
      timers.delete(i);
    },
  };
  clock.advance = async (ms) => {
    const end = clock.now + ms;
    for (;;) {
      await settle();
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      clock.now = Math.max(clock.now, due[1].at);
      due[1].fn();
    }
    await settle();
    clock.now = end;
  };
  clock.pending = () => timers.size;
  return clock;
}

/** An in-memory stand-in for the scene API: GET scene, PUT body with the base-sha check. */
function fakeServer({ body = 'file text\n', sha = 'sha-0' } = {}) {
  let n = 0;
  const srv = { body, sha, puts: [], gets: 0, down: false, status: null, gate: null, log: [] };
  srv.external = (text) => {
    srv.body = text;
    srv.sha = `sha-ext-${++n}`;
  };
  srv.fetch = async (url, init = {}) => {
    srv.log.push(`${init.method ?? 'GET'} ${url}`);
    if (srv.down) throw new TypeError('fetch failed');
    if (srv.gate) await srv.gate;
    if (srv.status) return respond(srv.status, { error: 'boom' });
    if (url.endsWith('/body') && init.method === 'PUT') {
      const req = JSON.parse(init.body);
      srv.puts.push({ ...req, at: Date.now() });
      if (req.base_sha256 !== srv.sha) return respond(409, { error: 'conflict', current: { sha256: srv.sha, body: srv.body } });
      srv.body = req.body;
      srv.sha = `sha-${++n}`;
      return respond(200, { ok: true, sha256: srv.sha });
    }
    srv.gets += 1;
    return respond(200, { sha256: srv.sha, body: srv.body });
  };
  return srv;
}
const respond = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });

function fakeStorage({ failing = false } = {}) {
  const m = new Map();
  const boom = () => {
    if (failing) throw new Error('storage unavailable');
  };
  return {
    m,
    getItem: (k) => (boom(), m.has(k) ? m.get(k) : null),
    setItem: (k, v) => (boom(), void m.set(k, String(v))),
    removeItem: (k) => (boom(), void m.delete(k)),
  };
}

function setup({ body = 'file text\n', sha = 'sha-0', storage = fakeStorage(), withDrafts = true } = {}) {
  const clock = fakeClock();
  const server = fakeServer({ body, sha });
  const drafts = withDrafts ? createDraftStore({ indexedDB: null, localStorage: storage, now: () => clock.now }) : null;
  const states = [];
  const make = (over = {}) => {
    const c = createSaveController({
      bookId: BOOK, sceneId: SCENE, text: server.body, sha256: server.sha,
      fetch: server.fetch, drafts, timers: clock.timers, now: () => clock.now,
      onChange: (snap) => states.push(snap.state),
      ...over,
    });
    return c;
  };
  return { clock, server, drafts, storage, states, make, controller: make() };
}

// ------------------------------------------------------------------ constants named by the contract

test('contract constants: 1500 ms debounce, 500 ms draft mirror, backoff 2/4/8/16/30 s, 7-day discard window', () => {
  assert.equal(DEBOUNCE_MS, 1500);
  assert.equal(DRAFT_MS, 500);
  assert.deepEqual(BACKOFF_MS, [2000, 4000, 8000, 16000, 30000]);
  assert.equal(DISCARD_KEEP_MS, 7 * 24 * 60 * 60 * 1000);
});

// ------------------------------------------------------------------ clean -> dirty -> saving -> saved

test('starts clean; an edit makes it dirty without saving yet', async () => {
  const { controller, server, clock } = setup();
  assert.equal(controller.snapshot().state, 'clean');
  controller.edit('file text\nmore\n');
  assert.equal(controller.snapshot().state, 'dirty');
  await clock.advance(DEBOUNCE_MS - 1);
  assert.equal(server.puts.length, 0, 'nothing sent before the debounce elapses');
});

test('debounce: 1500 ms after the LAST change one PUT with the whole text and the current base; then saved with the new sha', async () => {
  const { controller, server, clock, states } = setup({ body: 'a\n', sha: 'sha-0' });
  controller.edit('ab\n');
  await clock.advance(1000);
  controller.edit('abc\n'); // restarts the debounce
  await clock.advance(1499);
  assert.equal(server.puts.length, 0);
  await clock.advance(1);
  assert.equal(server.puts.length, 1);
  assert.deepEqual({ body: server.puts[0].body, base: server.puts[0].base_sha256 }, { body: 'abc\n', base: 'sha-0' });
  const snap = controller.snapshot();
  assert.equal(snap.state, 'saved');
  assert.equal(snap.baseSha256, server.sha, 'the response sha is the next base');
  assert.equal(snap.savedText, 'abc\n');
  assert.equal(snap.savedAt, new Date(clock.now).toISOString(), 'savedAt comes from the injected clock');
  const firstSha = snap.baseSha256;
  assert.deepEqual(states.filter((s, i) => s !== states[i - 1]), ['dirty', 'saving', 'saved']);
  // the next save uses the new base
  controller.edit('abcd\n');
  await clock.advance(DEBOUNCE_MS);
  assert.equal(server.puts[1].base_sha256, firstSha);
  assert.equal(server.body, 'abcd\n');
});

test('the PUT goes to /api/books/:b/scenes/:s/body with the write headers', async () => {
  const { controller, server, clock } = setup();
  controller.edit('x\n');
  await clock.advance(DEBOUNCE_MS);
  assert.equal(server.log[0], `PUT /api/books/${BOOK}/scenes/${SCENE}/body`);
});

test('editing back to the saved text cancels the pending save and clears the draft: no PUT', async () => {
  const { controller, server, clock, drafts } = setup({ body: 'same\n' });
  controller.edit('same!\n');
  await clock.advance(DRAFT_MS);
  assert.ok(await drafts.get(KEY), 'draft mirrored while different');
  controller.edit('same\n');
  assert.notEqual(controller.snapshot().state, 'dirty');
  await clock.advance(10000);
  assert.equal(server.puts.length, 0);
  assert.equal(await drafts.get(KEY), null);
});

test('blur saves immediately; Ctrl+S (saveNow) saves immediately; both do nothing when there is nothing to save', async () => {
  const a = setup();
  a.controller.edit('one\n');
  await a.controller.blur();
  assert.equal(a.server.puts.length, 1);
  assert.equal(a.controller.snapshot().state, 'saved');
  await a.controller.blur();
  await a.controller.saveNow();
  assert.equal(a.server.puts.length, 1, 'clean: no PUT');

  const b = setup();
  b.controller.edit('two\n');
  await b.controller.saveNow();
  assert.equal(b.server.puts.length, 1);
  assert.equal(b.server.body, 'two\n');
});

test('typing while a save is in flight: the in-flight text is saved, then the newer text follows', async () => {
  const { controller, server, clock } = setup({ body: 'a\n' });
  let release;
  server.gate = new Promise((r) => (release = r));
  controller.edit('first\n');
  const saving = controller.saveNow();
  await settle();
  assert.equal(controller.snapshot().state, 'saving');
  controller.edit('first and second\n');
  release();
  server.gate = null;
  await saving;
  assert.equal(server.puts[0].body, 'first\n');
  assert.equal(controller.snapshot().state, 'dirty', 'newer text still unsaved');
  await clock.advance(DEBOUNCE_MS);
  assert.equal(server.body, 'first and second\n');
  assert.equal(controller.snapshot().state, 'saved');
  assert.equal(server.puts.length, 2);
});

test('a second saveNow while saving does not send a second PUT', async () => {
  const { controller, server } = setup();
  let release;
  server.gate = new Promise((r) => (release = r));
  controller.edit('x\n');
  const p1 = controller.saveNow();
  const p2 = controller.saveNow();
  await settle();
  release();
  await Promise.all([p1, p2]);
  assert.equal(server.puts.length, 1);
});

// ------------------------------------------------------------------ offline (acceptance 3b)

test('offline: a network error goes offline, keeps the buffer, retries 2,4,8,16,30,30 s apart, and saves when the server returns', async () => {
  const { server, clock, make } = setup({ body: 'a\n', sha: 'sha-0' });
  const times = [];
  const timed = async (...args) => {
    times.push(clock.now);
    return server.fetch(...args);
  };
  const c = make({ fetch: timed });
  server.down = true;
  c.edit('typed offline\n');
  await clock.advance(DEBOUNCE_MS);
  assert.equal(c.snapshot().state, 'offline');
  assert.equal(c.snapshot().retryInMs, 2000);
  assert.equal(c.snapshot().text, 'typed offline\n', 'buffer kept');
  assert.equal(times.length, 1);

  for (const wait of [2000, 4000, 8000, 16000, 30000, 30000]) {
    await clock.advance(wait - 1);
    const before = times.length;
    await clock.advance(1);
    assert.equal(times.length, before + 1, `a retry fires exactly ${wait} ms after the previous failure`);
    assert.equal(c.snapshot().state, 'offline');
  }
  assert.deepEqual(times.map((t) => t - times[0]), [0, 2000, 6000, 14000, 30000, 60000, 90000]);

  // edits continue while offline
  c.edit('typed offline, and more\n');
  assert.equal(c.snapshot().state, 'offline');

  server.down = false;
  await clock.advance(30000);
  assert.equal(c.snapshot().state, 'saved');
  assert.equal(server.body, 'typed offline, and more\n', 'the latest buffer was saved by the retry');
  assert.equal(c.snapshot().attempt, 0);
  assert.equal(c.snapshot().retryInMs, null);
});

test('offline: the backoff restarts at 2 s after a success and a later failure', async () => {
  const { controller, server, clock } = setup();
  server.down = true;
  controller.edit('one\n');
  await controller.saveNow();
  await clock.advance(2000);
  await clock.advance(4000);
  server.down = false;
  await clock.advance(8000);
  assert.equal(controller.snapshot().state, 'saved');
  server.down = true;
  controller.edit('two\n');
  await controller.saveNow();
  assert.equal(controller.snapshot().retryInMs, 2000);
});

test('offline: a 5xx counts as offline (retries), a 4xx other than 409 is an error that does not retry', async () => {
  const a = setup();
  a.server.status = 503;
  a.controller.edit('x\n');
  await a.controller.saveNow();
  assert.equal(a.controller.snapshot().state, 'offline');
  a.server.status = null;
  await a.clock.advance(2000);
  assert.equal(a.controller.snapshot().state, 'saved');

  const b = setup();
  b.server.status = 400;
  b.controller.edit('x\n');
  await b.controller.saveNow();
  assert.equal(b.controller.snapshot().state, 'error');
  assert.deepEqual(b.controller.snapshot().error, { status: 400, code: 'boom' });
  const n = b.server.log.length;
  await b.clock.advance(120000);
  assert.equal(b.server.log.length, n, 'no automatic retry after a refusal');
  assert.equal(b.controller.snapshot().text, 'x\n');
});

test('offline: the draft mirror holds the text while offline, and is cleared once saved', async () => {
  const { controller, server, clock, drafts } = setup();
  server.down = true;
  controller.edit('precious words\n');
  await clock.advance(DEBOUNCE_MS);
  assert.equal((await drafts.get(KEY)).text, 'precious words\n');
  server.down = false;
  await clock.advance(2000);
  assert.equal(controller.snapshot().state, 'saved');
  assert.equal(await drafts.get(KEY), null);
});

// ------------------------------------------------------------------ conflict (acceptance 4)

async function conflicted(opts) {
  const ctx = setup(opts);
  ctx.controller.edit('my edit\n');
  ctx.server.external('their edit\n'); // external edit while dirty
  await ctx.clock.advance(DEBOUNCE_MS);
  return ctx;
}

test('conflict: a 409 stops autosave; further edits, blur and Ctrl+S send nothing; the disk version is offered; the draft holds the buffer', async () => {
  const { controller, server, clock, drafts } = await conflicted();
  const snap = controller.snapshot();
  assert.equal(snap.state, 'conflict');
  assert.deepEqual({ sha: snap.conflict.currentSha256, text: snap.conflict.currentText }, { sha: server.sha, text: 'their edit\n' });
  assert.equal(server.puts.length, 1);
  controller.edit('my edit, still typing\n');
  await controller.blur();
  await controller.saveNow();
  await clock.advance(120000);
  assert.equal(server.puts.length, 1, 'no further PUT while in conflict');
  assert.equal(controller.snapshot().state, 'conflict');
  assert.equal(server.body, 'their edit\n', 'the external version was not overwritten');
  assert.equal((await drafts.get(KEY)).text, 'my edit, still typing\n', 'the buffer is mirrored, never lost');
});

test('external edit while dirty goes straight to conflict (checkDisk), without waiting for a save', async () => {
  const { controller, server, clock } = setup({ body: 'orig\n' });
  controller.edit('orig and mine\n');
  server.external('orig changed outside\n');
  const r = await controller.checkDisk();
  assert.deepEqual(r, { action: 'conflict' });
  assert.equal(controller.snapshot().state, 'conflict');
  assert.equal(controller.snapshot().conflict.currentText, 'orig changed outside\n');
  assert.equal(server.puts.length, 0);
  await clock.advance(10000);
  assert.equal(server.puts.length, 0);
});

test('external edit while clean reloads silently (checkDisk) and an unchanged disk is ignored', async () => {
  const { controller, server } = setup({ body: 'orig\n' });
  assert.deepEqual(await controller.checkDisk(), { action: 'ignored' });
  server.external('changed outside\n');
  const r = await controller.checkDisk();
  assert.deepEqual({ action: r.action, text: r.text, sha: r.sha256 }, { action: 'reload', text: 'changed outside\n', sha: server.sha });
  const snap = controller.snapshot();
  assert.equal(snap.state, 'clean');
  assert.equal(snap.text, 'changed outside\n');
  assert.equal(snap.baseSha256, server.sha);
  assert.equal(server.puts.length, 0);
});

test('conflict choice "Keep mine": saves the buffer with the disk sha as base; the file ends with my text; draft cleared', async () => {
  const { controller, server, drafts } = await conflicted();
  const diskSha = server.sha;
  await controller.keepMine();
  assert.equal(server.puts.length, 2);
  assert.equal(server.puts[1].base_sha256, diskSha);
  assert.equal(server.puts[1].body, 'my edit\n');
  assert.equal(server.body, 'my edit\n');
  assert.equal(controller.snapshot().state, 'saved');
  assert.equal(controller.snapshot().conflict, null);
  assert.equal(await drafts.get(KEY), null);
});

test('conflict choice "Use the file\'s version": buffer becomes the disk text, no PUT, and my text is kept in the discarded drafts first', async () => {
  const { controller, server, drafts } = await conflicted();
  const r = await controller.adoptDisk();
  assert.equal(r.ok, true);
  assert.equal(r.text, 'their edit\n');
  assert.equal(r.sha256, server.sha);
  const snap = controller.snapshot();
  assert.equal(snap.state, 'clean');
  assert.equal(snap.text, 'their edit\n');
  assert.equal(snap.baseSha256, server.sha);
  assert.equal(server.puts.length, 1, 'nothing was written');
  assert.equal(server.body, 'their edit\n');
  const kept = await drafts.listDiscarded(KEY);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].text, 'my edit\n', 'the buffer was copied to the draft store before it was dropped');
  assert.equal(await drafts.get(KEY), null, 'no live draft remains');
});

test('after "Use the file\'s version" autosave works again from the new base', async () => {
  const { controller, server, clock } = await conflicted();
  await controller.adoptDisk();
  controller.edit('their edit\nplus a line\n');
  await clock.advance(DEBOUNCE_MS);
  assert.equal(server.body, 'their edit\nplus a line\n');
  assert.equal(controller.snapshot().state, 'saved');
});

test('after "Keep mine" autosave works again', async () => {
  const { controller, server, clock } = await conflicted();
  await controller.keepMine();
  controller.edit('my edit\nmore\n');
  await clock.advance(DEBOUNCE_MS);
  assert.equal(server.body, 'my edit\nmore\n');
});

test('never merges: with a conflict, the file holds exactly one side, not a blend', async () => {
  for (const choice of ['keepMine', 'adoptDisk']) {
    const { controller, server } = await conflicted();
    await controller[choice]();
    assert.ok(server.body === 'my edit\n' || server.body === 'their edit\n', `${choice}: ${JSON.stringify(server.body)}`);
  }
});

test('no text is lost: after every conflict choice the buffer is in the file, the draft store, or both', async () => {
  for (const choice of ['keepMine', 'adoptDisk']) {
    const { controller, server, drafts } = await conflicted();
    controller.edit('my edit\nplus later typing\n');
    await controller[choice]();
    const discarded = (await drafts.listDiscarded(KEY)).map((d) => d.text);
    const live = (await drafts.get(KEY))?.text;
    const where = [server.body, ...discarded, live];
    assert.ok(where.includes('my edit\nplus later typing\n'), `${choice}: ${JSON.stringify(where)}`);
  }
});

test('conflict choice with no draft store available: keepMine still saves; adoptDisk still replaces', async () => {
  const a = await conflicted({ withDrafts: false });
  await a.controller.keepMine();
  assert.equal(a.server.body, 'my edit\n');
  const b = await conflicted({ withDrafts: false });
  assert.equal((await b.controller.adoptDisk()).ok, true);
});

test('keepMine and adoptDisk outside a conflict: keepMine is a no-op', async () => {
  const { controller, server } = setup();
  controller.edit('x\n');
  await controller.keepMine();
  assert.equal(server.puts.length, 0, 'only a conflict can be overridden');
});

// ------------------------------------------------------------------ leaving the page

test('needsPrompt (beforeunload) is true only while a save is pending, running, failing or in conflict', async () => {
  const { controller, server, clock } = setup();
  assert.equal(controller.needsPrompt(), false);
  controller.edit('x\n');
  assert.equal(controller.needsPrompt(), true, 'dirty');
  await clock.advance(DEBOUNCE_MS);
  assert.equal(controller.needsPrompt(), false, 'saved');
  server.down = true;
  controller.edit('y\n');
  await controller.saveNow();
  assert.equal(controller.needsPrompt(), true, 'offline');
  for (const [state, want] of [['clean', false], ['saved', false], ['dirty', true], ['saving', true], ['offline', true], ['conflict', true], ['error', true]]) assert.equal(isUnsaved(state), want, state);
});

test('flush when leaving: saves and returns saved; with a slow server it gives up after 3 s and keeps the draft', async () => {
  const fast = setup();
  fast.controller.edit('leaving\n');
  assert.deepEqual(await fast.controller.flush(), { saved: true });
  assert.equal(fast.server.body, 'leaving\n');

  const slow = setup();
  slow.controller.edit('stuck\n');
  let release;
  slow.server.gate = new Promise((r) => (release = r));
  let done = false;
  const p = slow.controller.flush().then((r) => ((done = true), r));
  await slow.clock.advance(2999);
  assert.equal(done, false, 'still waiting just before 3 s');
  await slow.clock.advance(1);
  assert.deepEqual(await p, { saved: false });
  assert.equal((await slow.drafts.get(KEY)).text, 'stuck\n', 'the draft keeps the text');
  release();
});

test('flush on a clean buffer is immediate; flush in conflict does not save and keeps the draft', async () => {
  const clean = setup();
  assert.deepEqual(await clean.controller.flush(), { saved: true });
  const { controller, server, drafts } = await conflicted();
  assert.deepEqual(await controller.flush(), { saved: false });
  assert.equal(server.puts.length, 1);
  assert.equal((await drafts.get(KEY)).text, 'my edit\n');
});

test('flush while offline: tries once, fails, returns unsaved and the draft keeps the text', async () => {
  const { controller, server, drafts } = setup();
  server.down = true;
  controller.edit('offline leave\n');
  assert.deepEqual(await controller.flush(), { saved: false });
  assert.equal((await drafts.get(KEY)).text, 'offline leave\n');
});

test('mirrorForUnload writes the unsaved buffer synchronously to the draft store, and nothing when clean', () => {
  const { controller, storage } = setup();
  controller.mirrorForUnload();
  assert.equal([...storage.m.keys()].length, 0);
  controller.edit('closing the tab\n');
  controller.mirrorForUnload();
  const keys = [...storage.m.keys()];
  assert.equal(keys.length, 1);
  assert.equal(JSON.parse(storage.m.get(keys[0])).text, 'closing the tab\n');
});

test('dispose stops timers: no PUT after the editor closed, but the draft stays', async () => {
  const { controller, server, clock, drafts } = setup();
  controller.edit('bye\n');
  await clock.advance(DRAFT_MS);
  controller.dispose();
  await clock.advance(60000);
  assert.equal(server.puts.length, 0);
  assert.equal((await drafts.get(KEY)).text, 'bye\n');
});

// ------------------------------------------------------------------ the local draft store (acceptance 3c)

test('draft mirror: written 500 ms after the last change with text and base sha, keyed bookId/sceneId; none for a clean buffer', async () => {
  const { controller, drafts, clock, server } = setup({ body: 'base\n', sha: 'sha-0' });
  assert.equal(await drafts.get(KEY), null);
  controller.edit('base\nA\n');
  await clock.advance(DRAFT_MS - 1);
  assert.equal(await drafts.get(KEY), null, 'not yet');
  controller.edit('base\nAB\n');
  await clock.advance(DRAFT_MS - 1);
  assert.equal(await drafts.get(KEY), null, 'debounced again');
  await clock.advance(1);
  const d = await drafts.get(KEY);
  assert.equal(d.text, 'base\nAB\n');
  assert.equal(d.base_sha256, 'sha-0');
  assert.equal(d.key, KEY);
  assert.equal(typeof d.at, 'string');
  assert.equal(server.puts.length, 0, 'the mirror ran before the 1500 ms save');
});

test('draft cleared after a successful save', async () => {
  const { controller, drafts, clock } = setup();
  controller.edit('x\n');
  await clock.advance(DRAFT_MS);
  assert.ok(await drafts.get(KEY));
  await clock.advance(DEBOUNCE_MS);
  assert.equal(controller.snapshot().state, 'saved');
  assert.equal(await drafts.get(KEY), null);
});

test('browser closed with unsaved text: a new session over the same storage finds the draft and offers it; Restore makes the buffer dirty and saves it', async () => {
  const storage = fakeStorage();
  const first = setup({ body: 'file v1\n', sha: 'sha-0', storage });
  first.server.down = true; // the save never gets through before the tab closes
  first.controller.edit('file v1\nwords typed before the crash\n');
  await first.clock.advance(DRAFT_MS);
  first.controller.mirrorForUnload();
  first.controller.dispose();

  // reopen: new clock, new controller, new draft store instance, same storage; the file is as the first session loaded it
  const second = setup({ body: 'file v1\n', sha: 'sha-0', storage });
  const draft = await second.drafts.get(KEY);
  assert.equal(draft.text, 'file v1\nwords typed before the crash\n');
  const offer = draftOffer(draft, second.server.body);
  assert.ok(offer, 'banner "You have unsaved changes from <time>."');
  assert.equal(typeof offer.at, 'string');

  const outcome = second.controller.restoreDraft(draft);
  assert.equal(outcome, 'dirty');
  assert.equal(second.controller.snapshot().state, 'dirty');
  assert.equal(second.controller.snapshot().text, draft.text);
  await second.clock.advance(DEBOUNCE_MS);
  assert.equal(second.server.body, 'file v1\nwords typed before the crash\n');
  assert.equal(second.controller.snapshot().state, 'saved');
  assert.equal(await second.drafts.get(KEY), null);
});

test('draftOffer: nothing to offer when there is no draft or it equals the file', () => {
  assert.equal(draftOffer(null, 'x'), null);
  assert.equal(draftOffer({ text: 'same' }, 'same'), null);
  assert.ok(draftOffer({ text: 'different' }, 'same'));
});

test('restore when the file changed since the draft was made goes through the conflict flow, never straight to a save', async () => {
  const storage = fakeStorage();
  const first = setup({ body: 'v1\n', sha: 'sha-0', storage });
  first.controller.edit('v1\nmine\n');
  await first.clock.advance(DRAFT_MS);
  first.controller.dispose();

  const second = setup({ body: 'v2 changed outside\n', sha: 'sha-other', storage }); // different sha than the draft's base
  const draft = await second.drafts.get(KEY);
  assert.equal(draft.base_sha256, 'sha-0');
  assert.equal(second.controller.restoreDraft(draft), 'conflict');
  const snap = second.controller.snapshot();
  assert.equal(snap.state, 'conflict');
  assert.equal(snap.text, 'v1\nmine\n');
  assert.equal(snap.conflict.currentText, 'v2 changed outside\n');
  await second.clock.advance(60000);
  assert.equal(second.server.puts.length, 0, 'nothing saved automatically');
  assert.equal(second.server.body, 'v2 changed outside\n');
  assert.equal((await second.drafts.get(KEY)).text, 'v1\nmine\n', 'the draft is still there');
  await second.controller.keepMine();
  assert.equal(second.server.body, 'v1\nmine\n');
});

test('discarding a draft keeps it in a discarded list for 7 days, not destroyed', async () => {
  const clock = fakeClock();
  const storage = fakeStorage();
  const drafts = createDraftStore({ indexedDB: null, localStorage: storage, now: () => clock.now });
  await drafts.put(KEY, 'unsaved prose\n', 'sha-0');
  await drafts.discard(KEY);
  assert.equal(await drafts.get(KEY), null, 'no longer offered');
  let list = await drafts.listDiscarded(KEY);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 'unsaved prose\n');
  assert.equal(list[0].base_sha256, 'sha-0');

  await clock.advance(DISCARD_KEEP_MS - 1000);
  list = await drafts.listDiscarded(KEY);
  assert.equal(list.length, 1, 'still kept just inside 7 days');
  await clock.advance(2000);
  assert.equal((await drafts.listDiscarded(KEY)).length, 0, 'gone after 7 days');
});

test('discarded drafts keep several generations and can be removed one by one', async () => {
  const clock = fakeClock();
  const drafts = createDraftStore({ indexedDB: null, localStorage: fakeStorage(), now: () => clock.now });
  await drafts.put(KEY, 'one\n', 's');
  await drafts.discard(KEY);
  await clock.advance(1000);
  await drafts.put(KEY, 'two\n', 's');
  await drafts.discard(KEY);
  const list = await drafts.listDiscarded(KEY);
  assert.deepEqual(list.map((d) => d.text), ['two\n', 'one\n'], 'newest first');
  await drafts.removeDiscarded(KEY, list[0].discarded_at);
  assert.deepEqual((await drafts.listDiscarded(KEY)).map((d) => d.text), ['one\n']);
});

test('draft store is per scene: another scene\'s draft and discards are untouched', async () => {
  const drafts = createDraftStore({ indexedDB: null, localStorage: fakeStorage() });
  await drafts.put('b/s1', 'one\n', 'x');
  await drafts.put('b/s2', 'two\n', 'y');
  await drafts.clear('b/s1');
  assert.equal(await drafts.get('b/s1'), null);
  assert.equal((await drafts.get('b/s2')).text, 'two\n');
  await drafts.discard('b/s2');
  assert.equal((await drafts.listDiscarded('b/s1')).length, 0);
});

test('draft store failures are ignored: unusable or missing storage never throws and never stops saving', async () => {
  for (const storage of [fakeStorage({ failing: true }), null]) {
    const drafts = createDraftStore({ indexedDB: null, localStorage: storage });
    await drafts.put(KEY, 'x\n', 'sha');
    drafts.putNow(KEY, 'x\n', 'sha');
    assert.equal(await drafts.get(KEY), null);
    await drafts.clear(KEY);
    await drafts.discard(KEY, { text: 'y\n' });
    assert.deepEqual(await drafts.listDiscarded(KEY), []);
    await drafts.removeDiscarded(KEY, 'whenever');
  }
  const ctx = setup({ storage: fakeStorage({ failing: true }) });
  ctx.controller.edit('still saves\n');
  await ctx.clock.advance(DEBOUNCE_MS);
  assert.equal(ctx.server.body, 'still saves\n');
  assert.equal(ctx.controller.snapshot().state, 'saved');
});

test('a draft store whose methods throw or reject does not break the controller', async () => {
  const bad = {
    put: () => Promise.reject(new Error('x')),
    putNow: () => { throw new Error('x'); },
    clear: () => Promise.reject(new Error('x')),
    discard: () => Promise.reject(new Error('x')),
    get: () => Promise.reject(new Error('x')),
  };
  const clock = fakeClock();
  const server = fakeServer();
  const c = createSaveController({ bookId: BOOK, sceneId: SCENE, text: server.body, sha256: server.sha, fetch: server.fetch, drafts: bad, timers: clock.timers, now: () => clock.now });
  c.edit('x\n');
  c.mirrorForUnload();
  await clock.advance(DEBOUNCE_MS);
  assert.equal(c.snapshot().state, 'saved');
});

test('the draft round trips text byte for byte (CRLF, Unicode, emoji, no final newline)', async () => {
  const drafts = createDraftStore({ indexedDB: null, localStorage: fakeStorage() });
  for (const text of ['a\r\nb\r\n', 'こんにちは 🌊\n', 'no final newline', '', '  \n\n\n']) {
    await drafts.put(KEY, text, 'sha');
    assert.equal((await drafts.get(KEY)).text, text);
  }
});

test('subscribers see every state change and can unsubscribe', async () => {
  const { controller, clock } = setup();
  const seen = [];
  const off = controller.subscribe((s) => seen.push(s.state));
  controller.edit('x\n');
  await clock.advance(DEBOUNCE_MS);
  assert.deepEqual(seen.filter((s, i) => s !== seen[i - 1]), ['dirty', 'saving', 'saved']);
  off();
  const n = seen.length;
  controller.edit('y\n');
  assert.equal(seen.length, n);
});

// ------------------------------------------------------------------ conflict "Compare": the line diff

test('compare: identical texts (also across LF/CRLF) are all "same" rows', () => {
  const a = 'one\ntwo\nthree\n';
  assert.deepEqual(diffLines(a, a).map((r) => r.type), ['same', 'same', 'same']);
  assert.ok(sameLines(a, a.replace(/\n/g, '\r\n')));
  assert.deepEqual(diffLines('', ''), []);
});

test('compare: a changed line is one "change" row with your text left and the file\'s right; neighbours stay "same"', () => {
  const rows = diffLines('one\nmine\nthree\n', 'one\ntheirs\nthree\n');
  assert.deepEqual(rows.map((r) => r.type), ['same', 'change', 'same']);
  assert.deepEqual({ l: rows[1].left, r: rows[1].right, ln: rows[1].leftNo, rn: rows[1].rightNo }, { l: 'mine', r: 'theirs', ln: 2, rn: 2 });
});

test('compare: lines only I have are "left-only", lines only the file has are "right-only", numbering follows each side', () => {
  const rows = diffLines('a\nmy extra\nb\n', 'a\nb\ntheir extra\n');
  assert.deepEqual(rows.map((r) => [r.type, r.left, r.right]), [
    ['same', 'a', 'a'],
    ['left-only', 'my extra', null],
    ['same', 'b', 'b'],
    ['right-only', null, 'their extra'],
  ]);
  assert.deepEqual(rows.map((r) => r.leftNo), [1, 2, 3, null]);
  assert.deepEqual(rows.map((r) => r.rightNo), [1, null, 2, 3]);
});

test('compare: against an empty file every line of mine is left-only, and the reverse', () => {
  assert.deepEqual(diffLines('x\ny\n', '').map((r) => r.type), ['left-only', 'left-only']);
  assert.deepEqual(diffLines('', 'x\ny\n').map((r) => r.type), ['right-only', 'right-only']);
});

test('compare: nothing is lost, the left column is my text and the right column is the file for any pair of texts', () => {
  const mine = 'p1\n\np2 changed\np3\nonly mine\n';
  const theirs = 'p1\n\np2\np3\nonly theirs\nmore theirs\n';
  const rows = diffLines(mine, theirs);
  assert.equal(rows.filter((r) => r.left !== null).map((r) => r.left).join('\n'), mine.replace(/\n$/, ''));
  assert.equal(rows.filter((r) => r.right !== null).map((r) => r.right).join('\n'), theirs.replace(/\n$/, ''));
});
