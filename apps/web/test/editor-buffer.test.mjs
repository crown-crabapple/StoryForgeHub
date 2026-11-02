// M03-J02 acceptance 1 (round trip): for every scene body in every valid fixture and a synthetic torture body,
// as LF, CRLF, with and without a final newline: load -> serialise is the identical string; one inserted word changes
// only that line; mixed line endings open read-only and can be normalised with an exact preview.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { detectLineEnding, loadBuffer, normaliseLineEndings, normalisePreview, serialise } from '../src/editor/buffer.js';
import { TORTURE, allBodies, fixtureBodies, toCRLF, toLF, variantsOf } from './editor-fixtures.mjs';

/** Insert `word` at column `col` of 0-based line `i`, working on the raw text with the file's own separator. */
function expectedAfterInsert(text, sep, i, col, word) {
  const lines = text.split(sep);
  lines[i] = lines[i].slice(0, col) + word + lines[i].slice(col);
  return lines.join(sep);
}

test('the fixture set covers what the contract names: >= 60-line torture body, a native CRLF body, bodies with and without a final newline', () => {
  assert.ok(TORTURE.split('\n').length >= 60);
  for (const needle of ['<!--', '[[', '[@', '***', 'こんにちは', '🌊', '  \n', '\n\n\n', '_x_'.replace('x', 'emphasis'), '__strong__', '\n* ', '\n- ', '\n> ', '```', '~~~', '\n    indented', '\\*', '"Title']) {
    assert.ok(TORTURE.includes(needle), `torture body contains ${JSON.stringify(needle)}`);
  }
  const bodies = fixtureBodies();
  assert.ok(bodies.length >= 17);
  assert.ok(bodies.some((b) => b.body.includes('\r\n')), 'native CRLF fixture body');
  assert.ok(bodies.some((b) => b.body.endsWith('\n')), 'fixture bodies end with a newline');
  assert.equal(TORTURE.endsWith('\n'), false, 'the torture body has no final newline (allBodies also adds a with-newline copy)');
});

test('round trip: load then serialise is byte-identical for every body in every variant', () => {
  let checked = 0;
  for (const { name, body } of allBodies()) {
    for (const { label, text } of variantsOf(body)) {
      const { state, readOnly, lineEndings } = loadBuffer(text);
      assert.equal(readOnly, false, `${name} (${label}) is uniform, so editable`);
      assert.equal(lineEndings.kind, text.includes('\r\n') ? 'crlf' : 'lf', `${name} (${label})`);
      assert.equal(serialise(state), text, `${name} (${label})`);
      checked++;
    }
  }
  assert.ok(checked > 100);
});

test('round trip: the ending is detected per file (CRLF file stays CRLF, LF stays LF)', () => {
  const { state: crlf } = loadBuffer(toCRLF(TORTURE));
  assert.equal(crlf.lineBreak, '\r\n');
  assert.equal(detectLineEnding(toCRLF(TORTURE)).kind, 'crlf');
  const { state: lf } = loadBuffer(TORTURE);
  assert.equal(lf.lineBreak, '\n');
  assert.equal(serialise(crlf).includes('\n'), true);
  assert.equal(/(?<!\r)\n/.test(serialise(crlf)), false, 'no bare LF in the CRLF buffer');
  assert.equal(serialise(lf).includes('\r'), false);
});

test('round trip: the native CRLF fixture body is detected as CRLF and comes back identical', () => {
  const grafting = fixtureBodies().find((b) => b.name.endsWith('0020-the-grafting.md') && b.name.startsWith('salt-orchard/manuscript'));
  assert.ok(grafting);
  const { state, lineEndings, readOnly } = loadBuffer(grafting.body);
  assert.equal(lineEndings.kind, 'crlf');
  assert.equal(readOnly, false);
  assert.equal(serialise(state), grafting.body);
});

test('round trip: empty body, a lone newline, a single unterminated line, trailing blank lines', () => {
  for (const text of ['', '\n', '\r\n', 'x', 'x\n', 'x\r\n', '\n\n\n', '\r\n\r\n\r\n', 'a\n\n', ' \n', 'こんにちは', '🌊\n']) {
    const { state, readOnly } = loadBuffer(text);
    assert.equal(readOnly, false, JSON.stringify(text));
    assert.equal(serialise(state), text, JSON.stringify(text));
  }
});

test('the trailing newline (or its absence) is kept exactly, also after an edit elsewhere', () => {
  for (const sep of ['\n', '\r\n']) {
    for (const tail of ['', sep, sep + sep]) {
      const text = ['first line here', 'second line here'].join(sep) + tail;
      const { state } = loadBuffer(text);
      const next = state.update({ changes: { from: 0, insert: 'X' } }).state;
      assert.equal(serialise(next), 'X' + text, `${JSON.stringify(tail)} with ${JSON.stringify(sep)}`);
    }
  }
});

