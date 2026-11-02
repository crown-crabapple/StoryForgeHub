// The editor's view of the continuity findings (M05-J02): a subtle dotted underline under the evidence of each finding in the open scene.
// Decoration only: nothing here changes the text, the undo history or what is saved. The underline follows the text as it is edited.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

/** Replace the marks. Each: { line (1-based line of the editor text), from, to (0-based columns on that line), title, fingerprint }. */
export const setContinuityMarks = StateEffect.define();

/** @param {import('@codemirror/state').EditorState} state @param {any[]} marks */
function build(state, marks) {
  const ranges = [];
  for (const m of marks ?? []) {
    if (!Number.isInteger(m.line) || m.line < 1 || m.line > state.doc.lines) continue;
    const line = state.doc.line(m.line);
    const from = Math.min(line.from + Math.max(0, m.from), line.to);
    const to = Math.min(line.from + Math.max(0, m.to), line.to);
    if (to <= from) continue;
    ranges.push(
      Decoration.mark({
        class: 'cm-continuity',
        attributes: { title: m.title, 'aria-description': m.title, 'data-finding': m.fingerprint },
      }).range(from, to),
    );
  }
  return Decoration.set(ranges, true);
}

const field = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setContinuityMarks)) next = build(tr.state, e.value);
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The extension: add it once to the editor's extensions. */
export const continuityMarks = () => [field];
