// M03-J02 acceptance 2, 3a, 6, 7: the server half of the scene editor.
//   2  body edits through PUT .../body keep front matter, comments, Unicode, links, cites, `***` and untouched lines
//   3a a process killed mid-save (store fault point) leaves the old or the new file; the client's draft saves cleanly after restart
//   6  PUT .../raw: valid change saved, a change that adds an error is a 422 with diagnostics and nothing kept, 409 on a stale base, 403 without the guard
//   7  GET .../objects returns names (the inspector render half lives in apps/web/test)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { TORTURE, fixtureBodies, splitScene, toCRLF } from '../../web/test/editor-fixtures.mjs';
import { createDraftStore } from '../../web/src/editor/draft-store.js';
import { createSaveController } from '../../web/src/editor/save-controller.js';
import { close, copyFixture, listen, request, snapshot } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CRASH_CHILD = path.join(here, 'fixtures', 'body-crash-child.mjs');

const BOOK = 'book_01S5000000000000000000000A';
const LIVE_SCENES = [1, 2, 3, 5, 6, 8, 9].map((n) => `scene_01S5${'0'.repeat(20)}0${n}`);
const SCENE = 'scene_01S50000000000000000000002';
const OTHER_SCENE = 'scene_01S50000000000000000000003';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function serve(root) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const server = createServer({ repository: createFsRepository(root), webRoot });
  servers.push(server);
  return listen(server);
}

async function fresh() {
  const root = await copyFixture('valid/salt-orchard');
  return { root, port: await serve(root) };
}

