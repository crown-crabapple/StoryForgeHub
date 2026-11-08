// M12 W6: the manuscript rail marks a scene the AI wrote and the author has not accepted ("AI draft": origin ai and status drafting); an accepted AI scene
// (status moved on) and an author scene carry no badge. Server-rendered, no browser.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));

let vite;
let Outline;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  Outline = (await vite.ssrLoadModule('/src/Outline.jsx')).Outline;
});
after(async () => {
  await vite?.close();
});

const scene = (id, title, over = {}) => ({ id, title, act: 1, chapter: 1, sequence: 10, status: 'drafting', pov: null, word_count: 5, path: `manuscript/${id}.md`, ...over });
const BOOK = (scenes) => ({
  id: 'book_01S5000000000000000000000A', slug: 'salt-orchard', title: 'The Salt Orchard', path: '', status: 'drafting', scene_count: scenes.length, word_count: 5 * scenes.length,
  acts: [{ act: 1, label: 'Act 1', title: 'Low Water', chapters: [{ chapter: 1, label: 'Chapter 1', title: 'The Drowned Rows', scenes }] }],
});
const rail = (scenes) => renderToStaticMarkup(h(Outline, { book: BOOK(scenes), activeId: null, onChanged: () => {} }));
const rowOf = (html, id) => html.match(new RegExp(`<li\\b[^>]*data-scene-id="${id}"[\\s\\S]*?</li>`))?.[0] ?? '';

test('an AI draft (origin ai, status drafting) shows the "AI draft" badge; author scenes and accepted AI scenes do not', () => {
  const html = rail([
    scene('scene_author', 'By the author'),
    scene('scene_ai', 'By the AI', { origin: 'ai' }),
    scene('scene_accepted', 'Accepted AI scene', { origin: 'ai', status: 'revised' }),
    scene('scene_outline', 'AI outline only', { origin: 'ai', status: 'outline' }),
  ]);
  assert.match(rowOf(html, 'scene_ai'), />AI draft</);
  assert.match(rowOf(html, 'scene_ai'), /title="Written by an AI and not accepted yet/);
  for (const id of ['scene_author', 'scene_accepted', 'scene_outline']) assert.doesNotMatch(rowOf(html, id), /AI draft/, id);
  assert.equal((html.match(/AI draft</g) ?? []).length, 1);
});
