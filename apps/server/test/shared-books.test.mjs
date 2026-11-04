// Per-book access for shared-mode members, over HTTP: a member limited to some books sees and changes only those, the owner's changes take effect on the next
// request, and shared series data is out of reach for a limited member. Runs a real shared server over a copy of the tidewater fixture: two books in a
// series (Salt Orchard Two, Low Tide) and one standalone book (Pilgrims Road).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createAudit, openSettings, openSharedData } from '../../../packages/shared/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { createSharedGate } from '../src/shared-gate.mjs';
import { call, closeAll as closeHelperServers, cookieOf, PW } from './shared-helpers.mjs';
import { close, copyFixture, listen, snapshot } from './helpers.mjs';

const SO = 'book_01W10000000000000000000006'; // book A: Salt Orchard Two (series tidewater)
const LT = 'book_01W1000000000000000000000A'; // book B: Low Tide (series tidewater)
const PR = 'book_01W1000000000000000000000E'; // book C: Pilgrims Road (standalone)
const SCENE_SO = 'scene_01W10000000000000000000007';
const SCENE_LT = 'scene_01W1000000000000000000000B';
const ILSE = 'entry_01W10000000000000000000003'; // a shared (series) entry
const MAREN = 'entry_01W10000000000000000000008'; // an entry of Salt Orchard Two only
const SO_SCENE_FILE = 'tidewater/salt-orchard-2/manuscript/act-01-one/ch-001-one/0010-arrival.md';
const LT_SCENE_FILE = 'tidewater/low-tide/manuscript/act-01-one/ch-001-one/0010-ebb.md';

const servers = [];
after(async () => {
  for (const s of servers.splice(0)) await close(s);
  await closeHelperServers();
});

const tokenOf = (link) => link.split('#token=')[1];
const snap = (root) => snapshot(root, { skipStoryforge: true });

/** A shared-mode server over tidewater with an owner. `t.join(name, { role, books })` adds a member through an invite and returns { cookie, user }. */
async function boot() {
  const root = await copyFixture('valid/tidewater');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shared-data-'));
  const data = await openSharedData(dir);
  const settings = await openSettings(dir);
  const audit = createAudit(dir);
  const gate = createSharedGate({ data, publicUrl: null, bindHost: '127.0.0.1', aiForMembers: () => settings.get().ai_for_members, audit: (e) => audit.append(e) });
  const repository = createFsRepository(root, { watch: false, pollMs: 0 });
  await repository.rebuildIndex();
  const server = createServer({ repository, shared: { gate, data, settings, audit: (e) => audit.append(e), publicUrl: null, dir } });
  servers.push(server);
  const port = await listen(server);
  const t = { root, dir, data, port, c: {}, users: {}, call: (m, p, o) => call(port, m, p, o) };
  const init = await data.initOwner('ilse', 'Ilse');
  assert.equal(init.ok, true);
  const setup = await t.call('POST', '/api/auth/setup', { body: { token: init.token, password: PW } });
  assert.equal(setup.status, 200, setup.text);
  t.c.owner = cookieOf(setup, 'sf_session');
  t.users.owner = setup.json.user;
  t.join = async (name, { role = 'editor', books } = {}) => {
    const inv = await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role, ...(books === undefined ? {} : { books }) } });
    assert.equal(inv.status, 201, inv.text);
    const acc = await t.call('POST', '/api/auth/invite/accept', { body: { token: tokenOf(inv.json.link), username: name, display_name: name, password: PW } });
    assert.equal(acc.status, 200, acc.text);
    t.c[name] = cookieOf(acc, 'sf_session');
    t.users[name] = acc.json.user;
    return { cookie: t.c[name], user: acc.json.user };
  };
  /** The owner sets a member's per-book access. */
  t.setBooks = (name, books, extra = {}) => t.call('PUT', `/api/shared/members/${t.users[name].id}`, { cookie: t.c.owner, body: { books, ...extra } });
  return t;
}

/** A member limited to Salt Orchard Two (book A) as editor, set by the owner after the account exists. */
async function bootLimited(role = 'editor') {
  const t = await boot();
  await t.join('maren');
  const r = await t.setBooks('maren', { [SO]: role });
  assert.equal(r.status, 200, r.text);
  return t;
}

const get = (t, who, p) => t.call('GET', p, { cookie: t.c[who] });
const ids = (v) => JSON.stringify(v);
const sceneSha = async (t, book, scene) => (await get(t, 'owner', `/api/books/${book}/scenes/${scene}`)).json.sha256;
const read = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');