function send(port, method, pathname, { headers = GOOD, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const sceneUrl = (id) => `/api/books/${BOOK}/scenes/${id}`;
const getScene = async (port, id = SCENE) => (await request(port, 'GET', sceneUrl(id))).json;
const putBody = (port, id, body, base) => send(port, 'PUT', `${sceneUrl(id)}/body`, { body: { body, base_sha256: base } });
const putRaw = (port, id, content, base, headers) => send(port, 'PUT', `${sceneUrl(id)}/raw`, { headers, body: { content, base_sha256: base } });
const read = (root, rel) => fs.readFile(path.join(root, rel), 'utf8');

/** What the editor does for "type one word": insert `quietly ` before the second word of the first plain prose line. Returns { text, line }. */
function typeWord(body) {
  const lines = body.split(/(?<=\n)/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const plain = /^[A-Za-z][^\n<>[\]*_`]*\s[^\n]*\S/.test(l) && !/^(#|>|[-*]\s|\d+\.\s|\s)/.test(l);
    if (plain) {
      const at = offset + l.indexOf(' ') + 1;
      return { text: body.slice(0, at) + 'quietly ' + body.slice(at), line: i };
    }
    offset += l.length;
  }
  return { text: 'quietly ' + body, line: 0 };
}

/** Lines of `after` that differ from `before`, other than line `idx` (which must differ only by the insertion). */
function collateral(before, after, idx) {
  const a = before.split(/(?<=\n)/);
  const b = after.split(/(?<=\n)/);
  assert.equal(b.length, a.length, 'line count unchanged by a one-word edit');
  return a.map((l, i) => (i !== idx && l !== b[i] ? i : -1)).filter((i) => i >= 0);
}

// ------------------------------------------------------------------ acceptance 2

for (const id of LIVE_SCENES) {
  test(`body edit via PUT (${id.slice(-2)}): front matter bytes and every untouched line identical, validate() clean`, async () => {
    const { root, port } = await fresh();
    const scene = await getScene(port, id);
    const onDisk = await read(root, scene.path);
    const { frontMatter, body: oldBody } = splitScene(onDisk);
    assert.equal(scene.body, oldBody, 'the API body is exactly the bytes after the front matter');

    const { text, line } = typeWord(oldBody);
    assert.notEqual(text, oldBody);
    const r = await putBody(port, id, text, scene.sha256);
    assert.equal(r.status, 200, r.text);

    const after = await read(root, scene.path);
    assert.equal(after.slice(0, frontMatter.length), frontMatter, 'front matter bytes unchanged');
    assert.equal(after.slice(frontMatter.length), text, 'body is exactly what the editor sent');
    assert.deepEqual(collateral(oldBody, text, line), []);
    assert.equal(r.json.sha256, sha(Buffer.from(after)));

    const reopened = await getScene(port, id);
    assert.equal(reopened.body, text);
    assert.equal(reopened.sha256, r.json.sha256);
    assert.deepEqual((await validate(root)).diagnostics, []);
  });
}

test('body edit of the CRLF scene keeps CRLF on disk, byte for byte', async () => {
  const { root, port } = await fresh();
  const id = 'scene_01S50000000000000000000006'; // 0020-the-grafting.md is CRLF on disk
  const scene = await getScene(port, id);
  assert.ok(scene.body.includes('\r\n'));
  const onDisk = await read(root, scene.path);
  const { frontMatter } = splitScene(onDisk);
  const { text } = typeWord(scene.body);
  const r = await putBody(port, id, text, scene.sha256);
  assert.equal(r.status, 200, r.text);
  const after = await read(root, scene.path);
  assert.equal(after.slice(0, frontMatter.length), frontMatter);
  assert.equal(after.slice(frontMatter.length), text);
  assert.ok(!/(?<!\r)\n/.test(after), 'no bare LF appeared in a CRLF file');
  assert.deepEqual((await validate(root)).diagnostics, []);
});

for (const [label, make] of [['LF', (s) => s], ['CRLF', toCRLF]]) {
  test(`torture body (${label}) round-trips through PUT, survives a one-word edit, validate() clean`, async () => {
    const { root, port } = await fresh();
    const scene = await getScene(port);
    const { frontMatter } = splitScene(await read(root, scene.path));
    const torture = make(TORTURE + '\n');

    // The editor saves the untouched buffer: bytes in == bytes on disk, front matter unmoved.
    const first = await putBody(port, SCENE, torture, scene.sha256);
    assert.equal(first.status, 200, first.text);
    let file = await read(root, scene.path);
    assert.equal(file.slice(0, frontMatter.length), frontMatter);
    assert.equal(file.slice(frontMatter.length), torture);
    assert.equal((await getScene(port)).body, torture, 'reopen shows the identical body');

    // Then one word typed: only that line changes.
    const { text, line } = typeWord(torture);
    const second = await putBody(port, SCENE, text, first.json.sha256);
    assert.equal(second.status, 200, second.text);
    file = await read(root, scene.path);
    assert.equal(file.slice(0, frontMatter.length), frontMatter);
    assert.equal(file.slice(frontMatter.length), text);
    assert.deepEqual(collateral(torture, text, line), []);
    for (const needle of ['[[saltmarks|the saltmarks]]', '[@admiralty-tables]', '\n***\n'.replace(/\n/g, label === 'CRLF' ? '\r\n' : '\n'), 'こんにちは', '🌊', '<!-- note: check the tide times against chapter 3 -->']) {
      assert.ok(file.includes(needle), `kept: ${JSON.stringify(needle)}`);
    }
    assert.deepEqual((await validate(root)).diagnostics, []);
  });
}

test('every fixture scene body survives a PUT of itself unchanged (no normalisation by the server)', async () => {
  const { root, port } = await fresh();
  for (const id of LIVE_SCENES) {
    const scene = await getScene(port, id);
    const before = await read(root, scene.path);
    const r = await putBody(port, id, scene.body, scene.sha256);
    assert.equal(r.status, 200, r.text);
    assert.equal(await read(root, scene.path), before, `${scene.path} unchanged`);
  }
});

test('the fixtures used by the editor tests include a CRLF body and bodies with and without a final newline', () => {
  const bodies = fixtureBodies();
  assert.ok(bodies.some((b) => b.body.includes('\r\n')));
  assert.ok(bodies.some((b) => b.body.endsWith('\n')));
});

// ------------------------------------------------------------------ acceptance 3a

const EDIT_MARK = 'this sentence exists only in the unsaved draft';

for (const at of ['after-journal', 'after-tmp', 'after-rename', 'before-done']) {
  test(`interrupted save: process killed at store fault point ${at}; file is old or new, the client draft then saves`, async () => {
    const root = await copyFixture('valid/salt-orchard');
    const port0 = await serve(root);
    const scene = await getScene(port0);
    const oldBytes = await fs.readFile(path.join(root, scene.path));
    const { frontMatter, body } = splitScene(oldBytes.toString('utf8'));
    // The client's draft store holds this (text + the base sha it was typed on).
    const draft = { text: `${body}${EDIT_MARK}\n`, baseSha: scene.sha256 };
    const untouched = await snapshot(root, { skipStoryforge: true });

    const child = spawnSync(
      process.execPath,
      [CRASH_CHILD, JSON.stringify({ root, at, bookId: BOOK, sceneId: SCENE, body: draft.text, baseSha256: draft.baseSha })],
      { encoding: 'utf8', timeout: 60000 },
    );
    assert.equal(child.status, 86, `child must die at ${at} (exit 86); stderr: ${child.stderr}`);

    // Restart: a fresh repository on the same folder, recovery run.
    const repo = createFsRepository(root);
    await repo.recover();
    const port = await serve(root);

    const current = await fs.readFile(path.join(root, scene.path));
    const newBytes = Buffer.from(frontMatter + draft.text);
    const isOld = Buffer.compare(current, oldBytes) === 0;
    const isNew = Buffer.compare(current, newBytes) === 0;
    assert.ok(isOld || isNew, 'after recovery the file is exactly the old bytes or exactly the new bytes, never partial');
    const expectNew = at === 'after-rename' || at === 'before-done';
    assert.equal(isNew, expectNew, `store recovery table: ${at} -> ${expectNew ? 'new' : 'old'}`);
    const after = await snapshot(root, { skipStoryforge: true });
    for (const [rel, h] of Object.entries(untouched)) if (rel !== scene.path) assert.equal(after[rel], h, `${rel} untouched`);

    // The editor retries with its original base. Old file: accepted. New file: 409 whose `current` already holds the draft.
    const retry = await putBody(port, SCENE, draft.text, draft.baseSha);
    if (isOld) assert.equal(retry.status, 200, retry.text);
    else {
      assert.equal(retry.status, 409, retry.text);
      assert.equal(retry.json.current.body, draft.text);
    }

    // Restore the draft the way the editor does: reload the file, take its sha as the base, save the draft text.
    const reloaded = await getScene(port);
    const saved = await putBody(port, SCENE, draft.text, reloaded.sha256);
    assert.equal(saved.status, 200, saved.text);
    const final = await fs.readFile(path.join(root, scene.path), 'utf8');
    assert.equal(final, frontMatter + draft.text);
    assert.equal((await getScene(port)).body, draft.text);
    assert.deepEqual((await validate(root)).diagnostics, []);
  });
}

// ------------------------------------------------------------------ acceptance 6

test('PUT raw: a valid change (front matter + body) is written byte for byte', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const file = await read(root, scene.path);
  const content = file.replace(/^summary: .*$/m, 'summary: A summary fixed by hand in the raw editor.') + 'A raw-added line.\n';
  assert.notEqual(content, file);
  const r = await putRaw(port, SCENE, content, scene.sha256);
  assert.equal(r.status, 200, r.text);
  assert.equal(await read(root, scene.path), content);
  assert.equal(r.json.sha256, sha(Buffer.from(content)));
  const reopened = await getScene(port);
  assert.equal(reopened.front_matter.summary, 'A summary fixed by hand in the raw editor.');
  assert.deepEqual((await validate(root)).diagnostics, []);
});

test('PUT raw: a change that introduces an error is a 422 with diagnostics and the file is unchanged', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const other = await getScene(port, OTHER_SCENE);
  const before = await snapshot(root);
  const file = await read(root, scene.path);
  const broken = file.replace(/^id: .*$/m, `id: ${other.id}`); // duplicate id
  assert.notEqual(broken, file);
  const r = await putRaw(port, SCENE, broken, scene.sha256);
  assert.equal(r.status, 422, r.text);
  assert.ok(Array.isArray(r.json.diagnostics) && r.json.diagnostics.length > 0, 'diagnostics are returned');
  for (const d of r.json.diagnostics) assert.equal(typeof d.code, 'string');
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), Object.fromEntries(Object.entries(before).filter(([k]) => !k.startsWith('.storyforge/'))), 'nothing kept');
  assert.equal(await read(root, scene.path), file);
  assert.deepEqual((await validate(root)).diagnostics, []);
});

test('PUT raw: unterminated front matter is also refused with 422 and the file is unchanged', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const file = await read(root, scene.path);
  const r = await putRaw(port, SCENE, file.replace(/\n---\r?\n/, '\n'), scene.sha256);
  assert.equal(r.status, 422, r.text);
  assert.equal(await read(root, scene.path), file);
});

test('PUT raw: stale base is a 409 and the external version stays on disk', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const file = await read(root, scene.path);
  const external = file + 'external edit\n';
  await fs.writeFile(path.join(root, scene.path), external);
  const r = await putRaw(port, SCENE, file.replace(/^summary: .*$/m, 'summary: mine'), scene.sha256);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, 'conflict');
  assert.equal(await read(root, scene.path), external);
});

test('PUT raw: 403 without the write guard (header, content-type), nothing written; unknown scene is 404', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const before = await snapshot(root);
  const content = (await read(root, scene.path)) + 'x\n';
  const noHeader = await putRaw(port, SCENE, content, scene.sha256, { 'content-type': 'application/json' });
  assert.equal(noHeader.status, 403);
  const wrongType = await putRaw(port, SCENE, content, scene.sha256, { 'content-type': 'text/plain', 'x-storyforge': '1' });
  assert.equal(wrongType.status, 403);
  assert.deepEqual(await snapshot(root), before);
  const missing = await putRaw(port, 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', content, 'a'.repeat(64));
  assert.equal(missing.status, 404);
  const malformed = await send(port, 'PUT', `${sceneUrl(SCENE)}/raw`, { body: { content: 5 } });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await snapshot(root), before);
});

// ------------------------------------------------------------------ acceptance 7 (server half)

test('GET objects: entries, threads and events come back with names, ids, slugs and types', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', `/api/books/${BOOK}/objects?kinds=entry,thread,event`);
  assert.equal(r.status, 200, r.text);
  assert.ok(Array.isArray(r.json));
  for (const o of r.json) {
    assert.equal(typeof o.id, 'string');
    assert.ok(['entry', 'thread', 'event'].includes(o.kind), `kind ${o.kind}`);
    assert.equal(typeof o.slug, 'string');
    assert.equal(typeof o.title, 'string');
    assert.ok('type' in o);
  }
  const maren = r.json.find((o) => o.slug === 'maren-hollis');
  assert.ok(maren, 'maren-hollis present');
  assert.equal(maren.kind, 'entry');
  assert.equal(maren.title, 'Maren Hollis', 'the entry name, not the slug');
  assert.equal(maren.type, 'character');
  assert.equal(maren.id, 'entry_01S5000000000000000000000G');
  assert.ok(r.json.some((o) => o.kind === 'thread' && o.slug === 'brass-key'), 'a thread is listed');
  assert.ok(r.json.some((o) => o.kind === 'event' && o.slug === 'the-flood'), 'a timeline event is listed');
});

test('GET objects: `kinds` filters; unknown book is 404; it is read-only (no writes)', async () => {
  const { root, port } = await fresh();
  const before = await snapshot(root, { skipStoryforge: true });
  const only = await request(port, 'GET', `/api/books/${BOOK}/objects?kinds=thread`);
  assert.equal(only.status, 200, only.text);
  assert.ok(only.json.length > 0 && only.json.every((o) => o.kind === 'thread'));
  const entries = await request(port, 'GET', `/api/books/${BOOK}/objects?kinds=entry`);
  assert.ok(entries.json.length > 0 && entries.json.every((o) => o.kind === 'entry'));
  assert.ok(entries.json.some((o) => o.slug === 'pell' && o.title === 'Pell'));
  const none = await request(port, 'GET', `/api/books/${BOOK}/objects?kinds=nonsense`);
  assert.ok(none.status === 400 || (none.status === 200 && none.json.length === 0), `unknown kind: ${none.status}`);
  const unknown = await request(port, 'GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/objects?kinds=entry');
  assert.equal(unknown.status, 404);
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

// ------------------------------------------------------------------ acceptance 3b/4 against the real server

const timersThatNeverFire = { setTimeout: () => 0, clearTimeout: () => {} };

/** The editor's save controller talking to the real HTTP server (relative /api URLs resolved against the test port). */
function liveController(port, scene, { text } = {}) {
  const drafts = createDraftStore({ indexedDB: null, localStorage: memoryStorage() });
  const controller = createSaveController({
    bookId: BOOK,
    sceneId: scene.id,
    text: text ?? scene.body,
    sha256: scene.sha256,
    fetch: (url, init) => fetch(`http://127.0.0.1:${port}${url}`, init),
    drafts,
    timers: timersThatNeverFire,
  });
  return { controller, drafts };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}

test('controller over HTTP: an edit saves through PUT body; the file holds exactly the buffer and the controller adopts the new sha', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const { frontMatter } = splitScene(await read(root, scene.path));
  const { controller } = liveController(port, scene);
  const edited = typeWord(scene.body).text;
  controller.edit(edited);
  await controller.saveNow();
  assert.equal(controller.snapshot().state, 'saved');
  assert.equal(await read(root, scene.path), frontMatter + edited);
  assert.equal(controller.snapshot().baseSha256, (await getScene(port)).sha256);
});

test('controller over HTTP: external edit while dirty is a conflict; the file keeps the external version until a choice is made', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const { controller, drafts } = liveController(port, scene);
  const mine = typeWord(scene.body).text;
  controller.edit(mine);
  const onDisk = await read(root, scene.path);
  const external = onDisk + 'edited elsewhere\n';
  await fs.writeFile(path.join(root, scene.path), external);

  await controller.saveNow();
  assert.equal(controller.snapshot().state, 'conflict');
  assert.equal(controller.snapshot().conflict.currentText, scene.body + 'edited elsewhere\n');
  assert.equal(await read(root, scene.path), external, 'no automatic merge, no overwrite');
  await controller.saveNow();
  assert.equal(await read(root, scene.path), external, 'saving is stopped while in conflict');
  assert.equal((await drafts.get(`${BOOK}/${scene.id}`)).text, mine, 'the buffer is in the draft store');
});

