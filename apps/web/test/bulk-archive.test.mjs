// Bulk archive in the manuscript rail: the "Select scenes..." mode's bar (count, Select all / Clear, Archive N scenes, Done),
// and the rail outside select mode (no checkboxes, rows stay draggable). Server-rendered like dnd-render.test.mjs.
import assert from 'node:assert/strict';
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
  m = await vite.ssrLoadModule('/src/Outline.jsx');
});
after(async () => {
  await vite?.close();
});

const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const render = (el) => decode(renderToStaticMarkup(el));
const noop = () => {};
const bar = (count, total = 5) => render(h(m.SelectBar, { count, total, onAll: noop, onClear: noop, onArchive: noop, onDone: noop }));
const button = (html, label) => new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? null;

test('select bar: says how many scenes are selected, as a labelled group with a live count', () => {
  const html = bar(3);
  assert.match(html, /role="group"[^>]*aria-label="Selected scenes"/);
  assert.match(html, /aria-live="polite"[^>]*>3 of 5 selected</);
});

test('select bar: Archive names how many scenes it archives, and is disabled with nothing selected', () => {
  assert.ok(button(bar(3), 'Archive 3 scenes'), 'Archive 3 scenes');
  assert.doesNotMatch(button(bar(3), 'Archive 3 scenes'), /disabled/);
  assert.ok(button(bar(1), 'Archive'), 'one scene: plain Archive');
  assert.match(button(bar(0), 'Archive'), /disabled/);
});

test('select bar: Select all until everything is selected, then Clear; Done is always there', () => {
  assert.ok(button(bar(2), 'Select all'));
  assert.equal(button(bar(2), 'Clear'), null);
  assert.ok(button(bar(5), 'Clear'));
  assert.equal(button(bar(5), 'Select all'), null);
  for (const n of [0, 2, 5]) assert.ok(button(bar(n), 'Done'));
});

test('rail outside select mode: no checkboxes and no select bar; scene rows stay draggable', () => {
  const scene = (id, title, chapter) => ({ id, title, act: 1, chapter, sequence: 10, status: 'drafting', pov: null, word_count: 5, path: `manuscript/${id}.md` });
  const book = {
    id: 'book_x', slug: 'x', title: 'X', path: '', word_count: 10, archived: [], excluded: [],
    acts: [{ act: 1, title: null, chapters: [{ chapter: 1, title: 'One', label: 'Chapter 1', scenes: [scene('scene_a', 'A', 1), scene('scene_b', 'B', 1)] }] }],
  };
  const html = render(h(m.Outline, { book, onChanged: noop }));
  assert.doesNotMatch(html, /type="checkbox"/);
  assert.doesNotMatch(html, /Selected scenes/);
  assert.equal((html.match(/data-scene-id="[^"]+"[^>]*draggable="true"|draggable="true"[^>]*data-scene-id/g) ?? []).length, 2);
});
