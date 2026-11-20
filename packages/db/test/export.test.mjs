import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validate } from '@storyforge/format';
import { exportLibrary, importLibrary } from '../src/index.mjs';
import { copyFixture, expected, fileSet, hashTree, openStore, removeDir, tempDir } from './helpers.mjs';

const revisionSet = async (store) => (await store.listRevisions()).map((r) => `${r.book_path}|${r.scene_id}|${r.file}`);

test('import then export: the folder passes validate() with the same diagnostics as the source', async () => {
  const fx = await copyFixture();
  const { store, close } = await openStore();
  const out = await tempDir();
  const sharedOut = await tempDir();
  try {
    assert.equal((await importLibrary({ store, source: fx.dir, sharedData: fx.sharedData, dryRun: false })).ok, true);
    const r = await exportLibrary({ store, out: path.join(out, 'lib'), sharedOut: path.join(sharedOut, 'shared') });
    assert.equal(r.ok, true);
    assert.equal(r.revisions, 4);
    assert.ok(r.files > 50);
    assert.ok(r.shared_documents >= 10);

    const src = await validate(fx.dir);
    const exported = await validate(path.join(out, 'lib'));
    assert.deepEqual(exported.diagnostics, src.diagnostics);
    assert.deepEqual(exported.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code), ['E301']); // the fixture's only error
    assert.deepEqual(exported.books.map((b) => [b.id, b.order.map((o) => o.id)]), src.books.map((b) => [b.id, b.order.map((o) => o.id)]));
    for (const book of expected.books) assert.ok(exported.books.some((b) => b.id === book.id));

    // restore points come back under .storyforge/revisions with an index.json the store can read
    const dir = path.join(out, 'lib', 'saltmarsh', 'salt-orchard', '.storyforge', 'revisions', 'scene_01S50000000000000000000003');
    const index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8'));
    assert.deepEqual(index.map((e) => e.file), expected.restore_points.scene_01S50000000000000000000003.kept_files);
    assert.ok(index.every((e) => /^\d{8}T\d{6}Z-[a-z]+\.md$/.test(e.file) && e.at && e.reason && e.sha256 && Number.isInteger(e.words)));
    assert.equal(index.find((e) => e.file === '20261102T081500Z-manual.md').label, 'First pass');

    // shared documents: byte-identical, audit log lines joined with a trailing newline
    const sharedSrc = await hashTree(fx.sharedData);
    const sharedBack = await hashTree(path.join(sharedOut, 'shared'));
    for (const name of ['audit.jsonl', 'members.json', 'users.json']) assert.equal(sharedBack.get(name), sharedSrc.get(name), name);
  } finally {
    await close();
    await removeDir(fx.dir);
    await removeDir(out);
    await removeDir(sharedOut);
  }
});

test('export, then re-import into a fresh database: identical rows and the same fingerprint', async () => {
  const fx = await copyFixture();
  const a = await openStore();
  const b = await openStore();
  const out = await tempDir();
  const sharedOut = await tempDir();
  try {
    const first = await importLibrary({ store: a.store, source: fx.dir, sharedData: fx.sharedData, dryRun: false });
    assert.equal(first.ok, true);
    assert.equal((await exportLibrary({ store: a.store, out: path.join(out, 'lib'), sharedOut: path.join(sharedOut, 's') })).ok, true);

    const second = await importLibrary({ store: b.store, source: path.join(out, 'lib'), sharedData: path.join(sharedOut, 's'), dryRun: false });
    assert.equal(second.ok, true, JSON.stringify(second.code));
    assert.equal(second.report.fingerprint, first.report.fingerprint);
    assert.deepEqual(await fileSet(b.store), await fileSet(a.store));
    assert.deepEqual(await revisionSet(b.store), await revisionSet(a.store));
    assert.deepEqual(await b.store.readSharedLines('audit.jsonl'), await a.store.readSharedLines('audit.jsonl'));
    assert.deepEqual(await b.store.listShared(), await a.store.listShared());
  } finally {
    await a.close();
    await b.close();
    await removeDir(fx.dir);
    await removeDir(out);
    await removeDir(sharedOut);
  }
});

test('export refuses a folder that exists and is not empty, and accepts an empty one; empty folders are exported', async () => {
  const fx = await copyFixture();
  const { store, close } = await openStore();
  const out = await tempDir();
  try {
    await mkdir(path.join(fx.dir, 'saltmarsh', 'salt-orchard', 'empty-dir'), { recursive: true });
    assert.equal((await importLibrary({ store, source: fx.dir, sharedData: fx.sharedData, dryRun: false })).ok, true);

    await writeFile(path.join(out, 'already-here.txt'), 'x');
    const refused = await exportLibrary({ store, out });
    assert.deepEqual(refused, { ok: false, code: 'OUT_NOT_EMPTY', path: path.resolve(out) });
    assert.deepEqual([...(await hashTree(out)).keys()], ['already-here.txt']);

    const empty = await tempDir();
    try {
      const ok = await exportLibrary({ store, out: empty });
      assert.equal(ok.ok, true);
      assert.equal(ok.empty_folders, 1);
      assert.equal((await hashTree(empty)).get('saltmarsh/salt-orchard/empty-dir/'), 'dir');
    } finally {
      await removeDir(empty);
    }
  } finally {
    await close();
    await removeDir(fx.dir);
    await removeDir(out);
  }
});
