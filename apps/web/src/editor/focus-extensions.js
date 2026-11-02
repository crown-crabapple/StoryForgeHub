// CodeMirror pieces for focus mode: typewriter scrolling and "dim other paragraphs". Both only change how the editor looks and
// scrolls; the text, the undo history and what is saved are untouched.
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, ViewPlugin } from '@codemirror/view';
import { paragraphBounds, typewriterDelta } from '../writing/focus.js';

const dimLine = Decoration.line({ class: 'cm-dim' });

/** Lines outside the caret's paragraph get the `cm-dim` class. */
function dimDecorations(view) {
  const { doc, selection } = view.state;
  const lines = [];
  for (let i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text);
  const { from, to } = paragraphBounds(lines, doc.lineAt(selection.main.head).number - 1);
  const builder = new RangeSetBuilder();
  for (let i = 0; i < lines.length; i++) {
    if (i >= from && i <= to) continue;
    builder.add(doc.line(i + 1).from, doc.line(i + 1).from, dimLine);
  }
  return builder.finish();
}

const dimPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = dimDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.selectionSet) this.decorations = dimDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/** The nearest ancestor that scrolls, else the page. @param {HTMLElement} el */
function scrollParent(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** After the caret moves while typing, scroll so its line stays about 40% from the top of the visible area. */
const typewriterPlugin = ViewPlugin.fromClass(
  class {
    update(update) {
      if (!(update.docChanged || update.selectionSet) || !update.view.hasFocus) return;
      update.view.requestMeasure({
        read(view) {
          const at = view.coordsAtPos(view.state.selection.main.head);
          if (!at) return null;
          const scroller = scrollParent(view.dom);
          const isPage = scroller === document.scrollingElement || scroller === document.documentElement;
          const box = isPage ? { top: 0, height: window.innerHeight } : scroller.getBoundingClientRect();
          return { scroller, caretTop: at.top, containerTop: box.top, containerHeight: box.height };
        },
        write(m) {
          if (!m) return;
          const delta = typewriterDelta(m);
          if (Math.abs(delta) > 1) m.scroller.scrollBy({ top: delta, left: 0, behavior: 'instant' });
        },
      });
    }
  },
);

/** @param {{ typewriter: boolean, dim: boolean }} options @returns {import('@codemirror/state').Extension[]} */
export function focusExtensions({ typewriter, dim }) {
  return [...(typewriter ? [typewriterPlugin] : []), ...(dim ? [dimPlugin] : [])];
}
