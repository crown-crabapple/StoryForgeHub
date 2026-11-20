// H0 §2.0 / §8a: with a database attached every store write lands in the database first (one transaction), then on disk; a CONFLICT or a
// disk failure leaves both sides unchanged. Uses the real PGlite document store from @storyforge/db (tests may cross the layer).
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocumentStore, migrate, openDatabase } from '@storyforge/db';
import { __faults, attachDatabase, attachSharedDatabase, appendSharedLine, createTree, detachDatabase, detachSharedDatabase, moveTree, openStore, writeSharedJson } from '../src/index.mjs';
import { copyFixture, readOrNull, sha256, snapshot } from './helpers.mjs';

const db = await openDatabase('pglite:memory');
await migrate(db);
after(() => db.close());

let counter = 0;
const attached = [];
afterEach(() => {
  __faults.at = null;
  __faults.mode = 'throw';
  for (const root of attached.splice(0)) detachDatabase(root);
});

/** A fresh library row, the disk folder seeded into it, and the document store attached over `root` (wrapped so a test can watch the calls). */
async function attach(root, { wrap } = {}) {
  const docs = createDocumentStore(db, `lib-${++counter}`);
  await docs.ensureLibrary();
  const snap = await snapshot(root);
  const files = [];
  for (const rel of Object.keys(snap)) if (!rel.startsWith('.storyforge/')) files.push({ path: rel, before_sha256: null, bytes: await fs.readFile(path.join(root, rel)) });
  assert.deepEqual(await docs.applyOp({ opId: `seed-${counter}`, op: 'seed', files }), { ok: true });
  attachDatabase(root, wrap ? wrap(docs) : docs);
  attached.push(root);
  return docs;
}

/** Database bytes == disk bytes for every path (null == absent). */
async function assertMirrored(docs, root, rels) {
  for (const rel of rels) {
    const row = await docs.readFile(rel);
    const disk = await readOrNull(path.join(root, ...rel.split('/')));
    assert.equal(row ? row.sha256 : null, disk ? sha256(disk) : null, `database and disk agree at ${rel}`);
  }
}

const opNames = async (docs) => (await docs.listOps()).map((o) => o.op);
const WRITE = 'research/tidal-ranges.md';

test('write: the database holds the new bytes before the disk does, and both end identical', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const seen = [];
  const docs = await attach(root, {
    wrap: (d) => ({
      ...d,
      applyOp: async (c) => {
        seen.push({ op: c.op, disk: await readOrNull(path.join(root, WRITE)) });
        return d.applyOp(c);
      },
    }),
  });
  const store = await openStore(root);
  const cur = await store.read(WRITE);
  const next = Buffer.from('NEW tidal ranges\n');
  const r = await store.write(WRITE, next, { baseSha256: cur.sha256 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].op, 'write');
  assert.deepEqual(seen[0].disk, cur.bytes, 'the disk was still old when the database was written');
  assert.deepEqual((await docs.readFile(WRITE)).bytes, next);
  assert.deepEqual((await store.read(WRITE)).bytes, next);
  const ops = await docs.listOps();
  assert.equal(ops[0].op, 'write');
  assert.equal(ops[0].op_id, r.opId);
  assert.deepEqual(await docs.readTrash(r.opId, WRITE), cur.bytes, 'the replaced bytes are in the database trash');
});

test('create, move, archive, restore and remove all land in the database', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const docs = await attach(root);
  const store = await openStore(root);
  const touched = new Set([WRITE]);

  const created = await store.create('drafts/new/made.md', Buffer.from('# made\n'));
  assert.equal(created.ok, true, JSON.stringify(created));
  touched.add('drafts/new/made.md');
  assert.ok(await docs.readFile('drafts/new/made.md'));

  const cur = await store.read(WRITE);
  const moved = await store.move(WRITE, 'research/tides-moved.md', { baseSha256: cur.sha256 });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  touched.add('research/tides-moved.md');
  assert.equal(await docs.readFile(WRITE), null);

  const m = await store.read('research/tides-moved.md');
  const archived = await store.archive('research/tides-moved.md', { baseSha256: m.sha256 });
  assert.equal(archived.ok, true, JSON.stringify(archived));
  touched.add('archive/research/tides-moved.md');
  assert.ok(await docs.readFile('archive/research/tides-moved.md'));

  const a = await store.read('archive/research/tides-moved.md');
  const restored = await store.restore('archive/research/tides-moved.md', { baseSha256: a.sha256 });
  assert.equal(restored.ok, true, JSON.stringify(restored));
  assert.ok(await docs.readFile('research/tides-moved.md'));
  assert.equal(await docs.readFile('archive/research/tides-moved.md'), null);

  const r2 = await store.read('research/tides-moved.md');
  const removed = await store.batch('remove', {}, (tx) => tx.remove('research/tides-moved.md', { baseSha256: r2.sha256 }));
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(await docs.readFile('research/tides-moved.md'), null);
  assert.deepEqual(await docs.readTrash(removed.opId, 'research/tides-moved.md'), r2.bytes);

  await assertMirrored(docs, root, [...touched]);
  const names = await opNames(docs);
  for (const op of ['create', 'move', 'archive', 'restore', 'remove']) assert.ok(names.includes(op), `${op} was logged`);
});

