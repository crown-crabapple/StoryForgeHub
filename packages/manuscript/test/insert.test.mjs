// Acceptance 2 (insert) and 3 (insert with no gap).
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { insertScene } from '../src/index.mjs';
import {
  ARRIVAL, CH1, CH2, CH3, FERRY, GRAFTING, KEY, LOWTIDE, P, PROLOGUE, SALT, WALL,
  bodies, cleanup, copyFixture, diagnosticsOf, diffSnap, edit, errorsOf, orderIds, orderRows, read, rename,
  snapshot, trashFiles, withBody,
} from './helpers.mjs';

after(cleanup);

const BODY = 'A brand new scene.\n\n<!-- note: keep me -->\n';
const ULID_ID = /^scene_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Insert into a fresh salt-orchard copy and check everything that should be true of any insert. */
async function insertAndCheck(args, { expectPath, expectLines }) {
  const dir = copyFixture(SALT);
  const before = snapshot(dir);
  const bodiesBefore = bodies(dir);
  const r = await insertScene(dir, { title: 'New One', slug: 'new-one', body: BODY, ...args });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'OK');
  assert.ok(r.changes.length >= 1);
  // all other files byte-identical: only the new file was added
  assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [expectPath], removed: [], changed: [] });
  assert.deepEqual(bodies(dir), withBody(bodiesBefore, BODY));
  const text = read(dir, expectPath);
  for (const line of expectLines) assert.match(text, new RegExp(`^${line}\\r?$`, 'm'), line);
  assert.ok(text.endsWith(BODY), 'body written verbatim');
  assert.deepEqual(await errorsOf(dir), []);
  assert.deepEqual(await diagnosticsOf(dir), [], 'no warnings either: path and prefix are canonical');
  return dir;
}

describe('insertScene (acceptance 2)', () => {
  it('after the first scene of chapter 1 takes the midpoint sequence 15', async () => {
    const dir = await insertAndCheck(
      { chapter: 1, after: ARRIVAL },
      {
        expectPath: `${CH1}/0015-new-one.md`,
        expectLines: ['sequence: 15', 'chapter: 1', 'act: 1', 'title: "?New One"?', 'status: drafting'],
      },
    );
    const ids = await orderIds(dir);
    assert.deepEqual(ids.filter((i) => i !== ids[2]), [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL]);
    assert.match(ids[2], ULID_ID);
    assert.ok(
      trashFiles(dir).some((f) => /^\.storyforge\/trash\/\d{8}T\d{9}Z-[0-9A-Z]{6}\/op\.json$/.test(f)),
      'an op.json is recorded in the trash',
    );
  });

  it('at the start of chapter 1 (after: null) takes floor(10/2) = 5', async () => {
    const dir = await insertAndCheck(
      { chapter: 1, after: null },
      { expectPath: `${CH1}/0005-new-one.md`, expectLines: ['sequence: 5', 'chapter: 1', 'act: 1'] },
    );
    const ids = await orderIds(dir);
    assert.deepEqual(ids.filter((i) => i !== ids[1]), [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL]);
    assert.match(ids[1], ULID_ID);
  });

  it('at the end of chapter 3 takes prev + 10 and inherits act 2 and its folder', async () => {
    const dir = await insertAndCheck(
      { chapter: 3, after: WALL, status: 'outline' },
      { expectPath: `${CH3}/0030-new-one.md`, expectLines: ['sequence: 30', 'chapter: 3', 'act: 2', 'status: outline'] },
    );
    const ids = await orderIds(dir);
    assert.deepEqual(ids.slice(0, 7), [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL]);
    assert.match(ids[7], ULID_ID);
    assert.equal(ids.length, 8);
  });

  it('honours an explicit id and places the scene between two chapter-2 scenes', async () => {
    const dir = copyFixture(SALT);
    const id = 'scene_01S50000000000000000000099';
    const r = await insertScene(dir, { chapter: 2, after: FERRY, title: 'T', slug: 'mid', body: 'x\n', id });
    assert.equal(r.code, 'OK');
    assert.deepEqual(await orderIds(dir), [PROLOGUE, ARRIVAL, KEY, FERRY, id, GRAFTING, LOWTIDE, WALL]);
    assert.match(read(dir, `${CH2}/0015-mid.md`), new RegExp(`^id: ${id}\\r?$`, 'm'));
  });

  it('two inserts at the same anchor keep the expected order and never collide', async () => {
    const dir = copyFixture(SALT);
    assert.equal((await insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'A', slug: 'aa', body: 'a\n' })).code, 'OK');
    assert.equal((await insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'B', slug: 'bb', body: 'b\n' })).code, 'OK');
    const rows = (await orderRows(dir)).filter((s) => s.chapter === 1);
    assert.deepEqual(rows.map((s) => s.title), ['Arrival', 'B', 'A', 'The Key']);
    assert.deepEqual(rows.map((s) => s.sequence), [10, 12, 15, 20]);
    assert.deepEqual(await errorsOf(dir), []);
  });
});

