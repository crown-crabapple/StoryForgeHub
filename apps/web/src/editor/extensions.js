// CodeMirror extensions for the scene editor: Markdown highlighting plus decorations. Everything here only changes
// how the text LOOKS; the text itself is never touched (ADR 0002). Class names are styled in styles.css.
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** The small "note" label before an author note. It is not part of the text. */
class NoteLabel extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-note-label';
    el.setAttribute('aria-hidden', 'true');
    el.textContent = 'note';
    return el;
  }
}
const noteLabel = Decoration.widget({ widget: new NoteLabel(), side: -1 });

const mark = (cls) => Decoration.mark({ class: cls });
const M_NOTE = mark('cm-note');
const M_COMMENT = mark('cm-comment');
const M_WL_MARK = mark('cm-wl-mark');
const M_WL_LABEL = mark('cm-wl-label');
const M_CITE = mark('cm-cite');
const L_BREAK = Decoration.line({ class: 'cm-scene-break' });

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const NOTE_START_RE = /^<!--\s*note:/i;
const WIKI_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g;
const CITE_RE = /\[@[^\]\n]+\]/g;
const BREAK_LINE_RE = /^\s*\*\*\*\s*$/;

/**
 * The decoration ranges for a text: [{ from, to, deco }] (a widget has from === to). Pure, so it can be tested
 * without a view. Wiki-links and citations inside a comment are left to the comment's own style.
 * @param {string} text
 */
export function decorationRanges(text) {
  /** @type {{ from: number, to: number, deco: Decoration }[]} */
  const out = [];
  /** @type {[number, number][]} */
  const comments = [];
  for (const m of text.matchAll(COMMENT_RE)) {
    const from = m.index;
    const to = from + m[0].length;
    comments.push([from, to]);
    if (NOTE_START_RE.test(m[0])) {
      out.push({ from, to: from, deco: noteLabel });
      out.push({ from, to, deco: M_NOTE });
    } else out.push({ from, to, deco: M_COMMENT });
  }
  const inComment = (pos) => comments.some(([a, b]) => pos >= a && pos < b);
  for (const m of text.matchAll(WIKI_RE)) {
    const start = m.index;
    if (inComment(start)) continue;
    const end = start + m[0].length;
    if (m[2] === undefined) {
      out.push({ from: start, to: start + 2, deco: M_WL_MARK });
      out.push({ from: start + 2, to: end - 2, deco: M_WL_LABEL });
      out.push({ from: end - 2, to: end, deco: M_WL_MARK });
    } else {
      const labelStart = start + 2 + m[1].length + 1;
      const labelEnd = labelStart + m[2].length;
      out.push({ from: start, to: labelStart, deco: M_WL_MARK });
      if (labelEnd > labelStart) out.push({ from: labelStart, to: labelEnd, deco: M_WL_LABEL });
      out.push({ from: labelEnd, to: end, deco: M_WL_MARK });
    }
  }
  for (const m of text.matchAll(CITE_RE)) {
    if (!inComment(m.index)) out.push({ from: m.index, to: m.index + m[0].length, deco: M_CITE });
  }
  let pos = 0;
  for (const line of text.split('\n')) {
    if (BREAK_LINE_RE.test(line.replace(/\r$/, '')) && !inComment(pos)) out.push({ from: pos, to: pos, deco: L_BREAK });
    pos += line.length + 1;
  }
  return out;
}

/** Offsets in `text` (which uses LF) map 1:1 to the document, because the document is built with the same breaks. */
function buildDecorations(state) {
  const ranges = decorationRanges(state.doc.toString());
  const decos = ranges.map((r) => r.deco.range(r.from, r.to));
  return Decoration.set(decos, true);
}

const decorations = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildDecorations(view.state);
    }
    update(update) {
      if (update.docChanged) this.decorations = buildDecorations(update.state);
    }
  },
  { decorations: (v) => v.decorations },
);

// Markdown syntax marks (** * # > ` and so on) get one class, so "Show Markdown marks" can dim or hide them.
const highlight = HighlightStyle.define([
  { tag: tags.heading1, class: 'cm-md-h1' },
  { tag: tags.heading2, class: 'cm-md-h2' },
  { tag: tags.heading3, class: 'cm-md-h3' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], class: 'cm-md-h4' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-em' },
  { tag: tags.strikethrough, class: 'cm-md-strike' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: tags.quote, class: 'cm-md-quote' },
  { tag: [tags.link, tags.url], class: 'cm-md-link' },
  { tag: tags.processingInstruction, class: 'cm-md-mark' },
]);

/** Layout of the editing surface (the colours and fonts come from the design tokens). */
const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: 'var(--text-2)', fontFamily: 'var(--font-prose)', fontSize: 'var(--fs-prose)' },
    '.cm-scroller': { fontFamily: 'var(--font-prose)', lineHeight: 'var(--lh-prose)', overflow: 'visible' },
    '.cm-content': { padding: '0', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-placeholder': { color: 'var(--muted)', fontStyle: 'italic' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--accent-soft)' },
  },
  { dark: true },
);

/** Wraps the compartment that turns the dimmed Markdown marks into nearly hidden ones. */
export const marksCompartment = new Compartment();

/** @param {boolean} show true = marks dimmed but visible; false = nearly hidden (still in the text and selectable) */
export const marksExtension = (show) => marksCompartment.of(show ? [] : EditorView.editorAttributes.of({ class: 'sf-hide-marks' }));

/** Reconfigure effect for the marks toggle. @param {boolean} show */
export const setMarks = (show) => marksCompartment.reconfigure(show ? [] : EditorView.editorAttributes.of({ class: 'sf-hide-marks' }));

/**
 * The decorated Markdown editing extensions (no keymaps, history or save logic: the component adds those).
 * `addKeymap: false` so Enter does not continue list markers or otherwise add text the author did not type.
 */
export const decoratedMarkdown = () => [
  markdown({ base: markdownLanguage, addKeymap: false }),
  syntaxHighlighting(highlight),
  decorations,
  theme,
  EditorView.lineWrapping,
];

/** The plain editing surface for the raw-file escape hatch: no Markdown language, no decorations. */
export const plainSurface = () => [
  EditorView.lineWrapping,
  EditorView.theme(
    {
      '&': { backgroundColor: 'var(--bg)', color: 'var(--text-2)', fontFamily: 'ui-monospace, Consolas, "Courier New", monospace', fontSize: '14px' },
      '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.55' },
      '.cm-content': { caretColor: 'var(--accent)', padding: 'var(--s3) 0' },
      '&.cm-focused': { outline: 'none' },
      '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { background: 'var(--accent-soft)' },
    },
    { dark: true },
  ),
];
