// M03-J01 acceptance 7 (routes) and 9: the structure routes of contract section 4.
//   POST /api/books/:b/scenes/:s/fields | /split      POST /api/books/:b/scenes/merge | /scenes/archive
//   POST /api/books/:b/chapters | /chapters/:n/fields | /chapters/:n/archive | /chapters/renumber
//   POST /api/books/:b/acts | /acts/:n/fields
// 7: every route with { dryRun: true } writes nothing and returns { ok, changes: [{ from, to, before_sha256,
//    after_sha256, diff }] } with a non-empty list and real diffs.
// 9: every route is 403 without `x-storyforge` (and with a wrong content-type or foreign Host), 404 for an
//    unknown book, and 404 for an unknown scene on the scene routes.
//
// The merge route's body field names are not fixed by the contract (mergeScenes(firstId, secondId)), so the
// request carries every plausible spelling of them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const id = (n) => `scene_01S500000000000000000000${String(n).padStart(2, '0')}`;
const ARRIVAL = id(2);
const KEY = id(3);
const FERRY = id(5);
const GRAFTING = id(6);
const LOWTIDE = id(8);
const UNKNOWN_SCENE = 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const UNKNOWN_BOOK = 'book_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function fresh(prep) {
  const root = await copyFixture('valid/salt-orchard');
  if (prep) await prep(root);
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const server = createServer({ repository: createFsRepository(root), webRoot });
  servers.push(server);
  const port = await listen(server);
  return { root, port };
}

function send(port, method, pathname, { headers = GOOD, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const post = (port, url, body, opts = {}) => send(port, 'POST', url, { body, ...opts });

/** Files under .storyforge/trash (so a dry run that makes a trash folder is caught). */
async function trashListing(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { out.push(`${path.relative(root, full)}/`); await walk(full); } else out.push(path.relative(root, full));
    }
  }
  await walk(path.join(root, '.storyforge', 'trash'));
  return out.sort();
}
/** Everything outside .storyforge/ plus the trash listing. (.storyforge/index files may be built by reads.) */
async function state(root) {
  return { files: await snapshot(root, { skipStoryforge: true }), trash: await trashListing(root) };
}

const u = (b, rest) => `/api/books/${b}/${rest}`;
const mergeBody = (first, second, extra = {}) => ({ first, second, firstId: first, secondId: second, first_id: first, second_id: second, ...extra });

/**
 * Every route: how to call it for real, and (for scene routes) which scene it addresses.
 * `real` is a request that succeeds on a fresh salt-orchard copy; `text` marks routes that edit lines of
 * existing files (their diff must show a - and a + line).
 */
const ROUTES = [
  { name: 'scene fields', url: (b, s = KEY) => u(b, `scenes/${s}/fields`), body: { title: 'The Brass Key' }, scene: true, lineEdit: /title/ },
  { name: 'scene split', url: (b, s = ARRIVAL) => u(b, `scenes/${s}/split`), body: { atLine: 3 }, scene: true },
  { name: 'scene merge', url: (b) => u(b, 'scenes/merge'), body: mergeBody(ARRIVAL, KEY), unknownScene: mergeBody(UNKNOWN_SCENE, KEY) },
  { name: 'chapter create', url: (b) => u(b, 'chapters'), body: { act: 2, after: 3, title: 'Aftermath' } },
  { name: 'chapter fields', url: (b) => u(b, 'chapters/1/fields'), body: { title: 'The Flooded Rows' }, lineEdit: /title/ },
  { name: 'chapter archive', url: (b) => u(b, 'chapters/2/archive'), body: {} },
  { name: 'scenes archive', url: (b) => u(b, 'scenes/archive'), body: { scenes: [ARRIVAL, LOWTIDE] }, unknownScene: { scenes: [ARRIVAL, UNKNOWN_SCENE] } },
  { name: 'chapter move', url: (b) => u(b, 'chapters/2/move'), body: { act: 2 } },
  { name: 'chapters renumber', url: (b) => u(b, 'chapters/renumber'), body: { step: 1 }, needsGap: true },
  { name: 'act create', url: (b) => u(b, 'acts'), body: { title: 'Ebb Tide' } },
  { name: 'act fields', url: (b) => u(b, 'acts/1/fields'), body: { title: 'Lower Water' }, lineEdit: /title/ },
];

