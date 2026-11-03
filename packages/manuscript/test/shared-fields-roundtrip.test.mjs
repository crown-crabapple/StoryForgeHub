// M07-J01 section 8: every new field (labels, typed field items, series codex files) survives the app's front-matter
// edit path byte for byte when it is not the field being edited: change one line, change it back, get the original bytes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../../format/src/index.mjs';
import { editFrontMatterLine } from '../src/index.mjs';
import { cleanup, copyFixture } from './helpers.mjs';

after(cleanup);

const CASES = [
  // [file, key edited, original value is read from the file, plain?]
  ['tidewater/series.md', 'title', true, 'labels on a series'],
  ['tidewater/salt-orchard-2/book.md', 'title', true, 'labels on a book'],
  ['tidewater/salt-orchard-2/manuscript/act-01-one/ch-001-one/0010-arrival.md', 'title', true, 'labels on a scene'],
  ['tidewater/low-tide/planning/threads/the-lost-ledger.md', 'title', true, 'labels on a thread'],
  ['tidewater/codex/characters/ilse-hollis.md', 'name', true, 'labels and links on a shared entry'],
  ['tidewater/salt-orchard-2/codex/vessels/gull-and-ledger.md', 'name', true, 'typed field values on an entry'],
  ['tidewater/codex/_types/vessel.md', 'name', true, 'typed field items on a shared type file'],
];

for (const [rel, key, plain, label] of CASES) {
  test(`${label}: editing ${key} and editing it back restores the file byte for byte`, () => {
    const lib = copyFixture('valid/tidewater');
    const file = path.join(lib, ...rel.split('/'));
    const original = fs.readFileSync(file);
    const current = new RegExp(`^${key}: (.+)$`, 'm').exec(original.toString('utf8'))[1].replace(/^"(.*)"$/, '$1');

    const there = editFrontMatterLine(original, key, 'Something else entirely', { plain });
    assert.ok(there.ok, there.message);
    const changedLines = there.buf.toString('utf8').split('\n').filter((l, i) => l !== original.toString('utf8').split('\n')[i]);
    assert.deepEqual(changedLines, [`${key}: Something else entirely`.replace(/^(\w+): (.*)$/, plain ? '$1: $2' : '$1: "$2"')]);

    const back = editFrontMatterLine(there.buf, key, current, { plain });
    assert.ok(back.ok, back.message);
    assert.ok(back.buf.equals(original), 'bytes are identical after the round trip');
  });
}

test('an edit of an unrelated line leaves the validator seeing the same labels and typed fields', async () => {
  const lib = copyFixture('valid/tidewater');
  const before = (await validate(lib)).diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`);
  const file = path.join(lib, 'tidewater', 'salt-orchard-2', 'codex', 'vessels', 'gull-and-ledger.md');
  const r = editFrontMatterLine(fs.readFileSync(file), 'name', 'Gull and Ledger II', { plain: true });
  assert.ok(r.ok);
  fs.writeFileSync(file, r.buf);
  const after = (await validate(lib)).diagnostics.map((d) => `${d.code}|${d.file}|${d.location}`);
  assert.deepEqual(after, before);
});
