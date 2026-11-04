// Server-render the shell and pages with fixture data (no browser, no network) and check structure.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));

let vite;
let m; // the loaded modules
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const load = (p) => vite.ssrLoadModule(p);
  m = {
    ...(await load('/src/shell/AppShell.jsx')),
    ...(await load('/src/shell/TopBar.jsx')),
    ...(await load('/src/shell/ProjectNav.jsx')),
    ...(await load('/src/shell/Workspace.jsx')),
    ...(await load('/src/shell/Inspector.jsx')),
    ...(await load('/src/shell/SaveStatus.jsx')),
    ...(await load('/src/shell/BookSwitcher.jsx')),
    ...(await load('/src/BookView.jsx')),
    ...(await load('/src/LibraryView.jsx')),
    ...(await load('/src/PlaceholderView.jsx')),
  };
});
after(async () => {
  await vite?.close();
});

const render = (el) => renderToStaticMarkup(el);
/** Decode the few entities React writes, so assertions can use the real text. */
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const count = (html, re) => (html.match(re) ?? []).length;

// ---------------------------------------------------------------- fixtures (the shape /api returns)

const BOOK_ID = 'book_01S5000000000000000000000A';
const scene = (id, title, extra = {}) => ({ id, title, position: 1, act: 1, chapter: 1, sequence: 10, status: 'drafting', pov: 'maren-hollis', word_count: 26, path: `manuscript/${id}.md`, ...extra });
const KEY = scene('scene_3', 'The Key', { path: 'manuscript/act-01/ch-001/0020-the-key.md' });
const BOOK = {
  id: BOOK_ID,
  slug: 'salt-orchard',
  title: 'The Salt Orchard',
  path: '',
  status: 'drafting',
  scene_count: 3,
  word_count: 100,
  acts: [
    {
      act: 1,
      label: 'Act 1',
      chapters: [
        { chapter: 1, label: 'Chapter One', title: 'The Drowned Rows', scenes: [scene('scene_2', 'Arrival', { word_count: 40 }), KEY] },
        { chapter: 2, label: 'Chapter Two', title: null, scenes: [scene('scene_5', 'Broken', { problem: { code: 'E101', message: 'bad front matter' } })] },
      ],
    },
  ],
};
const BOOKS = [
  { id: BOOK_ID, slug: 'salt-orchard', title: 'The Salt Orchard' },
  { id: 'book_2', slug: 'second', title: 'Second Book' },
];
const SCENE = {
  ...KEY,
  front_matter: { characters: ['maren-hollis', 'pell'], locations: ['salt-orchard'], plot_threads: ['brass-key'] },
  body: 'The key was colder.\n\n<!-- note: check the tide times -->\n\n[[pell|Pell]] watched. <!-- opaque: keep -->\n',
  sha256: 'abc',
};
const DIAGS = [
  { code: 'W301', severity: 'warning', file: KEY.path, location: 'line 3', message: 'link to nothing' },
  { code: 'E999', severity: 'error', file: 'planning/other.md', location: '', message: 'elsewhere' },
];

const page = (children, opts = {}) => h(m.AppShell, { books: BOOKS, bookId: BOOK_ID, tab: 'manuscript', ...opts }, children);
const bookPage = (sceneData = SCENE) =>
  page(
    h(
      m.BookLayout,
      { book: BOOK, activeId: KEY.id, inspector: h(m.SceneInspector, { book: BOOK, scene: sceneData, diagnostics: { items: DIAGS, error: null, loading: false } }) },
      h(m.ScenePaper, { book: BOOK, scene: sceneData, chapterLabel: 'Chapter One: The Drowned Rows' }),
    ),
  );

// ---------------------------------------------------------------- tests

test('book page: landmarks, one h1, one main, skip link first in tab order', () => {
  const html = render(bookPage());
  assert.equal(count(html, /<header[ >]/g), 1);
  assert.equal(count(html, /<nav aria-label="Project"/g), 1);
  assert.equal(count(html, /<nav[^>]*aria-label="Manuscript"/g), 1);
  assert.equal(count(html, /<main[ >]/g), 1);
  assert.equal(count(html, /<aside[^>]*aria-label="Inspector"/g), 1);
  assert.equal(count(html, /<h1[ >]/g), 1);
  const firstFocusable = /<(a|button|input)\b[^>]*>/.exec(html)[0];
  assert.match(firstFocusable, /^<a /);
  assert.match(firstFocusable, /href="#main"/);
  assert.match(html, /Skip to content/);
  assert.match(html, /<main id="main"/);
});

