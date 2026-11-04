// Per-book access for shared-mode members (store level): the book map shape, setBooks, setRole, invites carrying books, principalOf/listMembers, and the
// members.json / invites.json shape checks that refuse a bad map instead of loading it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSharedData, SharedDataError } from '../src/index.mjs';
import { BOOK_ROLES, MAX_MEMBER_BOOKS, isBookMap } from '../src/shared-data.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-shared-books-'));
const PW = 'correct horse battery';
const A = 'book_01S5000000000000000000000A';
const B = 'book_01S5000000000000000000000B';
const C = 'book_01S5000000000000000000000C';
const USR_OWNER = 'usr_01S50000000000000000000001';
const USR_M = 'usr_01S5000000000000000000000M';
const INV_ID = 'inv_01S5000000000000000000000A';
const HASH = 'a'.repeat(64);

async function withOwner() {
  const dir = tmp();
  const data = await openSharedData(dir, { now: () => 1_800_000_000_000 });
  const init = await data.initOwner('ilse', 'Ilse');
  assert.equal(init.ok, true);
  const done = await data.completeSetup(init.token, PW);
  assert.equal(done.ok, true);
  return { dir, data, owner: done.user };
}

/** Invite and accept a member; returns the principal. */
async function addMember(data, owner, { name = 'maren', role = 'editor', books } = {}) {
  const inv = await data.createInvite({ role, ...(books === undefined ? {} : { books }), by: owner.id });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  const acc = await data.acceptInvite(inv.token, { username: name, display_name: name, password: PW });
  assert.equal(acc.ok, true, JSON.stringify(acc));
  return acc.user;
}

const writeFiles = (dir, { members, invites }) => {
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ version: 1, users: [] }));
  if (members) fs.writeFileSync(path.join(dir, 'members.json'), JSON.stringify({ version: 1, members }));
  if (invites) fs.writeFileSync(path.join(dir, 'invites.json'), JSON.stringify({ version: 1, invites }));
};

test('isBookMap: absent, null and well-formed maps (even empty) pass', () => {
  assert.deepEqual(BOOK_ROLES, ['editor', 'reviewer', 'viewer']);
  for (const v of [undefined, null, {}, { [A]: 'editor' }, { [A]: 'editor', [B]: 'reviewer', [C]: 'viewer' }]) assert.equal(isBookMap(v), true, JSON.stringify(v));
});

test('isBookMap: bad id, bad role, owner role, wrong container, non-plain object and over the maximum are refused', () => {
  const refused = [
    { not_a_book: 'editor' },
    { book_lower: 'editor' },
    { [`${A}x`]: 'editor' },
    { [A]: 'admin' },
    { [A]: 'owner' },
    { [A]: '' },
    { [A]: null },
    { [A]: 1 },
    { [A]: ['editor'] },
    { [A]: 'editor', bad: 'viewer' },
    [],
    [A],
    'editor',
    42,
    true,
    new Map([[A, 'editor']]),
    Object.create({ [A]: 'editor' }),
    Object.create(null),
    new (class Books {})(),
  ];
  for (const v of refused) assert.equal(isBookMap(v), false, String(JSON.stringify(v) ?? typeof v));
  const big = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`book_${String(i).padStart(26, '0')}`, 'viewer']));
  assert.equal(MAX_MEMBER_BOOKS, 500);
  assert.equal(isBookMap(big(MAX_MEMBER_BOOKS)), true, 'exactly the maximum is fine');
  assert.equal(isBookMap(big(MAX_MEMBER_BOOKS + 1)), false, 'one over is refused');
});

