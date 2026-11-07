// The Series section of the Plan Overview (Story Planner M8): projections of GET /series-plan.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arcText, bookRows, characterRows, hiddenNote, seriesPlanUrl } from '../src/planner/series.js';

const plan = {
  series: { slug: 's', title: 'The Salt Cycle' },
  books: [
    { id: 'b2', slug: 'two', title: 'Two', series_number: 2, logline: 'L2', synopsis: { type: 'overview', name: 'o', body: 'Second body' }, arcs: [{ character: { id: 'c1', name: 'Ava', shared: true }, start: 'afraid', end: 'brave', milestones: [] }] },
    { id: 'b1', slug: 'one', title: 'One', series_number: 1, logline: 'L1', synopsis: null, arcs: [{ character: { id: 'c1', name: 'Ava', shared: true }, start: 'naive', end: null, milestones: [] }] },
    { id: 'b3', slug: 'three', title: 'Three', series_number: null, logline: '', synopsis: { type: 'overview', name: 'o', body: '  ' }, arcs: [] },
  ],
  characters: [{ id: 'c1', name: 'Ava', books: [{ id: 'b2', title: 'Two', arc_slug: 'ava' }, { id: 'b1', title: 'One', arc_slug: 'ava' }] }],
  hidden: 2,
};

test('seriesPlanUrl is book-relative', () => {
  assert.equal(seriesPlanUrl('a b'), '/api/books/a%20b/series-plan');
});

test('books come in series order, numberless last, with the current one flagged', () => {
  const rows = bookRows(plan, 'b2');
  assert.deepEqual(rows.map((r) => r.id), ['b1', 'b2', 'b3']);
  assert.deepEqual(rows.map((r) => r.current), [false, true, false]);
  assert.deepEqual(rows.map((r) => r.number), [1, 2, null]);
  assert.deepEqual(rows.map((r) => r.synopsis), [null, 'Second body', null]);
  assert.equal(rows[0].logline, 'L1');
});

test('characters x books rows give start to end per book in series order', () => {
  const rows = characterRows(plan);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Ava');
  assert.deepEqual(rows[0].books, [
    { id: 'b1', title: 'One', text: 'naive → …' },
    { id: 'b2', title: 'Two', text: 'afraid → brave' },
  ]);
  assert.equal(arcText({}), 'Arc planned');
  assert.deepEqual(characterRows(null), []);
});

test('the hidden note names the count and is empty for none', () => {
  assert.equal(hiddenNote(0), '');
  assert.equal(hiddenNote(undefined), '');
  assert.equal(hiddenNote(1), '1 book you cannot see is left out.');
  assert.equal(hiddenNote(3), '3 books you cannot see are left out.');
});
