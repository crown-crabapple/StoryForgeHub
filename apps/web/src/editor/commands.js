// Editor commands. They only insert or wrap text; no other text is rewritten (ADR 0002). Each `*Spec`
// function reads an EditorState and returns a transaction spec (or null for "nothing to do"), so it can be
// tested without a DOM. The `Command`s at the bottom dispatch those specs on a view-like { state, dispatch }.
import { EditorSelection } from '@codemirror/state';

const NOTE_OPEN = '<!-- note: ';
const NOTE_CLOSE = ' -->';

/** Number of `ch` characters in a row ending at `end` (going left) or starting at `start` (going right). */
function runBefore(state, pos, ch) {
  let n = 0;
  while (pos - n > 0 && state.sliceDoc(pos - n - 1, pos - n) === ch) n++;
  return n;
}
function runAfter(state, pos, ch) {
  let n = 0;
  while (pos + n < state.doc.length && state.sliceDoc(pos + n, pos + n + 1) === ch) n++;
  return n;
}

/**
 * Does a pair of `k` stars round a text mean this marker is already on? Bold ("**", length 2) is on for 2 or more
 * stars each side; italic ("*", length 1) for an odd number (so `**x**` is bold, `***x***` is bold and italic).
 */
const isOn = (len, k) => (len === 2 ? k >= 2 : k % 2 === 1);

/**
 * Toggle `**` (len 2) or `*` (len 1) round every selection range. Nothing but the marker characters is added
 * or removed. With no selection the markers are inserted with the caret between them.
 * @param {import('@codemirror/state').EditorState} state
 * @param {1 | 2} len
 */
export function toggleEmphasisSpec(state, len) {
  const m = '*'.repeat(len);
  return state.changeByRange((range) => {
    const { from, to } = range;
    const text = state.sliceDoc(from, to);
    // 1. the selection itself starts and ends with the marker: take it off
    const lead = text.length - text.replace(/^\*+/, '').length;
    const trail = text.length - text.replace(/\*+$/, '').length;
    const inner = Math.min(lead, trail, Math.floor(text.length / 2));
    if (!range.empty && isOn(len, inner)) {
      return {
        changes: [{ from, to: from + len }, { from: to - len, to }],
        range: EditorSelection.range(from, to - 2 * len),
      };
    }
    // 2. the markers sit just outside the selection: take them off
    const outer = Math.min(runBefore(state, from, '*'), runAfter(state, to, '*'));
    if (isOn(len, outer)) {
      return {
        changes: [{ from: from - len, to: from }, { from: to, to: to + len }],
        range: EditorSelection.range(from - len, to - len),
      };
    }
    // 3. put them on
    return {
      changes: [{ from, insert: m }, { from: to, insert: m }],
      range: EditorSelection.range(from + len, to + len),
    };
  });
}

/** Bold: `**…**`. @param {import('@codemirror/state').EditorState} state */
export const boldSpec = (state) => toggleEmphasisSpec(state, 2);
/** Italic: `*…*`. @param {import('@codemirror/state').EditorState} state */
export const italicSpec = (state) => toggleEmphasisSpec(state, 1);

/** A selection that cannot sit inside `[[slug|label]]` as it is (it would break the link). */
const LINK_UNSAFE = /[[\]|\r\n]/;

/**
 * Insert a link to a Codex entry / thread / event: `[[slug]]` at the caret, or `[[slug|selected text]]` round a
 * selection. A selection that cannot be a link label (brackets, a bar, a line break) is left alone and the link
 * is inserted after it.
 * @param {import('@codemirror/state').EditorState} state @param {string} slug
 */
export function linkSpec(state, slug) {
  return state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    if (range.empty || LINK_UNSAFE.test(selected)) {
      const insert = `[[${slug}]]`;
      return { changes: { from: range.to, insert }, range: EditorSelection.cursor(range.to + insert.length) };
    }
    const insert = `[[${slug}|${selected}]]`;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
}

/**
 * Author note: `<!-- note:  -->` with the caret inside, or the selection wrapped as `<!-- note: text -->`.
 * A selection that contains `-->` cannot be wrapped (it would end the comment early): then nothing happens (null).
 * @param {import('@codemirror/state').EditorState} state
 */
export function noteSpec(state) {
  if (state.selection.ranges.some((r) => !r.empty && state.sliceDoc(r.from, r.to).includes('-->'))) return null;
  return state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: `${NOTE_OPEN}${NOTE_CLOSE}` },
        range: EditorSelection.cursor(range.from + NOTE_OPEN.length),
      };
    }
    return {
      changes: [{ from: range.from, insert: NOTE_OPEN }, { from: range.to, insert: NOTE_CLOSE }],
      range: EditorSelection.range(range.from + NOTE_OPEN.length, range.to + NOTE_OPEN.length),
    };
  });
}

const isBlank = (state, lineNumber) => state.doc.line(lineNumber).text.trim() === '';

/**
 * Scene break: a line `***` with a blank line before and after, inserted at the end of the main selection
 * (nothing is deleted). Only the line breaks needed to make the blank lines are added.
 * @param {import('@codemirror/state').EditorState} state
 */
export function sceneBreakSpec(state) {
  const lb = state.lineBreak;
  const pos = state.selection.main.to;
  const line = state.doc.lineAt(pos);
  const atLineStart = pos === line.from;
  const afterText = state.sliceDoc(pos, line.to);
  let prefix;
  if (!atLineStart) prefix = lb + lb;
  else if (line.number === 1 || isBlank(state, line.number - 1)) prefix = '';
  else prefix = lb;
  let suffix;
  if (afterText !== '') suffix = lb + lb;
  else if (line.number === state.doc.lines) suffix = lb + lb;
  else if (isBlank(state, line.number + 1) && !(line.number + 1 === state.doc.lines && state.doc.line(line.number + 1).length === 0)) suffix = '';
  else suffix = lb;
  const insert = `${prefix}***${suffix}`;
  // a line break counts as one position in the document, whatever the file's separator is
  return { changes: { from: pos, insert }, selection: EditorSelection.cursor(pos + state.toText(insert).length) };
}

// ---------------------------------------------------------------- commands for a view ({ state, dispatch })

/** @param {(state: import('@codemirror/state').EditorState) => any} makeSpec @returns {(view: { state: any, dispatch: (tr: any) => void }) => boolean} */
function commandOf(makeSpec) {
  return ({ state, dispatch }) => {
    if (state.readOnly) return true;
    const spec = makeSpec(state);
    if (spec) dispatch(state.update(spec, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

export const bold = commandOf(boldSpec);
export const italic = commandOf(italicSpec);
export const authorNote = commandOf(noteSpec);
export const sceneBreak = commandOf(sceneBreakSpec);
/** @param {string} slug */
export const insertLink = (slug) => commandOf((state) => linkSpec(state, slug));