test('setBooks: sets, replaces, clears; the member list and principal follow; the file is written', async () => {
  const { dir, data, owner } = await withOwner();
  const m = await addMember(data, owner);
  assert.equal(m.books, null, 'a member invited without books has every book');

  assert.deepEqual(await data.setBooks(m.id, { [A]: 'editor' }), { ok: true });
  assert.deepEqual({ ...data.listMembers().find((x) => x.user === m.id).books }, { [A]: 'editor' });
  assert.deepEqual({ ...(await data.login('maren', PW, 'a')).user.books }, { [A]: 'editor' });

  assert.deepEqual(await data.setBooks(m.id, { [B]: 'viewer', [C]: 'reviewer' }), { ok: true });
  assert.deepEqual({ ...data.listMembers().find((x) => x.user === m.id).books }, { [B]: 'viewer', [C]: 'reviewer' }, 'replaced, not merged');

  assert.deepEqual(await data.setBooks(m.id, {}), { ok: true });
  assert.deepEqual({ ...data.listMembers().find((x) => x.user === m.id).books }, {}, 'an empty map is no book at all, not every book');

  await data.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'members.json'), 'utf8'));
  assert.deepEqual(onDisk.members.find((x) => x.user === m.id).books, {});

  assert.deepEqual(await data.setBooks(m.id, null), { ok: true });
  assert.equal(data.listMembers().find((x) => x.user === m.id).books, null);
  await data.flush();
  assert.equal('books' in JSON.parse(fs.readFileSync(path.join(dir, 'members.json'), 'utf8')).members.find((x) => x.user === m.id), false, 'clearing removes the key');
  assert.deepEqual(await data.setBooks(m.id, undefined), { ok: true }, 'undefined clears too');
});

test('setBooks: a bad map is refused and changes nothing; the stored map is a copy, not the caller\'s object', async () => {
  const { data, owner } = await withOwner();
  const m = await addMember(data, owner, { books: { [A]: 'editor' } });
  for (const bad of [{ [A]: 'owner' }, { nope: 'editor' }, [A], 'all', 7, { [A]: 'god' }]) {
    const r = await data.setBooks(m.id, bad);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_ARGS', JSON.stringify(bad));
  }
  assert.deepEqual({ ...data.listMembers().find((x) => x.user === m.id).books }, { [A]: 'editor' }, 'unchanged after the refusals');

  const mine = { [B]: 'viewer' };
  await data.setBooks(m.id, mine);
  mine[A] = 'editor';
  mine[B] = 'editor';
  assert.deepEqual({ ...data.listMembers().find((x) => x.user === m.id).books }, { [B]: 'viewer' }, 'later edits of the caller\'s object do not leak in');
  assert.throws(() => {
    data.listMembers().find((x) => x.user === m.id).books[A] = 'editor';
  }, TypeError, 'what listMembers returns is frozen');
  assert.deepEqual({ ...data.listMembers().find((x) => x.user === m.id).books }, { [B]: 'viewer' });
});