test('conflict choices over HTTP: Keep mine overwrites with the disk sha as base; Use the file\'s version leaves the file and keeps my text as a discarded draft', async () => {
  for (const choice of ['keep', 'adopt']) {
    const { root, port } = await fresh();
    const scene = await getScene(port);
    const { frontMatter } = splitScene(await read(root, scene.path));
    const { controller, drafts } = liveController(port, scene);
    const mine = typeWord(scene.body).text;
    controller.edit(mine);
    const external = (await read(root, scene.path)) + 'edited elsewhere\n';
    await fs.writeFile(path.join(root, scene.path), external);
    await controller.saveNow();
    assert.equal(controller.snapshot().state, 'conflict');

    if (choice === 'keep') {
      await controller.keepMine();
      assert.equal(await read(root, scene.path), frontMatter + mine, 'file ends with my buffer, front matter untouched');
      assert.equal(controller.snapshot().state, 'saved');
    } else {
      const r = await controller.adoptDisk();
      assert.equal(r.ok, true);
      assert.equal(await read(root, scene.path), external, 'file untouched');
      assert.equal(controller.snapshot().text, scene.body + 'edited elsewhere\n');
      assert.deepEqual((await drafts.listDiscarded(`${BOOK}/${scene.id}`)).map((d) => d.text), [mine]);
    }
    assert.deepEqual((await validate(root)).diagnostics, []);
  }
});

test('conflict choice "Save mine as a copy": createScene right after this scene, titled "<title> (my version)", holding the buffer; the original is untouched', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const external = (await read(root, scene.path)) + 'edited elsewhere\n';
  await fs.writeFile(path.join(root, scene.path), external);
  const mine = typeWord(scene.body).text;

  const r = await send(port, 'POST', `/api/books/${BOOK}/scenes`, {
    body: { chapter: scene.chapter, after: scene.id, title: `${scene.title} (my version)`, slug: `${scene.slug ?? 'the-key'}-my-version`, body: mine },
  });
  assert.equal(r.status, 201, r.text);
  const copy = await getScene(port, r.json.id);
  assert.equal(copy.title, `${scene.title} (my version)`);
  assert.equal(copy.body, mine, 'the copy holds the buffer byte for byte');
  assert.equal(await read(root, scene.path), external, 'the conflicted scene was not touched');
  const book = (await request(port, 'GET', `/api/books/${BOOK}`)).json;
  const ids = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).map((s) => s.id);
  assert.equal(ids[ids.indexOf(scene.id) + 1], r.json.id, 'right after this scene');
  assert.deepEqual((await validate(root)).diagnostics, []);
});
