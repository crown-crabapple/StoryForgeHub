// Acceptance 4 (move, drag-equivalent).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { moveScene } from '../src/index.mjs';
import {
  ARRIVAL, CH1, CH2, CH3, FERRY, GRAFTING, KEY, LOWTIDE, P, PROLOGUE, SALT, WALL,
  bodies, cleanup, copyFixture, diagnosticsOf, diffSnap, errorsOf, exists, orderIds, orderRows, read, snapshot, trashFiles, write,
} from './helpers.mjs';

after(cleanup);

describe('moveScene (acceptance 4)', () => {
  it('chapter 1 -> after a scene in chapter 3: new chapter/act/sequence, canonical path, old path only in trash', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const bodiesBefore = bodies(dir);
    const oldText = read(dir, P.KEY);

    const r = await moveScene(dir, KEY, { chapter: 3, after: LOWTIDE });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.code, 'OK');
    assert.ok(r.changes.length >= 1);

    assert.deepEqual(await orderIds(dir), [PROLOGUE, ARRIVAL, FERRY, GRAFTING, LOWTIDE, KEY, WALL]);
    const newPath = `${CH3}/0015-the-key.md`;
    assert.deepEqual(diffSnap(before, snapshot(dir)), { added: [newPath], removed: [P.KEY], changed: [] });
    assert.deepEqual(bodies(dir), bodiesBefore, 'every body identical');

    // only the act/chapter/sequence lines differ
    const expected = oldText
      .replace(/^act: 1$/m, 'act: 2')
      .replace(/^chapter: 1$/m, 'chapter: 3')
      .replace(/^sequence: 20$/m, 'sequence: 15');
    assert.equal(read(dir, newPath), expected);

    assert.equal(exists(dir, P.KEY), false, 'old path gone from the book');
    assert.ok(trashFiles(dir).some((f) => f.endsWith(`/${P.KEY}`)), 'old file preserved in trash');
    assert.deepEqual(await errorsOf(dir), []);
    assert.deepEqual(await diagnosticsOf(dir), []);
  });

  it('within a chapter to the first position (after: null) takes floor(10/2) = 5', async () => {
    const dir = copyFixture(SALT);
    const before = snapshot(dir);
    const bodiesBefore = bodies(dir);
    const r = await moveScene(dir, GRAFTING, { chapter: 2, after: null });
    assert.equal(r.code, 'OK', JSON.stringify(r));
    assert.deepEqual(await orderIds(dir), [PROLOGUE, ARRIVAL, KEY, GRAFTING, FERRY, LOWTIDE, WALL]);
    assert.deepEqual(diffSnap(before, snapshot(dir)), {
      added: [`${CH2}/0005-the-grafting.md`],
      removed: [P.GRAFTING],
      changed: [],
    });
    assert.deepEqual(bodies(dir), bodiesBefore);
    assert.match(read(dir, `${CH2}/0005-the-grafting.md`), /^sequence: 5\r?$/m);
    assert.ok(trashFiles(dir).some((f) => f.endsWith(`/${P.GRAFTING}`)));
    assert.deepEqual(await diagnosticsOf(dir), []);
  });

  it('within a chapter to the last position takes prev + 10', async () => {
    const dir = copyFixture(SALT);
    const r = await moveScene(dir, ARRIVAL, { chapter: 1, after: KEY });
    assert.equal(r.code, 'OK', JSON.stringify(r));
    assert.deepEqual(await orderIds(dir), [PROLOGUE, KEY, ARRIVAL, FERRY, GRAFTING, LOWTIDE, WALL]);
    assert.ok(exists(dir, `${CH1}/0030-arrival.md`));
    assert.equal(exists(dir, P.ARRIVAL), false);
  });

  it('preserves CRLF line endings byte-for-byte; only the sequence line changes', async () => {
    const dir = copyFixture(SALT);
    const crlf = read(dir, P.KEY).replace(/\r?\n/g, '\r\n');
    write(dir, P.KEY, crlf);
    assert.deepEqual(await orderIds(dir), [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL]);
    const r = await moveScene(dir, KEY, { chapter: 1, after: null });
    assert.equal(r.code, 'OK', JSON.stringify(r));
    const out = fs.readFileSync(path.join(dir, ...`${CH1}/0005-the-key.md`.split('/')), 'latin1');
    assert.equal(out, crlf.replace('sequence: 20\r\n', 'sequence: 5\r\n'));
  });

  it('keeps unknown front-matter keys and their order (never re-serialises YAML)', async () => {
    const dir = copyFixture(SALT);
    const text = read(dir, P.KEY).replace(/^status: drafting$/m, 'x-weird:   [ 1,2 ]   # keep me\nstatus: drafting');
    write(dir, P.KEY, text);
    const r = await moveScene(dir, KEY, { chapter: 3, after: WALL });
    assert.equal(r.code, 'OK', JSON.stringify(r));
    const out = read(dir, `${CH3}/0030-the-key.md`);
    assert.ok(out.includes('x-weird:   [ 1,2 ]   # keep me\nstatus: drafting'));
  });
});