test('owner sets books: the member list shows them, the member\'s own session sees them on the next request', async () => {
  const t = await boot();
  const m = await t.join('maren');
  assert.equal((await get(t, 'maren', '/api/books')).json.length, 3, 'a new member has every book');
  const r = await t.setBooks('maren', { [SO]: 'editor' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true });
  const list = (await get(t, 'owner', '/api/shared/members')).json.members;
  assert.deepEqual(list.find((x) => x.user === m.user.id).books, { [SO]: 'editor' });
  assert.equal(list.find((x) => x.user === t.users.owner.id).books, null);
});

test('a limited member: GET /api/books lists only their book; their book is readable, the others are 403', async () => {
  const t = await bootLimited();
  const books = await get(t, 'maren', '/api/books');
  assert.equal(books.status, 200, books.text);
  assert.deepEqual(books.json.map((b) => b.id), [SO]);
  assert.equal(books.text.includes(LT) || books.text.includes(PR), false);

  assert.equal((await get(t, 'maren', `/api/books/${SO}`)).status, 200);
  assert.equal((await get(t, 'maren', `/api/books/${SO}/scenes/${SCENE_SO}`)).status, 200);
  for (const [book, scene] of [[LT, SCENE_LT], [PR, 'scene_01W1000000000000000000000F']]) {
    const b = await get(t, 'maren', `/api/books/${book}`);
    assert.equal(b.status, 403, b.text);
    const s = await get(t, 'maren', `/api/books/${book}/scenes/${scene}`);
    assert.equal(s.status, 403, s.text);
    assert.equal(s.text.includes('Ebb') || s.text.includes('Captain Vane'), false, 'no prose or title in the refusal');
    for (const sub of ['notes', 'codex/entries', 'diagnostics', 'export', 'cover', 'labels', 'link-targets']) {
      assert.equal((await get(t, 'maren', `/api/books/${book}/${sub}`)).status, 403, sub);
    }
  }
  // the owner still sees all three
  assert.equal((await get(t, 'owner', '/api/books')).json.length, 3);
});

test('a limited member: an encoded or padded form of another book id never reaches it', async () => {
  const t = await bootLimited();
  for (const p of [`/api/books/${LT.replace('_', '%5F')}`, `/api/books/${LT.replace('_', '%5f')}/scenes/${SCENE_LT}`, `/api/books/low-tide`, `/api/books/${LT}%2F`, `/api/books/%2e%2e/${LT}`]) {
    const r = await get(t, 'maren', p);
    assert.ok(r.status === 403 || r.status === 404, `${p} -> ${r.status}`);
    assert.equal(r.text.includes('Ebb') || r.text.includes('Low Tide'), false, p);
  }
});

test('search: a word in two books returns only the member\'s book; the book filter refuses another book', async () => {
  const t = await bootLimited();
  const owner = await get(t, 'owner', '/api/search?q=ledger&limit=100');
  assert.deepEqual([...new Set(owner.json.map((h) => h.book_id))].sort(), [LT, SO].sort(), 'the word is in both books (fixture check)');
  const r = await get(t, 'maren', '/api/search?q=ledger&limit=100');
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.length > 0);
  assert.deepEqual([...new Set(r.json.map((h) => h.book_id))], [SO]);
  assert.equal(r.text.includes(LT), false);
  const mine = await get(t, 'maren', `/api/search?q=ledger&book=${SO}`);
  assert.equal(mine.status, 200, mine.text);
  assert.ok(mine.json.length > 0);
  const other = await get(t, 'maren', `/api/search?q=ledger&book=${LT}`);
  assert.equal(other.status, 403, other.text);
  assert.equal(other.json.code, 'BOOK_ACCESS');
  assert.equal((await get(t, 'maren', `/api/search?q=ledger&book=${SO}&book=${LT}`)).status, 403, 'a repeated book parameter is checked in full');
  assert.equal((await get(t, 'maren', '/api/search?q=ledger&book=nonsense')).status, 403, 'a book that is not theirs, known or not');
});

