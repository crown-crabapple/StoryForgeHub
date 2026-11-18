// The editor finding layer (M13-J01), Node only: EditorState with no DOM. Decorations are read from the field.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { loadBuffer } from '../src/editor/buffer.js';
import { applyFinding, applyFindingTransaction, findingMarks, findings, setFindings } from '../src/editor/finding-marks.js';

const SCENE = 'scene_01HZX0000000000000000000AA';
let n = 0;
function mk(body, word, extra = {}) {
  const from = body.indexOf(word);
  assert.ok(from >= 0);
  n += 1;
  return {
    schema: 'storyforge.finding/v1',
    id: `fnd_${String(n).padStart(16, '0')}`,
    engine: 'sample',
    engineVersion: '1',
    ruleId: 'r',
    category: 'grammar',
    severity: 'error',
    advisory: false,
    message: `msg ${n}`,
    sceneId: SCENE,
    source: { sha256: '0'.repeat(64), length: body.length },
    range: { from, to: from + word.length },
    original: word,
    replacements: ['fixed', ''],
    ...extra,
  };
}
const open = (text, list) => {
  const { state } = loadBuffer(text, [history(), findingMarks()]);
  return list ? state.update({ effects: setFindings.of(list) }).state : state;
};
/** The decorated ranges, read back from the view-decorations facet. */
function decorated(state) {
  const out = [];
  for (const src of state.facet(EditorView.decorations)) {
    if (typeof src === 'function') continue;
    src.between(0, state.doc.length, (from, to, deco) => {
      out.push({ from, to, text: state.sliceDoc(from, to), spec: deco.spec });
    });
  }
  return out;
}
/** A view-like object: enough of EditorView for applyFinding. */
const fakeView = (state) => ({
  state,
  dispatched: 0,
  dispatch(spec) {
    this.dispatched += 1;
    this.state = this.state.update(spec).state;
  },
});

test('decorated at exactly its range, with class, id and description', () => {
  const body = 'He go home today.';
  const f = mk(body, 'go');
  const d = decorated(open(body, [f]));
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].from, d[0].to, d[0].text], [3, 5, 'go']);
  assert.match(d[0].spec.class, /^cm-finding cm-finding-grammar /);
  assert.equal(d[0].spec.attributes['data-finding'], f.id);
  assert.equal(d[0].spec.attributes['aria-description'], f.message);
});

test('advisory findings get cm-finding-advisory', () => {
  const body = 'It was very good.';
  const d = decorated(open(body, [mk(body, 'very', { advisory: true, category: 'style', severity: 'info' })]));
  assert.match(d[0].spec.class, /cm-finding-advisory/);
});

test('exact range after an emoji (surrogate pair counts 2)', () => {
  const body = 'Wave 🌊 then teh end.';
  const f = mk(body, 'teh');
  const d = decorated(open(body, [f]));
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'teh');
  assert.equal(d[0].from, body.indexOf('teh'));
});

test('exact range in a CRLF buffer (line break counts 1)', () => {
  const lf = 'first line\nsecond teh line';
  const f = mk(lf, 'teh');
  const state = open(lf.replace(/\n/g, '\r\n'), [f]);
  assert.equal(state.lineBreak, '\r\n');
  const d = decorated(state);
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'teh');
  assert.equal(d[0].from, f.range.from);
});

test('a finding whose original does not match at load, or is out of range, is not drawn', () => {
  const body = 'He go home.';
  const bad = mk(body, 'go', { original: 'no' });
  const out = mk(body, 'go', { range: { from: 5, to: 99 } });
  const state = open(body, [bad, out]);
  assert.equal(decorated(state).length, 0);
  assert.equal(findings(state).length, 0);
});

test('an edit before the finding moves it; an edit after leaves it', () => {
  const body = 'He go home.';
  const f = mk(body, 'go');
  let state = open(body, [f]);
  state = state.update({ changes: { from: 0, insert: 'Well, ' } }).state;
  assert.equal(decorated(state)[0].text, 'go');
  assert.equal(findings(state)[0].range.from, 9);
  state = state.update({ changes: { from: state.doc.length, insert: ' More.' } }).state;
  assert.equal(decorated(state)[0].text, 'go');
});

