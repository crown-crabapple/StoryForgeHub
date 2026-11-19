// M13-J05: the core half of the Book interior layout: withInteriorLayout / setInteriorLayout (preferences.interior in book.md).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { withInteriorLayout } from '../src/fs-writes.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const body = '\nBody text.\n\nSecond paragraph.\n';

function patchText(text, patch) {
  const r = withInteriorLayout(Buffer.from(text), patch);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

test('withInteriorLayout creates the map with version 1, keeps comments and other keys, and copies the body bytes unchanged', () => {
  const r = patchText(`---\n# keep me\nid: x\npreferences:\n  ai:\n    level: off\n---${body}`, { fontSize: 12, trim: '5.5x8.5' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.interior, { version: 1, fontSize: 12, trim: '5.5x8.5' });
  const text = r.buf.toString('utf8');
  assert.match(text, /# keep me/);
  assert.match(text, /level: off/);
  assert.match(text, /interior:\n {4}version: 1\n {4}fontSize: 12\n {4}trim: 5\.5x8\.5/);
  assert.ok(text.endsWith(body));
  const bare = patchText(`---\nid: x\n---${body}`, { font: 'inter' });
  assert.match(bare.buf.toString('utf8'), /preferences:\n {2}interior:\n {4}version: 1\n {4}font: inter/);
});

test('withInteriorLayout merges shallowly; margins, frontMatter and backMatter replace as wholes', () => {
  const start = '---\nid: x\npreferences:\n  interior:\n    version: 1\n    fontSize: 11\n    margins:\n      inside: 0.75\n      outside: 0.5\n      top: 0.6\n      bottom: 0.6\n    frontMatter:\n      copyright: Mine\n      dedication: For you\n---' + body;
  const a = patchText(start, { lineHeight: 1.5 });
  assert.equal(a.interior.fontSize, 11);
  assert.equal(a.interior.lineHeight, 1.5);
  assert.equal(a.interior.frontMatter.dedication, 'For you');
  const b = patchText(start, { margins: { inside: 1, outside: 0.8 }, frontMatter: { copyright: 'Other' } });
  assert.deepEqual(b.interior.margins, { inside: 1, outside: 0.8 });
  assert.deepEqual(b.interior.frontMatter, { copyright: 'Other' });
  assert.equal(b.interior.fontSize, 11);
  assert.match(b.buf.toString('utf8'), /margins:\n {6}inside: 1\n {6}outside: 0.8\n/);
  assert.doesNotMatch(b.buf.toString('utf8'), /dedication/);
});

test('withInteriorLayout: the same values again are unchanged', () => {
  const a = patchText(`---\nid: x\n---${body}`, { fontSize: 12 });
  const same = patchText(a.buf.toString('utf8'), { fontSize: 12 });
  assert.equal(same.changed, false);
  assert.equal(same.buf.toString('utf8'), a.buf.toString('utf8'));
  const flipped = patchText(a.buf.toString('utf8'), { fontSize: 12.5 });
  assert.equal(flipped.interior.fontSize, 12.5);
});

test('withInteriorLayout keeps CRLF in the head', () => {
  const r = patchText(`---\r\nid: x\r\n---${body}`, { pageNumbers: false });
  assert.ok(!/[^\r]\n/.test(r.buf.toString('utf8').split('---')[1]), 'head lines stay CRLF');
});

test('withInteriorLayout refuses every bad change with BAD_ARGS and bad documents with NOT_A_DOCUMENT', () => {
  const bytes = Buffer.from(`---\nid: x\n---${body}`);
  const bad = [null, [], {}, { other: 1 }, { fontSize: 15 }, { fontSize: 11.3 }, { lineHeight: 2 }, { trim: 'a4' }, { font: 'comic' }, { chapterStart: 'left' }, { sceneBreak: 'x' }, { runningHeads: 'yes' },
    { margins: { inside: 3 } }, { margins: { sideways: 1 } }, { frontMatter: { copyright: 'x'.repeat(2001) } }, { backMatter: { aboutAuthor: 3 } }, { version: 2 }, { template: 'other' }];
  for (const patch of bad) {
    const r = withInteriorLayout(bytes, /** @type {any} */ (patch));
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.code, 'BAD_ARGS', JSON.stringify(patch));
  }
  assert.match(String(withInteriorLayout(bytes, { version: 2 }).message), /newer StoryForge/);
  assert.equal(withInteriorLayout(Buffer.from('no front matter'), { fontSize: 12 }).code, 'NOT_A_DOCUMENT');
  assert.equal(withInteriorLayout(Buffer.from(`---\nid: x\npreferences: 3\n---${body}`), { fontSize: 12 }).code, 'BAD_ARGS');
  assert.equal(withInteriorLayout(Buffer.from(`---\nid: x\npreferences:\n  interior: 3\n---${body}`), { fontSize: 12 }).code, 'BAD_ARGS');
  // a file saved by a newer StoryForge is not changed
  assert.equal(withInteriorLayout(Buffer.from(`---\nid: x\npreferences:\n  interior:\n    version: 2\n---${body}`), { fontSize: 12 }).code, 'BAD_ARGS');
});

test('setInteriorLayout writes book.md through the store and the library stays valid', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    const before = await fs.readFile(path.join(root, 'book.md'));
    assert.equal((await repo.setInteriorLayout('book_nope', { fontSize: 12 })).code, 'NOT_FOUND');
    assert.equal((await repo.setInteriorLayout(BOOK, { fontSize: 99 })).code, 'BAD_ARGS');
    assert.deepEqual(await fs.readFile(path.join(root, 'book.md')), before);
    const r = await repo.setInteriorLayout(BOOK, { fontSize: 12, margins: { inside: 0.9, outside: 0.5, top: 0.6, bottom: 0.6 } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.interior.fontSize, 12);
    assert.equal(r.unchanged, undefined);
    const text = await fs.readFile(path.join(root, 'book.md'), 'utf8');
    assert.match(text, /interior:\n {4}version: 1\n {4}fontSize: 12/);
    assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.severity === 'error'), []);
    const again = await repo.setInteriorLayout(BOOK, { fontSize: 12 });
    assert.equal(again.unchanged, true);
    assert.equal(await fs.readFile(path.join(root, 'book.md'), 'utf8'), text);
  } finally {
    await repo.close();
  }
});
