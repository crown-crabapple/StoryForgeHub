// Pending suggestions shown inside the editor text (inline review): the original lines of a hunk are struck through and a card under them shows the proposed lines
// with Accept / Decline. Decoration only: nothing here changes the text, the undo history or what is saved. A hunk whose lines no longer match the buffer
// (the author has unsaved edits there) is not drawn, and a hunk is dropped as soon as the author edits the lines it marks.
import { Facet, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { hunkSides, sourceLabelOf } from '../suggestions/model.js';

/**
 * Replace the suggestion marks. Each: { suggestionId, hunkId, line (1-based line of the editor text: the first original line, or the line the new lines go before),
 * lines, originalLines, newLines, rationale, by, source, canDecide }.
 */
export const setSuggestionMarks = StateEffect.define();

/** The callback of the cards' buttons: `(suggestionId, hunkId, 'accept' | 'decline') => Promise | void`. Give a function that stays the same for the editor's life. */
export const suggestionHandler = Facet.define({ combine: (values) => values[0] ?? null });

const stripCr = (s) => String(s).replace(/\r$/, '');

/**
 * Which suggestions can be drawn against the editor text: a hunk is kept when its original lines are exactly the lines of the text where it says (a trailing \r is ignored);
 * a pure insertion (`lines` 0) when its line is in the text or just after it. Pure: no CodeMirror.
 * @param {string[]} docLines the lines of the editor text @param {any[]} suggestions @returns {any[]} the kept marks, each with `kind: 'replace' | 'insert'`
 */
export function planSuggestionMarks(docLines, suggestions) {
  const out = [];
  for (const s of suggestions ?? []) {
    if (!Number.isInteger(s?.line) || !Number.isInteger(s.lines) || s.line < 1 || s.lines < 0) continue;
    const original = s.originalLines ?? [];
    if (s.lines === 0) {
      if (s.line <= docLines.length + 1) out.push({ ...s, kind: 'insert' });
      continue;
    }
    if (original.length !== s.lines || s.line + s.lines - 1 > docLines.length) continue;
    let same = true;
    for (let i = 0; i < s.lines && same; i++) same = stripCr(docLines[s.line - 1 + i]) === stripCr(original[i]);
    if (same) out.push({ ...s, kind: 'replace' });
  }
  return out;
}

class SuggestionCard extends WidgetType {
  /** @param {any} mark @param {{ handler: Function | null }} env */
  constructor(mark, env) {
    super();
    this.mark = mark;
    this.env = env;
  }

  eq(other) {
    const a = this.mark;
    const b = other.mark;
    return (
      a.suggestionId === b.suggestionId &&
      a.hunkId === b.hunkId &&
      a.kind === b.kind &&
      a.canDecide === b.canDecide &&
      a.rationale === b.rationale &&
      a.source === b.source &&
      a.by?.name === b.by?.name &&
      (a.newLines ?? []).join('\n') === (b.newLines ?? []).join('\n') &&
      (a.originalLines ?? []).join('\n') === (b.originalLines ?? []).join('\n')
    );
  }

  ignoreEvent() {
    return true;
  }

  toDOM() {
    const m = this.mark;
    const card = document.createElement('div');
    card.className = 'cm-sugg-card';
    card.dataset.suggestion = m.suggestionId;
    card.dataset.hunk = m.hunkId;
    const newLines = m.newLines ?? [];
    const body = document.createElement('div');
    body.className = 'cm-sugg-new';
    if (newLines.length === 0) {
      const gone = document.createElement('div');
      gone.className = 'cm-sugg-ins cm-sugg-none';
      gone.textContent = 'Remove the struck-through text';
      body.append(gone);
    } else {
      // a one-line replacement shows which words changed (<ins> in the proposal)
      const words = m.kind === 'replace' && m.originalLines?.length === 1 && newLines.length === 1 ? hunkSides({ originalLines: m.originalLines, newLines }).after : null;
      newLines.forEach((text) => {
        const row = document.createElement('div');
        row.className = 'cm-sugg-ins';
        if (words) {
          for (const p of words) {
            if (p.type === 'add') {
              const ins = document.createElement('ins');
              ins.textContent = p.text;
              row.append(ins);
            } else row.append(document.createTextNode(p.text));
          }
        } else row.textContent = text === '' ? ' ' : text;
        if (!row.textContent) row.textContent = ' ';
        body.append(row);
      });
    }
    card.append(body);

    const meta = document.createElement('div');
    meta.className = 'cm-sugg-meta';
    const who = m.by?.name ?? sourceLabelOf(m.source ?? 'ai');
    const label = document.createElement('span');
    label.className = 'cm-sugg-label';
    label.textContent = m.canDecide ? `Suggested by ${who}` : `Suggested change (${who})`;
    meta.append(label);
    const why = String(m.rationale ?? '').trim();
    if (why) {
      const r = document.createElement('span');
      r.className = 'cm-sugg-why';
      r.title = why;
      const oneLine = why.replace(/\s+/g, ' ');
      r.textContent = oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine;
      meta.append(r);
    }
    if (m.canDecide) {
      const actions = document.createElement('span');
      actions.className = 'cm-sugg-actions';
      const buttons = [];
      const make = (decision, text, extra) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn btn-small${extra}`;
        b.textContent = text;
        b.setAttribute('aria-label', `${text} this suggested change`);
        b.addEventListener('mousedown', (e) => e.preventDefault()); // the editor keeps its caret
        b.addEventListener('click', (e) => {
          e.preventDefault();
          if (!this.env.handler) return;
          for (const x of buttons) x.disabled = true;
          Promise.resolve(this.env.handler(m.suggestionId, m.hunkId, decision)).finally(() => {
            for (const x of buttons) x.disabled = false;
          });
        });
        buttons.push(b);
        actions.append(b);
      };
      make('accept', 'Accept', ' btn-primary');
      make('decline', 'Decline', '');
      meta.append(actions);
    }
    card.append(meta);
    return card;
  }
}

/** @param {import('@codemirror/state').EditorState} state @param {{ from: number, to: number, mark: any }[]} entries */
function decorate(state, entries) {
  const env = { handler: state.facet(suggestionHandler) };
  const ranges = [];
  for (const e of entries) {
    const widget = new SuggestionCard(e.mark, env);
    if (e.mark.kind === 'insert') {
      ranges.push(Decoration.widget({ widget, block: true, side: e.side }).range(e.at));
      continue;
    }
    const first = state.doc.lineAt(e.from).number;
    const last = state.doc.lineAt(e.to).number;
    for (let n = first; n <= last; n++) ranges.push(Decoration.line({ class: 'cm-sugg-del', attributes: { 'data-hunk': e.mark.hunkId } }).range(state.doc.line(n).from));
    ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(e.to));
  }
  return Decoration.set(ranges, true);
}

/** @param {import('@codemirror/state').EditorState} state @param {any[]} marks */
function build(state, marks) {
  const docLines = [];
  for (let n = 1; n <= state.doc.lines; n++) docLines.push(state.doc.line(n).text);
  const entries = planSuggestionMarks(docLines, marks).map((mark) => {
    if (mark.kind === 'insert') {
      const at = mark.line <= state.doc.lines ? state.doc.line(mark.line).from : state.doc.length;
      return { from: at, to: at, at, side: mark.line <= state.doc.lines ? -1 : 1, mark };
    }
    const from = state.doc.line(mark.line).from;
    const to = state.doc.line(mark.line + mark.lines - 1).to;
    return { from, to, at: to, side: 1, mark };
  });
  return { entries, deco: decorate(state, entries) };
}

const field = StateField.define({
  create: () => ({ entries: [], deco: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSuggestionMarks)) return build(tr.state, e.value);
    if (!tr.docChanged || value.entries.length === 0) return value;
    // an edit on the marked lines drops that hunk; the others move with the text
    const kept = [];
    for (const e of value.entries) {
      if (tr.changes.touchesRange(e.from, e.to)) continue;
      kept.push({ ...e, from: tr.changes.mapPos(e.from, 1), to: tr.changes.mapPos(e.to, -1), at: tr.changes.mapPos(e.at, e.mark.kind === 'insert' ? -1 : 1) });
    }
    return { entries: kept, deco: decorate(tr.state, kept) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** The marks now drawn (each as `{ suggestionId, hunkId, ... }`), in text order. @param {import('@codemirror/state').EditorState} state */
export const drawnSuggestionMarks = (state) => state.field(field).entries.map((e) => e.mark);

/**
 * The extension: add it once to the editor's extensions. `onDecide` is called by the cards' buttons; keep it the same function for the editor's life
 * (read the current handler from a ref inside it).
 * @param {(suggestionId: string, hunkId: string, decision: 'accept' | 'decline') => Promise<unknown> | void} [onDecide]
 */
export const suggestionMarks = (onDecide) => [field, suggestionHandler.of(onDecide ?? null)];
