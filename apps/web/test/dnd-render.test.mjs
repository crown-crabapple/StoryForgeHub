// M03-J03 acceptance 8: server-rendered checks of the drag-and-drop rail and the Move... dialog (no browser, no
// network): draggable scene rows whose link and menu button still work, a drop hook on every chapter row (empty
// ones too), the aria-live announcer, no insertion line at rest, the 2px accent line in the stylesheet, and the
// Move... dialog's fields and options. Insertion-line states that need pointer events are covered at the pure-helper
// level in move-target.test.mjs and by the manual browser check (acceptance 9).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));

let vite;
let m;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  m = {
    ...(await vite.ssrLoadModule('/src/Outline.jsx')),
    ...(await vite.ssrLoadModule('/src/structure/MoveDialog.jsx')),
  };
});
after(async () => {
  await vite?.close();
});

const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => decode(renderToStaticMarkup(el));
const count = (html, re) => (html.match(re) ?? []).length;
const noop = () => {};

const scene = (id, title, chapter, act = 1) => ({ id, title, act, chapter, sequence: 10, status: 'drafting', pov: null, word_count: 5, path: `manuscript/${id}.md` });
const ARRIVAL = scene('scene_arrival', 'Arrival', 1);
const KEY = scene('scene_key', 'The Key', 1);
const LOWTIDE = scene('scene_low', 'Low Tide', 3, 2);
const BOOK = {
  id: 'book_01S5000000000000000000000A',
  slug: 'salt-orchard',
  title: 'The Salt Orchard',
  path: '',
  status: 'drafting',
  scene_count: 3,
  word_count: 15,
  acts: [
    {
      act: 1, label: 'Act 1', title: 'Low Water',
      chapters: [
        { chapter: 1, label: 'Chapter 1', title: 'The Drowned Rows', scenes: [ARRIVAL, KEY] },
        { chapter: 2, label: 'Chapter 2', title: 'Nothing Yet', scenes: [] },
      ],
    },
    { act: 2, label: 'Act 2', title: 'High Water', chapters: [{ chapter: 3, label: 'Chapter 3', title: null, scenes: [LOWTIDE] }] },
  ],
};

const rail = () => render(h(m.Outline, { book: BOOK, activeId: KEY.id, onChanged: noop }));

// ---------------------------------------------------------------- the rail

test('rail: every scene row is draggable, with its link and menu button still real controls', () => {
  const html = rail();
  const rows = [...html.matchAll(/<li\b[^>]*data-scene-id="([^"]+)"[^>]*>/g)];
  assert.deepEqual(rows.map((r) => r[1]), [ARRIVAL.id, KEY.id, LOWTIDE.id]);
  for (const r of rows) assert.match(r[0], /draggable="true"/, `${r[1]} is draggable`);
  for (const s of [ARRIVAL, KEY, LOWTIDE]) {
    assert.match(html, new RegExp(`<a [^>]*href="[^"]*scene=${s.id}"`), `${s.title}: link is a real anchor`);
    assert.match(html, new RegExp(`<button [^>]*aria-label="More actions for ${s.title}"`), `${s.title}: menu button`);
  }
});

test('rail: only scene rows are draggable (acts, chapters and the heading are not)', () => {
  const html = rail();
  assert.equal(count(html, /draggable="true"/g), 3);
  for (const li of html.matchAll(/<li\b[^>]*draggable="true"[^>]*>/g)) assert.match(li[0], /data-scene-id=/);
});

test('rail: the link inside a draggable row does not start its own native link drag', () => {
  const html = rail();
  for (const a of html.matchAll(/<a [^>]*data-scene-link[^>]*>/g)) assert.match(a[0], /draggable="false"/);
});

test('rail: every chapter row, empty chapters included, is a drop target hook', () => {
  const html = rail();
  const rows = [...html.matchAll(/<div\b[^>]*data-chapter-row="(\d+)"[^>]*>/g)].map((r) => Number(r[1]));
  assert.deepEqual(rows, [1, 2, 3]);
  assert.match(html, /Nothing Yet/, 'the empty chapter is listed');
});

test('rail: at rest there is no insertion line, no highlighted chapter, nothing dragging', () => {
  const html = rail();
  assert.equal(count(html, /drop-line/g), 0);
  assert.equal(count(html, /is-drop-target/g), 0);
  assert.equal(count(html, /is-dragging/g), 0);
  assert.equal(count(html, /data-drop=/g), 0);
});

test('rail: an aria-live region exists for the drop announcements, empty until something is dragged', () => {
  const html = rail();
  const region = /<div\b[^>]*aria-live="(polite|assertive)"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(region, 'an aria-live region');
  assert.equal(region[2].trim(), '', 'empty at rest');
  assert.match(region[0], /role="status"/);
});

test('rail: the book menu button sits in the rail header (home of "Tidy file names...")', () => {
  const html = rail();
  const head = /<div class="rail-head">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(head, 'rail header');
  assert.match(head[1], /The Salt Orchard/);
  const button = /<button\b[^>]*aria-label="More actions for The Salt Orchard"[^>]*>/.exec(head[1]);
  assert.ok(button, 'book menu button');
  assert.match(button[0], /aria-haspopup="menu"/);
});

