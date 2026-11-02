// M03-J02 acceptance 7 (render half): the inspector shows entry names and thread titles, with the slug in the
// `title` attribute, using the objects the GET /api/books/:b/objects route returns.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { nameIndex } from '../src/editor/names.js';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let m;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  m = await vite.ssrLoadModule('/src/shell/Inspector.jsx');
});
after(async () => {
  await vite?.close();
});

const OBJECTS = [
  { id: 'entry_01S5000000000000000000000G', kind: 'entry', slug: 'maren-hollis', title: 'Maren Hollis', type: 'character' },
  { id: 'entry_01S5000000000000000000000H', kind: 'entry', slug: 'ilse-hollis', title: 'Ilse Hollis', type: 'character' },
  { id: 'entry_pell', kind: 'entry', slug: 'pell', title: 'Pell Reyes', type: 'character' },
  { id: 'entry_port', kind: 'entry', slug: 'salt-orchard', title: 'The Salt Orchard', type: 'location' },
  { id: 'thread_key', kind: 'thread', slug: 'brass-key', title: 'The Brass Key', type: null },
];
const BOOK = { id: 'book_1', slug: 'salt-orchard', title: 'The Salt Orchard', path: '' };
const SCENE = {
  id: 'scene_2',
  title: 'The Key',
  path: 'manuscript/act-01/ch-001/0020-the-key.md',
  pov: 'maren-hollis',
  front_matter: { pov: 'maren-hollis', characters: ['maren-hollis', 'pell', 'not-in-the-index'], locations: ['salt-orchard'], plot_threads: ['brass-key'] },
  body: 'The key was colder.\n',
  sha256: 'abc',
};
const DIAGS = { items: [], error: null, loading: false };
const decode = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

test('nameIndex: resolves a slug or an id to the entry name / thread title; unknown refs come back unchanged', () => {
  const { nameOf, known } = nameIndex(OBJECTS);
  assert.equal(nameOf('maren-hollis'), 'Maren Hollis');
  assert.equal(nameOf('entry_01S5000000000000000000000G'), 'Maren Hollis');
  assert.equal(nameOf('brass-key'), 'The Brass Key');
  assert.equal(nameOf('not-in-the-index'), 'not-in-the-index', 'a name is never invented');
  assert.equal(known('pell'), true);
  assert.equal(known('nobody'), false);
});

test('nameIndex: empty, null and malformed inputs are safe', () => {
  for (const input of [null, undefined, [], [null, {}, { id: 'x', title: '' }, { slug: 's', title: 5 }]]) {
    const { nameOf, known } = nameIndex(input);
    assert.equal(nameOf('s'), 's');
    assert.equal(known('s'), false);
  }
});

test('inspector renders names for POV, characters, locations and threads, with the slug kept in the title attribute', () => {
  const html = decode(renderToStaticMarkup(h(m.SceneInspector, { book: BOOK, scene: SCENE, diagnostics: DIAGS, objects: OBJECTS })));
  for (const name of ['Maren Hollis', 'Pell Reyes', 'The Salt Orchard', 'The Brass Key']) assert.ok(html.includes(`>${name}<`), `shows ${name}`);
  for (const slug of ['maren-hollis', 'pell', 'salt-orchard', 'brass-key']) assert.ok(html.includes(`title="${slug}"`), `slug ${slug} is in a title attribute`);
  assert.ok(!html.includes('>maren-hollis<') && !html.includes('>brass-key<'), 'slugs are no longer the visible text when the name is known');
  assert.ok(html.includes('>not-in-the-index<'), 'an unknown reference falls back to its slug');
});

test('inspector without objects (route not answered yet) still shows the slugs', () => {
  const html = decode(renderToStaticMarkup(h(m.SceneInspector, { book: BOOK, scene: SCENE, diagnostics: DIAGS })));
  for (const slug of ['maren-hollis', 'pell', 'salt-orchard', 'brass-key']) assert.ok(html.includes(`>${slug}<`), slug);
});