test('a multi-file batch is one transaction', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const docs = await attach(root);
  const store = await openStore(root);
  const rels = ['codex/lore/saltmarks.md', 'codex/objects/ferry-bell.md'];
  const r = await store.batch('multi', { n: 2 }, async (tx) => {
    for (const rel of rels) {
      const cur = await tx.read(rel);
      const w = await tx.write(rel, Buffer.from(`BATCH ${rel}\n`), { baseSha256: cur.sha256 });
      if (!w.ok) return w;
    }
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ops = (await docs.listOps()).filter((o) => o.op === 'multi');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].files.length, 2);
  assert.deepEqual(ops[0].args, { n: 2 });
  await assertMirrored(docs, root, rels);
});

test('a database-side change behind the store back is a CONFLICT and the disk is untouched', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const docs = await attach(root);
  const store = await openStore(root);
  const cur = await store.read(WRITE);
  const row = await docs.readFile(WRITE);
  assert.deepEqual(await docs.applyOp({ opId: 'behind-1', op: 'other-writer', files: [{ path: WRITE, before_sha256: row.sha256, bytes: Buffer.from('someone else\n') }] }), { ok: true });
  const before = await snapshot(root);

  const r = await store.write(WRITE, Buffer.from('mine\n'), { baseSha256: cur.sha256 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CONFLICT');
  assert.equal(r.current.sha256, cur.sha256, 'current is what the disk holds');
  assert.deepEqual(await snapshot(root), before, 'nothing on disk changed (no journal, no trash)');
  assert.deepEqual((await docs.readFile(WRITE)).bytes, Buffer.from('someone else\n'));
});

test('a disk failure undoes the database change too', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const docs = await attach(root);
  const store = await openStore(root);
  const cur = await store.read(WRITE);
  __faults.at = 'after-tmp';
  const r = await store.write(WRITE, Buffer.from('never lands\n'), { baseSha256: cur.sha256 });
  __faults.at = null;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ROLLED_BACK');
  assert.equal(r.rollbackErrors, undefined);
  assert.deepEqual((await store.read(WRITE)).bytes, cur.bytes);
  assert.deepEqual((await docs.readFile(WRITE)).bytes, cur.bytes);
  const names = await opNames(docs);
  assert.ok(names.includes('write') && names.includes('rollback'), `both ops are in the log: ${names}`);
  const rb = (await docs.listOps()).find((o) => o.op === 'rollback');
  assert.equal(rb.op_id, `${r.opId}-rb`);
});

test('a rolled-back create and move leave the database as it was', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const docs = await attach(root);
  const store = await openStore(root);
  const cur = await store.read(WRITE);
  const rows = await docs.listFiles();
  __faults.at = 'after-rename';
  const c = await store.create('drafts/new/never.md', Buffer.from('x\n'));
  const m = await store.move(WRITE, 'research/never-moved.md', { baseSha256: cur.sha256 });
  __faults.at = null;
  assert.equal(c.code, 'ROLLED_BACK');
  assert.equal(m.code, 'ROLLED_BACK');
  assert.deepEqual(await docs.listFiles(), rows);
  await assertMirrored(docs, root, ['drafts/new/never.md', WRITE, 'research/never-moved.md']);
});

test('verify throwing rolls back the disk and the database', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const docs = await attach(root);
  const store = await openStore(root);
  const cur = await store.read(WRITE);
  const r = await store.batch('verified', {}, async (tx) => tx.write(WRITE, Buffer.from('rejected\n'), { baseSha256: cur.sha256 }), {
    verify: async () => {
      throw new Error('no good');
    },
  });
  assert.equal(r.code, 'ROLLED_BACK');
  assert.match(r.message, /no good/);
  assert.deepEqual((await store.read(WRITE)).bytes, cur.bytes);
  assert.deepEqual((await docs.readFile(WRITE)).bytes, cur.bytes);
  assert.ok((await opNames(docs)).includes('rollback'));
});

