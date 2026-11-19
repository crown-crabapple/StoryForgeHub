// M13-J04: the core half of the EPUB validation choice: withEpubChecks / setEpubChecks (preferences.checks.epub.validate in book.md).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { withEpubChecks } from '../src/fs-writes.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const body = '\nBody text.\n\nSecond paragraph.\n';

function patchText(text, patch) {
  const r = withEpubChecks(Buffer.from(text), patch);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

test('withEpubChecks creates the maps, keeps comments and other keys, and copies the body bytes unchanged', () => {
  const r = patchText(`---\n# keep me\nid: x\npreferences:\n  ai:\n    level: off\n---${body}`, { validate: true });
  assert.equal(r.changed, true);
  assert.deepEqual(r.epub, { validate: true });
  const text = r.buf.toString('utf8');
  assert.match(text, /# keep me/);
  assert.match(text, /level: off/);
  assert.match(text, /checks:\n {4}epub:\n {6}validate: true/);
  assert.ok(text.endsWith(body));
  const bare = patchText(`---\nid: x\n---${body}`, { validate: false });
  assert.match(bare.buf.toString('utf8'), /preferences:\n {2}checks:\n {4}epub:\n {6}validate: false/);
});

test('withEpubChecks: the same value again is unchanged; the other checks keep their place', () => {
  const a = patchText(`---\nid: x\npreferences:\n  checks:\n    style:\n      enabled: true\n---${body}`, { validate: true });
  assert.match(a.buf.toString('utf8'), /style:\n {6}enabled: true/);
  const same = patchText(a.buf.toString('utf8'), { validate: true });
  assert.equal(same.changed, false);
  assert.equal(same.buf.toString('utf8'), a.buf.toString('utf8'));
  const flipped = patchText(a.buf.toString('utf8'), { validate: false });
  assert.deepEqual(flipped.epub, { validate: false });
});

test('withEpubChecks keeps CRLF in the head', () => {
  const r = patchText(`---\r\nid: x\r\n---${body}`, { validate: true });
  assert.ok(!/[^\r]\n/.test(r.buf.toString('utf8').split('---')[1]), 'head lines stay CRLF');
});

test('withEpubChecks refuses every bad change with BAD_ARGS and bad documents with NOT_A_DOCUMENT', () => {
  const bytes = Buffer.from(`---\nid: x\n---${body}`);
  for (const patch of [null, [], {}, { validate: 'yes' }, { validate: true, other: 1 }, { other: true }]) {
    const r = withEpubChecks(bytes, /** @type {any} */ (patch));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_ARGS');
  }
  assert.equal(withEpubChecks(Buffer.from('no front matter'), { validate: true }).code, 'NOT_A_DOCUMENT');
  assert.equal(withEpubChecks(Buffer.from(`---\nid: x\npreferences: 3\n---${body}`), { validate: true }).code, 'BAD_ARGS');
  assert.equal(withEpubChecks(Buffer.from(`---\nid: x\npreferences:\n  checks:\n    epub: 3\n---${body}`), { validate: true }).code, 'BAD_ARGS');
});

test('setEpubChecks writes book.md through the store and the library stays valid', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    const before = await fs.readFile(path.join(root, 'book.md'));
    assert.equal((await repo.setEpubChecks('book_nope', { validate: true })).code, 'NOT_FOUND');
    assert.equal((await repo.setEpubChecks(BOOK, /** @type {any} */ ({ validate: 'yes' }))).code, 'BAD_ARGS');
    assert.deepEqual(await fs.readFile(path.join(root, 'book.md')), before);
    const r = await repo.setEpubChecks(BOOK, { validate: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.epub, { validate: true });
    assert.equal(r.unchanged, undefined);
    const text = await fs.readFile(path.join(root, 'book.md'), 'utf8');
    assert.match(text, /epub:\n {6}validate: true/);
    assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.severity === 'error'), []);
    const again = await repo.setEpubChecks(BOOK, { validate: true });
    assert.equal(again.unchanged, true);
    assert.equal(await fs.readFile(path.join(root, 'book.md'), 'utf8'), text);
  } finally {
    await repo.close();
  }
});