/** Make chapters 0,1,4,5 so renumber has work to do (done through the files, before the server reads). */
async function openGap(root) {
  const act1 = path.join(root, 'manuscript', 'act-01-low-water');
  const act2 = path.join(root, 'manuscript', 'act-02-high-water');
  for (const [parent, from, to, slug] of [[act2, 3, 5, 'the-wall'], [act1, 2, 4, 'the-grafting']]) {
    const dir = path.join(parent, `ch-00${from}-${slug}`);
    for (const f of await fs.readdir(dir)) {
      const file = path.join(dir, f);
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(new RegExp(`^chapter: ${from}$`, 'm'), `chapter: ${to}`));
    }
    await fs.rename(dir, path.join(parent, `ch-00${to}-${slug}`));
  }
}

const freshFor = (route) => fresh(route.needsGap ? openGap : undefined);

// ---------------------------------------------------------------- acceptance 7: dry runs

for (const route of ROUTES) {
  test(`dry run: POST ${route.name} writes nothing and returns changes with diffs`, async () => {
    const { root, port } = await freshFor(route);
    await request(port, 'GET', `/api/books/${BOOK}`); // let any read-side caches settle first
    const before = await state(root);
    const r = await post(port, route.url(BOOK), { ...route.body, dryRun: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, r.text);
    assert.ok(Array.isArray(r.json.changes) && r.json.changes.length > 0, `non-empty changes: ${r.text}`);
    for (const c of r.json.changes) {
      assert.ok('from' in c && 'to' in c, `from/to: ${JSON.stringify(c)}`);
      assert.ok('before_sha256' in c && 'after_sha256' in c, `hashes: ${JSON.stringify(c)}`);
      assert.match(c.after_sha256, /^[0-9a-f]{64}$/);
      assert.ok(c.before_sha256 === null || /^[0-9a-f]{64}$/.test(c.before_sha256));
      assert.equal(typeof c.diff, 'string', `diff is a string: ${JSON.stringify(c)}`);
    }
    assert.ok(r.json.changes.some((c) => c.diff.length > 0), 'at least one change has a diff');
    assert.deepEqual(await state(root), before, 'no file written, no trash entry made');
  });

  test(`dry run then real run: POST ${route.name} touches exactly the files the dry run named`, async () => {
    const { root, port } = await freshFor(route);
    const planned = await post(port, route.url(BOOK), { ...route.body, dryRun: true });
    assert.equal(planned.status, 200, planned.text);
    const before = await snapshot(root, { skipStoryforge: true });
    const real = await post(port, route.url(BOOK), route.body);
    assert.ok(real.status === 200 || real.status === 201, real.text);
    const after = await snapshot(root, { skipStoryforge: true });
    const changedPaths = Object.keys({ ...before, ...after }).filter((k) => !k.endsWith('/') && before[k] !== after[k]);
    const named = new Set(planned.json.changes.flatMap((c) => [c.from, c.to]).filter(Boolean));
    assert.ok(changedPaths.length > 0, 'the real run changed files');
    for (const p of changedPaths) assert.ok(named.has(p), `${p} changed but the dry run did not name it (named: ${[...named]})`);
    for (const c of planned.json.changes) {
      const file = path.join(root, ...c.to.split('/'));
      assert.ok(await fs.stat(file).then(() => true, () => false), `${c.to} exists after the real run`);
    }
  });

  if (route.lineEdit) {
    test(`dry run: POST ${route.name} shows a unified diff of the one changed line`, async () => {
      const { port } = await freshFor(route);
      const r = await post(port, route.url(BOOK), { ...route.body, dryRun: true });
      assert.equal(r.status, 200, r.text);
      const d = r.json.changes.map((c) => c.diff).join('\n');
      assert.match(d, /^@@ /m, 'has a hunk header');
      assert.match(d, new RegExp(`^-${route.lineEdit.source}`, 'm'), 'removed line');
      assert.match(d, new RegExp(`^\\+${route.lineEdit.source}`, 'm'), 'added line');
      const removed = d.split('\n').filter((l) => /^-(?!--)/.test(l));
      const added = d.split('\n').filter((l) => /^\+(?!\+\+)/.test(l));
      assert.equal(removed.length, 1, d);
      assert.equal(added.length, 1, d);
    });
  }
}

test('dry run: a request the library refuses (NO_CHAPTER_GAP) is still an error, and writes nothing', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  const gap = await post(port, u(BOOK, 'chapters'), { act: 1, after: 1, title: 'Interlude', dryRun: true });
  assert.ok(gap.status === 400 || gap.status === 409, gap.text);
  assert.equal(gap.json.code, 'NO_CHAPTER_GAP');
  assert.deepEqual(await state(root), before);
});

// ---------------------------------------------------------------- real runs refused by the library