test('status, index status and library name no other book', async () => {
  const t = await bootLimited();
  const owner = {
    status: await get(t, 'owner', '/api/status'),
    index: await get(t, 'owner', '/api/index/status'),
    library: await get(t, 'owner', '/api/library'),
  };
  assert.equal(owner.status.text.includes(LT), true, 'fixture check: the owner sees book B in status');
  assert.equal(owner.library.json.diagnostics.length > 0, true, 'fixture check: the library has diagnostics for book B');

  const status = await get(t, 'maren', '/api/status');
  assert.equal(status.status, 200, status.text);
  assert.deepEqual(status.json.books.map((b) => b.book_id), [SO]);
  assert.deepEqual(status.json.recover, { needsAttention: [], rolledBack: [] });
  const index = await get(t, 'maren', '/api/index/status');
  assert.equal(index.status, 200, index.text);
  assert.deepEqual(index.json.map((b) => b.book_id), [SO]);
  const library = await get(t, 'maren', '/api/library');
  assert.equal(library.status, 200, library.text);
  assert.deepEqual(library.json.series.map((s) => s.book_ids), [[SO]]);
  assert.deepEqual(library.json.diagnostics, []);
  for (const r of [status, index, library]) {
    assert.equal(r.text.includes(LT) || r.text.includes(PR) || r.text.includes('low-tide') || r.text.includes('pilgrims-road'), false, r.text.slice(0, 200));
  }
});

test('library with a series the member has no book in: the series is not listed at all', async () => {
  const t = await boot();
  await t.join('pat');
  assert.equal((await t.setBooks('pat', { [PR]: 'viewer' })).status, 200);
  const library = await get(t, 'pat', '/api/library');
  assert.equal(library.status, 200);
  assert.deepEqual(library.json.series, []);
  assert.equal(library.text.includes(SO) || library.text.includes('tidewater/'), false);
  assert.deepEqual((await get(t, 'pat', '/api/books')).json.map((b) => b.id), [PR]);
});

test('link-targets of their book list no other book', async () => {
  const t = await bootLimited();
  const owner = (await get(t, 'owner', `/api/books/${SO}/link-targets`)).json;
  assert.ok(owner.books.some((b) => b.id === LT), 'fixture check: the owner is offered book B');
  const r = await get(t, 'maren', `/api/books/${SO}/link-targets`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.books.some((b) => b.id === LT), false);
  assert.equal(r.text.includes(LT), false);
  assert.ok(r.json.series.items.length > 0, 'their own series entries are still listed');
  assert.ok(r.json.book.length > 0);
});

test('a limited editor writes to their book, not to another; library-wide writes are refused; refusals change nothing', async () => {
  const t = await bootLimited();
  const sha = await sceneSha(t, SO, SCENE_SO);
  const w = await t.call('PUT', `/api/books/${SO}/scenes/${SCENE_SO}/body`, { cookie: t.c.maren, body: { body: 'Maren wrote this.\n', base_sha256: sha } });
  assert.equal(w.status, 200, w.text);
  assert.match(await read(t.root, SO_SCENE_FILE), /Maren wrote this\./);
  const note = await t.call('POST', `/api/books/${SO}/notes`, { cookie: t.c.maren, body: { kind: 'research', title: 'An idea' } });
  assert.equal(note.status, 201, note.text);

  const before = await snap(t.root);
  const lt = await sceneSha(t, LT, SCENE_LT);
  const refused = [
    ['PUT', `/api/books/${LT}/scenes/${SCENE_LT}/body`, { body: 'Maren was here.\n', base_sha256: lt }],
    ['POST', `/api/books/${LT}/notes`, { kind: 'research', title: 'Sneaky' }],
    ['POST', `/api/books/${PR}/notes`, { kind: 'research', title: 'Sneaky' }],
    ['POST', `/api/books/${LT}/entries`, { type: 'character', name: 'Sneaky' }],
    ['POST', '/api/index/rebuild', {}],
    ['POST', '/api/index/rebuild', { book: SO }],
    ['POST', '/api/books', { title: 'A new book' }],
  ];
  for (const [method, p, body] of refused) {
    const r = await t.call(method, p, { cookie: t.c.maren, body });
    assert.equal(r.status, 403, `${method} ${p}: ${r.text}`);
  }
  assert.deepEqual(await snap(t.root), before, 'no refused write touched a file');
  assert.match(await read(t.root, LT_SCENE_FILE), /opened the ledger/);
  // the owner can still do what was refused
  assert.equal((await t.call('POST', '/api/index/rebuild', { cookie: t.c.owner, body: {} })).status, 200);
});

