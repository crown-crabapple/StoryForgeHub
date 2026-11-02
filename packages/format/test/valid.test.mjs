import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { VALID, listDirs, readExpected, keyOf } from './helpers.mjs';

const dirOf = (n) => path.join(VALID, n);

test('valid fixture folders are exactly codex-graph, covers, library, salt-orchard, spec-example', () => {
  assert.deepEqual(listDirs(VALID), ['codex-graph', 'covers', 'library', 'salt-orchard', 'spec-example']);
});

for (const name of ['salt-orchard', 'library', 'spec-example', 'covers', 'codex-graph']) {
  test(`valid/${name}: diagnostics equal expected`, async () => {
    const expected = readExpected(dirOf(name));
    const result = await validate(dirOf(name));
    // compared in order too: the contract fixes the sort
    assert.deepEqual(result.diagnostics.map(keyOf), expected.diagnostics.map(keyOf));
    for (const d of result.diagnostics) assert.ok(!d.file.includes('\\'));
  });
}

for (const name of ['salt-orchard', 'spec-example']) {
  test(`valid/${name}: scene order, positions, exclusions`, async () => {
    const expected = readExpected(dirOf(name));
    const result = await validate(dirOf(name));
    assert.equal(result.books.length, 1);
    const book = result.books[0];
    assert.equal(book.path, '');
    assert.deepEqual(book.order.map((s) => s.id), expected.order);
    assert.deepEqual(book.order.map((s) => s.position), expected.order.map((_, i) => i + 1));

    const orderIds = new Set(book.order.map((s) => s.id));
    for (const x of expected.excluded) {
      const got = book.excluded.find((e) => e.id === x.id);
      assert.ok(got, `${x.id} (${x.reason}) must be listed in excluded`);
      assert.equal(got.reason, x.reason);
      assert.equal(got.path, x.path);
      assert.ok(!orderIds.has(x.id), `${x.reason} scene must not be in order`);
    }
  });
}

test('valid/salt-orchard: book metadata', async () => {
  const book = (await validate(dirOf('salt-orchard'))).books[0];
  assert.equal(book.slug, 'salt-orchard');
  assert.equal(book.title, 'The Salt Orchard');
  assert.match(book.id, /^book_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(book.series, null);
});

test('valid/salt-orchard: chapter 0 prologue, acts, chapter labels', async () => {
  const { order } = (await validate(dirOf('salt-orchard'))).books[0];
  assert.equal(order[0].chapter, 0);
  assert.equal(order[0].chapter_label, 'Prologue');
  assert.equal(order[1].chapter_label, 'Chapter One'); // chapter.md label
  assert.equal(order.find((s) => s.chapter === 3).chapter_label, 'Chapter 3'); // section 4.5 default, no chapter.md
  assert.deepEqual([...new Set(order.map((s) => s.act))], [1, 2]);
  assert.deepEqual([...new Set(order.map((s) => s.chapter))], [0, 1, 2, 3]);
  // the scene stored with CRLF line endings is read normally
  const graft = order.find((s) => s.title === 'The Grafting');
  assert.ok(graft, 'CRLF scene must be parsed');
  assert.equal(graft.sequence, 20);
  assert.equal(graft.chapter, 2);
  assert.equal(graft.act, 1);
  assert.equal(graft.position, 5);
  assert.equal(graft.id, readExpected(dirOf('salt-orchard')).order[4]);
});

test('valid/salt-orchard: timeline is chronological, narrative position follows book order', async () => {
  const expected = readExpected(dirOf('salt-orchard'));
  const book = (await validate(dirOf('salt-orchard'))).books[0];
  assert.deepEqual(book.timeline.map((e) => e.slug), expected.timeline);
  const orders = book.timeline.map((e) => e.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));

  const pos = Object.fromEntries(book.timeline.map((e) => [e.slug, e.narrative_position]));
  // lowest section 4.2 position among the event's scenes; variants are skipped
  assert.equal(pos['the-flood'], 1); // prologue scene, linked from the event's `scenes`
  assert.equal(pos['the-return'], 2); // linked only from the scene's `events` (one-sided)
  assert.equal(pos['the-first-grafting'], 5);
  assert.equal(pos['the-wall-falls'], 7);
  assert.equal(pos['the-key-found-twice'], null); // only scene is a variant: unplaced, not an error
});

test('valid/library: books, series membership and order', async () => {
  const result = await validate(dirOf('library'));
  assert.deepEqual(result.books.map((b) => b.path), [
    'lantern-hill',
    'tidewater/tidewater-one',
    'tidewater/tidewater-two',
  ]);
  const bySlug = Object.fromEntries(result.books.map((b) => [b.slug, b]));
  assert.equal(bySlug['lantern-hill'].series, null);
  assert.equal(bySlug['tidewater-one'].series, 'tidewater');
  assert.equal(bySlug['tidewater-two'].series, 'tidewater');
  for (const b of result.books) {
    assert.deepEqual(b.order.map((s) => s.position), [1, 2]);
    assert.ok(b.order.every((s) => s.path.startsWith(b.path + '/')), 'scene paths are relative to rootDir');
  }
});

test('valid/spec-example: .storyforge decoy is ignored and only variant/archived are excluded', async () => {
  const book = (await validate(dirOf('spec-example'))).books[0];
  assert.equal(book.order.length, 7);
  assert.ok(book.excluded.every((e) => ['variant', 'archived'].includes(e.reason)));
});

test('valid/covers: six books, series membership, one synthetic PNG <= 20 KB', async () => {
  const result = await validate(dirOf('covers'));
  assert.deepEqual(result.books.map((b) => b.slug).sort(), [
    'first-light', 'lost-cover', 'north-road', 'old-draft', 'second-light', 'svg-cover',
  ]);
  const bySlug = Object.fromEntries(result.books.map((b) => [b.slug, b]));
  assert.equal(bySlug['first-light'].series, 'harbour-lights');
  assert.equal(bySlug['second-light'].series, 'harbour-lights');
  assert.equal(bySlug['north-road'].series, null);
  const png = fs.readFileSync(path.join(dirOf('covers'), 'harbour-lights/first-light/assets/cover.png'));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.length <= 20 * 1024);
  assert.ok(!fs.existsSync(path.join(dirOf('covers'), 'lost-cover/assets/missing.png')));
  const svg = fs.readFileSync(path.join(dirOf('covers'), 'svg-cover/assets/cover.svg'), 'utf8');
  assert.match(svg, /^<svg /);
});

function copyWithColor(value) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-color-'));
  fs.cpSync(dirOf('covers'), tmp, { recursive: true });
  const f = path.join(tmp, 'north-road', 'book.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('profile: fiction', `profile: fiction\ncover_color: ${value}`));
  return tmp;
}

test('book.md cover_color "#3A5F7D" is valid', async () => {
  const tmp = copyWithColor('"#3A5F7D"');
  try {
    assert.deepEqual((await validate(tmp)).diagnostics, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('book.md cover_color: red -> E102 at cover_color', async () => {
  const tmp = copyWithColor('red');
  try {
    const diags = (await validate(tmp)).diagnostics;
    assert.deepEqual(diags.map(keyOf), ['E102 | north-road/book.md | cover_color']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
