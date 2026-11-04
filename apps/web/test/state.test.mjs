import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROJECT_TABS, parseRoute, tabHref } from '../src/routes.js';
import { NO_WRITES, deriveSave, writeFinished, writeStarted } from '../src/shell/save-state.js';

const T1 = '2026-11-01T09:00:00.000Z';
const T2 = '2026-11-01T09:05:00.000Z';

test('save status: no book open is read-only', () => {
  assert.deepEqual(deriveSave({ bookId: null, writes: NO_WRITES, lastReconciledAt: T1 }), { kind: 'readonly', at: null });
});

test('save status: a write in flight is saving, and outranks everything else', () => {
  const writes = writeStarted({ ...NO_WRITES, conflictBook: 'b' });
  assert.equal(deriveSave({ bookId: 'b', writes, lastReconciledAt: T1 }).kind, 'saving');
});

test('save status: a 409 is a conflict for that book only, until a later write succeeds', () => {
  let w = writeFinished(writeStarted(NO_WRITES), 'b', 409, T1);
  assert.equal(deriveSave({ bookId: 'b', writes: w, lastReconciledAt: T1 }).kind, 'conflict');
  assert.equal(deriveSave({ bookId: 'other', writes: w, lastReconciledAt: T1 }).kind, 'saved');
  w = writeFinished(writeStarted(w), 'b', 200, T2);
  assert.deepEqual(deriveSave({ bookId: 'b', writes: w, lastReconciledAt: T1 }), { kind: 'saved', at: T2 });
});

test('save status: saved shows the later of the last write and the last reconcile', () => {
  const w = writeFinished(writeStarted(NO_WRITES), 'b', 200, T1);
  assert.equal(deriveSave({ bookId: 'b', writes: w, lastReconciledAt: T2 }).at, T2);
  assert.equal(deriveSave({ bookId: 'b', writes: w, lastReconciledAt: null }).at, T1);
  assert.equal(deriveSave({ bookId: 'b', writes: NO_WRITES, lastReconciledAt: T2 }).at, T2);
});

test('save status: with no write and no reconcile time yet it says checking, not saved', () => {
  assert.equal(deriveSave({ bookId: 'b', writes: NO_WRITES, lastReconciledAt: null }).kind, 'checking');
});

test('save status: refused or unreachable writes do not claim a save and do not leave it saving', () => {
  for (const status of [400, 500, null]) {
    const w = writeFinished(writeStarted(NO_WRITES), 'b', status, T1);
    assert.equal(w.inflight, 0);
    assert.equal(w.lastWriteAt, null);
    assert.equal(w.conflictBook, null);
  }
});

test('routes: library, book, scene, raw file, tabs and unknown paths', () => {
  assert.deepEqual(parseRoute('/'), { name: 'library' });
  assert.deepEqual(parseRoute('/settings/members'), { name: 'members' });
  assert.deepEqual(parseRoute('/books/b1'), { name: 'book', bookId: 'b1', sceneId: null, file: null });
  assert.deepEqual(parseRoute('/books/b1/', '?scene=s1'), { name: 'book', bookId: 'b1', sceneId: 's1', file: null });
  assert.deepEqual(parseRoute('/books/b1', '?file=a%2Fb.md'), { name: 'book', bookId: 'b1', sceneId: null, file: 'a/b.md' });
  for (const tab of ['codex', 'timeline', 'places', 'notes']) assert.deepEqual(parseRoute(`/books/b1/${tab}`), { name: 'tab', bookId: 'b1', tab });
  assert.equal(parseRoute('/books/b1/nope').name, 'notfound');
  assert.equal(parseRoute('/elsewhere').name, 'notfound');
  assert.equal(parseRoute('/books/%E0%A4%A').name, 'notfound');
});

test('routes: every project tab has a link that parses back to itself', () => {
  assert.deepEqual(
    PROJECT_TABS.map((t) => t.label),
    ['Manuscript', 'Codex', 'Timeline', 'Continuity', 'Places', 'Notes', 'Canvas'],
  );
  for (const t of PROJECT_TABS) {
    const route = parseRoute(tabHref('book one', t.key));
    assert.equal(route.bookId, 'book one');
    assert.equal(route.name, t.key === 'manuscript' ? 'book' : 'tab');
  }
});
