// Focus mode (M03-J04 section 4): the keymap, the persisted options and the small calculations behind typewriter scrolling and
// "dim other paragraphs". Pure; none of it touches the document text.
import { bindingsFor, matchesChord } from '../shortcuts/registry.js';

export const FOCUS_OPTIONS_KEY = 'storyforge.focus';
/** @type {{ typewriter: boolean, dim: boolean }} */
export const DEFAULT_FOCUS_OPTIONS = { typewriter: false, dim: false };
/** Where the caret line sits while typewriter scrolling is on: this far down the visible area. */
export const TYPEWRITER_RATIO = 0.4;
/** Paragraphs other than the caret's are drawn at this opacity. */
export const DIM_OPACITY = 0.45;

/**
 * What a key press means for focus mode: 'toggle' (focus.toggle, Ctrl/Cmd+Shift+F unless rebound), 'exit' (focus.exit, Escape, while focused) or null. The bindings come from the
 * shortcut registry (M07-J04); without `bindings` the defaults are used.
 * Nothing happens while a dialog is open (Escape then belongs to the dialog).
 * @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean }} event
 * @param {{ focus: boolean, dialogOpen?: boolean }} state
 * @param {Record<string, string | null>} [bindings]
 * @returns {'toggle' | 'exit' | null}
 */
export function focusKeyAction(event, { focus, dialogOpen = false }, bindings = bindingsFor({})) {
  if (dialogOpen) return null;
  if (typeof event.key !== 'string') return null;
  if (matchesChord(event, bindings['focus.toggle'])) return 'toggle';
  if (focus && matchesChord(event, bindings['focus.exit'])) return 'exit';
  return null;
}

/** The saved options (typewriter / dim), tolerant of missing, broken or blocked storage. @param {{ getItem: (k: string) => string | null } | null | undefined} storage */
export function readFocusOptions(storage) {
  try {
    const raw = storage?.getItem(FOCUS_OPTIONS_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return { typewriter: v?.typewriter === true, dim: v?.dim === true };
  } catch {
    return { ...DEFAULT_FOCUS_OPTIONS };
  }
}

/** @param {{ setItem: (k: string, v: string) => void } | null | undefined} storage @param {{ typewriter: boolean, dim: boolean }} options */
export function writeFocusOptions(storage, options) {
  try {
    storage?.setItem(FOCUS_OPTIONS_KEY, JSON.stringify({ typewriter: options.typewriter === true, dim: options.dim === true }));
  } catch {
    // not remembered; the options still work for this visit
  }
}

/**
 * How far to scroll so the caret line sits at `ratio` of the way down the container (positive: scroll down).
 * @param {{ caretTop: number, containerTop: number, containerHeight: number, ratio?: number }} m
 */
export function typewriterDelta({ caretTop, containerTop, containerHeight, ratio = TYPEWRITER_RATIO }) {
  return Math.round(caretTop - (containerTop + containerHeight * ratio));
}

/**
 * The paragraph around a line: the first and last line index of the run of non-blank lines that contains `index`
 * (a blank line is its own one-line paragraph).
 * @param {string[]} lines @param {number} index 0-based
 * @returns {{ from: number, to: number }}
 */
export function paragraphBounds(lines, index) {
  const blank = (i) => (lines[i] ?? '').trim() === '';
  if (index < 0 || index >= lines.length || blank(index)) return { from: index, to: index };
  let from = index;
  let to = index;
  while (from > 0 && !blank(from - 1)) from--;
  while (to < lines.length - 1 && !blank(to + 1)) to++;
  return { from, to };
}
