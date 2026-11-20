// Phase 1 startup proof (H0 section 8a): `serve --database` rebuilds the on-disk copy from the database, writes through to the database first, overwrites
// an outside edit and logs it, and refuses to start over a folder it must not touch. The server runs in this process over a `pglite:<folder>` database
// (apps/server/test/db-helpers.mjs); the last tests run the real command line.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { claimCopy, createDocumentStore, migrate, openDatabase } from '../../../packages/db/src/index.mjs';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { writeNewTree } from '../../../packages/store/src/index.mjs';
import { openSharedData } from '../../../packages/shared/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { createSharedGate } from '../src/shared-gate.mjs';
import { startDatabaseMode } from '../src/db-serve.mjs';
import { call, cookieOf, PW } from './shared-helpers.mjs';
import { close, listen } from './helpers.mjs';
import { asMember } from './plugin-helpers.mjs';
import { BOOK, BOOK_DIR, SCENE, SCENE_PATH, bootDb, closeAll, diskFiles, freshDatabaseUrl, importInto, tempDir } from './db-helpers.mjs';
import { runCli, startServer, waitFor } from './proc-helpers.mjs';

after(closeAll);

const absOf = (root, rel) => path.join(root, ...rel.split('/'));
const sceneUrl = `/api/books/${BOOK}/scenes/${SCENE}`;

/** The database's files (not folders) as path -> bytes, dot-paths left out the way diskFiles leaves them out. */
async function dbFiles(store) {
  const out = new Map();
  for (const f of await store.listFiles()) {
    if (f.path.endsWith('/') || f.path.split('/').some((s) => s.startsWith('.'))) continue;
    out.set(f.path, (await store.readFile(f.path)).bytes);
  }
  return out;
}

async function assertCopyMatches(t) {
  const want = await dbFiles(t.store);
  const have = await diskFiles(t.root);
  assert.ok(want.size > 50, `the fixture has files (${want.size})`);
  assert.deepEqual([...have.keys()].sort(), [...want.keys()].sort());
  for (const [p, bytes] of want) assert.ok(have.get(p).equals(bytes), `${p} differs from the database`);
}

test('an empty copy folder is rebuilt to match the database exactly, and the scene reads from it', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const t = await bootDb({ url });
  await assertCopyMatches(t);
  // the restore points came from the database too
  assert.ok((await fs.readdir(absOf(t.root, `${BOOK_DIR}/.storyforge/revisions`))).length > 0);
  const marker = JSON.parse(await fs.readFile(path.join(t.root, '.storyforge', 'db-copy.json'), 'utf8'));
  assert.equal(marker.library_id, 'main');
  assert.match(marker.database, /^pglite:/);
  const r = await t.member('GET', sceneUrl);
  assert.equal(r.status, 200, r.text);
  const fileText = (await t.store.readFile(SCENE_PATH)).bytes.toString('utf8');
  assert.ok(fileText.includes('The ferry nudged the jetty'));
  assert.ok(String(r.json.body).includes('The ferry nudged the jetty'), r.text.slice(0, 200));
  // the status report names the database without its URL
  const st = await t.member('GET', '/api/status');
  assert.equal(st.status, 200);
  assert.deepEqual(Object.keys(st.json.database).sort(), ['files', 'kind', 'library_id']);
  assert.equal(st.json.database.kind, 'pglite');
  assert.equal(st.json.database.library_id, 'main');
  assert.equal(st.json.database.files, (await t.store.listFiles()).filter((f) => !f.path.endsWith('/')).length);
  assert.ok(!st.text.includes('pglite:'));
  await t.stop();
});

test('a write through the API lands in the database and on disk', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const t = await bootDb({ url });
  const r = await t.member('POST', `/api/books/${BOOK}/entries`, { type: 'ship', name: 'Corvid Star' });
  assert.equal(r.status, 201, r.text);
  const rel = `${BOOK_DIR}/${r.json.path}`;
  const inDb = await t.store.readFile(rel);
  assert.ok(inDb, `${rel} is in the database`);
  const onDisk = await fs.readFile(absOf(t.root, rel));
  assert.ok(inDb.bytes.equals(onDisk));
  assert.match(onDisk.toString('utf8'), /Corvid Star/);
  const ops = await t.store.listOps({ limit: 3 });
  assert.ok(ops.some((o) => (o.files ?? []).some((f) => f.path === rel)), 'the change log has the write');
  await assertCopyMatches(t);
  await t.stop();
});

test('stop, delete one file and edit another in the copy, restart: both come back from the database', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const copy = await tempDir('sf-dbstart-copy-');
  const a = await bootDb({ url, copy });
  const original = (await a.store.readFile(SCENE_PATH)).bytes;
  const other = `${BOOK_DIR}/codex/characters/pell.md`;
  const otherBytes = (await a.store.readFile(other)).bytes;
  await a.stop();
  await fs.rm(absOf(copy, other));
  await fs.writeFile(absOf(copy, SCENE_PATH), 'scribbled over while the server was off\n');
  await fs.writeFile(absOf(copy, `${BOOK_DIR}/stray.md`), 'not in the database\n');
  const b = await bootDb({ url, copy });
  assert.ok((await fs.readFile(absOf(copy, other))).equals(otherBytes), 'the deleted file is back');
  assert.ok((await fs.readFile(absOf(copy, SCENE_PATH))).equals(original), 'the edited file is restored');
  await assert.rejects(fs.stat(absOf(copy, `${BOOK_DIR}/stray.md`)), { code: 'ENOENT' });
  await assertCopyMatches(b);
  await b.stop();
});