test('NO_CHAPTER_GAP comes back as a 4xx with the code, and nothing is written', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  const r = await post(port, u(BOOK, 'chapters'), { act: 1, after: 1, title: 'Interlude' });
  assert.ok(r.status === 400 || r.status === 409, r.text);
  assert.equal(r.json.code, 'NO_CHAPTER_GAP');
  assert.deepEqual(await state(root), before);
});

test('BAD_SPLIT_POINT comes back as a 4xx with the code, and nothing is written', async () => {
  const MID = 'scene_01S50000000000000000000011';
  const { root, port } = await fresh(async (r) => {
    await fs.writeFile(
      path.join(r, 'manuscript', 'act-02-high-water', 'ch-003-the-wall', '0012-commented.md'),
      `---
schema: storyforge.scene/v1
id: ${MID}
title: Commented
act: 2
chapter: 3
sequence: 12
status: drafting
---
One.
<!--
hidden
still hidden
-->
Two.
`,
    );
  });
  const before = await state(root);
  const r = await post(port, u(BOOK, `scenes/${MID}/split`), { atLine: 4 });
  assert.ok(r.status === 400 || r.status === 409, r.text);
  assert.equal(r.json.code, 'BAD_SPLIT_POINT');
  const dry = await post(port, u(BOOK, `scenes/${MID}/split`), { atLine: 4, dryRun: true });
  assert.equal(dry.json.code, 'BAD_SPLIT_POINT');
  assert.deepEqual(await state(root), before);
  const ok = await post(port, u(BOOK, `scenes/${MID}/split`), { atLine: 6 });
  assert.equal(ok.status, 200, ok.text);
});

test('malformed bodies are 400 and write nothing', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  for (const route of ROUTES) {
    for (const body of ['{not json', '[]', '"str"', 'null']) {
      const r = await send(port, 'POST', route.url(BOOK), { body });
      assert.equal(r.status, 400, `${route.name} ${body}: ${r.text}`);
    }
  }
  assert.deepEqual(await state(root), before);
});

