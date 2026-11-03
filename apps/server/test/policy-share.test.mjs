// M07-J03: a share link reads only its book's manuscript (book, scene text, cover) and exports it when its scope says so.
// Everything else about the book is private project data (DECISIONS 12): notes, receipts, suggestions, comments, revisions, raw files, activity, AI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, classifyRead } from '../src/policy.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const OTHER = 'book_01S5000000000000000000000B';
const share = (scope = ['read']) => ({ kind: 'share', id: 'shr_X', book: BOOK, scope });
const viewer = { kind: 'user', id: 'usr_V', username: 'v', display_name: 'V', role: 'viewer' };

/** @param {any} who @param {string} path */
function may(who, path) {
  const r = classifyRead(path);
  assert.ok(r, `${path} classifies`);
  return allowed(who, r.cls, { book: r.book, shareable: r.shareable === true, path });
}

test('a share link reads its book, scene text and cover, and nothing private', () => {
  for (const p of [`/api/books/${BOOK}`, `/api/books/${BOOK}/scenes/scene_01S5000000000000000000000A`, `/api/books/${BOOK}/cover`, '/api/health', '/api/status']) {
    assert.equal(may(share(), p), true, p);
  }
  for (const p of [
    `/api/books/${BOOK}/receipts`, `/api/books/${BOOK}/receipts/blame`, `/api/books/${BOOK}/suggestions`, `/api/books/${BOOK}/comments`,
    `/api/books/${BOOK}/presence`, `/api/books/${BOOK}/raw`, `/api/books/${BOOK}/notes`, `/api/books/${BOOK}/activity`,
    `/api/books/${BOOK}/scenes/scene_01S5000000000000000000000A/revisions`, `/api/books/${BOOK}/ai/status`, `/api/books/${BOOK}/diagnostics`,
    `/api/books/${BOOK}/continuity`, `/api/books/${BOOK}/backup`, `/api/books/${OTHER}`, `/api/books/${OTHER}/scenes/scene_01S5000000000000000000000A`,
    '/api/books', '/api/library', '/api/search', '/api/shared/members',
  ]) {
    assert.equal(may(share(), p), false, p);
  }
});

test('export needs the export scope; members keep reading everything a viewer may', () => {
  assert.equal(may(share(['read']), `/api/books/${BOOK}/export`), false);
  assert.equal(may(share(['read', 'export']), `/api/books/${BOOK}/export`), true);
  assert.equal(may(share(['read', 'export']), `/api/books/${OTHER}/export`), false);
  for (const p of [`/api/books/${BOOK}/receipts`, `/api/books/${BOOK}/notes`, `/api/books/${BOOK}/comments`, '/api/books']) assert.equal(may(viewer, p), true, p);
});

test('a share link makes no write of any class, presence included', () => {
  for (const cls of ['read', 'comment', 'suggest', 'write', 'ai', 'admin']) assert.equal(allowed(share(['read', 'export']), cls, { book: BOOK }), false, cls);
});