test('a limited member is also refused every admin route', async () => {
  const t = await bootLimited();
  for (const [method, p, body] of [
    ['GET', '/api/shared/members'],
    ['PUT', `/api/shared/members/${t.users.maren.id}`, { books: null }],
    ['POST', '/api/shared/invites', { role: 'viewer' }],
    ['GET', `/api/books/${SO}/backup`],
  ]) {
    const r = await t.call(method, p, { cookie: t.c.maren, body });
    assert.equal(r.status, 403, `${method} ${p}`);
  }
  assert.deepEqual((await t.setBooks('maren', { [SO]: 'editor' })).json, { ok: true });
  assert.deepEqual((await get(t, 'owner', '/api/shared/members')).json.members.find((m) => m.user === t.users.maren.id).books, { [SO]: 'editor' }, 'the self-grant attempt changed nothing');
});

test('a limited viewer: reads their book, every write to it is 403', async () => {
  const t = await bootLimited('viewer');
  assert.equal((await get(t, 'maren', `/api/books/${SO}/scenes/${SCENE_SO}`)).status, 200);
  assert.equal((await get(t, 'maren', `/api/books/${SO}/notes`)).status, 200);
  const sha = await sceneSha(t, SO, SCENE_SO);
  const before = await snap(t.root);
  const w = await t.call('PUT', `/api/books/${SO}/scenes/${SCENE_SO}/body`, { cookie: t.c.maren, body: { body: 'no\n', base_sha256: sha } });
  assert.equal(w.status, 403, w.text);
  assert.equal((await t.call('POST', `/api/books/${SO}/notes`, { cookie: t.c.maren, body: { kind: 'research', title: 'x' } })).status, 403);
  assert.deepEqual(await snap(t.root), before);
});

test('the per-book role beats the library role: an editor who is only a viewer on a book cannot write there, a viewer who is editor on it can', async () => {
  const t = await boot();
  await t.join('edview', { role: 'editor' });
  await t.join('viewed', { role: 'viewer' });
  assert.equal((await t.setBooks('edview', { [SO]: 'viewer' })).status, 200);
  assert.equal((await t.setBooks('viewed', { [SO]: 'editor' })).status, 200);
  const sha = await sceneSha(t, SO, SCENE_SO);
  const denied = await t.call('PUT', `/api/books/${SO}/scenes/${SCENE_SO}/body`, { cookie: t.c.edview, body: { body: 'x\n', base_sha256: sha } });
  assert.equal(denied.status, 403, denied.text);
  const ok = await t.call('PUT', `/api/books/${SO}/scenes/${SCENE_SO}/body`, { cookie: t.c.viewed, body: { body: 'Viewer made editor.\n', base_sha256: sha } });
  assert.equal(ok.status, 200, ok.text);
});

test('a limited reviewer: comments and suggests on their book only', async () => {
  const t = await bootLimited('reviewer');
  const sha = await sceneSha(t, SO, SCENE_SO);
  assert.equal((await t.call('PUT', `/api/books/${SO}/scenes/${SCENE_SO}/body`, { cookie: t.c.maren, body: { body: 'no\n', base_sha256: sha } })).status, 403);
  const sug = await t.call('POST', `/api/books/${SO}/suggestions`, { cookie: t.c.maren, body: { target: SCENE_SO, proposedText: 'Maren stepped onto the quay.\n', expect_sha256: sha } });
  assert.equal(sug.status, 201, sug.text);
  const other = await t.call('POST', `/api/books/${LT}/suggestions`, { cookie: t.c.maren, body: { target: SCENE_LT, proposedText: 'x\n' } });
  assert.equal(other.status, 403, other.text);
});

test('clearing the books (null) gives every book back on the very next request, no re-login; setting them again takes them away', async () => {
  const t = await bootLimited();
  assert.equal((await get(t, 'maren', `/api/books/${LT}`)).status, 403);
  const all = await t.setBooks('maren', null);
  assert.equal(all.status, 200, all.text);
  assert.deepEqual((await get(t, 'maren', '/api/books')).json.map((b) => b.id).sort(), [LT, PR, SO].sort());
  assert.equal((await get(t, 'maren', `/api/books/${LT}`)).status, 200);
  const sha = await sceneSha(t, LT, SCENE_LT);
  assert.equal((await t.call('PUT', `/api/books/${LT}/scenes/${SCENE_LT}/body`, { cookie: t.c.maren, body: { body: 'Back as an editor.\n', base_sha256: sha } })).status, 200);
  assert.equal((await t.call('POST', '/api/index/rebuild', { cookie: t.c.maren, body: {} })).status, 200, 'with every book the member is an ordinary editor again (index rebuild is an editor write)');

  assert.equal((await t.setBooks('maren', { [PR]: 'viewer' })).status, 200);
  assert.equal((await get(t, 'maren', `/api/books/${LT}`)).status, 403);
  assert.equal((await get(t, 'maren', `/api/books/${PR}`)).status, 200);
  assert.equal((await t.call('POST', `/api/books/${PR}/notes`, { cookie: t.c.maren, body: { kind: 'research', title: 'x' } })).status, 403);
  // an empty list is no book at all
  assert.equal((await t.setBooks('maren', {})).status, 200);
  assert.deepEqual((await get(t, 'maren', '/api/books')).json, []);
  assert.equal((await get(t, 'maren', `/api/books/${SO}`)).status, 403);
  assert.deepEqual((await get(t, 'maren', '/api/search?q=ledger')).json, []);
  assert.deepEqual((await get(t, 'maren', '/api/status')).json.books, []);
});

