import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { importLibrary, materialize } from '../src/index.mjs';
import { copyFixture, fileSet, hashTree, openStore, removeDir, tempDir } from './helpers.mjs';

const BOOK = 'saltmarsh/salt-orchard';
const SCENE = 'scene_01S50000000000000000000003';

async function imported() {
  const fx = await copyFixture();
  const s = await openStore();
  const r = await importLibrary({ store: s.store, source: fx.dir, sharedData: fx.sharedData, dryRun: false });
  assert.equal(r.ok, true);
  return { ...s, fx };
}

/** What the database says the folder should hold: library files, folder markers and restore points. */
async function wanted(store) {
  const want = new Map();
  for (const [p, sha] of Object.entries(await fileSet(store))) want.set(p, sha === 'dir' ? 'dir' : sha);
  return want;
}

test('an empty folder becomes a full copy of the database', async () => {
  const { store, close, fx } = await imported();
  const dir = await tempDir();
  try {
    await store.applyOp({ opId: 'op-dir', op: 'test', files: [], dirs: { add: ['saltmarsh/salt-orchard/empty-dir/'] } });
    const r = await materialize({ store, dir });
    const files = (await store.listFiles()).filter((f) => !f.path.endsWith('/')).length;
    assert.equal(r.removed, 0);
    assert.equal(r.unchanged, 0);
    assert.equal(r.written, files + 1 + 4 + 1); // files, the empty folder, 4 restore points, their index.json
    const tree = await hashTree(dir);
    for (const [p, sha] of await wanted(store)) assert.equal(tree.get(p), sha, p);
    assert.ok(tree.has(`${BOOK}/.storyforge/revisions/${SCENE}/index.json`));
    for (const f of (await store.listRevisions())) assert.ok(tree.has(`${f.book_path}/.storyforge/revisions/${f.scene_id}/${f.file}`));
    // a second run changes nothing
    const again = await materialize({ store, dir });
    assert.deepEqual([again.written, again.removed], [0, 0]);
    assert.equal(again.unchanged, files + 4 + 1);
  } finally {
    await close();
    await removeDir(fx.dir);
    await removeDir(dir);
  }
});

test('edited, added and deleted files are put right; .storyforge caches are left alone', async () => {
  const { store, close, fx } = await imported();
  const dir = await tempDir();
  try {
    await materialize({ store, dir });
    const clean = await hashTree(dir);

    const edited = path.join(dir, 'library.md');
    const deleted = path.join(dir, BOOK, 'book.md');
    await writeFile(edited, 'changed outside the app');
    await rm(deleted);
    await writeFile(path.join(dir, 'stray.md'), 'not in the database');
    await mkdir(path.join(dir, BOOK, 'stray-dir', 'deeper'), { recursive: true });
    await writeFile(path.join(dir, BOOK, 'stray-dir', 'deeper', 'x.md'), 'x');
    await mkdir(path.join(dir, 'stray-empty'), { recursive: true });
    // caches: an index file next to the restore points, and one that is not under revisions/ at all
    const cache = path.join(dir, BOOK, '.storyforge', 'index.sqlite');
    const cacheBytes = Buffer.from('disposable cache');
    await writeFile(cache, cacheBytes);
    await writeFile(path.join(dir, '.storyforge-lock'), 'pid');
    // inside revisions/: a stray file and a stray scene folder go; a damaged restore point is restored
    await writeFile(path.join(dir, BOOK, '.storyforge', 'revisions', SCENE, 'stray.md'), 'x');
    await mkdir(path.join(dir, BOOK, '.storyforge', 'revisions', 'scene_stray'), { recursive: true });
    await writeFile(path.join(dir, BOOK, '.storyforge', 'revisions', SCENE, '20261105T120000Z-autosave.md'), 'damaged');

    const r = await materialize({ store, dir });
    assert.equal(r.written, 3); // library.md, book.md, the damaged restore point
    assert.ok(r.removed >= 4); // stray.md, x.md, stray revision file, plus the stray folders
    const after = await hashTree(dir);
    for (const [p, sha] of clean) assert.equal(after.get(p), sha, p);
    for (const p of after.keys()) assert.ok(clean.has(p) || p === `${BOOK}/.storyforge/index.sqlite` || p === '.storyforge-lock', `unexpected ${p}`);
    assert.deepEqual(await readFile(cache), cacheBytes);
    assert.equal(await readFile(path.join(dir, '.storyforge-lock'), 'utf8'), 'pid');
  } finally {
    await close();
    await removeDir(fx.dir);
    await removeDir(dir);
  }
});

test('a file where a folder belongs, and a folder where a file belongs, are replaced', async () => {
  const { store, close, fx } = await imported();
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, 'library.md', 'inside'), { recursive: true });
    await writeFile(path.join(dir, 'library.md', 'inside', 'a.txt'), 'a');
    await writeFile(path.join(dir, 'saltmarsh'), 'a file where the series folder belongs');
    await materialize({ store, dir });
    const tree = await hashTree(dir);
    for (const [p, sha] of await wanted(store)) assert.equal(tree.get(p), sha, p);
    assert.ok(![...tree.keys()].some((k) => k.startsWith('library.md/')));
  } finally {
    await close();
    await removeDir(fx.dir);
    await removeDir(dir);
  }
});

test('shared documents: written into sharedDir, audit.jsonl as lines joined with a trailing newline, extras removed', async () => {
  const { store, close, fx } = await imported();
  const dir = await tempDir();
  const sharedDir = await tempDir();
  try {
    await writeFile(path.join(sharedDir, 'users.json'), '{}');
    await writeFile(path.join(sharedDir, 'extra.json'), '{}');
    const r = await materialize({ store, dir, sharedDir });
    assert.equal(r.shared.removed, 1);
    const lines = await store.readSharedLines('audit.jsonl');
    assert.equal(await readFile(path.join(sharedDir, 'audit.jsonl'), 'utf8'), `${lines.join('\n')}\n`);
    const src = await hashTree(fx.sharedData);
    const back = await hashTree(sharedDir);
    for (const name of ['audit.jsonl', 'users.json', 'members.json']) assert.equal(back.get(name), src.get(name), name);
    assert.ok(!back.has('extra.json'));
    const again = await materialize({ store, dir, sharedDir });
    assert.deepEqual([again.shared.written, again.shared.removed], [0, 0]);
  } finally {
    await close();
    await removeDir(fx.dir);
    await removeDir(dir);
    await removeDir(sharedDir);
  }
});