test('one inserted word changes only that line, for every body in every variant', () => {
  for (const { name, body } of allBodies()) {
    for (const { label, text } of variantsOf(body)) {
      const sep = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.split(sep);
      // a plain-prose line with at least two words (the first one is enough for the tiny fixtures)
      let i = lines.findIndex((l) => /^[A-Za-z][^<>[\]*_`]*\s\S/.test(l) && !/^(#|>)/.test(l));
      if (i < 0) i = lines.findIndex((l) => l.trim().length > 0);
      if (i < 0) continue;
      const col = Math.max(0, lines[i].indexOf(' ') + 1);
      const { state } = loadBuffer(text);
      const from = state.doc.line(i + 1).from + col;
      const next = state.update({ changes: { from, insert: 'quietly ' } }).state;
      const out = serialise(next);
      assert.equal(out, expectedAfterInsert(text, sep, i, col, 'quietly '), `${name} (${label})`);
      const after = out.split(sep);
      assert.equal(after.length, lines.length);
      for (let k = 0; k < lines.length; k++) if (k !== i) assert.equal(after[k], lines[k], `${name} (${label}) line ${k + 1} untouched`);
    }
  }
});

test('typing a line break and deleting a line break keep the file ending', () => {
  for (const sep of ['\n', '\r\n']) {
    const text = ['alpha', 'beta', 'gamma'].join(sep) + sep;
    const { state } = loadBuffer(text);
    const split = state.update({ changes: { from: 3, insert: state.lineBreak } }).state;
    assert.equal(serialise(split), `alp${sep}ha${sep}beta${sep}gamma${sep}`);
    const joined = state.update({ changes: { from: state.doc.line(1).to, to: state.doc.line(2).from } }).state;
    assert.equal(serialise(joined), `alphabeta${sep}gamma${sep}`);
  }
});

// ---------------------------------------------------------------- mixed line endings

test('mixed endings are detected and opened read-only; nothing is rewritten on load', () => {
  const mixed = 'one\r\ntwo\nthree\r\nfour\n';
  const info = detectLineEnding(mixed);
  assert.equal(info.kind, 'mixed');
  assert.deepEqual([info.crlf, info.lf], [2, 2]);
  const { state, readOnly, lineEndings } = loadBuffer(mixed);
  assert.equal(readOnly, true);
  assert.equal(lineEndings.kind, 'mixed');
  assert.equal(state.readOnly, true, 'EditorState.readOnly is on');
  assert.equal(state.facet(EditorState.readOnly), true);
});

test('mixed detection: one stray CRLF in an LF body, one stray LF in a CRLF body, every fixture body', () => {
  for (const { name, body } of allBodies()) {
    const lf = toLF(body);
    const lines = lf.split('\n');
    if (lines.length < 3) continue; // needs two line breaks to mix
    const strayCrlf = lf.replace('\n', '\r\n');
    assert.equal(loadBuffer(strayCrlf).readOnly, true, `${name}: one CRLF among LF`);
    const crlf = toCRLF(lf);
    const strayLf = crlf.replace('\r\n', '\n');
    assert.equal(loadBuffer(strayLf).readOnly, true, `${name}: one LF among CRLF`);
  }
});

test('a bare CR is not treated as a clean file', () => {
  assert.equal(detectLineEnding('a\rb\n').kind, 'mixed');
  assert.equal(loadBuffer('a\rb\n').readOnly, true);
});

test('normalise preview counts the lines that would change and names the majority ending', () => {
  assert.deepEqual(normalisePreview('a\r\nb\r\nc\r\nd\n'), { target: '\r\n', changing: 1, total: 4 });
  assert.deepEqual(normalisePreview('a\nb\nc\r\nd\n'), { target: '\n', changing: 1, total: 4 });
  assert.deepEqual(normalisePreview('a\nb\nc\nd\r\ne\r\n'), { target: '\n', changing: 2, total: 5 });
  assert.deepEqual(normalisePreview('a\r\nb\r\nc\r\nd\ne\n'), { target: '\r\n', changing: 2, total: 5 });
});

test('normalising makes the whole text uniform with the majority ending, nothing else changes', () => {
  for (const [text, target] of [['a\r\nb\r\nc\r\nd\n', '\r\n'], ['a\nb\nc\r\nd\n', '\n'], ['x y\n\r\n\nz  \r\n\nend', '\n']]) {
    const preview = normalisePreview(text);
    const out = normaliseLineEndings(text, preview.target);
    assert.equal(preview.target, target);
    assert.equal(detectLineEnding(out).kind, target === '\r\n' ? 'crlf' : 'lf');
    assert.equal(toLF(out), toLF(text), 'only the endings differ');
    const { state, readOnly } = loadBuffer(out);
    assert.equal(readOnly, false);
    assert.equal(serialise(state), out);
  }
});

test('normalising an already uniform text is a no-op with a zero preview', () => {
  for (const text of ['a\nb\n', 'a\r\nb\r\n', 'single line', '']) {
    const p = normalisePreview(text);
    assert.equal(p.changing, 0);
    assert.equal(normaliseLineEndings(text, p.target), text);
  }
});
