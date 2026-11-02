// M05-J05 exit codes: 2 for usage/IO errors (missing framework files, missing python, bad flags).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFixture, makeFramework, run, cli, snapshot } from './helpers.mjs';

const book = () => copyFixture('salt-orchard');

test('framework without CLAUDE.md -> exit 2, nothing written', () => {
  const b = book();
  const fw = makeFramework({ claudeMd: false });
  const before = snapshot(fw);
  const r = run('context', { book: b, fw, chapter: 2 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.trim().length > 0, 'a plain message on stderr');
  assert.deepEqual([...snapshot(fw).keys()], [...before.keys()]);
});

test('framework without scripts/style/style_checker.py -> exit 2', () => {
  const r = run('context', { book: book(), fw: makeFramework({ checker: false }), chapter: 2 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('nonexistent framework folder -> exit 2', () => {
  const r = run('context', { book: book(), fw: 'Z:\\definitely\\not\\here', chapter: 2 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('no --framework and no CLAUDE_BOOK_ROOT -> exit 2', () => {
  const r = cli(['context', '--book', book(), '--chapter', '2']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('CLAUDE_BOOK_ROOT is used when --framework is absent', () => {
  const fw = makeFramework();
  const r = cli(['context', '--book', book(), '--chapter', '2'], { env: { CLAUDE_BOOK_ROOT: fw } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(snapshot(fw).has('.work/salt-orchard/context/book.md'));
});

test('missing python -> exit 2 with a plain message', () => {
  const fw = makeFramework();
  const r = run('style', { book: book(), fw, chapter: 1, extra: ['--python', 'sf-no-such-python-xyz'] });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.trim().length > 0);
  assert.ok(!r.stderr.includes('    at '), 'no stack trace');
});

test('missing book folder -> exit 2', () => {
  const r = run('context', { book: 'Z:\\no\\such\\book', fw: makeFramework(), chapter: 2 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

test('missing --chapter and unknown command -> exit 2', () => {
  const fw = makeFramework();
  assert.equal(run('context', { book: book(), fw }).status, 2);
  assert.equal(run('review-request', { book: book(), fw }).status, 2);
  assert.equal(run('frobnicate', { book: book(), fw, chapter: 1 }).status, 2);
});

test('a chapter that does not exist in the book -> exit 2, not a stack trace', () => {
  const r = run('context', { book: book(), fw: makeFramework(), chapter: 99 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(!r.stderr.includes('    at '));
});