test('rail: scenes appear in book order inside their chapters (so the drop positions map onto the visible order)', () => {
  const html = rail();
  const at = (s) => html.indexOf(s);
  assert.ok(at('Arrival') < at('The Key') && at('The Key') < at('Nothing Yet') && at('Nothing Yet') < at('Low Tide'));
});

// ---------------------------------------------------------------- the stylesheet

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const rule = (selector) => {
  const esc = selector.replace(/[.[\]"=]/g, '\\$&');
  const hit = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(css);
  return hit ? hit[1] : null;
};

test('stylesheet: the insertion line is 2px high in the accent colour, above or below a row, and does not take pointer events', () => {
  const line = rule('.drop-line');
  assert.ok(line, '.drop-line rule');
  assert.match(line, /height:\s*2px/);
  assert.match(line, /background:\s*var\(--accent\)/);
  assert.match(line, /pointer-events:\s*none/);
  assert.ok(rule('.drop-line[data-position="before"]'), 'before state');
  assert.ok(rule('.drop-line[data-position="after"]'), 'after state');
});

test('stylesheet: a chapter drop target is outlined with the accent colour', () => {
  const t = rule('.outline-chapter.is-drop-target');
  assert.ok(t, 'rule exists');
  assert.match(t, /var\(--accent\)/);
});

// ---------------------------------------------------------------- the Move... dialog

const dialog = (props = {}) => render(h(m.MoveDialog, { book: BOOK, scene: ARRIVAL, onSubmit: noop, onClose: noop, onRepair: noop, ...props }));
const options = (html, name) => {
  const sel = new RegExp(`<select [^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
  assert.ok(sel, `${name} select`);
  return [...sel[1].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((o) => ({ value: o[1], label: o[3], selected: /selected/.test(o[2]) }));
};

test('Move dialog: a modal dialog named for the scene, with Act/Chapter and Position selects and Move / Cancel', () => {
  const html = dialog();
  assert.match(html, /role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Move Arrival"/);
  assert.match(html, /<label>\s*<span class="form-label">Act and chapter<\/span>\s*<select/);
  assert.match(html, /<label>\s*<span class="form-label">Position<\/span>\s*<select/);
  assert.match(html, /<button type="button" class="btn">Cancel<\/button>/);
  assert.match(html, /<button type="submit"[^>]*>Move<\/button>/);
});

test('Move dialog: the chapter select lists every chapter of every act, empty ones too, grouped by act', () => {
  const html = dialog();
  assert.deepEqual([...html.matchAll(/<optgroup label="([^"]*)"/g)].map((g) => g[1]), ['Act 1: Low Water', 'Act 2: High Water']);
  const chapters = options(html, 'chapter');
  assert.deepEqual(chapters.map((c) => c.value), ['1', '2', '3']);
  assert.ok(chapters.find((c) => c.value === '2').label.includes('Nothing Yet'), 'the empty chapter is offered');
  assert.deepEqual(chapters.filter((c) => c.selected).map((c) => c.value), ['1'], "the scene's own chapter is preselected");
});

test('Move dialog: the position select offers "At the start" and "After <scene>" for the chapter, never the scene itself', () => {
  const html = dialog();
  assert.deepEqual(options(html, 'position').map((o) => o.label), ['At the start', 'After The Key']);
  // for the second scene the current slot (after Arrival) is preselected
  const second = dialog({ scene: KEY });
  assert.deepEqual(options(second, 'position').map((o) => [o.label, o.selected]), [['At the start', false], ['After Arrival', true]]);
  const first = options(html, 'position');
  assert.equal(first[0].selected, true, 'a first scene starts on "At the start"');
});

test('Move dialog: a scene in another act opens on that act and chapter', () => {
  const html = dialog({ scene: LOWTIDE });
  assert.deepEqual(options(html, 'chapter').filter((c) => c.selected).map((c) => c.value), ['3']);
  assert.deepEqual(options(html, 'position').map((o) => o.label), ['At the start']);
});

test('Move dialog: no alert and no Repair button unless the move was refused', () => {
  const html = dialog();
  assert.equal(count(html, /role="alert"/g), 0);
  assert.doesNotMatch(html, /Repair/);
});

test('Move dialog: a refusal shows its message as an alert, and a book with problems offers Repair', () => {
  const html = dialog({ error: 'Fix the problems first (Repair...)', repair: true });
  assert.match(html, /<p role="alert" class="error">Fix the problems first \(Repair\.\.\.\)<\/p>/);
  assert.match(html, /<button type="button" class="btn">Repair\.\.\.<\/button>/);
});

test('Move dialog: Move is disabled while a move is running', () => {
  assert.match(dialog({ busy: true }), /<button type="submit"[^>]*disabled=""[^>]*>Move<\/button>/);
  assert.doesNotMatch(dialog({ busy: false }), /<button type="submit"[^>]*disabled/);
});