test('a member who signed in before the change is limited by it at once', async () => {
  const t = await boot();
  await t.join('maren');
  assert.equal((await get(t, 'maren', `/api/books/${LT}`)).status, 200);
  assert.equal((await t.setBooks('maren', { [SO]: 'editor' })).status, 200);
  assert.equal((await get(t, 'maren', `/api/books/${LT}`)).status, 403);
  const login = await t.call('POST', '/api/auth/login', { body: { username: 'maren', password: PW } });
  assert.equal(login.status, 200, login.text);
  assert.equal((await get(t, 'maren', '/api/books')).json.length, 1);
});

test('an invite with books: the accepted member is limited to those books with those roles', async () => {
  const t = await boot();
  const inv = await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role: 'editor', books: { [SO]: 'viewer', [PR]: 'editor' } } });
  assert.equal(inv.status, 201, inv.text);
  assert.deepEqual(inv.json.invite.books, { [SO]: 'viewer', [PR]: 'editor' });
  const acc = await t.call('POST', '/api/auth/invite/accept', { body: { token: tokenOf(inv.json.link), username: 'invited', display_name: 'Invited', password: PW } });
  assert.equal(acc.status, 200, acc.text);
  const cookie = cookieOf(acc, 'sf_session');
  const books = await t.call('GET', '/api/books', { cookie });
  assert.deepEqual(books.json.map((b) => b.id).sort(), [PR, SO].sort());
  assert.equal((await t.call('GET', `/api/books/${LT}`, { cookie })).status, 403);
  const sha = await sceneSha(t, SO, SCENE_SO);
  assert.equal((await t.call('PUT', `/api/books/${SO}/scenes/${SCENE_SO}/body`, { cookie, body: { body: 'x\n', base_sha256: sha } })).status, 403, 'viewer on SO');
  assert.equal((await t.call('POST', `/api/books/${PR}/notes`, { cookie, body: { kind: 'research', title: 'Mine' } })).status, 201, 'editor on PR');
  const members = (await get(t, 'owner', '/api/shared/members')).json.members;
  assert.deepEqual(members.find((m) => m.user === acc.json.user.id).books, { [SO]: 'viewer', [PR]: 'editor' });
});

test('an invite with a bad books map is refused and creates nothing', async () => {
  const t = await boot();
  const before = (await get(t, 'owner', '/api/shared/invites')).json.invites.length;
  for (const books of [{ [SO]: 'owner' }, { 'low-tide': 'editor' }, [SO], 'all', { [SO]: 'god' }]) {
    const r = await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role: 'editor', books } });
    assert.equal(r.status, 400, JSON.stringify(books));
    assert.equal(r.json.code, 'BAD_ARGS');
  }
  assert.equal((await get(t, 'owner', '/api/shared/invites')).json.invites.length, before);
});

test('PUT members: a bad books map is 400 and leaves the access as it was; an unknown member is 404; an empty body is 400', async () => {
  const t = await bootLimited();
  for (const books of [{ [SO]: 'owner' }, { 'low-tide': 'editor' }, [SO], 'all', 7]) {
    const r = await t.setBooks('maren', books);
    assert.equal(r.status, 400, JSON.stringify(books));
    assert.equal(r.json.code, 'BAD_ARGS');
  }
  assert.deepEqual((await get(t, 'maren', '/api/books')).json.map((b) => b.id), [SO], 'still limited to the same book');
  const missing = await t.call('PUT', '/api/shared/members/usr_NOPE', { cookie: t.c.owner, body: { books: null } });
  assert.equal(missing.status, 404);
  assert.equal((await t.call('PUT', `/api/shared/members/${t.users.maren.id}`, { cookie: t.c.owner, body: {} })).status, 400);
});

