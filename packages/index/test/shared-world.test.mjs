// M07-J01 section 8 acceptance: the tidewater library (a series shared world, cross-book links, labels, typed fields).
// Every book's index is rebuilt from nothing and its graph is compared, node owner by node owner and edge by edge,
// with tools/canon-check/resolve.mjs: a second implementation of the rules that shares no code with the validator.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../format/src/index.mjs';
import { openStore } from '../../store/src/index.mjs';
import { buildGraph, openIndex } from '../src/index.mjs';
import { FIXTURES } from './helpers.mjs';
import { resolveLibrary } from '../../../tools/canon-check/resolve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER = path.resolve(HERE, '../../../tools/canon-check/resolve.mjs');
const temps = [];
after(async () => {
  for (const t of temps) await fs.rm(t, { recursive: true, force: true });
});

async function copyLibrary() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-world-'));
  temps.push(base);
  const lib = path.join(base, 'tidewater-lib');
  await fs.cp(path.join(FIXTURES, 'valid/tidewater'), lib, { recursive: true });
  return lib;
}

async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

async function deleteStoryforgeDirs(lib) {
  for (const f of await walk(lib)) {
    const at = f.split(path.sep).indexOf('.storyforge');
    if (at >= 0) await fs.rm(f.split(path.sep).slice(0, at + 1).join(path.sep), { recursive: true, force: true });
  }
  // folders left empty are removed too, so nothing of an old index is left
  for (const dirPath of [lib, ...(await fs.readdir(lib, { recursive: true })).map((r) => path.join(lib, r))]) {
    if (path.basename(dirPath) === '.storyforge') await fs.rm(dirPath, { recursive: true, force: true });
  }
}

const BOOKS = ['tidewater/salt-orchard-2', 'tidewater/low-tide', 'pilgrims-road'];

/** Rebuild every book's index of a library from its files; returns { path -> { idx, graph, summary } }. */
async function rebuildAll(lib) {
  const out = {};
  for (const bookPath of BOOKS) {
    const bookRoot = path.join(lib, ...bookPath.split('/'));
    const store = await openStore(bookRoot);
    const idx = openIndex(bookRoot, { store, libraryRoot: lib });
    const r = await idx.rebuild();
    assert.ok(r.ok, `${bookPath}: ${r.message}`);
    out[bookPath] = { idx, store, graph: idx.query.graph(), summary: idx.query.bookSummary() };
  }
  return out;
}

const edgeKey = (e) => `${e.from} > ${e.to}`;

/** The graph of one book against the independent resolver's output. */
function checkAgainstResolver(all, resolved) {
  const slugOfBookId = new Map(Object.values(all).map((b) => [b.summary.id, b.summary.slug]));
  for (const [bookPath, b] of Object.entries(all)) {
    const { nodes, edges } = b.graph;
    const ids = new Set(nodes.map((n) => n.id));
    for (const n of nodes) {
      const expected = resolved.owners[n.id];
      assert.ok(expected, `${bookPath}: the resolver knows ${n.id}`);
      let got;
      if (n.owner === 'series') got = `series:${b.summary.series}`;
      else if (n.external) got = `book:${slugOfBookId.get(n.book_id)}`;
      else got = `book:${b.summary.slug}`;
      assert.equal(got, expected, `${bookPath}: owner of ${n.id}`);
    }
    // every explicit edge is one the resolver found, and every resolver link between two nodes of this graph is an edge
    const fromResolver = new Set(
      resolved.links
        .filter((l) => l.to_id && l.from_id !== l.to_id && ids.has(l.from_id) && ids.has(l.to_id) && !nodes.find((n) => n.id === l.from_id).external)
        .map((l) => `${l.from_id} > ${l.to_id}`),
    );
    const explicit = new Set(edges.filter((e) => e.kind === 'explicit').map(edgeKey));
    assert.deepEqual([...explicit].sort(), [...fromResolver].sort(), `${bookPath}: explicit edges`);
  }
}

test('tidewater: indexes rebuilt from nothing agree with the independent resolver, twice', async () => {
  const lib = await copyLibrary();
  await deleteStoryforgeDirs(lib);
  const resolved = resolveLibrary(lib);

  const first = await rebuildAll(lib);
  checkAgainstResolver(first, resolved);

  // ilse-hollis is one file, one id, and both books of the series have an edge to it
  const files = (await walk(lib)).filter((f) => path.basename(f) === 'ilse-hollis.md');
  assert.equal(files.length, 1);
  const ilse = /^id: (.+)$/m.exec(await fs.readFile(files[0], 'utf8'))[1];
  assert.equal(resolved.owners[ilse], 'series:tidewater');
  for (const bookPath of ['tidewater/salt-orchard-2', 'tidewater/low-tide']) {
    const { nodes, edges } = first[bookPath].graph;
    assert.equal(nodes.filter((n) => n.id === ilse).length, 1);
    assert.deepEqual(nodes.find((n) => n.id === ilse), { id: ilse, kind: 'entry', type: 'character', name: 'Ilse Hollis', owner: 'series', series_id: nodes.find((n) => n.id === ilse).series_id, path: 'tidewater/codex/characters/ilse-hollis.md' });
    assert.ok(edges.some((e) => e.to === ilse && e.from.startsWith('scene_') && e.kind === 'explicit'), `${bookPath} links to ilse-hollis`);
  }

  // delete every .storyforge/, rebuild: identical graph nodes and edges; then rebuild once more (steps 2, 3 and 8)
  const snapshot = Object.fromEntries(Object.entries(first).map(([p, b]) => [p, b.graph]));
  for (const b of Object.values(first)) await b.store.close?.();
  await deleteStoryforgeDirs(lib);
  const second = await rebuildAll(lib);
  assert.deepEqual(Object.fromEntries(Object.entries(second).map(([p, b]) => [p, b.graph])), snapshot);
  checkAgainstResolver(second, resolveLibrary(lib));
  const third = await rebuildAll(lib);
  assert.deepEqual(Object.fromEntries(Object.entries(third).map(([p, b]) => [p, b.graph])), snapshot);
  checkAgainstResolver(third, resolveLibrary(lib));
  for (const b of [...Object.values(second), ...Object.values(third)]) await b.store.close?.();
});

