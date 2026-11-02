// M05-J03 acceptance 6 (package half): what a backup contains, and the backup -> restore round trip.
// (The restored book opening through createFsRepository and the HTTP API is in apps/server/test/export-routes.test.mjs.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../../format/src/index.mjs';
import { createBackup, restoreBackup } from '../src/index.mjs';
import { BOOK_ID, SLUG, addExtras, assertSameFiles, cleanup, copyBook, readAll, readZip, tmpDir, walkFiles } from './helpers.mjs';

after(cleanup);

const NOW = new Date('2026-03-04T12:00:00Z');
const fileEntries = (z) => z.entries.filter((e) => !e.name.endsWith('/'));

test('backup: every file but .storyforge/** and provenance/**, prefixed with the book folder name, byte for byte', async () => {
  const root = copyBook();
  const extras = addExtras(root);
  const { bytes, filename } = await createBackup(root, { now: NOW });
  assert.equal(filename, 'salt-orchard-backup-20260304.zip');
  const z = readZip(bytes);
  const files = fileEntries(z);
  const want = walkFiles(root).filter((p) => !p.startsWith('.storyforge/') && !p.startsWith('provenance/')).sort();
  assert.deepEqual(files.map((e) => e.name).sort(), want.map((p) => `${SLUG}/${p}`));
  for (const e of files) {
    assert.ok(e.data.equals(fs.readFileSync(path.join(root, ...e.name.split('/').slice(1)))), `${e.name} byte-identical`);
    assert.ok(!e.name.includes('\\'), 'forward slashes only');
    assert.ok(!e.name.startsWith('/') && !/^[A-Za-z]:/.test(e.name) && !e.name.split('/').includes('..'));
  }
  const names = files.map((e) => e.name);
  assert.ok(names.includes('salt-orchard/archive/manuscript/act-01-low-water/ch-002-the-grafting/0030-the-cut-scene.md'), 'archive/ included');
  assert.ok(names.includes('salt-orchard/assets/cover-test.png'), 'assets/ included');
  assert.ok(names.includes('salt-orchard/assets/empty.txt'), 'empty files included');
  assert.ok(names.includes('salt-orchard/research/tidal-ranges.md'), 'non-schema notes included');
  assert.ok(names.includes('salt-orchard/notes/café ☕.md'), 'non-ASCII file names included');
  assert.ok(!names.some((n) => n.includes('.storyforge')), 'no .storyforge');
  assert.ok(!names.some((n) => n.includes('/provenance/')), 'no provenance by default');
  assert.ok(extras.length > 0);
});

test('backup: includeProvenance adds provenance/** and nothing else', async () => {
  const root = copyBook();
  addExtras(root);
  const off = readZip((await createBackup(root, { now: NOW })).bytes);
  const on = readZip((await createBackup(root, { includeProvenance: true, now: NOW })).bytes);
  const diff = fileEntries(on).map((e) => e.name).filter((n) => !fileEntries(off).some((e) => e.name === n));
  assert.deepEqual(diff, ['salt-orchard/provenance/receipts/r-0001.json']);
  assert.ok(fileEntries(on).find((e) => e.name.endsWith('r-0001.json')).data.equals(Buffer.from('{"receipt":1}\n')));
  const explicitOff = readZip((await createBackup(root, { includeProvenance: false, now: NOW })).bytes);
  assert.deepEqual(fileEntries(explicitOff).map((e) => e.name), fileEntries(off).map((e) => e.name));
});

test('backup: the manifest is the zip comment - JSON with format version, book id, file count and a sha256', async () => {
  const root = copyBook();
  const { bytes } = await createBackup(root, { now: NOW });
  const z = readZip(bytes);
  const m = JSON.parse(z.comment);
  assert.equal(m.storyforge_backup, 1);
  assert.equal(m.book_id, BOOK_ID);
  assert.equal(m.files, fileEntries(z).length);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!z.entries.some((e) => /manifest/i.test(e.name)), 'the zip contains only the book\'s own files');
  // the hash depends on content: a one-byte edit of one file gives another manifest hash
  const root2 = copyBook();
  fs.appendFileSync(path.join(root2, 'research', 'tidal-ranges.md'), 'x');
  const m2 = JSON.parse(readZip((await createBackup(root2, { now: NOW })).bytes).comment);
  assert.notEqual(m2.sha256, m.sha256);
  assert.equal(m2.files, m.files);
});

