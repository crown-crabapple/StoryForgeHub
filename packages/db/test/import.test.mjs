import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { validate } from '@storyforge/format';
import { importLibrary, materialize } from '../src/index.mjs';
import { copyFixture, countRows, expected, hashTree, openStore, removeDir, tempDir } from './helpers.mjs';

const opts = (store, fx, extra = {}) => ({ store, source: fx.dir, sharedData: fx.sharedData, ...extra });
const total = (rows) => Object.values(rows).reduce((a, b) => a + b, 0);

test('dry run writes nothing: the database has zero rows and the report is complete', async () => {
  const fx = await copyFixture();
  const { db, store, close } = await openStore();
  try {
    const r = await importLibrary(opts(store, fx)); // dryRun defaults to true
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(total(await countRows(db)), 0);
    const rep = r.report;
    assert.match(rep.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(rep.files > 50);
    assert.ok(rep.total_bytes > 0);
    assert.deepEqual(rep.books.map((b) => [b.id, b.path]), expected.books.map((b) => [b.id, b.path]));
    assert.ok(rep.skipped.some((s) => s.path.endsWith('.storyforge/') && /cache/.test(s.reason)));
    assert.ok(rep.skipped.some((s) => s.path.includes('shared-data')));
    // validate() diagnostics are listed per book, errors included
    const codes = Object.values(rep.diagnostics).flat().map((d) => d.code).sort();
    assert.deepEqual(codes, expected.expected_findings.map((f) => f.code).sort());
    assert.ok(rep.diagnostics['saltmarsh/salt-orchard'].some((d) => d.code === 'E301' && d.file.endsWith('0010-ferry.md')));
  } finally {
    await close();
    await removeDir(fx.dir);
  }
});

test('the report counts per schema kind match expected-import.json', async () => {
  const fx = await copyFixture();
  const { store, close } = await openStore();
  try {
    const { report } = await importLibrary(opts(store, fx));
    assert.deepEqual(report.kinds, expected.counts.documents);
    const perBook = Object.fromEntries(report.books.map((b) => [b.id, b]));
    assert.equal(perBook[expected.books[0].id].archived_scenes, expected.counts.archived_documents.scene);
    assert.equal(report.books.reduce((n, b) => n + b.scenes + b.archived_scenes, 0), expected.counts.documents.scene);
    assert.ok(Object.keys(report.categories).includes('manuscript'));
  } finally {
    await close();
    await removeDir(fx.dir);
  }
});

test('import writes everything in one operation; scene order, restore points and shared data match the manifest', async () => {
  const fx = await copyFixture();
  const { db, store, close } = await openStore();
  const copy = await tempDir();
  try {
    const r = await importLibrary(opts(store, fx, { dryRun: false, now: () => new Date('2026-11-19T12:00:00Z') }));
    assert.equal(r.ok, true, JSON.stringify(r));
    const fp16 = r.report.fingerprint.slice(0, 16);
    const ops = await store.listOps();
    assert.equal(ops.length, 1);
    assert.equal(ops[0].op, 'import');
    assert.equal(ops[0].op_id, `import-${fp16}`);
    assert.ok(ops[0].files.every((f) => f.before_sha256 === null && f.after_sha256));
    assert.equal(ops[0].files.length, r.report.files);
    assert.equal((await store.findImportReceipt(r.report.fingerprint)).report.imported_at, '2026-11-19T12:00:00.000Z');

    // scene order, derived from the imported files (materialize them and let the validator order the scenes)
    await materialize({ store, dir: copy });
    const { books } = await validate(copy);
    for (const [bookId, ids] of Object.entries(expected.scene_order)) {
      const book = books.find((b) => b.id === bookId);
      assert.ok(book, bookId);
      assert.deepEqual(book.order.map((o) => o.id), ids);
    }

    // restore points: 6 in the source, the 4 newest kept, with the index.json meta
    for (const [sceneId, want] of Object.entries(expected.restore_points)) {
      const rows = await store.listRevisions({ sceneId });
      assert.equal(rows.length, want.kept);
      assert.deepEqual(rows.map((x) => x.file), want.kept_files);
      assert.ok(rows.every((x) => x.book_path === 'saltmarsh/salt-orchard'));
      assert.equal(rows.find((x) => x.file === '20261102T081500Z-manual.md').meta.label, 'First pass');
      assert.equal(r.report.revisions.per_scene.find((s) => s.scene === sceneId).found, want.in_source);
    }
    assert.equal(r.report.revisions.found, expected.counts.other_records.revision_files);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM scene_revision')).rows[0].n), 4);

    // shared data: JSON documents as documents, audit.jsonl as lines
    assert.equal((await store.readSharedLines('audit.jsonl')).length, expected.counts.shared_data.audit_event);
    assert.deepEqual(await store.listShared(), ['audit-head.json', 'audit.jsonl', 'invites.json', 'members.json', 'oauth.json', 'plugin-tokens.json', 'sessions.json', 'settings.json', 'setup.json', 'shares.json', 'users.json', 'webhooks.json']);
    const users = JSON.parse((await store.readShared('users.json')).toString());
    assert.equal((Array.isArray(users) ? users : users.users).length, expected.counts.shared_data.user);
    assert.equal(r.report.shared_data.audit_lines['audit.jsonl'], expected.counts.shared_data.audit_event);
  } finally {
    await close();
    await removeDir(fx.dir);
    await removeDir(copy);
  }
});

test('a second import of the same folder says unchanged and writes nothing; a changed folder is refused', async () => {
  const fx = await copyFixture();
  const { db, store, close } = await openStore();
  try {
    const first = await importLibrary(opts(store, fx, { dryRun: false }));
    assert.equal(first.ok, true);
    const rows = await countRows(db);

    const again = await importLibrary(opts(store, fx, { dryRun: false }));
    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true);
    assert.equal(again.report.fingerprint, first.report.fingerprint);
    assert.deepEqual(await countRows(db), rows);
    assert.equal((await store.listOps()).length, 1);

    await writeFile(path.join(fx.dir, 'library.md'), `${(await store.readFile('library.md')).bytes.toString()}\nedited\n`);
    const changed = await importLibrary(opts(store, fx, { dryRun: false }));
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'NOT_EMPTY');
    assert.notEqual(changed.report.fingerprint, first.report.fingerprint);
    assert.deepEqual(await countRows(db), rows);
  } finally {
    await close();
    await removeDir(fx.dir);
  }
});

