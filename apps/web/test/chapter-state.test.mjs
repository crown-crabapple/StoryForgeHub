// P2-J3: the chip words, the chapter's one save state, and the remembered notes margins.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateSaveState, cannotSaveText, chipLabel, NOTES_KEY, readNotesOpen, writeNotesOpen } from '../src/chapter/chapter-state.js';

test('chipLabel: the four named states, plus unsaved and not-saved; a clean scene says nothing', () => {
  assert.equal(chipLabel('saved'), 'Saved');
  assert.equal(chipLabel('saving'), 'Saving');
  assert.equal(chipLabel('offline'), 'Offline');
  assert.equal(chipLabel('conflict'), 'Conflict');
  assert.equal(chipLabel('dirty'), 'Unsaved');
  assert.equal(chipLabel('error'), 'Not saved');
  assert.equal(chipLabel('clean'), null);
  assert.equal(chipLabel(undefined), null);
});

test('aggregateSaveState: the worst state wins, the latest save time is kept, no scenes is null', () => {
  assert.equal(aggregateSaveState([]), null);
  assert.deepEqual(aggregateSaveState([{ state: 'clean', savedAt: null }]), { state: 'clean', savedAt: null });
  assert.deepEqual(
    aggregateSaveState([
      { state: 'saved', savedAt: '2026-11-20T10:00:00.000Z' },
      { state: 'dirty', savedAt: null },
      { state: 'saved', savedAt: '2026-11-20T10:05:00.000Z' },
    ]),
    { state: 'dirty', savedAt: '2026-11-20T10:05:00.000Z' },
  );
  assert.equal(aggregateSaveState([{ state: 'offline', savedAt: null }, { state: 'conflict', savedAt: null }, { state: 'saving', savedAt: null }]).state, 'conflict');
  assert.equal(aggregateSaveState([{ state: 'saving', savedAt: null }, { state: 'dirty', savedAt: null }]).state, 'saving');
});

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), m };
};

test('notes margins are collapsed by default and remembered per scene', () => {
  const s = memory();
  assert.deepEqual(readNotesOpen(s), {});
  assert.deepEqual(writeNotesOpen(s, 'a', true), { a: true });
  assert.deepEqual(writeNotesOpen(s, 'b', true), { a: true, b: true });
  assert.deepEqual(readNotesOpen(s), { a: true, b: true });
  assert.deepEqual(writeNotesOpen(s, 'a', false), { b: true });
  assert.deepEqual(JSON.parse(s.m.get(NOTES_KEY)), { b: true });
});

test('notes margins: broken or missing storage never throws', () => {
  assert.deepEqual(readNotesOpen(null), {});
  assert.deepEqual(readNotesOpen({ getItem: () => '{not json' }), {});
  assert.deepEqual(readNotesOpen({ getItem: () => '[1,2]' }), {});
  assert.deepEqual(readNotesOpen({ getItem: () => '{"a":true,"b":"yes"}' }), { a: true });
  assert.deepEqual(readNotesOpen({ getItem: () => { throw new Error('denied'); } }), {});
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(writeNotesOpen(full, 'a', true), { a: true });
  assert.deepEqual(writeNotesOpen(undefined, 'a', true), { a: true });
});

test('cannotSaveText is calm and says nothing was saved', () => {
  assert.match(cannotSaveText('a link needs an address'), /Nothing was saved/);
});
