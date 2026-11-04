// Per-book access (policy.mjs): a member with a book list has a role only on the books listed, by exact id; a route about no book is open to such a member
// only as a read. Owners, all-books members and share links are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, classifyRead, isLimited, roleOnBook } from '../src/policy.mjs';

const A = 'book_01S5000000000000000000000A';
const B = 'book_01S5000000000000000000000B';
const C = 'book_01S5000000000000000000000C';
const CLASSES = ['read', 'export', 'comment', 'suggest', 'write', 'ai', 'admin'];
const user = (role, books) => ({ kind: 'user', id: 'usr_X', username: 'x', display_name: 'X', role, books });
const limited = (books, role = 'editor') => user(role, books);

/** The classes `who` may use on `book` (AI for members switched on, so 'ai' shows the role rule alone). */
const may = (who, book) => CLASSES.filter((cls) => allowed(who, cls, { book, aiForMembers: true }));

test('isLimited / roleOnBook: only a non-owner user with a book list is limited; the role is the listed one for that exact id', () => {
  assert.equal(isLimited(limited({ [A]: 'viewer' })), true);
  assert.equal(isLimited(limited({})), true, 'an empty list is limited (no book), not every book');
  assert.equal(isLimited(user('editor', null)), false);
  assert.equal(isLimited(user('editor', undefined)), false);
  assert.equal(isLimited(user('owner', { [A]: 'viewer' })), false, 'an owner is never limited');
  assert.equal(isLimited({ kind: 'share', id: 'shr_X', book: A, scope: ['read'] }), false);
  assert.equal(isLimited(null), false);
  assert.equal(roleOnBook(limited({ [A]: 'reviewer' }, 'editor'), A), 'reviewer', 'the per-book role wins over the library role');
  assert.equal(roleOnBook(limited({ [A]: 'viewer' }), B), null);
  assert.equal(roleOnBook(limited({ [A]: 'viewer' }), undefined), null);
  assert.equal(roleOnBook(limited({ [A]: 'viewer' }), '__proto__'), null);
  assert.equal(roleOnBook(limited({ [A]: 'viewer' }), 'constructor'), null);
  assert.equal(roleOnBook(user('editor', null), B), 'editor');
  assert.equal(roleOnBook(user('owner', null), B), 'owner');
  assert.equal(roleOnBook(null, A), null);
});

test('a limited member on a listed book: each class follows the per-book role', () => {
  assert.deepEqual(may(limited({ [A]: 'viewer' }), A), ['read', 'export']);
  assert.deepEqual(may(limited({ [A]: 'reviewer' }), A), ['read', 'export', 'comment', 'suggest']);
  assert.deepEqual(may(limited({ [A]: 'editor' }), A), ['read', 'export', 'comment', 'suggest', 'write', 'ai']);
  for (const role of ['viewer', 'reviewer', 'editor']) assert.equal(allowed(limited({ [A]: role }), 'admin', { book: A }), false, `admin is never open: ${role}`);
});

test('the per-book role replaces the library role in both directions', () => {
  // a library viewer who is editor on A can edit A; a library editor who is only viewer on A cannot
  assert.equal(allowed(limited({ [A]: 'editor' }, 'viewer'), 'write', { book: A }), true);
  assert.equal(allowed(limited({ [A]: 'viewer' }, 'editor'), 'write', { book: A }), false);
  assert.equal(allowed(limited({ [A]: 'viewer' }, 'editor'), 'comment', { book: A }), false);
  assert.equal(allowed(limited({ [A]: 'editor', [B]: 'viewer' }), 'write', { book: B }), false, 'each book has its own role');
  assert.equal(allowed(limited({ [A]: 'editor', [B]: 'viewer' }), 'write', { book: A }), true);
});

test('ai: needs the book role of editor AND the owner switch for members', () => {
  assert.equal(allowed(limited({ [A]: 'editor' }), 'ai', { book: A, aiForMembers: false }), false);
  assert.equal(allowed(limited({ [A]: 'editor' }), 'ai', { book: A }), false);
  assert.equal(allowed(limited({ [A]: 'editor' }), 'ai', { book: A, aiForMembers: true }), true);
  assert.equal(allowed(limited({ [A]: 'reviewer' }), 'ai', { book: A, aiForMembers: true }), false);
  assert.equal(allowed(limited({ [A]: 'editor' }), 'ai', { book: B, aiForMembers: true }), false);
});

test('a limited member on a book that is not listed: every class is refused', () => {
  for (const who of [limited({ [A]: 'editor' }), limited({ [A]: 'editor' }, 'viewer'), limited({}, 'editor')]) {
    assert.deepEqual(may(who, B), []);
    assert.deepEqual(may(who, C), []);
  }
});

test('a limited member with an empty list reaches no book at all', () => {
  assert.deepEqual(may(limited({}), A), []);
  assert.equal(allowed(limited({}), 'read', { book: A }), false);
});

