// M03-J03 acceptance 7: the pure target helper behind Alt+Up / Alt+Down, rail drop positions and the Move... dialog,
// table-tested against the book tree the API returns. No DOM, no network.
// Module: src/structure/move-target.js. A target is { chapter, act, after } exactly as POST .../move takes it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterOptions, dialogTarget, dropTarget, halfOf, keyboardTarget, positionOptions } from '../src/structure/move-target.js';

const sc = (id, title) => ({ id, title });
// Act 1: ch0 [P] | ch1 [A K] | ch2 [] (empty) | ch3 [F G]      Act 2: ch4 [L W] | ch5 [] (empty, last)
const P = sc('P', 'Prologue');
const A = sc('A', 'Arrival');
const K = sc('K', 'The Key');
const F = sc('F', 'Ferry');
const G = sc('G', 'The Grafting');
const L = sc('L', 'Low Tide');
const W = sc('W', 'The Wall');
const BOOK = {
  acts: [
    {
      act: 1, label: 'Act 1', title: 'Low Water',
      chapters: [
        { chapter: 0, label: 'Prologue', title: null, scenes: [P] },
        { chapter: 1, label: 'Chapter 1', title: 'The Drowned Rows', scenes: [A, K] },
        { chapter: 2, label: 'Chapter 2', title: null, scenes: [] },
        { chapter: 3, label: 'Chapter 3', title: null, scenes: [F, G] },
      ],
    },
    {
      act: 2, label: 'Act 2', title: 'High Water',
      chapters: [
        { chapter: 4, label: 'Chapter 4', title: null, scenes: [L, W] },
        { chapter: 5, label: 'Chapter 5', title: null, scenes: [] },
      ],
    },
  ],
};
const pick = (t) => (t === null ? null : { chapter: t.chapter, act: t.act, after: t.after });

// ---------------------------------------------------------------- Alt+Up / Alt+Down

const KEYBOARD = [
  // [scene, direction, expected target, why]
  ['A', 'down', { chapter: 1, act: 1, after: 'K' }, 'down within a chapter: after the next scene'],
  ['F', 'down', { chapter: 3, act: 1, after: 'G' }, 'down within a chapter (second chapter)'],
  ['L', 'down', { chapter: 4, act: 2, after: 'W' }, 'down within a chapter in act 2'],
  ['P', 'down', { chapter: 1, act: 1, after: null }, 'last (only) scene of a chapter: first in the next chapter'],
  ['K', 'down', { chapter: 2, act: 1, after: null }, 'last scene of a chapter: into the EMPTY next chapter'],
  ['G', 'down', { chapter: 4, act: 2, after: null }, 'last scene of the last chapter of an act: first in the next act'],
  ['W', 'down', { chapter: 5, act: 2, after: null }, 'into a trailing empty chapter'],
  ['K', 'up', { chapter: 1, act: 1, after: null }, 'up from the second scene: first in the chapter'],
  ['G', 'up', { chapter: 3, act: 1, after: null }, 'up within chapter 3'],
  ['W', 'up', { chapter: 4, act: 2, after: null }, 'up within chapter 4'],
  ['A', 'up', { chapter: 0, act: 1, after: 'P' }, 'first scene: last in the previous chapter'],
  ['F', 'up', { chapter: 2, act: 1, after: null }, 'first scene: into the EMPTY previous chapter'],
  ['L', 'up', { chapter: 3, act: 1, after: 'G' }, 'first scene of act 2: last in the previous chapter, which is in act 1'],
  ['P', 'up', null, 'very first scene of the book: nothing above'],
];
for (const [id, dir, expected, why] of KEYBOARD) {
  test(`keyboardTarget: ${id} ${dir} - ${why}`, () => {
    assert.deepEqual(pick(keyboardTarget(BOOK, id, dir)), expected);
  });
}

test('keyboardTarget: nothing below the last scene of the book when no chapter follows', () => {
  const book = { acts: [{ act: 1, label: 'Act 1', chapters: [{ chapter: 1, label: 'Chapter 1', title: null, scenes: [sc('x', 'X'), sc('y', 'Y')] }] }] };
  assert.equal(keyboardTarget(book, 'y', 'down'), null);
  assert.equal(keyboardTarget(book, 'x', 'up'), null);
  assert.deepEqual(pick(keyboardTarget(book, 'x', 'down')), { chapter: 1, act: 1, after: 'y' });
});

test('keyboardTarget: a scene alone in the only chapter cannot move either way', () => {
  const book = { acts: [{ act: 1, label: 'Act 1', chapters: [{ chapter: 1, label: 'Chapter 1', title: null, scenes: [sc('only', 'Only')] }] }] };
  assert.equal(keyboardTarget(book, 'only', 'up'), null);
  assert.equal(keyboardTarget(book, 'only', 'down'), null);
});