test('PUT members with role and books together applies both', async () => {
  const t = await bootLimited();
  const r = await t.setBooks('maren', { [SO]: 'editor', [LT]: 'viewer' }, { role: 'reviewer' });
  assert.equal(r.status, 200, r.text);
  const m = (await get(t, 'owner', '/api/shared/members')).json.members.find((x) => x.user === t.users.maren.id);
  assert.equal(m.role, 'reviewer');
  assert.deepEqual(m.books, { [SO]: 'editor', [LT]: 'viewer' });
  assert.deepEqual((await get(t, 'maren', '/api/books')).json.map((b) => b.id).sort(), [LT, SO].sort());
});

test('PUT members with a role only keeps the member\'s books', async () => {
  const t = await bootLimited();
  const r = await t.call('PUT', `/api/shared/members/${t.users.maren.id}`, { cookie: t.c.owner, body: { role: 'viewer' } });
  assert.equal(r.status, 200, r.text);
  const m = (await get(t, 'owner', '/api/shared/members')).json.members.find((x) => x.user === t.users.maren.id);
  assert.deepEqual(m.books, { [SO]: 'editor' });
  assert.deepEqual((await get(t, 'maren', '/api/books')).json.map((b) => b.id), [SO]);
});

test('an owner: books are refused with 409 OWNER_ALL_BOOKS; the last-owner rule is unchanged', async () => {
  const t = await boot();
  const own = await t.call('PUT', `/api/shared/members/${t.users.owner.id}`, { cookie: t.c.owner, body: { books: { [SO]: 'editor' } } });
  assert.equal(own.status, 409, own.text);
  assert.equal(own.json.code, 'OWNER_ALL_BOOKS');
  assert.equal((await t.call('PUT', `/api/shared/members/${t.users.owner.id}`, { cookie: t.c.owner, body: { books: null } })).status, 409);
  assert.equal((await get(t, 'owner', '/api/books')).json.length, 3);
  assert.equal((await get(t, 'owner', `/api/books/${LT}`)).status, 200);
  const demote = await t.call('PUT', `/api/shared/members/${t.users.owner.id}`, { cookie: t.c.owner, body: { role: 'editor' } });
  assert.equal(demote.status, 409);
  assert.equal(demote.json.code, 'LAST_OWNER');
  const remove = await t.call('DELETE', `/api/shared/members/${t.users.owner.id}`, { cookie: t.c.owner });
  assert.equal(remove.status, 409);
  assert.equal(remove.json.code, 'LAST_OWNER');
});

test('promoting a limited member to owner gives every book', async () => {
  const t = await bootLimited();
  const r = await t.call('PUT', `/api/shared/members/${t.users.maren.id}`, { cookie: t.c.owner, body: { role: 'owner' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await get(t, 'maren', '/api/books')).json.length, 3);
  assert.equal((await get(t, 'maren', `/api/books/${LT}`)).status, 200);
  assert.equal((await get(t, 'maren', '/api/shared/members')).status, 200);
});

test('a share link and its reader are untouched by book rules', async () => {
  const t = await boot();
  const sh = await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: LT, scope: 'read', expires_days: 30 } });
  assert.equal(sh.status, 201, sh.text);
  const used = await t.call('POST', '/api/auth/share', { body: { token: tokenOf(sh.json.link) } });
  const cookie = cookieOf(used, 'sf_share');
  assert.equal((await t.call('GET', `/api/books/${LT}/scenes/${SCENE_LT}`, { cookie })).status, 200);
  assert.equal((await t.call('GET', `/api/books/${SO}/scenes/${SCENE_SO}`, { cookie })).status, 403);
  assert.equal((await t.call('GET', '/api/books', { cookie })).status, 403);
});