test('tidewater: the index graph equals buildGraph() over the files, shared and external nodes included', async () => {
  const lib = await copyLibrary();
  const all = await rebuildAll(lib);
  const result = await validate(lib);
  for (const [bookPath, b] of Object.entries(all)) {
    assert.deepEqual(b.graph, buildGraph(result, undefined, bookPath), bookPath);
  }
});

test('tidewater: a cross-book target is an external node with only id, kind, title and path; another book is never copied', async () => {
  const lib = await copyLibrary();
  const all = await rebuildAll(lib);
  const lowTide = all['tidewater/low-tide'];
  const thread = lowTide.graph.nodes.find((n) => n.kind === 'thread');
  assert.equal(thread.external, undefined, 'the thread is a plain node of its own book');
  const ext = all['tidewater/salt-orchard-2'].graph.nodes.find((n) => n.id === thread.id);
  assert.deepEqual(ext, {
    id: thread.id, kind: 'thread', type: null, name: 'The lost ledger', owner: 'book', book_id: lowTide.summary.id, external: true,
    path: 'tidewater/low-tide/planning/threads/the-lost-ledger.md',
  });
  const mine = all['tidewater/salt-orchard-2'].graph.nodes.filter((n) => !n.owner).map((n) => n.id);
  assert.ok(!all['tidewater/low-tide'].graph.nodes.filter((n) => !n.owner).some((n) => mine.includes(n.id)), 'no document is in two books');
  // the shared entries are not in the other book's objects table and the index counts only its own entries
  assert.equal(all['tidewater/salt-orchard-2'].idx.query.counts().entries, 2);
});

test('tidewater: a book outside the series has no shared nodes, and cannot see the shared entries', async () => {
  const lib = await copyLibrary();
  const all = await rebuildAll(lib);
  const g = all['pilgrims-road'].graph;
  assert.ok(g.nodes.every((n) => !n.owner), 'only its own nodes');
  assert.equal(all['pilgrims-road'].summary.series, null);
  const ilse = Object.entries(resolveLibrary(lib).owners).find(([, o]) => o === 'series:tidewater')[0];
  assert.ok(!g.nodes.some((n) => n.id === ilse));
  assert.equal(all['pilgrims-road'].idx.status().stale_paths.some((p) => p.startsWith('../')), false);
});

test('tidewater: editing a shared entry makes both books of the series stale, and a refresh reflects it', async () => {
  const lib = await copyLibrary();
  const all = await rebuildAll(lib);
  for (const p of BOOKS) assert.equal(all[p].idx.status().state, 'fresh', p);
  const shared = path.join(lib, 'tidewater', 'codex', 'characters', 'ilse-hollis.md');
  await fs.writeFile(shared, (await fs.readFile(shared, 'utf8')).replace('name: Ilse Hollis', 'name: Ilse Hollis-Brandt'));
  for (const p of ['tidewater/salt-orchard-2', 'tidewater/low-tide']) {
    const st = all[p].idx.status();
    assert.equal(st.state, 'stale', p);
    assert.deepEqual(st.stale_paths, ['../codex/characters/ilse-hollis.md']);
  }
  assert.equal(all['pilgrims-road'].idx.status().state, 'fresh');
  for (const p of ['tidewater/salt-orchard-2', 'tidewater/low-tide']) {
    const r = await all[p].idx.refresh();
    assert.ok(r.ok);
    assert.equal(all[p].idx.status().state, 'fresh');
    assert.ok(all[p].idx.query.graph().nodes.some((n) => n.name === 'Ilse Hollis-Brandt' && n.owner === 'series'));
  }
});

test('an index of schema_version 2 is stale and is rebuilt', async () => {
  const lib = await copyLibrary();
  const all = await rebuildAll(lib);
  const b = all['tidewater/low-tide'];
  const { DatabaseSync } = await import('node:sqlite');
  const dbFile = path.join(lib, 'tidewater', 'low-tide', '.storyforge', 'index.sqlite');
  const db = new DatabaseSync(dbFile);
  db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  db.close();
  assert.equal(b.idx.status().state, 'stale');
  assert.ok((await b.idx.rebuild()).ok);
  assert.equal(b.idx.status().state, 'fresh');
  assert.equal(b.idx.status().schema_version, 3);
});

test('the independent resolver imports nothing but yaml and node:fs / node:path, and runs as a command', async () => {
  const src = await fs.readFile(RESOLVER, 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['node:fs', 'node:path', 'yaml']);
  assert.ok(!/@storyforge/.test(src.replace(/^\/\/.*$/gm, '')), 'no workspace package is named outside comments');
  const { execFileSync } = await import('node:child_process');
  const lib = await copyLibrary();
  const printed = JSON.parse(execFileSync(process.execPath, [RESOLVER, lib], { encoding: 'utf8' }));
  assert.deepEqual(printed, JSON.parse(JSON.stringify(resolveLibrary(lib))));
  assert.ok(fsSync.existsSync(RESOLVER));
});
