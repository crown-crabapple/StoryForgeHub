// M03-J02 acceptance 1 (commands): each command on a selection and at the caret, toggling, and "only the targeted
// lines change" - on LF and CRLF bodies, over every fixture body and the torture body. Pure EditorState, no DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history, redo, undo } from '@codemirror/commands';
import { loadBuffer, serialise } from '../src/editor/buffer.js';
import { authorNote, bold, boldSpec, insertLink, italic, italicSpec, linkSpec, noteSpec, sceneBreak, sceneBreakSpec } from '../src/editor/commands.js';
import { TORTURE, allBodies, toCRLF, toLF } from './editor-fixtures.mjs';

const SEPS = ['\n', '\r\n'];
const open = (text, ext = []) => loadBuffer(text, ext).state;

/** Select (line i, col a) .. (line j, col b), 0-based, on a state. */
function select(state, i, a, j = i, b = a) {
  const from = state.doc.line(i + 1).from + a;
  const to = state.doc.line(j + 1).from + b;
  return state.update({ selection: EditorSelection.range(from, to) }).state;
}

/** Run a view command on a state, return the new state (the same one when nothing was dispatched). */
function run(state, cmd) {
  let next = state;
  const handled = cmd({ get state() { return next; }, dispatch: (tr) => { next = tr.state; } });
  return { state: next, handled };
}

const apply = (state, spec) => (spec ? state.update(spec).state : state);

/** Every change of a transaction is a pure insertion (nothing deleted or rewritten). */
function assertOnlyInsertions(state, spec) {
  const tr = state.update(spec);
  tr.changes.iterChanges((fromA, toA) => assert.equal(fromA, toA, 'a change deleted or replaced text'));
}

/** The inserted `***` sits on its own line with a blank line before it (or at the document start) and a blank line after it. */
function assertBlankAround(state, spec) {
  const tr = state.update(spec);
  const d = tr.state.doc.toString(); // LF-joined; positions equal document positions
  let found = 0;
  tr.changes.iterChanges((_fa, _ta, fromB, _toB, inserted) => {
    assert.ok(inserted.toString().includes('***'), 'the insertion holds the break');
    const at = fromB + inserted.toString().indexOf('***');
    const before = d.slice(0, at);
    const after = d.slice(at + 3);
    assert.ok(before === '' || before.endsWith('\n\n'), 'blank line (or start) before: ' + JSON.stringify(before.slice(-6)));
    assert.ok(after.startsWith('\n\n'), 'blank line after: ' + JSON.stringify(after.slice(0, 6)));
    found++;
  });
  assert.equal(found, 1);
}

/** Lines (split on the file's separator) that differ between two texts, as 0-based indexes of the shorter-or-equal common prefix. */
function changedLines(before, after, sep) {
  const a = before.split(sep);
  const b = after.split(sep);
  const out = [];
  for (let k = 0; k < Math.max(a.length, b.length); k++) if (a[k] !== b[k]) out.push(k);
  return out;
}

// A small body with known lines; used for the literal-expectation tests.
const lines = ['The key was colder than the morning.', '', 'She turned it over twice.', 'Then she slept.', ''];
const bodyFor = (sep) => lines.join(sep);