test('a failed database undo is reported in rollbackErrors', async () => {
  const root = await copyFixture('valid/salt-orchard');
  await attach(root, { wrap: (d) => ({ ...d, applyOp: async (c) => (c.op === 'rollback' ? { ok: false, code: 'CONFLICT', path: WRITE, current_sha256: null } : d.applyOp(c)) }) });
  const store = await openStore(root);
  const cur = await store.read(WRITE);
  __faults.at = 'after-tmp';
  const r = await store.write(WRITE, Buffer.from('x\n'), { baseSha256: cur.sha256 });
  __faults.at = null;
  assert.equal(r.code, 'ROLLED_BACK');
  assert.ok(r.rollbackErrors.some((e) => /database undo refused/.test(e)), JSON.stringify(r.rollbackErrors));
});

test('a database that throws fails the batch and the disk is untouched', async () => {
  const root = await copyFixture('valid/salt-orchard');
  await attach(root, {
    wrap: (d) => ({
      ...d,
      applyOp: async () => {
        throw new Error('connection lost');
      },
    }),
  });
  const store = await openStore(root);
  const cur = await store.read(WRITE);
  const before = await snapshot(root);
  const r = await store.write(WRITE, Buffer.from('x\n'), { baseSha256: cur.sha256 });
  assert.equal(r.ok, false);
  assert.match(r.message, /connection lost/);
  assert.deepEqual(await snapshot(root), before);
});

test('createTree puts every file of the new folder in the database, then on disk', async () => {
  const root = await copyFixture('valid/covers');
  const docs = await attach(root);
  const files = new Map();
  const src = path.join(root, 'north-road');
  for (const rel of Object.keys(await snapshot(src))) files.set(rel, await fs.readFile(path.join(src, ...rel.split('/'))));
  const seen = [];
  detachDatabase(root);
  attachDatabase(root, {
    ...docs,
    applyOp: async (c) => {
      seen.push({ op: c.op, onDisk: await readOrNull(path.join(root, 'copy-road', 'book.md')) });
      return docs.applyOp(c);
    },
  });

  const r = await createTree(root, 'copy-road', files);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(seen, [{ op: 'createTree', onDisk: null }], 'the database was written before the folder existed');
  await assertMirrored(docs, root, [...files.keys()].map((f) => `copy-road/${f}`));
  assert.equal((await docs.listOps())[0].op, 'createTree');
});

test('moveTree moves every row under the folder in one operation', async () => {
  const root = await copyFixture('valid/covers');
  const docs = await attach(root);
  const had = (await docs.listFiles()).filter((f) => f.path.startsWith('north-road/')).map((f) => f.path);
  assert.ok(had.length > 3);

  const r = await moveTree(root, 'north-road', 'harbour-lights/north-road');
  assert.equal(r.ok, true, JSON.stringify(r));
  const now = (await docs.listFiles()).map((f) => f.path);
  assert.equal(now.some((p) => p.startsWith('north-road/')), false);
  for (const p of had) assert.ok(now.includes(`harbour-lights/${p}`), p);
  await assertMirrored(docs, root, had.flatMap((p) => [p, `harbour-lights/${p}`]));
  const ops = (await docs.listOps()).filter((o) => o.op === 'moveTree');
  assert.equal(ops.length, 1);
  assert.equal(ops[0].files.length, had.length * 2);
});

test('moveTree refused (target exists) changes nothing in the database', async () => {
  const root = await copyFixture('valid/covers');
  const docs = await attach(root);
  const rows = await docs.listFiles();
  const r = await moveTree(root, 'north-road', 'old-draft');
  assert.equal(r.ok, false);
  assert.deepEqual(await docs.listFiles(), rows);
});

test('moveTree: a disk failure after the database step moves the rows back', async () => {
  const root = await copyFixture('valid/covers');
  const docs = await attach(root);
  const rows = await docs.listFiles();
  // fail the rename itself: a plain file where the new folder's parent should be makes the rename throw after the database step
  const spy = [];
  detachDatabase(root);
  attachDatabase(root, {
    ...docs,
    applyOp: async (c) => {
      spy.push(c.op);
      const r = await docs.applyOp(c);
      if (c.op === 'moveTree') await fs.mkdir(path.join(root, 'harbour-lights', 'north-road')); // the place "appears meanwhile"
      return r;
    },
  });
  const r = await moveTree(root, 'north-road', 'harbour-lights/north-road');
  assert.equal(r.code, 'ROLLED_BACK');
  assert.deepEqual(spy, ['moveTree', 'rollback']);
  assert.deepEqual(await docs.listFiles(), rows);
  assert.equal((await readOrNull(path.join(root, 'north-road', 'book.md'))) !== null, true);
});

