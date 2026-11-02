// Inserted line breaks (paste, drop, commands) must take the buffer's own ending: no bare LF in a CRLF buffer,
// no CR in an LF buffer, and untouched lines stay byte-identical. Plus the pure helper `toLineBreak`, table-driven.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSelection } from '@codemirror/state';
import { loadBuffer, serialise, toLineBreak } from '../src/editor/buffer.js';
import { authorNote, bold, insertLink, italic, sceneBreak } from '../src/editor/commands.js';

const INSERTS = [
  ['LF', 'one\ntwo'],
  ['CRLF', 'one\r\ntwo'],
  ['CR', 'one\rtwo'],
  ['mixed', 'a\nb\r\nc\rd'],
  ['leading and trailing', '\nx\r\n'],
  ['blank runs', 'a\n\n\r\n\rb'],
  ['no break', 'plain'],
];
const BASE = ['first line', 'second line', 'third line', ''];
const textFor = (sep) => BASE.join(sep);
const SEPS = ['\n', '\r\n'];

/** Ending check: the text contains only `sep` as a line break. */
function assertOnly(text, sep, label) {
  const stripped = text.split(sep).join('');
  assert.ok(!/[\r\n]/.test(stripped), `${label}: foreign line break in ${JSON.stringify(text)}`);
}
const at = (state, line, col) => state.doc.line(line).from + col;
const run = (state, cmd) => {
  let next = state;
  cmd({ get state() { return next; }, dispatch: (tr) => { next = tr.state; } });
  return next;
};

test('toLineBreak: table-driven', () => {
  const table = [
    ['', '\n', ''], ['', '\r\n', ''], ['abc', '\r\n', 'abc'],
    ['a\nb', '\r\n', 'a\r\nb'], ['a\r\nb', '\n', 'a\nb'], ['a\rb', '\n', 'a\nb'], ['a\rb', '\r\n', 'a\r\nb'],
    ['a\r\nb\nc\rd', '\n', 'a\nb\nc\nd'], ['a\r\nb\nc\rd', '\r\n', 'a\r\nb\r\nc\r\nd'],
    ['\n\n', '\r\n', '\r\n\r\n'], ['\r\r', '\n', '\n\n'], ['\r\n\r\n', '\r\n', '\r\n\r\n'],
    ['x\n', '\r\n', 'x\r\n'], ['\n\r', '\n', '\n\n'], ['café\n🌊\r', '\r\n', 'café\r\n🌊\r\n'],
  ];
  for (const [input, lb, want] of table) assert.equal(toLineBreak(input, lb), want, JSON.stringify([input, lb]));
  for (const [, input] of INSERTS) assert.equal(toLineBreak(toLineBreak(input, '\r\n'), '\r\n'), toLineBreak(input, '\r\n'), 'idempotent');
});

for (const sep of SEPS) {
  const name = sep === '\n' ? 'LF' : 'CRLF';
  for (const [label, ins] of INSERTS) {
    test(`${name} buffer: plain changes inserting ${label} keep only the buffer's ending`, () => {
      const text = textFor(sep);
      const { state } = loadBuffer(text);
      for (const col of [0, 5]) {
        const next = state.update({ changes: { from: at(state, 2, col), insert: ins } }).state;
        const out = serialise(next);
        assertOnly(out, sep, label);
        assert.equal(out, text.split(sep).map((l, i) => (i === 1 ? l.slice(0, col) + toLineBreak(ins, sep) + l.slice(col) : l)).join(sep));
        const lines = out.split(sep);
        assert.equal(lines[0], BASE[0], 'untouched line before');
        assert.equal(lines[lines.length - 2], BASE[2], 'untouched line after');
      }
    });

    test(`${name} buffer: replaceSelection with ${label} replaces the selection and keeps only the buffer's ending`, () => {
      const text = textFor(sep);
      const { state } = loadBuffer(text);
      const s = state.update({ selection: EditorSelection.range(at(state, 2, 0), at(state, 2, 6)) }).state; // "second"
      const out = serialise(s.update(s.replaceSelection(ins)).state);
      assertOnly(out, sep, label);
      assert.equal(out, text.replace('second', toLineBreak(ins, sep)).split(/\r?\n/).join(sep));
      assert.equal(out.split(sep)[0], 'first line');
    });
  }

  test(`${name} buffer: every command on a multi-line selection and at a caret leaves only the buffer's ending`, () => {
    const text = textFor(sep);
    const { state } = loadBuffer(text);
    const sel = state.update({ selection: EditorSelection.range(at(state, 1, 3), at(state, 3, 4)) }).state;
    const caretEnd = state.update({ selection: EditorSelection.cursor(at(state, 3, 10)) }).state;
    const caretStart = state.update({ selection: EditorSelection.cursor(0) }).state;
    const docEnd = state.update({ selection: EditorSelection.cursor(state.doc.length) }).state;
    for (const [label, cmd] of [['bold', bold], ['italic', italic], ['note', authorNote], ['link', insertLink('pell')], ['scene break', sceneBreak]]) {
      for (const [where, s] of [['multi-line selection', sel], ['caret at line end', caretEnd], ['caret at start', caretStart], ['doc end', docEnd]]) {
        let out;
        assert.doesNotThrow(() => (out = serialise(run(s, cmd))), `${label} @ ${where}`);
        assertOnly(out, sep, `${label} @ ${where}`);
        assert.equal(out.split(sep)[0].startsWith(where === 'caret at start' ? '' : 'first line'.slice(0, 3)), true);
      }
    }
  });

  test(`${name} buffer: pasting mixed text twice and undoing paste-sized edits keeps one ending`, () => {
    const { state } = loadBuffer(textFor(sep));
    let s = state.update({ changes: { from: 0, insert: 'a\nb\r\nc\r' } }).state;
    s = s.update({ changes: { from: s.doc.length, insert: '\rz\n' } }).state;
    assertOnly(serialise(s), sep, 'two pastes');
  });
}