test('a limited member on a route about no book: only reads, and only as a viewer', () => {
  const who = limited({ [A]: 'editor' });
  assert.equal(allowed(who, 'read', {}), true);
  assert.equal(allowed(limited({}), 'read', {}), true, 'the narrowing to zero books happens in book-scope, not here');
  for (const cls of ['export', 'comment', 'suggest', 'write', 'ai', 'admin']) assert.equal(allowed(who, cls, { aiForMembers: true }), false, `library-wide ${cls}`);
  // a library-wide write such as creating a book or recovering the library is refused even for a member who is editor on every listed book
  assert.equal(allowed(limited({ [A]: 'editor', [B]: 'editor' }), 'write', {}), false);
  assert.equal(allowed(limited({ [A]: 'editor', [B]: 'editor' }), 'admin', {}), false);
});

test('the book in the path must equal a listed id exactly: encoded, slug, case-changed or padded forms are refused', () => {
  const who = limited({ [A]: 'editor' });
  assert.equal(allowed(who, 'read', { book: A }), true);
  for (const book of [encodeURIComponent(A).replace('_', '%5F'), 'book%5F01S5000000000000000000000A', 'salt-orchard', A.toLowerCase(), ` ${A}`, `${A} `, `${A}/`, `${A}\n`, '', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(allowed(who, 'read', { book: book }), false, JSON.stringify(book));
  }
});

test('through classifyRead: a limited member reads their book routes and the top-level reads, nothing else', () => {
  const who = limited({ [A]: 'viewer' });
  const can = (p) => {
    const r = classifyRead(p);
    assert.ok(r, `${p} classifies`);
    return allowed(who, r.cls, { book: r.book, shareable: r.shareable === true, path: p });
  };
  for (const p of [`/api/books/${A}`, `/api/books/${A}/scenes/scene_X`, `/api/books/${A}/notes`, `/api/books/${A}/export`, '/api/books', '/api/search', '/api/status', '/api/index/status', '/api/library']) {
    assert.equal(can(p), true, p);
  }
  for (const p of [`/api/books/${B}`, `/api/books/${B}/scenes/scene_X`, `/api/books/${B}/export`, `/api/books/${B}/link-targets`, `/api/books/${A}/backup`, '/api/shared/members', '/api/library/recent', '/api/recover', '/api/ai/profiles']) {
    assert.equal(can(p), false, p);
  }
});

test('owner and all-books members are unchanged by the book rules', () => {
  const owner = user('owner', null);
  for (const book of [A, B, undefined]) assert.deepEqual(may(owner, book), CLASSES);
  assert.equal(allowed(user('owner', { [A]: 'viewer' }), 'admin', { book: B }), true, 'a stray book list on an owner is ignored');
  const roles = { viewer: ['read', 'export'], reviewer: ['read', 'export', 'comment', 'suggest'], editor: ['read', 'export', 'comment', 'suggest', 'write', 'ai'] };
  for (const [role, expect] of Object.entries(roles)) {
    for (const books of [null, undefined]) {
      assert.deepEqual(may(user(role, books), B), expect, `${role} ${books}`);
      assert.deepEqual(may(user(role, books), undefined), expect, `${role} ${books} no book`);
    }
  }
  assert.equal(allowed(user('editor', null), 'ai', { book: A }), false, 'AI for members still needs the owner switch');
  assert.equal(allowed(user('editor', null), 'admin', { book: A }), false);
});

test('a share principal is unchanged: its own book only, read/export by scope, never a write', () => {
  const share = (scope) => ({ kind: 'share', id: 'shr_X', book: A, scope });
  assert.equal(allowed(share(['read']), 'read', { book: A, shareable: true }), true);
  assert.equal(allowed(share(['read']), 'read', { book: B, shareable: true }), false);
  assert.equal(allowed(share(['read']), 'export', { book: A }), false);
  assert.equal(allowed(share(['read', 'export']), 'export', { book: A }), true);
  assert.equal(allowed(share(['read', 'export']), 'export', { book: B }), false);
  for (const cls of ['comment', 'suggest', 'write', 'ai', 'admin']) assert.equal(allowed(share(['read', 'export']), cls, { book: A }), false, cls);
  assert.equal(allowed(share(['read']), 'read', { path: '/api/status' }), true);
  assert.equal(allowed(share(['read']), 'read', { path: '/api/books' }), false);
});

test('no principal is refused; auth and public stay open to anyone', () => {
  assert.equal(allowed(null, 'read', { book: A }), false);
  assert.equal(allowed(null, 'auth'), true);
  assert.equal(allowed(null, 'public'), true);
  assert.equal(allowed(limited({ [A]: 'viewer' }), 'auth'), true);
  assert.equal(allowed(limited({ [A]: 'viewer' }), 'nonsense', { book: A }), false, 'an unknown class is refused');
});
