// M01-J04 acceptance 12: the M01 milestone gate, end to end with real server processes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copyFixture, request, snapshot } from './helpers.mjs';
import { GOOD, flatScenes, killAll, startServer, waitFor } from './proc-helpers.mjs';
import http from 'node:http';

after(killAll);

const BOOK = 'book_01S5000000000000000000000A';
const ARRIVAL = 'scene_01S50000000000000000000002';
const FERRY = 'scene_01S50000000000000000000005';
const ARRIVAL_REL = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
const FERRY_REL = 'manuscript/act-01-low-water/ch-002-the-grafting/0010-ferry.md';
const FERRY_NEW_REL = 'manuscript/act-01-low-water/ch-002-the-grafting/0010-ferry-crossing.md';
const WORD = 'zephyrquill';

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const statusOf = async (port) => (await request(port, 'GET', '/api/status')).json;
const bookIndex = async (port) => (await statusOf(port)).books.find((b) => b.book_id === BOOK)?.index;

function post(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: pathname, headers: { Host: `127.0.0.1:${port}`, 'content-length': Buffer.byteLength(payload), ...GOOD } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('M01 gate: build, stop, delete .storyforge, edit + rename externally, restart, everything is intact', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const before = await snapshot(root, { skipStoryforge: true });
  delete before['.storyforge-lock'];

  // 1. start, build the index
  const a = await startServer(root);
  assert.equal(await post(a.port, '/api/index/rebuild', {}), 200);
  await waitFor(async () => (await bookIndex(a.port)) === 'fresh', { what: 'fresh index on first run' });
  const bookA = (await request(a.port, 'GET', `/api/books/${BOOK}`)).json;
  const orderA = flatScenes(bookA).map((s) => s.id);
  assert.equal(orderA.length, 7);
  assert.equal((await request(a.port, 'GET', `/api/search?q=${WORD}&book=${BOOK}`)).json.length, 0);

  // 2. stop it and delete the whole index directory
  await a.stop();
  await fs.rm(path.join(root, '.storyforge'), { recursive: true, force: true });
  await assert.rejects(fs.access(path.join(root, '.storyforge')));

  // 3. an "external editor" edits one scene and renames another
  const arrivalBefore = await fs.readFile(abs(root, ARRIVAL_REL), 'utf8');
  const edited = `${arrivalBefore.trimEnd()}\n\nA ${WORD} drifted across the jetty.\n`;
  await fs.writeFile(abs(root, ARRIVAL_REL), edited);
  await fs.rename(abs(root, FERRY_REL), abs(root, FERRY_NEW_REL));

  // 4. start again
  const b = await startServer(root);
  await waitFor(async () => (await bookIndex(b.port)) === 'fresh', { what: 'fresh index after restart', timeout: 15000 });

  // same ids, same order, rename tracked by id
  const bookB = (await request(b.port, 'GET', `/api/books/${BOOK}`)).json;
  const scenes = flatScenes(bookB);
  assert.deepEqual(scenes.map((s) => s.id), orderA, 'same scene ids in the same order');
  assert.equal(scenes.find((s) => s.id === FERRY).path, FERRY_NEW_REL);
  assert.equal(scenes.find((s) => s.id === ARRIVAL).path, ARRIVAL_REL);

  // edited text served; search finds the new word
  const scene = (await request(b.port, 'GET', `/api/books/${BOOK}/scenes/${ARRIVAL}`)).json;
  assert.ok(scene.body.includes(`A ${WORD} drifted across the jetty.`));
  const hits = (await request(b.port, 'GET', `/api/search?q=${WORD}&book=${BOOK}`)).json;
  assert.ok(hits.some((h) => h.id === ARRIVAL), JSON.stringify(hits));

  // status fresh, not invalid
  const st = await statusOf(b.port);
  assert.equal(st.books.find((x) => x.book_id === BOOK).index, 'fresh');
  assert.deepEqual(st.books.find((x) => x.book_id === BOOK).invalid_paths, []);

  // no file lost: every .md from before exists with the same bytes, except the two intentional changes
  const after1 = await snapshot(root, { skipStoryforge: true });
  delete after1['.storyforge-lock'];
  for (const [rel, hash] of Object.entries(before)) {
    if (hash === 'dir') continue;
    if (rel === ARRIVAL_REL || rel === FERRY_REL) continue;
    assert.equal(after1[rel], hash, `${rel} unchanged`);
  }
  assert.equal(after1[FERRY_NEW_REL], before[FERRY_REL], 'renamed file has its original bytes');
  assert.equal(after1[FERRY_REL], undefined, 'old path is gone (rename, not copy)');
  assert.deepEqual(await fs.readFile(abs(root, ARRIVAL_REL), 'utf8'), edited, 'edited file is exactly what the editor wrote');
  const extra = Object.keys(after1).filter((k) => !(k in before) && k !== FERRY_NEW_REL);
  assert.deepEqual(extra, [], 'the app created no new author files');
});