test('wrongly typed fields are refused (4xx) and write nothing', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  const cases = [
    [u(BOOK, `scenes/${KEY}/fields`), { title: 123 }],
    [u(BOOK, `scenes/${KEY}/fields`), { status: 'done' }],
    [u(BOOK, `scenes/${KEY}/split`), { atLine: 'three' }],
    [u(BOOK, 'chapters'), { act: 'two', after: 3, title: 'x' }],
    [u(BOOK, 'chapters'), { act: 2, after: 3, title: 7 }],
    [u(BOOK, 'chapters/1/fields'), { title: ['a'] }],
    [u(BOOK, 'acts'), { title: {} }],
    [u(BOOK, 'acts/1/fields'), { title: 'a\nb' }],
  ];
  for (const [url, body] of cases) {
    const r = await post(port, url, body);
    assert.ok(r.status >= 400 && r.status < 500, `${url} ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
  }
  assert.deepEqual(await state(root), before);
});

test('merge of non-adjacent / cross-chapter scenes is refused (4xx) and writes nothing', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  for (const [a, b] of [[KEY, FERRY], [GRAFTING, LOWTIDE], [ARRIVAL, ARRIVAL]]) {
    const r = await post(port, u(BOOK, 'scenes/merge'), mergeBody(a, b));
    assert.ok(r.status === 400 || r.status === 409, `${a} + ${b}: ${r.status} ${r.text}`);
  }
  assert.deepEqual(await state(root), before);
});

test('after a real structure write the next GET shows it (rename a scene, then read the tree)', async () => {
  const { port } = await fresh();
  const r = await post(port, u(BOOK, `scenes/${KEY}/fields`), { title: 'The Brass Key', status: 'revised' });
  assert.equal(r.status, 200, r.text);
  const book = (await request(port, 'GET', `/api/books/${BOOK}`)).json;
  const scene = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).find((s) => s.id === KEY);
  assert.equal(scene.title, 'The Brass Key');
  assert.equal(scene.status, 'revised');
});

test('chapter / act creation shows up in the tree with the next number', async () => {
  const { port } = await fresh();
  assert.ok([200, 201].includes((await post(port, u(BOOK, 'chapters'), { act: 2, after: 3, title: 'Aftermath' })).status));
  const book = (await request(port, 'GET', `/api/books/${BOOK}`)).json;
  const act2 = book.acts.find((a) => a.act === 2);
  assert.deepEqual(act2.chapters.map((c) => c.chapter), [3, 4]);
  assert.equal(act2.chapters[1].title, 'Aftermath');
});

// ---------------------------------------------------------------- acceptance 9: guards

for (const route of ROUTES) {
  test(`guards: POST ${route.name} is 403 without x-storyforge, with a wrong content-type, or with a foreign Host; nothing is written`, async () => {
    const { root, port } = await freshFor(route);
    const before = await state(root);
    const url = route.url(BOOK);
    const noHeader = await post(port, url, route.body, { headers: { 'content-type': 'application/json' } });
    assert.equal(noHeader.status, 403, noHeader.text);
    const noHeaderDry = await post(port, url, { ...route.body, dryRun: true }, { headers: { 'content-type': 'application/json' } });
    assert.equal(noHeaderDry.status, 403, 'a dry run is guarded too');
    const wrongType = await post(port, url, route.body, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' } });
    assert.equal(wrongType.status, 403, wrongType.text);
    const evil = await post(port, url, route.body, { host: 'evil.example' });
    assert.equal(evil.status, 403, evil.text);
    assert.deepEqual(await state(root), before);
  });

  test(`guards: POST ${route.name} on an unknown book is 404`, async () => {
    const { root, port } = await fresh();
    const before = await state(root);
    const r = await post(port, route.url(UNKNOWN_BOOK), route.body);
    assert.equal(r.status, 404, r.text);
    const dry = await post(port, route.url(UNKNOWN_BOOK), { ...route.body, dryRun: true });
    assert.equal(dry.status, 404, 'also for a dry run');
    assert.deepEqual(await state(root), before);
  });
}

for (const route of ROUTES.filter((r) => r.scene || r.unknownScene)) {
  test(`guards: POST ${route.name} on an unknown scene is 404 and writes nothing`, async () => {
    const { root, port } = await fresh();
    const before = await state(root);
    const url = route.scene ? route.url(BOOK, UNKNOWN_SCENE) : route.url(BOOK);
    const body = route.scene ? route.body : route.unknownScene;
    const r = await post(port, url, body);
    assert.equal(r.status, 404, r.text);
    const dry = await post(port, url, { ...body, dryRun: true });
    assert.equal(dry.status, 404, 'also for a dry run');
    assert.deepEqual(await state(root), before);
  });
}

test('guards: merge with the second scene unknown is also 404', async () => {
  const { port } = await fresh();
  const r = await post(port, u(BOOK, 'scenes/merge'), mergeBody(ARRIVAL, UNKNOWN_SCENE));
  assert.equal(r.status, 404, r.text);
});

test('guards: unknown chapter / act numbers are refused with a 4xx and nothing is written', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  for (const [url, body] of [
    [u(BOOK, 'chapters/42/fields'), { title: 'x' }],
    [u(BOOK, 'chapters/42/archive'), {}],
    [u(BOOK, 'acts/42/fields'), { title: 'x' }],
  ]) {
    const r = await post(port, url, body);
    assert.ok(r.status >= 400 && r.status < 500, `${url}: ${r.status} ${r.text}`);
  }
  assert.deepEqual(await state(root), before);
});

test('guards: GET on a structure route is not served (405 or 404, never 200) and writes nothing', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  for (const route of ROUTES) {
    const r = await request(port, 'GET', route.url(BOOK));
    assert.ok(r.status === 404 || r.status === 405, `${route.name}: ${r.status}`);
  }
  assert.deepEqual(await state(root), before);
});

test('guards: a 6 MB body to a structure route is 413 and nothing is written', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  const r = await send(port, 'POST', u(BOOK, 'acts'), { body: JSON.stringify({ title: 'x'.repeat(6 * 1024 * 1024) }) }).catch((e) => ({ status: e.code }));
  assert.ok(r.status === 413 || r.status === 'ECONNRESET' || r.status === 'EPIPE', String(r.status));
  assert.deepEqual(await state(root), before);
});

// ---------------------------------------------------------------- undo route

const restoreUrl = (b, opId) => u(b, `ops/${encodeURIComponent(opId)}/restore`);
const keyPath = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md';

test('undo: rename a scene, POST ops/:opId/restore, and the files are byte-identical again', async () => {
  const { root, port } = await fresh();
  const before = await snapshot(root, { skipStoryforge: true });
  const r = await post(port, u(BOOK, `scenes/${KEY}/fields`), { title: 'Undo Me' });
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.opId, 'string', 'the write result carries the op id');
  assert.notDeepEqual(await snapshot(root, { skipStoryforge: true }), before);
  const undo = await post(port, restoreUrl(BOOK, r.json.opId), {});
  assert.equal(undo.status, 200, undo.text);
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before, 'byte-identical to before the rename');
  const book = (await request(port, 'GET', `/api/books/${BOOK}`)).json;
  assert.equal(book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).find((s) => s.id === KEY).title, 'The Key');
});

test('undo: after an external edit the restore is refused with 409 and a reason, and the edit is kept', async () => {
  const { root, port } = await fresh();
  const r = await post(port, u(BOOK, `scenes/${KEY}/fields`), { title: 'Undo Me' });
  const file = path.join(root, ...keyPath.split('/'));
  await fs.appendFile(file, '\nAn external edit.\n');
  const before = await state(root);
  const undo = await post(port, restoreUrl(BOOK, r.json.opId), {});
  assert.equal(undo.status, 409, undo.text);
  assert.ok(undo.json.message || undo.json.code, 'says why');
  assert.deepEqual(await state(root), before, 'nothing written');
  assert.ok((await fs.readFile(file, 'utf8')).endsWith('An external edit.\n'));
});

test('undo: dry run writes nothing; 403 without the guard header (also wrong type, foreign Host); 404 unknown book; unknown op refused', async () => {
  const { root, port } = await fresh();
  const r = await post(port, u(BOOK, `scenes/${KEY}/fields`), { title: 'Undo Me' });
  const url = restoreUrl(BOOK, r.json.opId);
  const before = await state(root);
  const dry = await post(port, url, { dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.ok(dry.json.changes.length > 0);
  assert.deepEqual(await state(root), before);
  assert.equal((await post(port, url, {}, { headers: { 'content-type': 'application/json' } })).status, 403);
  assert.equal((await post(port, url, {}, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' } })).status, 403);
  assert.equal((await post(port, url, {}, { host: 'evil.example' })).status, 403);
  assert.equal((await post(port, restoreUrl(UNKNOWN_BOOK, r.json.opId), {})).status, 404);
  for (const op of ['20990101T000000000Z-ZZZZZZ', '..%2F..%2Fbook.md']) {
    const bad = await post(port, `/api/books/${BOOK}/ops/${op}/restore`, {});
    assert.ok(bad.status >= 400 && bad.status < 500, `${op}: ${bad.status}`);
  }
  assert.deepEqual(await state(root), before, 'nothing written by any of them');
});

// ---------------------------------------------------------------- bulk restore of archived scenes

test('scenes restore: archived scenes come back in one operation, a dry run writes nothing, one Undo archives them again', async () => {
  const { root, port } = await fresh();
  const a = await post(port, u(BOOK, 'scenes/archive'), { scenes: [ARRIVAL, KEY, LOWTIDE] });
  assert.equal(a.status, 200, a.text);
  const archivedPaths = a.json.changes.map((c) => c.to);
  const live = await snapshot(root, { skipStoryforge: true });

  const dry = await post(port, u(BOOK, 'scenes/restore'), { paths: archivedPaths.slice(0, 2), dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.changes.length, 2);
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), live, 'dry run wrote nothing');

  const r = await post(port, u(BOOK, 'scenes/restore'), { paths: archivedPaths.slice(0, 2) });
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.opId, 'string');
  for (const c of r.json.changes) {
    assert.ok(await fs.stat(path.join(root, c.to)).then(() => true, () => false), `${c.to} is back`);
    assert.equal(await fs.stat(path.join(root, c.from)).then(() => true, () => false), false, `${c.from} left the archive`);
  }
  assert.ok(await fs.stat(path.join(root, archivedPaths[2])).then(() => true, () => false), 'the one not chosen stays archived');

  const undo = await post(port, u(BOOK, `ops/${r.json.opId}/restore`), {});
  assert.equal(undo.status, 200, undo.text);
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), live, 'one Undo puts both back in the archive');
});

test('scenes restore: a path that is not an archived scene is refused and nothing is written; bad bodies are 400; 403 without the guard header', async () => {
  const { root, port } = await fresh();
  const before = await state(root);
  const unknown = await post(port, u(BOOK, 'scenes/restore'), { paths: ['archive/manuscript/nope.md'] });
  assert.equal(unknown.status, 404, unknown.text); // like every structure route: an unknown scene is 404
  for (const body of [{}, { paths: [] }, { paths: [1] }, { paths: 'x' }]) {
    const r = await post(port, u(BOOK, 'scenes/restore'), body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const noGuard = await post(port, u(BOOK, 'scenes/restore'), { paths: ['archive/x.md'] }, { headers: { 'content-type': 'application/json' } });
  assert.equal(noGuard.status, 403);
  assert.deepEqual(await state(root), before);
});