for (const sep of SEPS) {
  const name = sep === '\n' ? 'LF' : 'CRLF';

  test(`bold (${name}): wraps the selection in ** and changes only that line`, () => {
    const text = bodyFor(sep);
    const s = select(open(text), 2, 4, 2, 10); // "turned"
    const next = apply(s, boldSpec(s));
    assert.equal(serialise(next), text.replace('She turned it', 'She **turned** it'));
    assert.deepEqual(changedLines(text, serialise(next), sep), [2]);
    assert.equal(next.sliceDoc(next.selection.main.from, next.selection.main.to), 'turned', 'the words stay selected');
    assertOnlyInsertions(s, boldSpec(s));
  });

  test(`bold (${name}): toggles off when the markers are inside the selection`, () => {
    const text = bodyFor(sep).replace('turned', '**turned**');
    const s = select(open(text), 2, 4, 2, 14); // "**turned**"
    const next = apply(s, boldSpec(s));
    assert.equal(serialise(next), bodyFor(sep));
  });

  test(`bold (${name}): toggles off when the markers sit just outside the selection`, () => {
    const text = bodyFor(sep).replace('turned', '**turned**');
    const s = select(open(text), 2, 6, 2, 12); // "turned"
    const next = apply(s, boldSpec(s));
    assert.equal(serialise(next), bodyFor(sep));
  });

  test(`bold (${name}): twice is the identity`, () => {
    const text = bodyFor(sep);
    let s = select(open(text), 3, 5, 3, 8);
    s = apply(s, boldSpec(s));
    s = apply(s, boldSpec(s));
    assert.equal(serialise(s), text);
  });

  test(`italic (${name}): wraps in * and toggles off`, () => {
    const text = bodyFor(sep);
    let s = select(open(text), 3, 5, 3, 8); // "she"
    s = apply(s, italicSpec(s));
    assert.equal(serialise(s), text.replace('Then she slept', 'Then *she* slept'));
    s = apply(s, italicSpec(s));
    assert.equal(serialise(s), text);
  });

  test(`italic (${name}): inside **bold** adds a marker pair, it does not strip the bold`, () => {
    const text = bodyFor(sep).replace('turned', '**turned**');
    const s = select(open(text), 2, 6, 2, 12);
    const next = apply(s, italicSpec(s));
    assert.equal(serialise(next), bodyFor(sep).replace('turned', '***turned***'));
  });

  test(`bold and italic (${name}): at the caret the markers go in and the caret sits between them`, () => {
    const text = bodyFor(sep);
    const s = select(open(text), 3, 5);
    for (const [spec, m] of [[boldSpec, '**'], [italicSpec, '*']]) {
      const next = apply(s, spec(s));
      assert.equal(serialise(next), text.replace('Then she slept', `Then ${m}${m}she slept`));
      const head = next.selection.main.head;
      assert.equal(next.sliceDoc(head - m.length, head), m);
      assert.equal(next.sliceDoc(head, head + m.length), m);
      assert.ok(next.selection.main.empty);
    }
  });

  test(`bold (${name}): a selection across lines wraps once, only its first and last lines change`, () => {
    const text = bodyFor(sep);
    const s = select(open(text), 2, 4, 3, 9);
    const next = apply(s, boldSpec(s));
    const out = serialise(next);
    assert.deepEqual(changedLines(text, out, sep), [2, 3]);
    assert.equal(out.split(sep)[2], 'She **turned it over twice.');
    assert.equal(out.split(sep)[3], 'Then she **slept.');
  });

  test(`link (${name}): at the caret inserts [[slug]]; a selection becomes [[slug|selected text]]`, () => {
    const text = bodyFor(sep);
    const caret = select(open(text), 2, 0);
    const a = apply(caret, linkSpec(caret, 'pell'));
    assert.equal(serialise(a), text.replace('She turned', '[[pell]]She turned'));
    assert.deepEqual(changedLines(text, serialise(a), sep), [2]);
    assertOnlyInsertions(caret, linkSpec(caret, 'pell'));

    const sel = select(open(text), 2, 4, 2, 10);
    const b = apply(sel, linkSpec(sel, 'pell'));
    assert.equal(serialise(b), text.replace('She turned it', 'She [[pell|turned]] it'));
    assert.deepEqual(changedLines(text, serialise(b), sep), [2]);
  });

  test(`author note (${name}): at the caret inserts <!-- note:  --> with the caret inside; a selection is wrapped`, () => {
    const text = bodyFor(sep);
    const caret = select(open(text), 1, 0);
    const a = apply(caret, noteSpec(caret));
    assert.equal(serialise(a), text.replace(`${sep}${sep}She`, `${sep}<!-- note:  -->${sep}She`));
    assert.deepEqual(changedLines(text, serialise(a), sep), [1]);
    const head = a.selection.main.head;
    assert.equal(a.sliceDoc(head - '<!-- note: '.length, head), '<!-- note: ');
    assert.equal(a.sliceDoc(head, head + ' -->'.length), ' -->');

    const sel = select(open(text), 2, 4, 2, 10);
    const b = apply(sel, noteSpec(sel));
    assert.equal(serialise(b), text.replace('She turned it', 'She <!-- note: turned --> it'));
  });

  test(`scene break (${name}): inserts a *** line with a blank line before and after, between two paragraphs`, () => {
    const text = bodyFor(sep);
    const s = select(open(text), 1, 0); // the blank line between the paragraphs
    const next = apply(s, sceneBreakSpec(s));
    const out = serialise(next).split(sep);
    const k = out.indexOf('***');
    assert.ok(k > 0);
    assert.equal(out[k - 1], '');
    assert.equal(out[k + 1], '');
    assert.equal(out.filter((l) => l === '***').length, 1);
    assert.equal(out.filter((l) => l !== '***').join(sep).replace(/(\r?\n){2,}/g, '\n'), lines.join(sep).replace(/(\r?\n){2,}/g, '\n'), 'no text was lost or changed');
    assertOnlyInsertions(s, sceneBreakSpec(s));
  });

  test(`scene break (${name}): in the middle of a paragraph line the break goes after the caret and the text stays intact`, () => {
    const text = bodyFor(sep);
    const s = select(open(text), 2, 10);
    const next = apply(s, sceneBreakSpec(s));
    const out = serialise(next);
    assert.ok(out.includes(`${sep}${sep}***${sep}${sep}`), JSON.stringify(out));
    assert.equal(out.replace(`${sep}${sep}***${sep}${sep}`, ''), text, 'removing the inserted block restores the original');
  });

  test(`scene break (${name}): at the end of a document without a final newline`, () => {
    const text = lines.slice(0, 4).join(sep); // ends "Then she slept."
    const s = select(open(text), 3, lines[3].length);
    const out = serialise(apply(s, sceneBreakSpec(s)));
    assert.ok(out.startsWith(text + sep + sep + '***'), JSON.stringify(out));
    assert.ok(out.slice(text.length).split(sep).includes('***'));
  });
}

