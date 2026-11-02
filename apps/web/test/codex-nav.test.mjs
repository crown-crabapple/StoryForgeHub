// M04-J02 acceptance 2 (render side): the Codex inspector's "Open in manuscript" targets the first explicit scene, scenes in
// "Appears in" link into the manuscript, and the manuscript inspector's entry chips link back with "Open in Codex".
// Contract section 3: scene links are /books/:id?scene=<sceneId>, the way back is /books/:id/codex?entry=<entryId>.
//
// ASSUMED props (the contract names the components, not their props): EntryInspector({ bookId, entry }) where `entry` is the
// GET /api/books/:b/entries/:id answer. Change ENTRY_INSPECTOR_PROPS if the component takes something else.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let linked;
let inspectorModule;
let inspectorLoadError = null;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  linked = await vite.ssrLoadModule('/src/writing/LinkedEntries.jsx');
  try {
    inspectorModule = await vite.ssrLoadModule('/src/codex/EntryInspector.jsx');
  } catch (e) {
    inspectorLoadError = e;
  }
});
after(async () => {
  await vite?.close();
});

const BOOK_ID = 'book_01CG0000000000000000000001';
const MAREN = 'entry_01CG0000000000000000000005';
const TOBIN = 'entry_01CG0000000000000000000006';
const LANDFALL = 'scene_01CG0000000000000000000002';
const NIGHT = 'scene_01CG0000000000000000000003';
const LAST = 'scene_01CG0000000000000000000004';
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Every <a ...>text</a> as { href, text }. */
function anchors(html) {
  return [...decode(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ href: /href="([^"]*)"/.exec(m[1])?.[1] ?? null, text: m[2].replace(/<[^>]+>/g, '').trim() }));
}

// ---------------------------------------------------------------------------------------------------- manuscript chip -> Codex

const OBJECTS = [
  { id: MAREN, kind: 'entry', slug: 'maren-hollis', title: 'Maren Hollis', type: 'character' },
  { id: TOBIN, kind: 'entry', slug: 'tobin-reyes', title: 'Tobin Reyes', type: 'character' },
  { id: 'entry_01CG0000000000000000000007', kind: 'entry', slug: 'port-aldine', title: 'Port Aldine', type: 'location' },
  { id: 'thread_01CG000000000000000000000X', kind: 'thread', slug: 'the-key-mystery', title: 'The Key Mystery', type: null },
];

test('manuscript inspector: every entry chip has "Open in Codex" linking to /books/:id/codex?entry=<entry id>', () => {
  const html = renderToStaticMarkup(
    h(linked.LinkedEntries, {
      bookId: BOOK_ID,
      front: { characters: ['maren-hollis'], locations: ['port-aldine'] },
      body: 'Then [[tobin-reyes|the ferryman]] spoke.',
      objects: OBJECTS,
    }),
  );
  const links = anchors(html).filter((a) => /open in codex/i.test(a.text));
  assert.deepEqual(
    links.map((a) => a.href).sort(),
    [
      `/books/${BOOK_ID}/codex?entry=${MAREN}`,
      `/books/${BOOK_ID}/codex?entry=${TOBIN}`,
      `/books/${BOOK_ID}/codex?entry=entry_01CG0000000000000000000007`,
    ].sort(),
    'one link per entry, by entry id (not slug), including the one only mentioned in the body',
  );
});

test('manuscript inspector: a plot thread is not an entry and gets no "Open in Codex"', () => {
  const html = renderToStaticMarkup(h(linked.LinkedEntries, { bookId: BOOK_ID, front: { plot_threads: ['the-key-mystery'] }, body: '', objects: OBJECTS }));
  assert.ok(html.includes('The Key Mystery'));
  assert.ok(!/open in codex/i.test(html));
});

test('manuscript inspector: with nothing linked there is no Codex link', () => {
  const html = renderToStaticMarkup(h(linked.LinkedEntries, { bookId: BOOK_ID, front: {}, body: 'plain prose', objects: OBJECTS }));
  assert.ok(!/open in codex/i.test(html));
});

// ---------------------------------------------------------------------------------------------------- Codex inspector -> scene

const ENTRY_INSPECTOR_PROPS = (entry) => ({ bookId: BOOK_ID, entry });
const MAREN_ENTRY = {
  id: MAREN,
  slug: 'maren-hollis',
  name: 'Maren Hollis',
  type: 'character',
  status: 'canon',
  fields: {},
  sections: [{ heading: 'Overview', text: 'A harbour pilot.' }],
  // API order: explicit first, then inferred, each in manuscript order
  appears_in: [
    { scene_id: LANDFALL, title: 'Landfall', position: 1, rel: 'pov', kind: 'explicit' },
    { scene_id: LAST, title: 'Last Ferry', position: 3, rel: 'character', kind: 'explicit' },
    { scene_id: NIGHT, title: 'Night Lines', position: 2, rel: 'mention', kind: 'inferred' },
  ],
  related: [],
};

function renderInspector(entry) {
  assert.ok(!inspectorLoadError, `implementation missing: apps/web/src/codex/EntryInspector.jsx did not load (${inspectorLoadError?.message})`);
  const C = inspectorModule.EntryInspector ?? inspectorModule.default;
  assert.equal(typeof C, 'function', 'EntryInspector is exported');
  return renderToStaticMarkup(h(C, ENTRY_INSPECTOR_PROPS(entry)));
}

test('Codex inspector: "Open in manuscript" links to the first explicit scene', () => {
  const links = anchors(renderInspector(MAREN_ENTRY));
  const open = links.filter((a) => /open in manuscript/i.test(a.text));
  assert.equal(open.length, 1);
  assert.equal(open[0].href, `/books/${BOOK_ID}?scene=${LANDFALL}`);
});

test('Codex inspector: "Open in manuscript" skips a mention-only first row and uses the first explicit one', () => {
  const entry = { ...MAREN_ENTRY, appears_in: [MAREN_ENTRY.appears_in[2], MAREN_ENTRY.appears_in[1]] };
  const open = anchors(renderInspector(entry)).filter((a) => /open in manuscript/i.test(a.text));
  assert.equal(open[0]?.href, `/books/${BOOK_ID}?scene=${LAST}`);
});

test('Codex inspector: every scene in "Appears in" links to it in the manuscript, in order, and mentions are tagged', () => {
  const html = renderInspector(MAREN_ENTRY);
  const links = anchors(html).filter((a) => a.href?.startsWith(`/books/${BOOK_ID}?scene=`) && !/open in manuscript/i.test(a.text));
  assert.deepEqual(links.map((a) => a.href), [LANDFALL, LAST, NIGHT].map((s) => `/books/${BOOK_ID}?scene=${s}`));
  assert.deepEqual(links.map((a) => a.text), ['Landfall', 'Last Ferry', 'Night Lines']);
  assert.equal((decode(html).match(/mentioned/g) ?? []).length, 1, '"mentioned" appears once, for the inferred row');
});

test('Codex inspector: an entry with no explicit scene has no "Open in manuscript" link', () => {
  const entry = { ...MAREN_ENTRY, appears_in: [MAREN_ENTRY.appears_in[2]] };
  assert.equal(anchors(renderInspector(entry)).filter((a) => /open in manuscript/i.test(a.text)).length, 0);
  const none = { ...MAREN_ENTRY, appears_in: [] };
  assert.equal(anchors(renderInspector(none)).filter((a) => /open in manuscript/i.test(a.text)).length, 0);
});
