// The editor buffer: loading a scene body, finding its line ending, and serialising it back. No DOM.
// The rule (ADR 0002): load then serialise without edits gives back the identical string.
import { EditorState, Transaction } from '@codemirror/state';

/**
 * @typedef {{ kind: 'lf' | 'crlf' | 'mixed', crlf: number, lf: number, cr: number }} LineEndings
 *   `kind` 'lf' also covers a text with no line break at all. A bare CR counts as mixed (it would otherwise be
 *   turned into a line break by the editor).
 */

/** Count the line endings of a text. @param {string} text @returns {LineEndings} */
export function detectLineEnding(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  /** @type {LineEndings['kind']} */
  let kind = 'lf';
  if (cr > 0 || (crlf > 0 && lf > 0)) kind = 'mixed';
  else if (crlf > 0) kind = 'crlf';
  return { kind, crlf, lf, cr };
}

/** The ending most lines use (CRLF only when it is the larger count). @param {LineEndings} info @returns {'\n' | '\r\n'} */
export function majorityEnding(info) {
  return info.crlf > info.lf + info.cr ? '\r\n' : '\n';
}

/**
 * What "Normalise line endings" would do: how many of the line endings change, and to what.
 * @param {string} text @returns {{ target: '\n' | '\r\n', changing: number, total: number }}
 */
export function normalisePreview(text) {
  const info = detectLineEnding(text);
  const target = majorityEnding(info);
  const total = info.crlf + info.lf + info.cr;
  const same = target === '\r\n' ? info.crlf : info.lf;
  return { target, changing: total - same, total };
}

/** Every line ending (CRLF, LF or bare CR) becomes `ending`. @param {string} text @param {'\n' | '\r\n'} ending */
export function normaliseLineEndings(text, ending) {
  return text.replace(/\r\n|\r|\n/g, ending);
}

/** Every line break in `text` (CRLF, CR or LF) becomes `lineBreak`. @param {string} text @param {string} lineBreak */
export const toLineBreak = (text, lineBreak) => text.replace(/\r\n|\r|\n/g, lineBreak);

/**
 * The extensions that make a text round-trip: a CRLF file gets the CRLF line separator.
 * @param {LineEndings} info @returns {import('@codemirror/state').Extension[]}
 */
export function lineEndingExtensions(info) {
  return info.kind === 'crlf' ? [EditorState.lineSeparator.of('\r\n')] : [];
}

/**
 * Transaction filter (pure, no DOM): with a CRLF separator CodeMirror splits inserted text on CRLF only, so pasted,
 * dropped or command text holding a bare LF or CR would leave a foreign line ending inside a line (mixed endings on
 * disk). This rewrites every inserted line break to the buffer's own separator. Returns the transaction itself when
 * nothing needs fixing, otherwise an equivalent transaction spec (same changes, selection, user event, history flags).
 * @param {import('@codemirror/state').Transaction} tr
 */
export function lineBreakFilter(tr) {
  if (!tr.docChanged) return tr;
  const lb = tr.startState.lineBreak;
  const fixes = [];
  let dirty = false;
  let sameLength = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const lines = [];
    for (const line of inserted.iterLines()) lines.push(line);
    if (lines.some((l) => /[\r\n]/.test(l))) dirty = true;
    const insert = lines.map((l) => toLineBreak(l, lb)).join(lb);
    if (tr.startState.toText(insert).length !== inserted.length) sameLength = false;
    fixes.push({ from: fromA, to: toA, insert });
  });
  if (!dirty) return tr;
  const annotations = [Transaction.userEvent, Transaction.addToHistory, Transaction.remote]
    .map((type) => {
      const value = tr.annotation(type);
      return value === undefined ? null : type.of(value);
    })
    .filter((a) => a !== null);
  return {
    changes: fixes,
    ...(sameLength && tr.selection ? { selection: tr.selection } : {}),
    effects: tr.effects,
    annotations,
    scrollIntoView: tr.scrollIntoView,
    filter: false,
  };
}

/** The extension form of {@link lineBreakFilter}; `loadBuffer` always includes it. */
export const lineBreakGuard = EditorState.transactionFilter.of(lineBreakFilter);

/**
 * A new editor state holding `text` exactly. @param {string} text
 * @param {import('@codemirror/state').Extension[]} [extensions]
 * @returns {{ state: EditorState, lineEndings: LineEndings, readOnly: boolean }} `readOnly` is true for mixed endings (the
 *   caller must also make the view non-editable).
 */
export function loadBuffer(text, extensions = []) {
  const lineEndings = detectLineEnding(text);
  const readOnly = lineEndings.kind === 'mixed';
  const state = EditorState.create({
    doc: text,
    extensions: [...lineEndingExtensions(lineEndings), lineBreakGuard, ...(readOnly ? [EditorState.readOnly.of(true)] : []), ...extensions],
  });
  return { state, lineEndings, readOnly };
}

/** The buffer as it goes to disk (not `doc.toString()`, which always joins with LF). @param {EditorState} state */
export function serialise(state) {
  return state.sliceDoc(0, state.doc.length, state.lineBreak);
}

/** The 1-based line of the main selection's head (what "Split here" uses). @param {EditorState} state */
export function caretLine(state) {
  return state.doc.lineAt(state.selection.main.head).number;
}