test('bold with several selections wraps each of them', () => {
  const text = 'one two three';
  let s = open(text, [EditorState.allowMultipleSelections.of(true)]);
  s = s.update({ selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 13)]) }).state;
  assert.equal(serialise(apply(s, boldSpec(s))), '**one** two **three**');
});

test('link: a selection that cannot be a label (brackets, bar, line break) is left alone and the link follows it', () => {
  for (const [text, from, to] of [['a [b] c', 2, 5], ['a|b c', 0, 3], ['ab\ncd', 0, 5]]) {
    const s = open(text).update({ selection: EditorSelection.range(from, to) }).state;
    const out = serialise(apply(s, linkSpec(s, 'pell')));
    assert.ok(out.startsWith(text.slice(0, to)), 'selected text unchanged');
    assert.ok(out.includes('[[pell]]'));
    assert.equal(out.replace('[[pell]]', ''), text, 'only the link was inserted');
  }
});

test('author note: a selection that already contains --> is not wrapped (it would end the comment early)', () => {
  const s = open('a --> b').update({ selection: EditorSelection.range(0, 7) }).state;
  assert.equal(noteSpec(s), null);
});

// ---------------------------------------------------------------- the view-level commands

test('view commands: bold, italic, note, scene break and insertLink dispatch and keep undo history', () => {
  const text = 'The key was colder.\n\nShe turned it over.\n';
  const base = open(text, [history()]);
  const s = select(base, 2, 4, 2, 10);
  const afterBold = run(s, bold);
  assert.equal(afterBold.handled, true);
  assert.equal(serialise(afterBold.state), text.replace('turned', '**turned**'));

  // undo restores the original, redo re-applies
  const undone = run(afterBold.state, undo);
  assert.equal(serialise(undone.state), text);
  const redone = run(undone.state, redo);
  assert.equal(serialise(redone.state), text.replace('turned', '**turned**'));

  assert.equal(serialise(run(s, italic).state), text.replace('turned', '*turned*'));
  assert.equal(serialise(run(s, authorNote).state), text.replace('turned', '<!-- note: turned -->'));
  assert.equal(serialise(run(s, insertLink('pell')).state), text.replace('turned', '[[pell|turned]]'));
  assert.ok(serialise(run(select(base, 1, 0), sceneBreak).state).includes('\n***\n'));
});

test('view commands on a CRLF buffer keep CRLF through edit and undo', () => {
  const text = toCRLF('One line.\n\nTwo line.\n');
  const base = open(text, [history()]);
  const s = select(base, 2, 0, 2, 3);
  const edited = run(s, bold).state;
  assert.equal(serialise(edited), text.replace('Two', '**Two**'));
  assert.equal(serialise(run(edited, undo).state), text);
  const broke = run(select(base, 1, 0), sceneBreak).state;
  assert.ok(!/(?<!\r)\n/.test(serialise(broke)), 'the inserted scene break uses CRLF');
});

