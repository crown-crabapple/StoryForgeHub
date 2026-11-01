// Acceptance 6 (duplicate-sequence book refused) and 10 (unsimple field), plus the documented refusal codes.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { insertScene, moveScene, renumberChapter } from '../src/index.mjs';
import {
  ARRIVAL, CH1, KEY, LOWTIDE, P, SALT,
  cleanup, copyFixture, diffSnap, edit, snapshot, write,
} from './helpers.mjs';

after(cleanup);

const E204 = 'invalid/E204-duplicate-sequence';
const A = 'scene_01CS0000000000000000000002';
const B = 'scene_01CS0000000000000000000003';

async function untouched(dir, fn, expectCode) {
  const before = snapshot(dir);
  const r = await fn();
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, expectCode, JSON.stringify(r));
  assert.ok(Array.isArray(r.changes));
  assert.deepEqual(r.changes, []);
  assert.deepEqual(diffSnap(before, snapshot(dir), { trash: true }), { added: [], removed: [], changed: [] }, 'nothing written, not even trash');
  return r;
}

describe('refuse on a broken book (acceptance 6)', () => {
  it('insertScene refuses with REFUSED_INVALID_BOOK and the diagnostics', async () => {
    const dir = copyFixture(E204);
    const r = await untouched(dir, () => insertScene(dir, { chapter: 1, act: 1, after: A, title: 'N', slug: 'n', body: 'b\n' }), 'REFUSED_INVALID_BOOK');
    assert.ok(r.diagnostics.some((d) => d.code === 'E204'));
  });

  it('moveScene refuses with REFUSED_INVALID_BOOK', async () => {
    const dir = copyFixture(E204);
    const r = await untouched(dir, () => moveScene(dir, B, { chapter: 1, after: null }), 'REFUSED_INVALID_BOOK');
    assert.ok(r.diagnostics.some((d) => d.code === 'E204'));
  });

  it('renumberChapter refuses with REFUSED_INVALID_BOOK', async () => {
    const dir = copyFixture(E204);
    const r = await untouched(dir, () => renumberChapter(dir, 1), 'REFUSED_INVALID_BOOK');
    assert.ok(r.diagnostics.some((d) => d.code === 'E204'));
  });

  it('a scene with unparseable front matter (E100) also blocks writes', async () => {
    const dir = copyFixture('invalid/E100-bad-yaml');
    await untouched(dir, () => renumberChapter(dir, 1), 'REFUSED_INVALID_BOOK');
  });

  it('warnings do not block', async () => {
    const dir = copyFixture('valid/spec-example'); // W201 + W202 only
    const r = await renumberChapter(dir, 3);
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe('unsimple field (acceptance 10)', () => {
  const dest = { chapter: 3, after: LOWTIDE };

  it('`sequence: 20 # note` -> REFUSED_UNSIMPLE_FIELD, nothing written', async () => {
    const dir = copyFixture(SALT);
    edit(dir, P.KEY, (t) => t.replace(/^sequence: 20$/m, 'sequence: 20 # note'));
    await untouched(dir, () => moveScene(dir, KEY, dest), 'REFUSED_UNSIMPLE_FIELD');
  });

  it('`sequence: "20"` -> REFUSED_UNSIMPLE_FIELD, nothing written', async () => {
    const dir = copyFixture(SALT);
    edit(dir, P.KEY, (t) => t.replace(/^sequence: 20$/m, 'sequence: "20"'));
    await untouched(dir, () => moveScene(dir, KEY, dest), 'REFUSED_UNSIMPLE_FIELD');
  });

  it('`chapter: 1 # note` is also refused when the move rewrites chapter', async () => {
    const dir = copyFixture(SALT);
    edit(dir, P.KEY, (t) => t.replace(/^chapter: 1$/m, 'chapter: 1 # note'));
    await untouched(dir, () => moveScene(dir, KEY, dest), 'REFUSED_UNSIMPLE_FIELD');
  });
});

describe('other documented refusal codes', () => {
  it('REFUSED_UNKNOWN_SCENE for a move of an id that does not exist', async () => {
    const dir = copyFixture(SALT);
    await untouched(dir, () => moveScene(dir, 'scene_01S5000000000000000000ZZZZ', { chapter: 1, after: null }), 'REFUSED_UNKNOWN_SCENE');
  });

  it('REFUSED_BAD_ANCHOR when `after` is not in the target chapter (move)', async () => {
    const dir = copyFixture(SALT);
    await untouched(dir, () => moveScene(dir, KEY, { chapter: 3, after: ARRIVAL }), 'REFUSED_BAD_ANCHOR');
  });

  it('REFUSED_BAD_ANCHOR when `after` is not in the target chapter (insert)', async () => {
    const dir = copyFixture(SALT);
    await untouched(dir, () => insertScene(dir, { chapter: 3, after: ARRIVAL, title: 'N', slug: 'n', body: 'b\n' }), 'REFUSED_BAD_ANCHOR');
  });

  it('REFUSED_BAD_ANCHOR when `after` is an id that does not exist', async () => {
    const dir = copyFixture(SALT);
    await untouched(dir, () => insertScene(dir, { chapter: 1, after: 'scene_01S5000000000000000000ZZZZ', title: 'N', slug: 'n', body: 'b\n' }), 'REFUSED_BAD_ANCHOR');
  });

  it('REFUSED_UNKNOWN_CHAPTER for an insert into an empty chapter with no act given', async () => {
    const dir = copyFixture(SALT);
    await untouched(dir, () => insertScene(dir, { chapter: 9, after: null, title: 'N', slug: 'n', body: 'b\n' }), 'REFUSED_UNKNOWN_CHAPTER');
  });

  it('REFUSED_PATH_TAKEN when the canonical target path already exists', async () => {
    const dir = copyFixture(SALT);
    // a plain note (no front matter) squats on the path the insert would take
    write(dir, `${CH1}/0015-taken.md`, 'just a note\n');
    await untouched(dir, () => insertScene(dir, { chapter: 1, after: ARRIVAL, title: 'N', slug: 'taken', body: 'b\n' }), 'REFUSED_PATH_TAKEN');
  });

  it('operations never throw on bad input', async () => {
    const dir = copyFixture(SALT);
    for (const fn of [
      () => insertScene(dir, {}),
      () => moveScene(dir, undefined, {}),
      () => renumberChapter(dir, 999),
    ]) {
      const r = await fn();
      assert.equal(typeof r.ok, 'boolean');
      assert.equal(typeof r.code, 'string');
    }
  });
});