test('keyboardTarget: unknown scene, unknown direction, empty book give null (never throw)', () => {
  assert.equal(keyboardTarget(BOOK, 'nope', 'down'), null);
  assert.equal(keyboardTarget(BOOK, 'A', 'sideways'), null);
  assert.equal(keyboardTarget({ acts: [] }, 'A', 'up'), null);
  assert.equal(keyboardTarget(null, 'A', 'up'), null);
});

test('keyboardTarget: pressing Down then Up on the moved scene returns it to where it began (apply the targets to the tree)', () => {
  // simulate applying a target to the tree, as the server would
  const apply = (book, id, t) => ({
    acts: book.acts.map((a) => ({
      ...a,
      chapters: a.chapters.map((c) => {
        const without = c.scenes.filter((s) => s.id !== id);
        if (c.chapter !== t.chapter) return { ...c, scenes: without };
        const moving = book.acts.flatMap((x) => x.chapters.flatMap((y) => y.scenes)).find((s) => s.id === id);
        const at = t.after === null ? 0 : without.findIndex((s) => s.id === t.after) + 1;
        return { ...c, scenes: [...without.slice(0, at), moving, ...without.slice(at)] };
      }),
    })),
  });
  const flat = (book) => book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
  for (const id of flat(BOOK)) {
    const down = keyboardTarget(BOOK, id, 'down');
    if (!down) continue;
    const moved = apply(BOOK, id, down);
    const order = flat(moved);
    const crosses = down.after === null; // first in the next chapter: book order is unchanged, the chapter is
    assert.equal(order.indexOf(id), flat(BOOK).indexOf(id) + (crosses ? 0 : 1), `${id} moved exactly one slot down in book order`);
    const up = keyboardTarget(moved, id, 'up');
    assert.deepEqual(flat(apply(moved, id, up)), flat(BOOK), `${id}: Up undoes Down`);
  }
});

test('keyboardTarget: the announcement names the mover, the neighbour and the chapter', () => {
  const book = {
    acts: [{ act: 2, label: 'Act 2', chapters: [{ chapter: 3, label: 'Chapter 3', title: null, scenes: [sc('low', 'Low Tide'), sc('key', 'The Key')] }] }],
  };
  assert.equal(keyboardTarget(book, 'key', 'up').text, 'Move The Key to the start of Chapter 3');
  const book2 = { acts: [{ act: 2, label: 'Act 2', chapters: [{ chapter: 3, label: 'Chapter 3', title: null, scenes: [sc('low', 'Low Tide'), sc('wall', 'The Wall'), sc('key', 'The Key')] }] }] };
  assert.equal(keyboardTarget(book2, 'key', 'up').text, 'Move The Key after Low Tide in Chapter 3');
});

// ---------------------------------------------------------------- drop targets (rail)

test('halfOf: upper half is before, lower half (and the exact middle) is after', () => {
  const rect = { top: 100, height: 20 };
  assert.equal(halfOf(100, rect), 'before');
  assert.equal(halfOf(109, rect), 'before');
  assert.equal(halfOf(110, rect), 'after');
  assert.equal(halfOf(119, rect), 'after');
});

const DROPS = [
  // [dragged, over, expected {chapter, act, after, noop}, why]
  ['A', { kind: 'scene', sceneId: 'F', half: 'before' }, { chapter: 3, act: 1, after: null, noop: false }, 'before the first scene of another chapter'],
  ['A', { kind: 'scene', sceneId: 'G', half: 'before' }, { chapter: 3, act: 1, after: 'F', noop: false }, 'before X = after the scene above X'],
  ['A', { kind: 'scene', sceneId: 'F', half: 'after' }, { chapter: 3, act: 1, after: 'F', noop: false }, 'after X'],
  ['A', { kind: 'scene', sceneId: 'W', half: 'after' }, { chapter: 4, act: 2, after: 'W', noop: false }, 'across acts: act comes from the target chapter'],
  ['W', { kind: 'scene', sceneId: 'A', half: 'before' }, { chapter: 1, act: 1, after: null, noop: false }, 'from act 2 back to act 1, first slot'],
  ['K', { kind: 'chapter', chapter: 3 }, { chapter: 3, act: 1, after: 'G', noop: false }, 'chapter row = end of that chapter'],
  ['K', { kind: 'chapter', chapter: 2 }, { chapter: 2, act: 1, after: null, noop: false }, 'an empty chapter row'],
  ['A', { kind: 'chapter', chapter: 5 }, { chapter: 5, act: 2, after: null, noop: false }, 'an empty chapter in another act'],
  ['A', { kind: 'scene', sceneId: 'A', half: 'before' }, { chapter: 1, act: 1, after: null, noop: true }, 'on itself (upper half) is a no-op'],
  ['A', { kind: 'scene', sceneId: 'A', half: 'after' }, { chapter: 1, act: 1, after: null, noop: true }, 'on itself (lower half) is a no-op'],
  ['A', { kind: 'scene', sceneId: 'K', half: 'before' }, { chapter: 1, act: 1, after: null, noop: true }, 'just above the next scene = current slot, no-op'],
  ['K', { kind: 'scene', sceneId: 'A', half: 'after' }, { chapter: 1, act: 1, after: 'A', noop: true }, 'just below the previous scene = current slot, no-op'],
  ['K', { kind: 'chapter', chapter: 1 }, { chapter: 1, act: 1, after: 'A', noop: true }, 'the end of its own chapter when it is already last'],
  ['A', { kind: 'chapter', chapter: 1 }, { chapter: 1, act: 1, after: 'K', noop: false }, 'the end of its own chapter when it is first: a real move'],
];
for (const [dragged, over, expected, why] of DROPS) {
  test(`dropTarget: ${dragged} over ${over.kind === 'scene' ? `${over.sceneId} (${over.half})` : `chapter ${over.chapter}`} - ${why}`, () => {
    const t = dropTarget(BOOK, dragged, over);
    assert.ok(t, 'a target');
    assert.deepEqual({ chapter: t.chapter, act: t.act, after: t.after, noop: t.noop }, expected);
  });
}