test('removeEmptyDir removes the folder marker and the folder', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const docs = await attach(root);
  const store = await openStore(root);
  await docs.applyOp({ opId: 'marker-1', op: 'seed', files: [], dirs: { add: ['scratch-dir/'] } });
  await fs.mkdir(path.join(root, 'scratch-dir'));
  assert.ok((await docs.listFiles()).some((f) => f.path === 'scratch-dir/'));

  assert.equal(await store.removeEmptyDir('scratch-dir'), true);
  assert.equal((await docs.listFiles()).some((f) => f.path === 'scratch-dir/'), false);
  assert.ok((await opNames(docs)).includes('removeEmptyDir'));
  assert.equal(await store.exists('scratch-dir'), false);

  await fs.mkdir(path.join(root, 'full-dir'));
  await fs.writeFile(path.join(root, 'full-dir', 'a.md'), 'x');
  assert.equal(await store.removeEmptyDir('full-dir'), false);
  assert.equal(await store.exists('full-dir/a.md'), true);
});

test('revisions: save and prune are mirrored (book path is the store root, library-relative)', async () => {
  const root = await copyFixture('valid/covers');
  const docs = await attach(root);
  const book = await openStore(path.join(root, 'north-road'));
  const bytes = Buffer.from('scene text\n');
  const saved = await book.saveRevision('scn_one', bytes, { reason: 'manual', words: 2 });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.stored, true);
  const rows = await docs.listRevisions({ bookPath: 'north-road', sceneId: 'scn_one' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, saved.entry.file);
  assert.deepEqual(rows[0].bytes, bytes);
  assert.deepEqual(await book.readRevision('scn_one', saved.entry.file), bytes);

  const pruned = await book.pruneRevisions('scn_one', [saved.entry.file]);
  assert.equal(pruned.ok, true);
  assert.deepEqual(await docs.listRevisions({ bookPath: 'north-road' }), []);

  const lib = await openStore(root);
  const s2 = await lib.saveRevision('scn_two', bytes, { reason: 'manual' });
  assert.equal(s2.stored, true);
  assert.equal((await docs.listRevisions({ bookPath: '' })).length, 1, 'the library root is book path ""');
});

test('shared files: JSON documents and log lines are written to the database first', async () => {
  const docs = createDocumentStore(db, `lib-${++counter}`);
  await docs.ensureLibrary();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shared-'));
  attachSharedDatabase(dir, docs);
  try {
    await writeSharedJson(dir, 'users.json', { users: [1] });
    assert.deepEqual(await docs.readShared('users.json'), await fs.readFile(path.join(dir, 'users.json')));
    await writeSharedJson(dir, 'users.json', { users: [1, 2] });
    assert.deepEqual(await docs.readShared('users.json'), await fs.readFile(path.join(dir, 'users.json')));
    await appendSharedLine(dir, 'audit.jsonl', '{"n":1}');
    await appendSharedLine(dir, 'audit.jsonl', '{"n":2}');
    assert.deepEqual(await docs.readSharedLines('audit.jsonl'), ['{"n":1}', '{"n":2}']);
    assert.equal(await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');
  } finally {
    detachSharedDatabase(dir);
  }
});

test('no database attached: no database call is made', async () => {
  const calls = [];
  const spy = new Proxy({}, { get: (_t, name) => async () => (calls.push(String(name)), { ok: true }) });
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-elsewhere-'));
  attachDatabase(elsewhere, spy);
  attached.push(elsewhere);
  const root = await copyFixture('valid/salt-orchard');
  const store = await openStore(root);
  const cur = await store.read(WRITE);
  assert.equal((await store.write(WRITE, Buffer.from('plain\n'), { baseSha256: cur.sha256 })).ok, true);
  assert.equal((await store.create('drafts/plain.md', Buffer.from('p\n'))).ok, true);
  assert.equal((await store.saveRevision('scn_plain', Buffer.from('r\n'), { reason: 'manual' })).ok, true);
  assert.deepEqual(calls, []);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shared-'));
  await writeSharedJson(dir, 'settings.json', {});
  assert.deepEqual(calls, []);
});