test('backup filename: <slug>-backup-YYYYMMDD.zip from options.now', async () => {
  const root = copyBook();
  assert.equal((await createBackup(root, { now: new Date('2031-12-09T12:00:00Z') })).filename, 'salt-orchard-backup-20311209.zip');
  assert.equal((await createBackup(root, { now: new Date('2026-01-02T12:00:00Z') })).filename, 'salt-orchard-backup-20260102.zip');
});

test('round trip: restore into a new folder gives every file byte-identical, validate() is clean, no .storyforge is created', async () => {
  const src = copyBook();
  const original = readAll(src); // excludes .storyforge
  const { bytes } = await createBackup(src, { now: NOW });
  const parent = tmpDir();
  const target = path.join(parent, SLUG);
  const r = await restoreBackup(bytes, target);
  assert.equal(path.resolve(r.bookRoot), path.resolve(target));
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.files, original.size);
  assertSameFiles(assert, original, readAll(target, { skip: [] }), 'restored');
  assert.ok(!fs.existsSync(path.join(target, '.storyforge')), 'no .storyforge created');
  assert.deepEqual(fs.readdirSync(parent), [SLUG], 'no temp sibling left behind');
  const v = await validate(target);
  assert.deepEqual(v.diagnostics, []);
});

test('round trip with extras: binary, empty, CRLF and non-ASCII-named files survive; provenance only when asked for', async () => {
  const src = copyBook();
  addExtras(src);
  const original = readAll(src);
  for (const includeProvenance of [false, true]) {
    const { bytes } = await createBackup(src, { includeProvenance, now: NOW });
    const target = path.join(tmpDir(), 'restored');
    const r = await restoreBackup(bytes, target);
    const got = readAll(target, { skip: [] });
    const expected = new Map([...original].filter(([p]) => includeProvenance || !p.startsWith('provenance/')));
    assertSameFiles(assert, expected, got, `provenance=${includeProvenance}`);
    assert.equal(r.files, expected.size);
    assert.ok(!fs.existsSync(path.join(target, '.storyforge')));
  }
});

test('round trip: restoring twice from the same backup, then backing up again, gives the same manifest', async () => {
  const src = copyBook();
  const first = await createBackup(src, { now: NOW });
  const t1 = path.join(tmpDir(), 'a');
  await restoreBackup(first.bytes, t1);
  const second = await createBackup(t1, { now: NOW });
  assert.equal(readZip(second.bytes).comment, readZip(first.bytes).comment);
});

test('restore: an existing EMPTY directory is a valid target and is filled in place', async () => {
  const src = copyBook();
  const { bytes } = await createBackup(src, { now: NOW });
  const target = path.join(tmpDir(), 'empty-dir');
  fs.mkdirSync(target);
  const r = await restoreBackup(bytes, target);
  assert.equal(path.resolve(r.bookRoot), path.resolve(target));
  assertSameFiles(assert, readAll(src), readAll(target, { skip: [] }), 'restored into empty dir');
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['empty-dir']);
});

test('restore: a non-empty target is refused with RESTORE_TARGET_NOT_EMPTY and left exactly as it was', async () => {
  const { bytes } = await createBackup(copyBook(), { now: NOW });
  const parent = tmpDir();
  const target = path.join(parent, 'busy');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'mine');
  fs.mkdirSync(path.join(target, 'sub'));
  const parentBefore = fs.readdirSync(parent).sort();
  await assert.rejects(
    async () => restoreBackup(bytes, target),
    (e) => {
      assert.equal(e.code, 'RESTORE_TARGET_NOT_EMPTY');
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(target).sort(), ['keep.txt', 'sub']);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'mine');
  assert.deepEqual(fs.readdirSync(parent).sort(), parentBefore, 'no temp sibling left');
});

test('restore: a dot-file only target counts as non-empty', async () => {
  const { bytes } = await createBackup(copyBook(), { now: NOW });
  const target = path.join(tmpDir(), 'dots');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, '.hidden'), '');
  await assert.rejects(async () => restoreBackup(bytes, target), (e) => e.code === 'RESTORE_TARGET_NOT_EMPTY');
});