test('dropTarget: unknown dragged scene / row / chapter give null', () => {
  assert.equal(dropTarget(BOOK, 'nope', { kind: 'scene', sceneId: 'A', half: 'after' }), null);
  assert.equal(dropTarget(BOOK, 'A', { kind: 'scene', sceneId: 'nope', half: 'after' }), null);
  assert.equal(dropTarget(BOOK, 'A', { kind: 'chapter', chapter: 99 }), null);
  assert.equal(dropTarget(BOOK, 'A', null), null);
});

test('dropTarget: the indicator says which insertion line to draw (before X / after X / end of chapter) and the text is the announcement', () => {
  const before = dropTarget(BOOK, 'A', { kind: 'scene', sceneId: 'G', half: 'before' });
  assert.equal(before.indicator.kind, 'before');
  assert.equal(before.indicator.sceneId, 'G');
  assert.match(before.text, /^Move Arrival before The Grafting in Chapter 3$/);
  const after = dropTarget(BOOK, 'A', { kind: 'scene', sceneId: 'F', half: 'after' });
  assert.equal(after.indicator.kind, 'after');
  assert.equal(after.indicator.sceneId, 'F');
  assert.match(after.text, /^Move Arrival after Ferry in Chapter 3$/);
  const end = dropTarget(BOOK, 'A', { kind: 'chapter', chapter: 3 });
  assert.equal(end.indicator.kind, 'end');
  assert.equal(end.indicator.chapter, 3);
  assert.match(end.text, /end of Chapter 3$/);
  const empty = dropTarget(BOOK, 'A', { kind: 'chapter', chapter: 2 });
  assert.equal(empty.indicator.kind, 'end');
  assert.match(empty.text, /empty Chapter 2$/);
});

// ---------------------------------------------------------------- Move... dialog options

test('chapterOptions: every chapter of every act is offered, empty ones included, grouped by act', () => {
  const groups = chapterOptions(BOOK);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.chapters.map((c) => c.value)), [['0', '1', '2', '3'], ['4', '5']]);
  assert.match(groups[0].label, /Act 1/);
  assert.match(groups[1].label, /Act 2/);
});

test('positionOptions: "At the start" first, then "After <scene>" for each scene; the mover is not offered; empty chapter has only the start', () => {
  assert.deepEqual(positionOptions(BOOK, 3, 'A').map((o) => [o.value, o.label]), [['', 'At the start'], ['F', 'After Ferry'], ['G', 'After The Grafting']]);
  assert.deepEqual(positionOptions(BOOK, 1, 'A').map((o) => [o.value, o.label]), [['', 'At the start'], ['K', 'After The Key']]);
  assert.deepEqual(positionOptions(BOOK, 2, 'A').map((o) => [o.value, o.label]), [['', 'At the start']]);
  assert.deepEqual(positionOptions(BOOK, 99, 'A'), []);
});

test('positionOptions: an untitled scene is listed as "Untitled scene"', () => {
  const book = { acts: [{ act: 1, label: 'Act 1', chapters: [{ chapter: 1, label: 'Chapter 1', title: null, scenes: [{ id: 'u', title: '' }, { id: 'v', title: 'V' }] }] }] };
  assert.deepEqual(positionOptions(book, 1, 'v').map((o) => o.label), ['At the start', 'After Untitled scene']);
});

test('dialogTarget: the two selects become { chapter, act, after }; "" is the start; an unknown chapter is null', () => {
  assert.deepEqual(dialogTarget(BOOK, '4', ''), { chapter: 4, act: 2, after: null });
  assert.deepEqual(dialogTarget(BOOK, '3', 'F'), { chapter: 3, act: 1, after: 'F' });
  assert.deepEqual(dialogTarget(BOOK, 5, ''), { chapter: 5, act: 2, after: null });
  assert.equal(dialogTarget(BOOK, '99', ''), null);
});