test('an edit made in the copy from outside while the server runs is overwritten from the database and logged', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const t = await bootDb({ url, watch: true });
  const original = (await t.store.readFile(SCENE_PATH)).bytes;
  const file = absOf(t.root, SCENE_PATH);
  await new Promise((r) => setTimeout(r, 300)); // let the watches settle
  await fs.writeFile(file, Buffer.concat([original, Buffer.from('\nSneaked in from an editor.\n')]));
  const line = `db: outside change to ${SCENE_PATH} overwritten from the database`;
  await waitFor(() => t.logs.includes(line), { what: `the log line (${t.logs.join(' | ')})` });
  await waitFor(async () => (await fs.readFile(file)).equals(original), { what: 'the file restored' });
  assert.equal(t.logs.filter((l) => l.startsWith('db: outside change')).length, 1, t.logs.join(' | '));
  const r = await t.member('GET', sceneUrl);
  assert.ok(!String(r.json.body).includes('Sneaked in'));
  assert.ok((await t.store.readFile(SCENE_PATH)).bytes.equals(original), 'the database never saw the edit');
  await t.stop();
});

test('refusals: a folder with files and no marker, a marker for another library, an empty database', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const mode = (o) => startDatabaseMode({ url, libraryRoot: o.dir, libraryId: o.libraryId, log: () => {} });

  const real = await tempDir('sf-dbstart-real-');
  await fs.writeFile(path.join(real, 'book.md'), '---\nschema: storyforge.book/v1\n---\n');
  await assert.rejects(mode({ dir: real }), /not a StoryForge database copy/);
  assert.equal(await fs.readFile(path.join(real, 'book.md'), 'utf8'), '---\nschema: storyforge.book/v1\n---\n', 'the real library is untouched');
  await assert.rejects(fs.stat(path.join(real, '.storyforge', 'db-copy.json')), { code: 'ENOENT' });

  const other = await tempDir('sf-dbstart-other-');
  assert.deepEqual(await claimCopy({ dir: other, libraryId: 'someone-else', database: 'x' }), { ok: true });
  await assert.rejects(mode({ dir: other }), /on-disk copy of library "someone-else", not "main"/);

  const emptyUrl = await freshDatabaseUrl();
  const db = await openDatabase(emptyUrl);
  await migrate(db);
  await createDocumentStore(db, 'main').ensureLibrary();
  await db.close();
  const fresh = await tempDir('sf-dbstart-fresh-');
  await assert.rejects(startDatabaseMode({ url: emptyUrl, libraryRoot: fresh, log: () => {} }), /has no files: run `storyforge db import/);
  // the wrong library id in a good database is the same refusal
  await assert.rejects(startDatabaseMode({ url, libraryId: 'nope', libraryRoot: fresh, log: () => {} }), /has no files/);
  // the database was released each time: the good one still starts
  const ok = await bootDb({ url, copy: await tempDir('sf-dbstart-ok-') });
  await ok.stop();
});

test('writeNewTree into an attached library lands in the database in one operation; a taken place and a disk failure leave nothing behind', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const t = await bootDb({ url });
  const target = absOf(t.root, '_templates/demo');
  const files = [['template.md', Buffer.from('---\nschema: storyforge.template/v1\n---\nhi\n')], ['book/notes/readme.md', Buffer.from('notes\n')]];
  const opsBefore = (await t.store.listOps({ limit: 50 })).length;
  const r = await writeNewTree(target, () => files);
  assert.deepEqual(r, { ok: true, files: 2 });
  for (const [rel, bytes] of files) {
    assert.ok((await t.store.readFile(`_templates/demo/${rel}`)).bytes.equals(bytes), rel);
    assert.ok((await fs.readFile(absOf(target, rel))).equals(bytes), rel);
  }
  const ops = await t.store.listOps({ limit: 50 });
  assert.equal(ops.length, opsBefore + 1, 'one operation for the whole tree');
  assert.equal(ops[0].op, 'writeNewTree');
  assert.equal(ops[0].files.length, 2);

  // taken on disk
  assert.deepEqual(await writeNewTree(target, () => files), { ok: false, code: 'TARGET_NOT_EMPTY' });
  // taken in the database only (the disk folder is gone): CONFLICT is TARGET_NOT_EMPTY and the disk stays empty
  await fs.rm(target, { recursive: true });
  assert.deepEqual(await writeNewTree(target, () => files), { ok: false, code: 'TARGET_NOT_EMPTY' });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });

  // a disk failure after the database commit undoes the database side ("a" is both a file and a folder: fine for the database, impossible on disk)
  const bad = absOf(t.root, '_templates/broken');
  await assert.rejects(writeNewTree(bad, () => [['a', Buffer.from('x')], ['a/b', Buffer.from('y')]]));
  assert.equal(await t.store.readFile('_templates/broken/a'), null);
  assert.equal(await t.store.readFile('_templates/broken/a/b'), null);
  await assert.rejects(fs.stat(bad), { code: 'ENOENT' });
  await t.stop();
});

test('shared mode with a database: a shared write (an invite) updates the shared_doc row', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const sharedDir = await tempDir('sf-dbstart-shared-');
  const copy = await tempDir('sf-dbstart-copy-');
  const mode = await startDatabaseMode({ url, libraryRoot: copy, sharedDir, log: () => {} });
  const data = await openSharedData(sharedDir);
  const gate = createSharedGate({ data, publicUrl: null, bindHost: '127.0.0.1', aiForMembers: () => false, audit: () => {} });
  const repository = createFsRepository(copy, { watch: false, pollMs: 0, onOutsideChange: mode.onOutsideChange });
  const server = createServer({ repository, shared: { gate, data, settings: { get: () => ({ ai_for_members: false }) }, audit: () => {}, publicUrl: null, dir: sharedDir }, database: mode.status });
  const port = await listen(server);
  try {
    assert.equal(await mode.store.readShared('invites.json'), null, 'nothing shared in the database yet');
    const init = await data.initOwner('ilse', 'Ilse');
    assert.equal(init.ok, true);
    assert.ok(await mode.store.readShared('members.json'), 'initOwner went to the database');
    const setup = await call(port, 'POST', '/api/auth/setup', { body: { token: init.token, password: PW } });
    assert.equal(setup.status, 200, setup.text);
    const owner = cookieOf(setup, 'sf_session');
    const inv = await call(port, 'POST', '/api/shared/invites', { cookie: owner, body: { role: 'editor' } });
    assert.equal(inv.status, 201, inv.text);
    const row = await mode.store.readShared('invites.json');
    assert.ok(row, 'the invites document is in shared_doc');
    const onDisk = await fs.readFile(path.join(sharedDir, 'invites.json'));
    assert.ok(row.equals(onDisk), 'database and disk agree');
    const st = await call(port, 'GET', '/api/status', { cookie: owner });
    assert.equal(st.json.database.kind, 'pglite');
  } finally {
    await close(server);
    await repository.close?.();
    await mode.close();
  }
});

test('the command line: refusals exit 2 and never print a password; shared mode finds no owner in a database without shared data', async () => {
  const real = await tempDir('sf-dbstart-real-');
  await fs.writeFile(path.join(real, 'book.md'), 'x\n');
  const url = await freshDatabaseUrl();
  await importInto(url);
  const nonEmpty = await runCli(['serve', '--library', real, '--database', url, '--port', '0']);
  assert.equal(nonEmpty.code, 2, nonEmpty.output);
  assert.match(nonEmpty.stderr, /not a StoryForge database copy/);

  const down = await runCli(['serve', '--library', await tempDir('sf-dbstart-copy-'), '--database', 'postgres://writer:hunter2@127.0.0.1:1/storyforge', '--port', '0']);
  assert.equal(down.code, 2, down.output);
  assert.match(down.stderr, /writer:\*\*\*@/);
  assert.ok(!down.output.includes('hunter2'));

  assert.equal((await runCli(['serve', '--library-id', 'x', '--port', '0'])).code, 2);

  const shared = await runCli(['serve', '--shared', '--library', await tempDir('sf-dbstart-copy-'), '--database', url, '--shared-data', await tempDir('sf-dbstart-sd-'), '--port', '0']);
  assert.equal(shared.code, 2, shared.output);
  assert.match(shared.stderr, /no owner yet/);
});

test('the command line: serve --database starts, serves the scene and the status, and a write is in the database after the process is gone', async () => {
  const url = await freshDatabaseUrl();
  await importInto(url);
  const copy = await tempDir('sf-dbstart-copy-');
  const proc = await startServer(copy, ['--database', url]);
  let written;
  try {
    const scene = await asMember(proc.port, 'GET', sceneUrl);
    assert.equal(scene.status, 200, scene.text);
    assert.ok(String(scene.json.body).includes('The ferry nudged the jetty'));
    const st = await asMember(proc.port, 'GET', '/api/status');
    assert.equal(st.json.database.library_id, 'main');
    const made = await asMember(proc.port, 'POST', `/api/books/${BOOK}/entries`, { type: 'ship', name: 'Process Star' });
    assert.equal(made.status, 201, made.text);
    written = `${BOOK_DIR}/${made.json.path}`;
  } finally {
    await proc.stop();
  }
  const db = await openDatabase(url);
  try {
    const store = createDocumentStore(db, 'main');
    assert.match((await store.readFile(written))?.bytes.toString('utf8') ?? '', /Process Star/);
  } finally {
    await db.close();
  }
});
