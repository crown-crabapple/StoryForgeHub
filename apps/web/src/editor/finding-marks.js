// The editor's view of checker findings (M13-J01): an underline under each finding's exact range, and one action that applies a replacement.
// Findings live in the state field (not only as decorations) so they can follow edits. An edit touching a finding's range drops it as stale.
// Applying is an ordinary author edit (userEvent 'input.finding'): it enters history, so Undo restores the text. No network, no route.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

/** Replace the findings shown. Value: an array of findings (storyforge.finding/v1). */
export const setFindings = StateEffect.define();

/** Keep only findings whose range is inside the document and holds `original` there. @param {EditorState} state */
function keepCurrent(state, list) {
  const out = [];
  for (const f of list ?? []) {
    const r = f?.range;
    if (!r || !Number.isInteger(r.from) || !Number.isInteger(r.to)) continue;
    if (r.from < 0 || r.to <= r.from || r.to > state.doc.length) continue;
    if (state.sliceDoc(r.from, r.to) !== f.original) continue;
    out.push(f);
  }
  return out;
}

function decorate(list) {
  const ranges = list.map((f) => {
    const cls = `cm-finding cm-finding-${f.category} cm-finding-${f.severity}${f.advisory ? ' cm-finding-advisory' : ''}`;
    return Decoration.mark({
      class: cls,
      attributes: { 'data-finding': f.id, 'aria-description': f.message },
    }).range(f.range.from, f.range.to);
  });
  return Decoration.set(ranges, true);
}

/** Field value: { list (live findings), deco }. */
const field = StateField.define({
  create: () => ({ list: [], deco: Decoration.none }),
  update(value, tr) {
    let list = value.list;
    if (tr.docChanged) {
      const next = [];
      for (const f of list) {
        const { from, to } = f.range;
        if (tr.changes.touchesRange(from, to)) continue;
        next.push({ ...f, range: { from: tr.changes.mapPos(from, 1), to: tr.changes.mapPos(to, -1) } });
      }
      list = next;
    }
    let changed = tr.docChanged;
    for (const e of tr.effects) {
      if (e.is(setFindings)) {
        list = keepCurrent(tr.state, e.value);
        changed = true;
      }
    }
    return changed ? { list, deco: decorate(list) } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** The extension: add it once to the editor's extensions. */
export const findingMarks = () => [field];

/** The live findings after mapping through every edit. @param {EditorState} state */
export const findings = (state) => state.field(field).list;

/**
 * Pure core of applying a finding: the transaction spec, or a refusal code. Does not check read-only (the view does).
 * @param {EditorState} state @param {string} id @param {number} index
 * @returns {{ ok: true, spec: object } | { ok: false, code: string }}
 */
export function applyFindingTransaction(state, id, index) {
  const f = findings(state).find((x) => x.id === id);
  if (!f) return { ok: false, code: 'NOT_FOUND' };
  const reps = Array.isArray(f.replacements) ? f.replacements : [];
  if (!Number.isInteger(index) || index < 0 || index >= reps.length || typeof reps[index] !== 'string') {
    return { ok: false, code: 'NO_REPLACEMENT' };
  }
  const { from, to } = f.range;
  if (to > state.doc.length || state.sliceDoc(from, to) !== f.original) return { ok: false, code: 'STALE' };
  return {
    ok: true,
    spec: {
      changes: { from, to, insert: reps[index] },
      userEvent: 'input.finding',
    },
  };
}

/** Apply replacement `index` of finding `id` in the open editor. @param {EditorView} view @param {string} id @param {number} index */
export function applyFinding(view, id, index) {
  if (view.state.readOnly) return { ok: false, code: 'READ_ONLY' };
  const r = applyFindingTransaction(view.state, id, index);
  if (!r.ok) return r;
  view.dispatch(r.spec);
  return { ok: true };
}