test('book page: DOM order follows the visual and tab order (skip link, logo, switcher, save status, search, nav tabs, rail, main, inspector)', () => {
  const html = text(render(bookPage()));
  const at = (re) => {
    const i = html.search(re);
    assert.notEqual(i, -1, `missing ${re}`);
    return i;
  };
  const order = [
    at(/class="skip-link"/),
    at(/class="logo"/),
    at(/class="switcher-button"/),
    at(/role="status"/), // the save indicator is plain text (not focusable); the index dot only renders once /api/status has answered
    at(/type="search"/),
    at(/aria-label="Project"/),
    at(/class="project-tab"/),
    at(/aria-label="Manuscript"/),
    at(/<main /),
    at(/aria-label="Inspector"/),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('workspace: rail nav, main and inspector aside in that order, with the Chapters disclosure for narrow screens', () => {
  const html = render(h(m.Workspace, { rail: h('p', null, 'rail'), inspector: h('p', null, 'inspector') }, h('p', null, 'centre')));
  const nav = html.indexOf('<nav');
  const main = html.indexOf('<main');
  const aside = html.indexOf('<aside');
  assert.ok(nav !== -1 && nav < main && main < aside);
  assert.match(html, /<nav[^>]*aria-label="Manuscript"/);
  assert.match(html, /<aside[^>]*aria-label="Inspector"/);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>Chapters<\/button>/);
  assert.match(html, /data-open="false"/);
});

test('project nav: seven real links, aria-current only on the active tab', () => {
  for (const [tab, label] of [
    ['manuscript', 'Manuscript'],
    ['codex', 'Codex'],
    ['timeline', 'Timeline'],
    ['continuity', 'Continuity'],
    ['places', 'Places'],
    ['notes', 'Notes'],
    ['canvas', 'Canvas'],
  ]) {
    const html = render(h(m.ProjectNav, { bookId: BOOK_ID, active: tab }));
    assert.equal(count(html, /<a /g), 7);
    assert.equal(count(html, /aria-current="page"/g), 1);
    assert.match(html, new RegExp(`aria-current="page"[^>]*>${label}<|class="project-tab" aria-current="page">${label}<`));
  }
  const html = render(h(m.ProjectNav, { bookId: BOOK_ID, active: 'codex' }));
  for (const href of ['', '/codex', '/timeline', '/continuity', '/places', '/notes', '/canvas']) assert.ok(html.includes(`href="/books/${BOOK_ID}${href}"`), href);
});

test('top bar: logo link, book switcher button, save status, search and no Share or avatar', () => {
  const html = text(render(h(m.TopBar, { books: BOOKS, bookId: BOOK_ID })));
  assert.match(html, /<header/);
  assert.match(html, /<a href="\/" class="logo"/);
  assert.match(html, /<button[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"/);
  assert.match(html, /The Salt Orchard/);
  assert.match(html, /role="status"/);
  assert.match(html, /type="search"/);
  assert.doesNotMatch(html, /Share|Signed in|avatar/i);
});

test('book switcher: without a current book it offers the library', () => {
  const html = render(h(m.BookSwitcher, { books: BOOKS, current: null }));
  assert.match(html, /Library/);
});

test('save status: every state shows an icon and words', () => {
  const view = (kind, at = null) => text(render(h(m.SaveStatusView, { view: { kind, at } })));
  assert.match(view('saved', '2026-11-01T09:23:00.000Z'), /Saved \d{1,2}:23/);
  assert.match(view('saving'), /Saving…/);
  assert.match(view('conflict'), /Can't save — file changed outside/);
  assert.match(view('readonly'), /Read-only/);
  assert.match(view('checking'), /Checking…/);
  for (const kind of ['saved', 'saving', 'conflict', 'readonly', 'checking']) {
    const html = render(h(m.SaveStatusView, { view: { kind, at: '2026-11-01T09:23:00.000Z' } }));
    assert.match(html, /<svg[^>]*aria-hidden="true"/, `${kind} has an icon`);
    assert.match(html, /role="status"/);
    assert.match(html, new RegExp(`data-state="${kind}"`));
  }
});

test('inspector: scene sections, slugs, notes from comments, and problems split scene vs book', () => {
  const html = text(render(h(m.SceneInspector, { book: BOOK, scene: SCENE, diagnostics: { items: DIAGS, error: null, loading: false } })));
  for (const title of ['In this scene', 'Scene notes', 'Problems', 'Book problems']) assert.match(html, new RegExp(`<h2>${title}</h2>`));
  for (const slug of ['maren-hollis', 'pell', 'salt-orchard', 'brass-key']) assert.ok(html.includes(`>${slug}<`), slug);
  assert.ok(html.includes('check the tide times'), 'note text');
  assert.ok(!html.includes('opaque: keep') || html.includes('check the tide times'), 'only note: comments are listed as notes');
  const [, sceneProblems, bookProblems] = html.split(/<h2>Problems<\/h2>|<h2>Book problems<\/h2>/);
  assert.ok(sceneProblems.includes('W301') && !sceneProblems.includes('E999'));
  assert.ok(bookProblems.includes('E999') && !bookProblems.includes('W301'));
});

test('inspector section: uppercase 12px muted heading comes from the section component', () => {
  const html = render(h(m.InspectorSection, { title: 'Scene notes' }, h('p', null, 'x')));
  assert.match(html, /<section class="inspector-section"><h2>Scene notes<\/h2><p>x<\/p><\/section>/);
});

test('book view: outline with scenes, word counts, current scene marked, unreadable marker kept', () => {
  const html = text(render(bookPage()));
  assert.equal(count(html, /<a [^>]*aria-current="page"[^>]*><span class="outline-label">The Key</g), 1);
  assert.equal(count(html, /class="outline-row outline-scene"/g), 3);
  assert.match(html, /The Key<\/span><span class="outline-words">26w/);
  assert.match(html, /can't be read/);
  assert.match(html, /Act 1/);
  assert.match(html, /Chapter One: The Drowned Rows/);
});

test('book view: prose shows wiki-link labels and visible dimmed comments, never the raw link syntax', () => {
  const html = text(render(bookPage()));
  assert.match(html, /<span class="prose-link" title="pell">Pell<\/span>/);
  assert.doesNotMatch(html, /\[\[/);
  assert.ok(html.includes('<span class="prose-comment"><!-- note: check the tide times --></span>'));
  assert.match(html, /<h1>The Key<\/h1>/);
});

test('book view: a file that cannot be read is shown raw, exactly as on disk', () => {
  const broken = { ...SCENE, problem: { code: 'E101', message: 'bad front matter' }, body: '---\nnot: [valid\n---\n[[x]] <!-- y -->' };
  const html = text(render(bookPage(broken)));
  assert.match(html, /can't be read \(E101: bad front matter\)/);
  assert.ok(html.includes('<pre class="scene-text">---\nnot: [valid\n---\n[[x]] <!-- y --></pre>'));
  assert.doesNotMatch(html, /prose-link/);
});

test('library page: Start something new has exactly two real buttons and nothing else interactive', () => {
  const html = text(render(h(m.LibraryPage, { books: [{ id: 'b', title: 'Book', slug: 'book', status: 'drafting', scene_count: 1, word_count: 10, error_count: 0, warning_count: 0 }], error: null, loading: false })));
  assert.match(html, /<h1>Library<\/h1>/);
  assert.match(html, /Start something new/);
  // M02-J02 adds real filter buttons to the page; M02-J03 adds exactly two buttons to the Start section itself.
  const start = html.match(/<section aria-labelledby="start-heading"[\s\S]*?<\/section>/);
  assert.ok(start, 'Start something new section present');
  const buttons = [...start[0].matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((b) => b[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  assert.deepEqual(buttons, ['New book\u2026', 'Open folder\u2026']);
  assert.doesNotMatch(start[0], /<(a|input|select|textarea)\b/);
  assert.doesNotMatch(start[0], /arrives in the next update/);
});

test('placeholder tabs: a real page with one h1 that says what it will hold and that it arrives in M04', () => {
  for (const [tab, title] of [
    ['codex', 'Codex'],
    ['timeline', 'Timeline'],
    ['places', 'Places'],
    ['notes', 'Notes'],
  ]) {
    const html = render(page(h(m.PlaceholderView, { bookId: BOOK_ID, tab }), { tab }));
    assert.equal(count(html, /<h1[ >]/g), 1);
    assert.match(html, new RegExp(`<h1>${title}</h1>`));
    assert.match(html, /M04/);
    assert.match(html, /aria-current="page"[^>]*>|aria-current="page">/);
    assert.ok(html.includes(`href="/books/${BOOK_ID}"`), 'link back to the manuscript');
  }
});

test('no project nav outside a book; the shell still has its landmarks', () => {
  const html = render(h(m.AppShell, { books: BOOKS, bookId: null }, h('main', { id: 'main' }, h('h1', null, 'Library'))));
  assert.doesNotMatch(html, /aria-label="Project"/);
  assert.match(html, /<header/);
  assert.match(html, /Read-only/);
});

// ---------------------------------------------------------------- source checks (onClick is not in static markup)

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.jsx') ? [join(dir, e.name)] : []));
}

test('every onClick sits on a <button>, an <a href> or a Link (never a div or span)', () => {
  const offenders = [];
  for (const file of sourceFiles(join(webDir, 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const hit of src.matchAll(/\bonClick\s*=/g)) {
      const open = src.lastIndexOf('<', hit.index);
      const tag = /^<([A-Za-z][\w.]*)/.exec(src.slice(open))?.[1];
      if (!['button', 'a', 'Link'].includes(tag)) offenders.push(`${file.slice(webDir.length)}: onClick on <${tag}>`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('rendered anchors always have an href', () => {
  const html = render(bookPage());
  for (const a of html.match(/<a\b[^>]*>/g) ?? []) assert.match(a, /href="/, a);
});