describe('insertScene with no gap (acceptance 3)', () => {
  /** chapter 2 prepared as sequences 10, 11 (front matter and filename edited in the copy). */
  function prepared() {
    const dir = copyFixture(SALT);
    edit(dir, P.GRAFTING, (t) => t.replace(/^sequence: 20$/m, 'sequence: 11'));
    rename(dir, P.GRAFTING, `${CH2}/0011-the-grafting.md`);
    return dir;
  }

  it('renumbers the chapter and puts the new scene in the middle; bodies untouched', async () => {
    const dir = prepared();
    assert.deepEqual((await orderRows(dir)).filter((s) => s.chapter === 2).map((s) => s.sequence), [10, 11]);
    assert.deepEqual(await diagnosticsOf(dir), []);

    const before = snapshot(dir);
    const bodiesBefore = bodies(dir);
    const r = await insertScene(dir, { chapter: 2, after: FERRY, title: 'Mid', slug: 'mid', body: BODY });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, 'OK');

    const rows = (await orderRows(dir)).filter((s) => s.chapter === 2);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, FERRY);
    assert.equal(rows[1].title, 'Mid');
    assert.equal(rows[2].id, GRAFTING);
    assert.deepEqual(rows.map((s) => s.sequence), [10, 15, 20]);
    assert.deepEqual(rows.map((s) => s.path), [`${CH2}/0010-ferry.md`, `${CH2}/0015-mid.md`, `${CH2}/0020-the-grafting.md`]);

    assert.deepEqual(bodies(dir), withBody(bodiesBefore, BODY));
    assert.deepEqual(diffSnap(before, snapshot(dir)), {
      added: [`${CH2}/0015-mid.md`, `${CH2}/0020-the-grafting.md`],
      removed: [`${CH2}/0011-the-grafting.md`],
      changed: [],
    });
    assert.deepEqual(await errorsOf(dir), []);
    assert.deepEqual(await diagnosticsOf(dir), []);
    assert.ok(trashFiles(dir).some((f) => f.endsWith(`${CH2}/0011-the-grafting.md`)), 'old file kept in trash');
  });

  it('touches no other chapter', async () => {
    const dir = prepared();
    const before = snapshot(dir);
    await insertScene(dir, { chapter: 2, after: FERRY, title: 'Mid', slug: 'mid', body: 'm\n' });
    const d = diffSnap(before, snapshot(dir));
    const all = [...d.added, ...d.removed, ...d.changed];
    assert.ok(all.length > 0);
    for (const p of all) assert.ok(p.startsWith(`${CH2}/`), p);
  });
});

describe('insertScene origin (M12 W6)', () => {
  it('writes origin: ai after the status line, validates, and refuses any other origin before writing', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const bad = await insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'X', slug: 'x', body: 'x\n', origin: 'robot' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'REFUSED_BAD_ARGS');
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [], removed: [], changed: [] });
    const r = await insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'Machine', slug: 'machine', body: BODY, status: 'drafting', origin: 'ai' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(read(dir, r.path), /^status: drafting\r?\norigin: ai\r?\n/m);
    assert.deepEqual(await errorsOf(dir), []);
    const plain = await insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'Plain', slug: 'plain', body: BODY });
    assert.doesNotMatch(read(dir, plain.path), /origin:/);
  });
});