test('the source folder is byte-identical afterwards, for a dry run and for a real import', async () => {
  const fx = await copyFixture();
  const { store, close } = await openStore();
  try {
    const before = await hashTree(fx.dir);
    await importLibrary(opts(store, fx));
    assert.deepEqual(await hashTree(fx.dir), before);
    await importLibrary(opts(store, fx, { dryRun: false }));
    const after = await hashTree(fx.dir);
    assert.deepEqual(after, before);
    assert.ok(![...after.keys()].some((k) => k === '.storyforge/'), 'no .storyforge created at the root');
  } finally {
    await close();
    await removeDir(fx.dir);
  }
});

test('empty folders are kept as folder markers; symlinks and dot-entries are skipped', async () => {
  const fx = await copyFixture();
  const { store, close } = await openStore();
  try {
    await mkdir(path.join(fx.dir, 'saltmarsh', 'salt-orchard', 'empty-dir', 'inner'), { recursive: true });
    await writeFile(path.join(fx.dir, '.hidden'), 'x');
    let linked = true;
    try {
      await symlink(fx.sharedData, path.join(fx.dir, 'link-out'), 'dir');
    } catch {
      linked = false; // no permission to create symlinks on this machine
    }
    const r = await importLibrary(opts(store, fx, { dryRun: false }));
    assert.equal(r.ok, true);
    const paths = (await store.listFiles()).map((f) => f.path);
    assert.ok(paths.includes('saltmarsh/salt-orchard/empty-dir/inner/'));
    assert.ok(!paths.includes('saltmarsh/salt-orchard/empty-dir/'));
    assert.ok(!paths.some((p) => p.includes('.hidden') || p.startsWith('link-out')));
    assert.ok(r.report.skipped.some((s) => s.path === '.hidden' && s.reason === 'dot-entry'));
    if (linked) assert.ok(r.report.skipped.some((s) => s.path === 'link-out' && /symbolic link/.test(s.reason)));
  } finally {
    await close();
    await removeDir(fx.dir);
  }
});