test('the audit log records member.books with ids only, for a change and for a clear', async () => {
  const t = await bootLimited();
  await t.setBooks('maren', null);
  await t.setBooks('maren', { [SO]: 'viewer', [LT]: 'reviewer' });
  await t.setBooks('maren', {});
  await t.setBooks('maren', { [SO]: 'god' }); // refused, still on the record
  const lines = (await fs.readFile(path.join(t.dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const ev = lines.filter((l) => l.event === 'member.books');
  assert.equal(ev.length, 5, 'one event per request, the refused one included');
  assert.ok(ev.every((e) => e.actor === t.users.owner.id));
  assert.deepEqual(ev.map((e) => e.target), [
    `${t.users.maren.id}:${SO}=editor`,
    `${t.users.maren.id}:all`,
    `${t.users.maren.id}:${SO}=viewer,${LT}=reviewer`,
    `${t.users.maren.id}:none`,
    `${t.users.maren.id}:?`,
  ]);
  assert.deepEqual(ev.map((e) => e.result), [200, 200, 200, 200, 400]);
  const created = lines.filter((l) => l.event === 'invite.create');
  assert.ok(created.length >= 1);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// Series data: a limited member reads shared entries but may not change what every book of the series shares

/** A member limited to Salt Orchard Two (series tidewater) as `role`; the other book of the series, Low Tide, is not theirs. */
async function bootSeries(role = 'editor') {
  const t = await bootLimited(role);
  await t.join('everything', { role: role === 'viewer' ? 'editor' : role });
  return t;
}

const SERIES_REFUSAL = (r, what) => {
  assert.equal(r.status, 403, `${what}: ${r.text}`);
  assert.equal(r.json.code, 'SERIES_ACCESS', what);
};

test('series: a limited member reads shared entries of their book\'s series', async () => {
  const t = await bootSeries();
  const one = await get(t, 'maren', `/api/books/${SO}/entries/${ILSE}`);
  assert.equal(one.status, 200, one.text);
  assert.equal(one.json.shared, true);
  const list = await get(t, 'maren', `/api/books/${SO}/codex/entries`);
  assert.equal(list.status, 200);
  assert.equal(list.json.entries.find((e) => e.id === ILSE).shared, true);
});

test('series: a limited editor cannot change a shared entry (fields, body, slug, archive) or the files change', async () => {
  const t = await bootSeries();
  const seen = (await get(t, 'owner', `/api/books/${SO}/entries/${ILSE}`)).json;
  const before = await snap(t.root);
  const refusals = [
    ['POST', `/api/books/${SO}/entries/${ILSE}/fields`, { role: 'Lamp keeper' }],
    ['PUT', `/api/books/${SO}/entries/${ILSE}/body`, { body: `${seen.body}Sneaky.\n`, base_sha256: seen.sha256 }],
    ['POST', `/api/books/${SO}/entries/${ILSE}/slug`, { slug: 'ilse-h' }],
    ['POST', `/api/books/${SO}/entries/${ILSE}/archive`, {}],
  ];
  for (const [method, p, body] of refusals) SERIES_REFUSAL(await t.call(method, p, { cookie: t.c.maren, body }), `${method} ${p}`);
  assert.deepEqual(await snap(t.root), before);
  assert.doesNotMatch(await read(t.root, 'tidewater/codex/characters/ilse-hollis.md'), /Lamp keeper|Sneaky/);
});

test('series: where series, labels scope series, restore and move-to-series are refused for a limited member, and change nothing', async () => {
  const t = await bootSeries();
  const before = await snap(t.root);
  const refusals = [
    ['POST', `/api/books/${SO}/entries`, { type: 'character', name: 'Tobin Reyes', where: 'series' }],
    ['POST', `/api/books/${SO}/entries`, { type: 'character', name: 'Tobin Reyes', where: 'everywhere' }],
    ['POST', `/api/books/${SO}/labels`, { scope: 'series', labels: [{ name: 'Clue', color: '#E0A64B' }] }],
    ['POST', `/api/books/${SO}/labels`, { scope: 'galaxy', labels: [] }],
    ['POST', `/api/books/${SO}/entries/${MAREN}/move-to-series`, {}],
    ['POST', `/api/books/${SO}/entries/${MAREN}/move-to-series`, { dryRun: true }],
    ['POST', `/api/books/${SO}/entries/${ILSE}/restore`, {}],
    ['POST', `/api/books/${SO}/entries/restore`, {}],
  ];
  for (const [method, p, body] of refusals) SERIES_REFUSAL(await t.call(method, p, { cookie: t.c.maren, body }), `${method} ${p} ${JSON.stringify(body)}`);
  assert.deepEqual(await snap(t.root), before);
});

test('series: a limited member can still make and edit book-only entries and book labels', async () => {
  const t = await bootSeries();
  const made = await t.call('POST', `/api/books/${SO}/entries`, { cookie: t.c.maren, body: { type: 'character', name: 'Local One', where: 'book' } });
  assert.equal(made.status, 201, made.text);
  assert.equal(await fs.access(path.join(t.root, 'tidewater', 'salt-orchard-2', 'codex', 'characters', 'local-one.md')).then(() => true, () => false), true);
  const plain = await t.call('POST', `/api/books/${SO}/entries`, { cookie: t.c.maren, body: { type: 'character', name: 'Local Two' } });
  assert.equal(plain.status, 201, 'no where means the book');
  const edit = await t.call('POST', `/api/books/${SO}/entries/${MAREN}/fields`, { cookie: t.c.maren, body: { role: 'Cartographer' } });
  assert.equal(edit.status, 200, edit.text);
  assert.match(await read(t.root, 'tidewater/salt-orchard-2/codex/characters/maren-hollis.md'), /^role: Cartographer$/m);
  const seen = (await get(t, 'maren', `/api/books/${SO}/entries/${MAREN}`)).json;
  const body = await t.call('PUT', `/api/books/${SO}/entries/${MAREN}/body`, { cookie: t.c.maren, body: { body: `${seen.body}More.\n`, base_sha256: seen.sha256 } });
  assert.equal(body.status, 200, body.text);
  const labels = await t.call('POST', `/api/books/${SO}/labels`, { cookie: t.c.maren, body: { scope: 'book', labels: [{ name: 'Rewrite', color: '#C77DFF' }] } });
  assert.equal(labels.status, 200, labels.text);
  const noScope = await t.call('POST', `/api/books/${SO}/entries/${MAREN}/archive`, { cookie: t.c.maren, body: {} });
  assert.equal(noScope.status, 200, noScope.text);
});

test('series: a limited reviewer cannot suggest a change to a shared entry', async () => {
  const t = await bootSeries('reviewer');
  const before = await snap(t.root);
  const r = await t.call('POST', `/api/books/${SO}/suggestions`, { cookie: t.c.maren, body: { target: ILSE, proposedText: 'Changed for every book.\n' } });
  SERIES_REFUSAL(r, 'suggestion-create on a shared entry');
  assert.deepEqual(await snap(t.root), before);
});

test('series: the same actions by a member with every book work', async () => {
  const t = await bootSeries();
  const fields = await t.call('POST', `/api/books/${SO}/entries/${ILSE}/fields`, { cookie: t.c.everything, body: { role: 'Lamp keeper' } });
  assert.equal(fields.status, 200, fields.text);
  assert.match(await read(t.root, 'tidewater/codex/characters/ilse-hollis.md'), /^role: Lamp keeper$/m);
  const seen = (await get(t, 'everything', `/api/books/${LT}/entries/${ILSE}`)).json;
  const body = await t.call('PUT', `/api/books/${SO}/entries/${ILSE}/body`, { cookie: t.c.everything, body: { body: `${seen.body}Also here.\n`, base_sha256: seen.sha256 } });
  assert.equal(body.status, 200, body.text);
  const made = await t.call('POST', `/api/books/${SO}/entries`, { cookie: t.c.everything, body: { type: 'character', name: 'Tobin Reyes', where: 'series' } });
  assert.equal(made.status, 201, made.text);
  const labels = await t.call('POST', `/api/books/${SO}/labels`, { cookie: t.c.everything, body: { scope: 'series', labels: [{ name: 'Mystery', color: '#7B1FA2' }, { name: 'Clue', color: '#E0A64B' }] } });
  assert.equal(labels.status, 200, labels.text);
  const moved = await t.call('POST', `/api/books/${SO}/entries/${MAREN}/move-to-series`, { cookie: t.c.everything, body: {} });
  assert.equal(moved.status, 200, moved.text);
  assert.match(await read(t.root, 'tidewater/codex/characters/maren-hollis.md'), new RegExp(`^id: ${MAREN}$`, 'm'));
});

test('series: a member limited to a standalone book is not affected by series rules for their own entries', async () => {
  const t = await boot();
  await t.join('pat');
  assert.equal((await t.setBooks('pat', { [PR]: 'editor' })).status, 200);
  const made = await t.call('POST', `/api/books/${PR}/entries`, { cookie: t.c.pat, body: { type: 'character', name: 'Deckhand' } });
  assert.equal(made.status, 201, made.text);
  // a standalone book has no series: asking for one is refused, and for a limited member it is refused as a series write
  const series = await t.call('POST', `/api/books/${PR}/entries`, { cookie: t.c.pat, body: { type: 'character', name: 'Nobody', where: 'series' } });
  assert.equal(series.status, 403);
  assert.equal(ids(series.json.code), ids('SERIES_ACCESS'));
});