test('view commands do nothing on a read-only (mixed line endings) buffer', () => {
  const mixed = 'one\r\ntwo\nthree\r\n';
  const { state, readOnly } = loadBuffer(mixed);
  assert.equal(readOnly, true);
  const s = state.update({ selection: EditorSelection.range(0, 3) }).state;
  for (const cmd of [bold, italic, authorNote, sceneBreak, insertLink('pell')]) {
    const r = run(s, cmd);
    assert.equal(r.state, s, 'no transaction was dispatched');
  }
});

// ---------------------------------------------------------------- over every body

test('every body, LF and CRLF: bold/italic/link/note on a word change only that line and by exactly the markers', () => {
  const marks = [
    ['bold', boldSpec, (w) => `**${w}**`],
    ['italic', italicSpec, (w) => `*${w}*`],
    ['link', (s) => linkSpec(s, 'pell'), (w) => `[[pell|${w}]]`],
    ['note', noteSpec, (w) => `<!-- note: ${w} -->`],
  ];
  let checked = 0;
  for (const { name, body } of allBodies()) {
    for (const text of [toLF(body), toCRLF(body)]) {
      const sep = text.includes('\r\n') ? '\r\n' : '\n';
      const ls = text.split(sep);
      const i = ls.findIndex((l) => /^[A-Za-z][A-Za-z ,.']*$/.test(l) && l.includes(' '));
      if (i < 0) continue;
      const a = ls[i].indexOf(' ') + 1;
      const word = /^[A-Za-z']+/.exec(ls[i].slice(a))?.[0];
      if (!word) continue;
      const b = a + word.length;
      const s = select(open(text), i, a, i, b);
      for (const [label, spec, wrap] of marks) {
        const out = serialise(apply(s, spec(s)));
        const expected = [...ls];
        expected[i] = ls[i].slice(0, a) + wrap(word) + ls[i].slice(b);
        assert.equal(out, expected.join(sep), `${name} ${label}`);
        assert.deepEqual(changedLines(text, out, sep), [i], `${name} ${label}: only line ${i + 1}`);
        checked++;
      }
      // toggles come back byte for byte
      for (const spec of [boldSpec, italicSpec]) {
        const once = apply(s, spec(s));
        assert.equal(serialise(apply(once, spec(once))), text, `${name} toggle`);
      }
    }
  }
  assert.ok(checked >= 8 * 4, `commands were exercised (${checked})`);
});

test('every body, LF and CRLF: a scene break at a blank line or paragraph end only adds lines', () => {
  let checked = 0;
  for (const { name, body } of [...allBodies(), { name: 'torture', body: TORTURE }]) {
    for (const text of [toLF(body), toCRLF(body)]) {
      const sep = text.includes('\r\n') ? '\r\n' : '\n';
      const ls = text.split(sep);
      for (const i of new Set([0, Math.floor(ls.length / 2), ls.length - 1])) {
        const s = select(open(text), i, ls[i].length);
        const next = apply(s, sceneBreakSpec(s));
        const out = serialise(next);
        assert.ok(out.length > text.length, name);
        assert.ok(out.includes(`${sep}***${sep}`) || out.startsWith(`***${sep}`) || out.endsWith(`${sep}***`), `${name}: a *** line exists`);
        const before = ls.slice(0, i).join(sep);
        assert.ok(out.startsWith(before), `${name}: text before the break unchanged`);
        assert.ok(!/(?<!\r)\n/.test(out) || sep === '\n', `${name}: separator kept`);
        assertOnlyInsertions(s, sceneBreakSpec(s));
        assertBlankAround(s, sceneBreakSpec(s));
        checked++;
      }
    }
  }
  assert.ok(checked > 30);
});

test('scene break at the end of text that ends with a newline leaves a blank line after the *** (LF and CRLF)', () => {
  for (const sep of SEPS) {
    const text = `last paragraph${sep}`;
    const s = select(open(text), 0, 'last paragraph'.length);
    assertBlankAround(s, sceneBreakSpec(s));
  }
});
