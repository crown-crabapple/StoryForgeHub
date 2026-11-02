// M05-J03 acceptance 5: export and backup only read. The book tree (bytes, sizes, mtimes, directories) is identical
// afterwards, nothing new appears in or next to the book, and no SQLite index is needed or created.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assembleManuscript, createBackup, exportBook } from '../src/index.mjs';
import { FORMATS, addExtras, cleanup, copyBook, snapshotTree, tmpDir } from './helpers.mjs';

after(cleanup);

function assertUnchanged(before, after, label) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: same files and folders`);
  for (const [p, b] of before) {
    const a = after.get(p);
    assert.equal(a.sha, b.sha, `${label}: ${p} bytes`);
    assert.equal(a.size, b.size, `${label}: ${p} size`);
    assert.equal(a.mtimeMs, b.mtimeMs, `${label}: ${p} mtime`);
  }
}

test('assembleManuscript, all four exports and both backups leave the book tree untouched (bytes + mtimes)', async () => {
  const outer = tmpDir();
  const root = copyBook('valid/salt-orchard', { under: outer });
  addExtras(root);
  const before = snapshotTree(root);
  const outerBefore = fs.readdirSync(outer);

  await assembleManuscript(root, {});
  for (const f of FORMATS) {
    await exportBook(root, f, {});
    await exportBook(root, f, { sceneTitles: true, excludeStatuses: ['outline'] });
  }
  await createBackup(root, { now: new Date('2026-03-04T12:00:00Z') });
  await createBackup(root, { includeProvenance: true, now: new Date('2026-03-04T12:00:00Z') });

  assertUnchanged(before, snapshotTree(root), 'after export and backup');
  assert.deepEqual(fs.readdirSync(outer), outerBefore, 'nothing written next to the book either');
  assert.ok(!fs.existsSync(path.join(root, '.storyforge', 'index.sqlite-wal')));
});

test('no index is needed: export works on a book with no .storyforge folder at all and does not create one', async () => {
  const root = copyBook();
  fs.rmSync(path.join(root, '.storyforge'), { recursive: true, force: true });
  const before = snapshotTree(root);
  for (const f of FORMATS) {
    const out = await exportBook(root, f, {});
    assert.ok(out.bytes.length > 100, f);
  }
  await createBackup(root, { now: new Date('2026-03-04T12:00:00Z') });
  assert.ok(!fs.existsSync(path.join(root, '.storyforge')), 'no .storyforge created');
  assertUnchanged(before, snapshotTree(root), 'no .storyforge');
});

test('export reads canonical files only: a stale or corrupt .storyforge never changes the result', async () => {
  const clean = copyBook();
  fs.rmSync(path.join(clean, '.storyforge'), { recursive: true, force: true });
  const noisy = copyBook();
  fs.mkdirSync(path.join(noisy, '.storyforge'), { recursive: true });
  fs.writeFileSync(path.join(noisy, '.storyforge', 'index.sqlite'), 'garbage, not a database');
  for (const f of FORMATS) {
    const a = await exportBook(clean, f, {});
    const b = await exportBook(noisy, f, {});
    assert.ok(a.bytes.equals(b.bytes), f);
  }
});
