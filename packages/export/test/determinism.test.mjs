// M05-J03 acceptance 2: Markdown, DOCX, EPUB and PDF bytes are identical across two runs and on a copy of the book in
// another folder; the backup zip is identical for a fixed date.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBackup, exportBook } from '../src/index.mjs';
import { FORMATS, addExtras, cleanup, copyBook, readEpub, readZip, tmpDir } from './helpers.mjs';

after(cleanup);

for (const format of FORMATS) {
  test(`${format}: two runs, and a copy of the book in another folder, give identical bytes`, async () => {
    const a = copyBook();
    const b = copyBook('valid/salt-orchard', { under: path.join(tmpDir(), 'elsewhere', 'deeper') });
    const first = await exportBook(a, format, {});
    const second = await exportBook(a, format, {});
    const copy = await exportBook(b, format, {});
    assert.ok(first.bytes.equals(second.bytes), 'second run');
    assert.ok(first.bytes.equals(copy.bytes), 'copy in another folder');
    assert.equal(first.filename, copy.filename);
  });
}

test('determinism holds with options too (sceneTitles, excludeStatuses)', async () => {
  const opts = { sceneTitles: true, excludeStatuses: ['outline'] };
  for (const format of FORMATS) {
    const a = await exportBook(copyBook(), format, opts);
    const b = await exportBook(copyBook(), format, opts);
    assert.ok(a.bytes.equals(b.bytes), format);
  }
});

test('zip based formats use the fixed 1980-01-01 timestamp on every entry', async () => {
  for (const format of ['docx', 'epub']) {
    const { entries } = readZip((await exportBook(copyBook(), format, {})).bytes);
    assert.ok(entries.length >= 5, format);
    for (const e of entries) {
      assert.equal(e.dosDate, 0x21, `${format} ${e.name} date`);
      assert.equal(e.dosTime, 0, `${format} ${e.name} time`);
    }
  }
});

test('epub: dcterms:modified is the newest scene file mtime truncated to seconds, never now', async () => {
  const root = copyBook();
  const newest = new Date('2021-03-04T05:06:07.891Z');
  fs.utimesSync(path.join(root, 'manuscript', 'act-02-high-water', 'ch-003-the-wall', '0020-the-wall.md'), newest, newest);
  const ep = readEpub((await exportBook(root, 'epub', {})).bytes);
  assert.equal(/property="dcterms:modified"[^>]*>([^<]*)</.exec(ep.opf)?.[1], '2021-03-04T05:06:07Z');
  // moving the newest mtime moves the value: it is derived from the files
  const later = new Date('2022-12-31T23:59:59.999Z');
  fs.utimesSync(path.join(root, 'manuscript', 'act-01-low-water', 'ch-000-prologue', '0010-before-the-tide.md'), later, later);
  const ep2 = readEpub((await exportBook(root, 'epub', {})).bytes);
  assert.equal(/property="dcterms:modified"[^>]*>([^<]*)</.exec(ep2.opf)?.[1], '2022-12-31T23:59:59Z');
});

test('backup zip: identical bytes across runs and across a copy of the book for a fixed date', async () => {
  const now = new Date('2026-03-04T12:00:00Z');
  const a = copyBook();
  addExtras(a);
  const b = copyBook('valid/salt-orchard', { under: path.join(tmpDir(), 'elsewhere') });
  addExtras(b);
  const one = await createBackup(a, { now });
  const two = await createBackup(a, { now });
  const three = await createBackup(b, { now });
  assert.ok(one.bytes.equals(two.bytes));
  assert.ok(one.bytes.equals(three.bytes));
  assert.equal(one.filename, 'salt-orchard-backup-20260304.zip');
  for (const e of readZip(one.bytes).entries) assert.equal(e.dosDate, 0x21, e.name);
});