test('setBooks: an owner is refused (OWNER_ALL_BOOKS), an unknown member is NOT_FOUND', async () => {
  const { data, owner } = await withOwner();
  const r = await data.setBooks(owner.id, { [A]: 'editor' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OWNER_ALL_BOOKS');
  assert.equal((await data.setBooks(owner.id, null)).code, 'OWNER_ALL_BOOKS', 'even null is refused for an owner');
  assert.equal(data.listMembers().find((x) => x.user === owner.id).books, null);
  const none = await data.setBooks('usr_01S5000000000000000000000Z', { [A]: 'editor' });
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NOT_FOUND');
});

test('setRole: promoting a limited member to owner drops the book list; demoting back does not bring it back', async () => {
  const { dir, data, owner } = await withOwner();
  const m = await addMember(data, owner, { books: { [A]: 'viewer' } });
  assert.deepEqual(await data.setRole(m.id, 'owner'), { ok: true });
  assert.equal(data.listMembers().find((x) => x.user === m.id).books, null);
  await data.flush();
  assert.equal('books' in JSON.parse(fs.readFileSync(path.join(dir, 'members.json'), 'utf8')).members.find((x) => x.user === m.id), false);
  assert.equal((await data.login('maren', PW, 'a')).user.books, null);
  assert.equal((await openSharedData(dir)).listMembers().find((x) => x.user === m.id).books, null, 'the file still loads');
  assert.deepEqual(await data.setRole(m.id, 'editor'), { ok: true });
  assert.equal(data.listMembers().find((x) => x.user === m.id).books, null, 'every book again, not the old list');
});

test('setRole: a role change keeps a limited member\'s books; the last-owner rule is unchanged', async () => {
  const { data, owner } = await withOwner();
  const m = await addMember(data, owner, { books: { [A]: 'viewer' } });
  assert.deepEqual(await data.setRole(m.id, 'reviewer'), { ok: true });
  assert.deepEqual({ ...data.listMembers().find((x) => x.user === m.id).books }, { [A]: 'viewer' });
  assert.equal((await data.setRole(owner.id, 'editor')).code, 'LAST_OWNER');
  assert.equal((await data.removeMember(owner.id)).code, 'LAST_OWNER');
});

test('principalOf: books for a limited member, null for an owner and for an all-books member', async () => {
  const { data, owner } = await withOwner();
  const limited = await addMember(data, owner, { name: 'lim', books: { [A]: 'editor', [B]: 'viewer' } });
  const all = await addMember(data, owner, { name: 'everything', role: 'reviewer' });
  const none = await addMember(data, owner, { name: 'nothing', books: {} });
  assert.deepEqual({ ...limited.books }, { [A]: 'editor', [B]: 'viewer' });
  assert.equal(limited.role, 'editor');
  assert.equal(all.books, null);
  assert.equal(owner.books, null);
  assert.deepEqual({ ...none.books }, {});
  // the same through a session (what every request uses)
  const lg = await data.login('lim', PW, 'a');
  assert.deepEqual({ ...(await data.resolveSession(lg.token)).books }, { [A]: 'editor', [B]: 'viewer' });
  const og = await data.login('ilse', PW, 'a');
  assert.equal((await data.resolveSession(og.token)).books, null);
  // a change is seen by an existing session on its next resolve (no re-login)
  await data.setBooks(limited.id, { [B]: 'reviewer' });
  assert.deepEqual({ ...(await data.resolveSession(lg.token)).books }, { [B]: 'reviewer' });
  await data.setBooks(limited.id, null);
  assert.equal((await data.resolveSession(lg.token)).books, null);
});

test('invites: books ride on the invite and the accepted member has exactly them; no books means every book', async () => {
  const { dir, data, owner } = await withOwner();
  const inv = await data.createInvite({ role: 'reviewer', books: { [A]: 'viewer', [B]: 'reviewer' }, by: owner.id });
  assert.equal(inv.ok, true);
  assert.deepEqual({ ...inv.invite.books }, { [A]: 'viewer', [B]: 'reviewer' });
  assert.equal('token_hash' in inv.invite, false);
  assert.deepEqual({ ...data.listInvites()[0].books }, { [A]: 'viewer', [B]: 'reviewer' });
  const acc = await data.acceptInvite(inv.token, { username: 'maren', display_name: 'Maren', password: PW });
  assert.equal(acc.ok, true);
  assert.equal(acc.user.role, 'reviewer');
  assert.deepEqual({ ...acc.user.books }, { [A]: 'viewer', [B]: 'reviewer' });
  assert.deepEqual({ ...data.listMembers().find((x) => x.user === acc.user.id).books }, { [A]: 'viewer', [B]: 'reviewer' });
  await data.setBooks(acc.user.id, { [C]: 'viewer' });
  assert.deepEqual({ ...data.listInvites()[0].books }, { [A]: 'viewer', [B]: 'reviewer' }, 'changing the member does not rewrite the used invite');

  const plain = await data.createInvite({ role: 'editor', by: owner.id });
  assert.equal('books' in plain.invite, false);
  const nul = await data.createInvite({ role: 'editor', books: null, by: owner.id });
  assert.equal('books' in nul.invite, false);
  const empty = await data.createInvite({ role: 'editor', books: {}, by: owner.id });
  const e = await data.acceptInvite(empty.token, { username: 'nobooks', display_name: 'N', password: PW });
  assert.deepEqual({ ...e.user.books }, {}, 'an empty map stays "no book", it is not widened to every book');

  await data.flush();
  const reopened = await openSharedData(dir);
  assert.deepEqual({ ...reopened.listMembers().find((x) => x.user === acc.user.id).books }, { [C]: 'viewer' });
});

test('invites: a bad map or an owner invite is refused and nothing is stored', async () => {
  const { data, owner } = await withOwner();
  const before = data.listInvites().length;
  for (const books of [{ [A]: 'owner' }, { nope: 'editor' }, [A], 'all', { [A]: 'god' }]) {
    const r = await data.createInvite({ role: 'editor', books, by: owner.id });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_ARGS', JSON.stringify(books));
  }
  assert.equal((await data.createInvite({ role: 'owner', books: { [A]: 'editor' }, by: owner.id })).code, 'BAD_ARGS');
  assert.equal(data.listInvites().length, before);
});

test('files: members.json with a bad book map, or an owner with books, stops shared mode (SharedDataError)', async () => {
  const bads = [
    { user: USR_M, role: 'editor', books: { nope: 'editor' } },
    { user: USR_M, role: 'editor', books: { [A]: 'owner' } },
    { user: USR_M, role: 'editor', books: [A] },
    { user: USR_M, role: 'editor', books: 'all' },
    { user: USR_OWNER, role: 'owner', books: { [A]: 'editor' } },
    { user: USR_OWNER, role: 'owner', books: {} },
  ];
  for (const member of bads) {
    const dir = tmp();
    writeFiles(dir, { members: [member] });
    await assert.rejects(openSharedData(dir), SharedDataError, JSON.stringify(member));
  }
});

test('files: invites.json with a bad book map stops shared mode; a good one loads', async () => {
  const inv = (books) => ({ id: INV_ID, token_hash: HASH, role: 'editor', ...(books === undefined ? {} : { books }), created: 1, expires: 2, by: USR_M, used: null, revoked: false });
  for (const books of [{ nope: 'editor' }, { [A]: 'owner' }, [A], 'all']) {
    const dir = tmp();
    writeFiles(dir, { invites: [inv(books)] });
    await assert.rejects(openSharedData(dir), SharedDataError, JSON.stringify(books));
  }
  const dir = tmp();
  writeFiles(dir, { invites: [inv({ [A]: 'viewer' })] });
  const data = await openSharedData(dir);
  assert.deepEqual({ ...data.listInvites()[0].books }, { [A]: 'viewer' });
});

test('files: an old members.json without books loads and behaves as every book; a good map loads as written', async () => {
  const dir = tmp();
  writeFiles(dir, {
    members: [
      { user: USR_OWNER, role: 'owner' },
      { user: USR_M, role: 'editor' },
      { user: 'usr_01S5000000000000000000000N', role: 'viewer', books: { [A]: 'reviewer' } },
    ],
  });
  const data = await openSharedData(dir);
  const by = (id) => data.listMembers().find((x) => x.user === id);
  assert.equal(by(USR_OWNER).books, null);
  assert.equal(by(USR_M).books, null);
  assert.deepEqual({ ...by('usr_01S5000000000000000000000N').books }, { [A]: 'reviewer' });
});

test('files: a book map survives a restart exactly', async () => {
  const { dir, data, owner } = await withOwner();
  const m = await addMember(data, owner, { books: { [A]: 'editor', [B]: 'viewer' } });
  await data.flush();
  const reopened = await openSharedData(dir);
  const login = await reopened.login('maren', PW, 'a');
  assert.equal(login.ok, true);
  assert.equal(login.user.id, m.id);
  assert.deepEqual({ ...login.user.books }, { [A]: 'editor', [B]: 'viewer' });
});
