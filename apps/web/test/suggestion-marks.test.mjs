// Inline suggestions in the editor: which hunks are drawn against the text (planSuggestionMarks, pure) and how the marks follow edits.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { drawnSuggestionMarks, planSuggestionMarks, setSuggestionMarks, suggestionMarks } from '../src/editor/suggestion-marks.js';

const mark = (over = {}) => ({ suggestionId: 's1', hunkId: 'h1', line: 2, lines: 1, originalLines: ['two'], newLines: ['TWO'], rationale: '', by: null, source: 'ai', canDecide: true, ...over });
const ids = (list) => list.map((m) => m.hunkId);

test('a hunk whose original lines are in the text is kept', () => {
  const plan = planSuggestionMarks(['one', 'two', 'three'], [mark()]);
  assert.deepEqual(ids(plan), ['h1']);
  assert.equal(plan[0].kind, 'replace');
});

test('a hunk whose lines differ from the text (unsaved edits there) is skipped; the others stay', () => {
  const plan = planSuggestionMarks(['one', 'two edited', 'three'], [mark(), mark({ hunkId: 'h2', line: 3, originalLines: ['three'], newLines: ['3'] })]);
  assert.deepEqual(ids(plan), ['h2']);
});

test('a multi-line hunk must match every line and fit in the text', () => {
  const two = mark({ line: 2, lines: 2, originalLines: ['two', 'three'] });
  assert.deepEqual(ids(planSuggestionMarks(['one', 'two', 'three'], [two])), ['h1']);
  assert.deepEqual(ids(planSuggestionMarks(['one', 'two', 'x'], [two])), []);
  assert.deepEqual(ids(planSuggestionMarks(['one', 'two'], [two])), []);
});

test('a pure insertion is kept for a line in the text and for the line just after the end', () => {
  const ins = (line) => mark({ hunkId: `i${line}`, line, lines: 0, originalLines: [], newLines: ['new'] });
  const plan = planSuggestionMarks(['one', 'two'], [ins(1), ins(3), ins(4)]);
  assert.deepEqual(ids(plan), ['i1', 'i3']);
  assert.equal(plan[1].kind, 'insert');
});

test('a trailing carriage return is ignored on either side', () => {
  assert.deepEqual(ids(planSuggestionMarks(['one\r', 'two\r'], [mark()])), ['h1']);
  assert.deepEqual(ids(planSuggestionMarks(['one', 'two'], [mark({ originalLines: ['two\r'] })])), ['h1']);
});

test('malformed marks are skipped', () => {
  assert.deepEqual(planSuggestionMarks(['one'], [mark({ line: 0 }), mark({ line: null }), mark({ line: 9 })]), []);
});

test('the editor field draws marks, keeps them through edits elsewhere and drops a hunk whose lines are edited', () => {
  let state = EditorState.create({ doc: 'one\ntwo\nthree\nfour', extensions: suggestionMarks(() => {}) });
  state = state.update({ effects: setSuggestionMarks.of([mark(), mark({ hunkId: 'h2', line: 4, originalLines: ['four'], newLines: ['4'] })]) }).state;
  const entries = (s) => drawnSuggestionMarks(s).map((m) => m.hunkId);
  assert.deepEqual(entries(state), ['h1', 'h2']);
  state = state.update({ changes: { from: 0, insert: 'zero\n' } }).state; // an edit above: both stay, and follow the text
  assert.deepEqual(entries(state), ['h1', 'h2']);
  state = state.update({ changes: { from: state.doc.line(3).from + 1, insert: 'X' } }).state; // inside the lines of h1 (now line 3)
  assert.deepEqual(entries(state), ['h2']);
});
