// M01-J04 acceptance 6 (repair via routes) plus the GET /api/status shape and the write guard.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };
const ACT1 = 'manuscript/act-01-low-water';
const FERRY_REL = `${ACT1}/ch-002-the-grafting/0010-ferry.md`;
const MISFILED_REL = `${ACT1}/ch-001-the-drowned-rows/0030-ferry.md`;
const WALL_REL = 'manuscript/act-02-high-water/ch-003-the-wall/0020-the-wall.md';

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

async function waitFor(fn, { timeout = 5000, interval = 50, what = 'condition' } = {}) {
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
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function fresh() {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root, { debounceMs: 50, pollMs: 60000 });
  const server = createServer({ repository: repo });
  cleanups.push(async () => {
    await close(server);
    await repo.close();
  });
  const port = await listen(server);
  await repo.rebuildIndex();
  await waitFor(async () => (await status(port)).json.books[0]?.index === 'fresh', { what: 'fresh index' });
  return { root, repo, port };
}

const status = (port) => request(port, 'GET', '/api/status');

function post(port, pathname, body, headers = GOOD) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: pathname, headers: { Host: `127.0.0.1:${port}`, 'content-length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Text after the front matter (the scene "body"), or the whole text if there is none. */
function bodyOf(text) {
  const lines = text.split('\n');
  if (lines[0].replace(/\r$/, '') !== '---') return text;
  for (let i = 1; i < lines.length; i++) if (lines[i].replace(/\r$/, '') === '---') return lines.slice(i + 1).join('\n');
  return text;
}

async function mdFiles(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await mdFiles(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

test('GET /api/status has the documented shape', async () => {
  const { port } = await fresh();
  const r = await status(port);
  assert.equal(r.status, 200);
  const s = r.json;
  assert.equal(typeof s.instance.pid, 'number');
  assert.equal(typeof s.instance.started_at, 'string');
  assert.equal(typeof s.instance.lock, 'string');
  assert.ok(['watch', 'poll'].includes(s.watch.mode), `mode: ${s.watch.mode}`);
  assert.ok('reason' in s.watch);
  assert.ok('last_event_at' in s.watch);
  assert.equal(typeof s.watch.pending, 'number');
  assert.ok(Array.isArray(s.books));
  assert.equal(s.books.length, 1);
  const b = s.books[0];
  assert.equal(b.book_id, BOOK);
  assert.equal(typeof b.title, 'string');
  assert.ok(['fresh', 'stale', 'building', 'invalid', 'missing', 'error'].includes(b.index));
  assert.equal(b.index, 'fresh');
  assert.deepEqual(b.invalid_paths, []);
  assert.equal(typeof b.errors, 'number');
  assert.equal(typeof b.warnings, 'number');
  assert.ok('last_reconciled_at' in b);
  assert.ok(Array.isArray(s.recover.needsAttention));
  assert.ok(Array.isArray(s.recover.rolledBack));
});

test('6. repair: plan lists one rename and one renumber; applying them returns the book to fresh without losing a body', async () => {
  const { root, port, repo } = await fresh();
  const originalBodies = new Map();
  for (const f of await mdFiles(path.join(root, 'manuscript'))) {
    if (!/\/\d{4}-[^/]+\.md$/.test(f.split(path.sep).join('/'))) continue;
    originalBodies.set(path.relative(root, f).split(path.sep).join('/'), bodyOf(await fs.readFile(f, 'utf8')));
  }
  assert.ok(originalBodies.size >= 8);

  // misfile a scene (W201/W202) and duplicate a sequence (E204), both with plain fs
  await fs.rename(path.join(root, ...FERRY_REL.split('/')), path.join(root, ...MISFILED_REL.split('/')));
  const wall = path.join(root, ...WALL_REL.split('/'));
  await fs.writeFile(wall, (await fs.readFile(wall, 'utf8')).replace('sequence: 20', 'sequence: 10'));
  await waitFor(async () => (await status(port)).json.books[0].index === 'invalid', { what: 'status invalid' });

  const beforePlan = await snapshot(root, { skipStoryforge: true });
  const planRes = await request(port, 'GET', `/api/books/${BOOK}/repair/plan`);
  assert.equal(planRes.status, 200, planRes.text);
  const actions = planRes.json.actions;
  assert.equal(actions.filter((a) => a.kind === 'rename').length, 1, JSON.stringify(actions));
  assert.equal(actions.filter((a) => a.kind === 'renumber').length, 1, JSON.stringify(actions));
  assert.equal(actions.length, 2);
  const rename = actions.find((a) => a.kind === 'rename');
  assert.equal(rename.from, MISFILED_REL);
  assert.equal(rename.to, FERRY_REL);
  assert.equal(actions.find((a) => a.kind === 'renumber').chapter, 3);
  assert.ok(Array.isArray(planRes.json.unrepairable));

  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), beforePlan, 'planning writes nothing');

  const applied = await post(port, `/api/books/${BOOK}/repair`, { actions });
  assert.equal(applied.status, 200, applied.text);

  await waitFor(async () => (await status(port)).json.books[0].index === 'fresh', { what: 'status fresh after repair' });
  const diags = await repo.getDiagnostics(BOOK);
  assert.deepEqual(diags.filter((d) => ['W201', 'W202', 'E204'].includes(d.code)), []);

  // every original body is still in the book or in the trash
  const present = new Set();
  for (const f of await mdFiles(root)) present.add(bodyOf(await fs.readFile(f, 'utf8')));
  for (const [rel, body] of originalBodies) assert.ok(present.has(body), `body of ${rel} survives (in the book or .storyforge/trash)`);
});

test('6b. applying a subset applies exactly those actions', async () => {
  const { root, port } = await fresh();
  await fs.rename(path.join(root, ...FERRY_REL.split('/')), path.join(root, ...MISFILED_REL.split('/')));
  await waitFor(async () => (await repo_diags(port)).some((d) => d.code === 'W201' || d.code === 'W202'), { what: 'misfile visible' });
  const plan = (await request(port, 'GET', `/api/books/${BOOK}/repair/plan`)).json;
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, 'rename');
  const r = await post(port, `/api/books/${BOOK}/repair`, { actions: [] });
  assert.equal(r.status, 200, r.text);
  await fs.access(path.join(root, ...MISFILED_REL.split('/')));
  await assert.rejects(fs.access(path.join(root, ...FERRY_REL.split('/'))), 'nothing renamed when no action was confirmed');
});

