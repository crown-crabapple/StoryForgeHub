// Per-book access helpers for the Members page: form rows to the books map, the summary words, the highest role.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessSummary, booksFromRows, highestRole, rowsFromBooks } from '../src/shared/bookAccess.js';

test('booksFromRows drops "No access" and unknown values', () => {
  assert.deepEqual(booksFromRows({ a: 'editor', b: 'none', c: 'viewer', d: 'owner', e: '' }), { a: 'editor', c: 'viewer' });
  assert.deepEqual(booksFromRows({ a: 'none' }), {});
});

test('rowsFromBooks lists every book, defaulting to no access', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(rowsFromBooks(list, { b: 'reviewer', gone: 'editor' }), { a: 'none', b: 'reviewer' });
  assert.deepEqual(rowsFromBooks(list, null), { a: 'none', b: 'none' });
});

test('highestRole picks editor over reviewer over viewer; empty is null', () => {
  assert.equal(highestRole({ a: 'viewer', b: 'editor', c: 'reviewer' }), 'editor');
  assert.equal(highestRole({ a: 'viewer', b: 'reviewer' }), 'reviewer');
  assert.equal(highestRole({ a: 'viewer' }), 'viewer');
  assert.equal(highestRole({}), null);
  assert.equal(highestRole(null), null);
});

test('accessSummary words', () => {
  assert.equal(accessSummary(null), 'All books');
  assert.equal(accessSummary(undefined), 'All books');
  assert.equal(accessSummary({ a: 'viewer' }), 'Only 1 book');
  assert.equal(accessSummary({ a: 'viewer', b: 'editor' }), 'Only 2 books');
});