test('an edit inside, across or replacing the range drops the finding', () => {
  const body = 'He gooo home.';
  const f = mk(body, 'gooo');
  for (const ch of [{ from: 4, insert: 'x' }, { from: 3, to: 5 }, { from: 3, to: 7, insert: 'went' }, { from: 1, to: 4 }]) {
    const state = open(body, [f]).update({ changes: ch }).state;
    assert.equal(findings(state).length, 0, JSON.stringify(ch));
    assert.equal(decorated(state).length, 0);
  }
});

test('apply changes exactly the range; undo restores the previous document', () => {
  const body = 'Wave 🌊 He go home.';
  const f = mk(body, 'go');
  const state = open(body, [f]);
  const r = applyFindingTransaction(state, f.id, 0);
  assert.equal(r.ok, true);
  assert.equal(r.spec.userEvent, 'input.finding');
  let next = state.update(r.spec).state;
  assert.equal(next.doc.toString(), body.replace('go', 'fixed'));
  assert.equal(findings(next).length, 0);
  undo({ state: next, dispatch: (tr) => { next = tr.state; } });
  assert.equal(next.doc.toString(), body);
});

test('apply with an empty-string replacement deletes the range', () => {
  const body = 'He go home.';
  const f = mk(body, 'go ');
  const state = open(body, [f]);
  const r = applyFindingTransaction(state, f.id, 1);
  assert.equal(state.update(r.spec).state.doc.toString(), 'He home.');
});

test('applyFinding dispatches one transaction and returns ok', () => {
  const body = 'He go home.';
  const f = mk(body, 'go');
  const view = fakeView(open(body, [f]));
  assert.deepEqual(applyFinding(view, f.id, 0), { ok: true });
  assert.equal(view.dispatched, 1);
  assert.equal(view.state.doc.toString(), 'He fixed home.');
});

test('applyFinding in a read-only editor returns READ_ONLY and changes nothing', () => {
  const body = 'He go home.';
  const f = mk(body, 'go');
  const base = EditorState.create({ doc: body, extensions: [findingMarks(), EditorState.readOnly.of(true)] });
  const view = fakeView(base.update({ effects: setFindings.of([f]) }).state);
  assert.deepEqual(applyFinding(view, f.id, 0), { ok: false, code: 'READ_ONLY' });
  assert.equal(view.dispatched, 0);
  assert.equal(view.state.doc.toString(), body);
});

test('STALE: the live text at the mapped range is not the original; nothing is dispatched', () => {
  const body = 'He go home.';
  const f = mk(body, 'go');
  const real = open(body, [f]);
  // The field drops a finding on any edit that touches it, so reach the guard with a state whose text there differs.
  const stale = {
    field: (fld) => real.field(fld),
    doc: real.doc,
    readOnly: false,
    sliceDoc: () => 'zz',
  };
  assert.deepEqual(applyFindingTransaction(stale, f.id, 0), { ok: false, code: 'STALE' });
  const view = { state: stale, dispatch() { throw new Error('must not dispatch'); } };
  assert.deepEqual(applyFinding(view, f.id, 0), { ok: false, code: 'STALE' });
});

test('NOT_FOUND and NO_REPLACEMENT', () => {
  const body = 'He go home.';
  const f = mk(body, 'go');
  const none = mk(body, 'home', { replacements: [] });
  const state = open(body, [f, none]);
  assert.deepEqual(applyFindingTransaction(state, 'fnd_0000000000000000', 0), { ok: false, code: 'NOT_FOUND' });
  assert.deepEqual(applyFindingTransaction(state, none.id, 0), { ok: false, code: 'NO_REPLACEMENT' });
  assert.deepEqual(applyFindingTransaction(state, f.id, 5), { ok: false, code: 'NO_REPLACEMENT' });
  assert.deepEqual(applyFindingTransaction(state, f.id, -1), { ok: false, code: 'NO_REPLACEMENT' });
  assert.equal(state.doc.toString(), body);
});