async function repo_diags(port) {
  return (await request(port, 'GET', `/api/books/${BOOK}/diagnostics`)).json;
}

test('POST repair without the x-storyforge header is 403 and changes nothing', async () => {
  const { root, port } = await fresh();
  await fs.rename(path.join(root, ...FERRY_REL.split('/')), path.join(root, ...MISFILED_REL.split('/')));
  const before = await snapshot(root, { skipStoryforge: true });
  for (const headers of [{ 'content-type': 'application/json' }, {}, { 'x-storyforge': '1' }]) {
    const r = await post(port, `/api/books/${BOOK}/repair`, { actions: [{ kind: 'rename', from: MISFILED_REL, to: FERRY_REL }] }, headers);
    assert.equal(r.status, 403, r.text);
  }
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

test('GET repair/plan on an unknown book is 404', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', '/api/books/book_00000000000000000000000000/repair/plan');
  assert.equal(r.status, 404);
});

test('POST /api/index/rebuild clears invalid once the files are valid again', async () => {
  const { root, port } = await fresh();
  const file = path.join(root, ...WALL_REL.split('/'));
  const original = await fs.readFile(file);
  await fs.writeFile(file, original.toString('utf8').replace(/^title:.*$/m, 'title: [unclosed'));
  await waitFor(async () => (await status(port)).json.books[0].index === 'invalid', { what: 'status invalid' });
  await fs.writeFile(file, original);
  const r = await post(port, '/api/index/rebuild', {});
  assert.equal(r.status, 200, r.text);
  await waitFor(async () => (await status(port)).json.books[0].index === 'fresh', { what: 'status fresh after rebuild' });
});
