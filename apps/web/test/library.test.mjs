// M02-J02 acceptance 5 (client filter), 6 (library render) and 7 (generated-cover palette).
//
// The contract names behaviour, not modules, so this file looks the units up by their likely
// locations/export names (see LOCATE below). A missing unit fails its tests with
// "implementation missing: ..." rather than skipping.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { contrast, lightness, rgb } from './color.mjs';

const webDir = fileURLToPath(new URL('..', import.meta.url));

const MODULES = [
  '/src/LibraryView.jsx',
  '/src/library/filter.js',
  '/src/library/filter.jsx',
  '/src/library/cover.js',
  '/src/library/cover.jsx',
  '/src/library/Cover.jsx',
  '/src/library/CoverCard.jsx',
  '/src/library/palette.js',
  '/src/library/cover-palette.js',
  '/src/library/LibraryPage.jsx',
  '/src/library/index.js',
  '/src/library/index.jsx',
];
const LOCATE = {
  Page: ['LibraryPage'],
  filter: ['filterBooks', 'filterLibrary', 'applyFilters', 'filterCards'],
  palette: ['COVER_PALETTE', 'PALETTE', 'coverPalette', 'COVER_COLORS'],
  pickColor: ['coverColorFor', 'pickCoverColor', 'coverColor', 'colorForBook', 'generatedCoverColor'],
  textColor: ['coverTextColor', 'textColorFor', 'coverTextColour', 'coverTextFor', 'readableTextColor'],
};

let vite;
let exportsAll = {};
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const p of MODULES) {
    try {
      exportsAll = { ...exportsAll, ...(await vite.ssrLoadModule(p)) };
    } catch {
      /* module does not exist (yet) */
    }
  }
});
after(async () => {
  await vite?.close();
});

function unit(kind) {
  for (const name of LOCATE[kind]) if (exportsAll[name] !== undefined) return exportsAll[name];
  assert.fail(`implementation missing: no export named one of ${LOCATE[kind].join(' | ')} under src/library/ or src/LibraryView.jsx`);
}

const render = (el) => renderToStaticMarkup(el);
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const count = (html, re) => (html.match(re) ?? []).length;

// ---------------------------------------------------------------- synthetic data (shape of /api/books)
const book = (slug, title, extra = {}) => ({
  id: `book_${slug}`, slug, title, path: slug, status: 'drafting', series: null, series_number: null, series_title: null,
  scene_count: 2, word_count: 1200, error_count: 0, warning_count: 0, subtitle: null, pen_name: null, pen_name_display: null,
  genre: [], word_target: null, language: null, archived: false, cover_color: null, cover_state: 'none', cover_url: null,
  blurb: '', index_state: 'ok', ...extra,
});
const FIRST = book('first-light', 'First Light', {
  series: 'harbour-lights', series_title: 'Harbour Lights', series_number: 1, pen_name: 'r-fenwick', pen_name_display: 'R. Fenwick',
  subtitle: 'The Beacon Is Lit', word_count: 42100, word_target: 90000, cover_state: 'image', cover_url: '/api/books/book_first-light/cover?v=0a1b2c3d',
});
const SECOND = book('second-light', 'Second Light', {
  series: 'harbour-lights', series_title: 'Harbour Lights', series_number: 2, status: 'planning', cover_color: '#2F4A3A', pen_name: 'r-fenwick', pen_name_display: 'R. Fenwick',
});
const NORTH = book('north-road', 'North Road', { status: 'revising', pen_name: 'a-marsh', pen_name_display: 'A. Marsh', word_target: 60000, word_count: 30000 });
const OLD = book('old-draft', 'Old Draft', { status: 'archived', archived: true });
const LOST = book('lost-cover', 'Lost Cover', { cover_state: 'missing' });
const SVG = book('svg-cover', 'Svg Cover', { cover_state: 'unsupported' });
const OUTSIDE = book('outside-cover', 'Outside Cover', { cover_state: 'outside' });
const ALL = [SECOND, NORTH, OLD, FIRST, LOST, SVG, OUTSIDE]; // deliberately not in display order
const LIBRARY = { root: '/synthetic/library', title: 'Synthetic', diagnostics: [], series: [{ slug: 'harbour-lights', title: 'Harbour Lights', status: 'active', book_ids: [FIRST.id, SECOND.id] }] };

function page(books, extra = {}) {
  const props = { books, library: LIBRARY, info: LIBRARY, libraryInfo: LIBRARY, series: LIBRARY.series, error: null, loading: false, ...extra };
  return text(render(h(unit('Page'), props)));
}
/** Contents of each whole-card link. */
const cardLinks = (html) => [...html.matchAll(/<a\b[^>]*href="\/books\/([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ id: decodeURIComponent(m[1]), inner: m[2] }));

// ---------------------------------------------------------------- 6: render
test('series section then standalone; books in series_number order with Book N labels', () => {
  const html = page(ALL);
  const series = html.indexOf('Harbour Lights');
  const standalone = html.indexOf('Standalone');
  assert.ok(series > -1, 'series heading');
  assert.ok(standalone > series, 'Standalone section comes after the series sections');
  const first = html.indexOf('First Light');
  const second = html.indexOf('Second Light');
  assert.ok(series < first && first < second && second < standalone, 'First Light, Second Light, then standalone');
  assert.match(html, /Book 1\b/);
  assert.match(html, /Book 2\b/);
  assert.match(html, /<h2[^>]*>[^<]*Harbour Lights/);
  assert.match(html, /<h2[^>]*>[^<]*Standalone/);
  assert.ok(html.indexOf('North Road') > standalone);
});

test('empty sections are not shown (no Standalone heading when every book is in a series)', () => {
  const html = page([FIRST, SECOND]);
  assert.match(html, /Harbour Lights/);
  assert.doesNotMatch(html, /Standalone/);
});

test('header shows "Library" and the book count', () => {
  const html = page([FIRST, SECOND, NORTH]);
  assert.match(html, /<h1[^>]*>Library<\/h1>/);
  assert.match(html, /3 books/);
  assert.match(page([NORTH]), /1 book(?!s)/);
});

test('image cover is an img with src and "Cover of <title>"; generated cover is named "Generated cover for <title>"', () => {
  const html = page(ALL);
  const img = html.match(/<img\b[^>]*>/g)?.find((t) => t.includes('/api/books/book_first-light/cover?v=0a1b2c3d'));
  assert.ok(img, 'img with cover_url');
  assert.match(img, /alt="Cover of First Light"/);
  assert.equal(count(html, /<img\b[^>]*cover\?v=/g), 1, 'only the image-state book has an <img>');
  for (const t of ['Second Light', 'North Road', 'Lost Cover', 'Svg Cover', 'Outside Cover']) {
    assert.match(html, new RegExp(`(?:aria-label|alt)="Generated cover for ${t}"`), `generated cover for ${t}`);
  }
  assert.doesNotMatch(html, /Generated cover for First Light/);
});

test('cover_color is used as the generated cover background', () => {
  assert.match(page([SECOND]).toLowerCase(), /#2f4a3a|rgb\(47,\s*74,\s*58\)/);
});

test('badges for missing, unsupported and outside covers; none for none/image', () => {
  const html = page(ALL);
  assert.match(html, /Cover not found/);
  assert.match(html, /Cover type not supported/);
  assert.match(html, /Cover must be in assets\//);
  assert.equal(count(html, /Cover not found/g), 1);
  assert.equal(count(html, /Cover type not supported/g), 1);
  assert.equal(count(html, /Cover must be in assets\//g), 1);
  for (const b of [FIRST, SECOND, NORTH]) {
    const only = page([b]);
    assert.doesNotMatch(only, /Cover not found|Cover type not supported|Cover must be in assets\//);
  }
  // tooltips say what to fix
  assert.match(html, /title="[^"]*book\.md[^"]*"/);
});

test('archived books are hidden by default and a "Show archived" toggle is offered, off', () => {
  const html = page(ALL);
  assert.doesNotMatch(html, /Old Draft/);
  const toggle = html.match(/<(?:input|button)\b[^>]*>[\s\S]{0,200}?Show archived|Show archived[\s\S]{0,200}?<input\b[^>]*>/);
  assert.ok(toggle, 'Show archived control');
  assert.doesNotMatch(toggle[0], /\bchecked\b|aria-pressed="true"/);
});

test('status chips are real buttons with aria-pressed; All starts pressed', () => {
  const html = page(ALL);
  for (const label of ['All', 'Planning', 'Drafting', 'Revising', 'Complete']) {
    assert.match(html, new RegExp(`<button\\b[^>]*aria-pressed="(?:true|false)"[^>]*>\\s*${label}\\s*<`), `${label} chip`);
  }
  assert.match(html, /<button\b[^>]*aria-pressed="true"[^>]*>\s*All\s*</);
  assert.equal(count(html, /<button\b[^>]*aria-pressed="true"/g), 1);
  assert.match(html, /Filter by title, series or pen name/);
  assert.match(html, /<select\b/, 'sort select');
});

test('empty library: honest message, the library path and the next-update note', () => {
  const html = page([]);
  assert.match(html, /No books here yet\./);
  assert.match(html, /\/synthetic\/library/);
  assert.match(html, /Creating books arrives in the next update\./);
  assert.doesNotMatch(html, /No books match/);
});

test('no-results state: "No books match" + "Clear filters" button once a filter is active', () => {
  // `initial` seeds the filter state (LibraryPage prop); the text filter matches nothing
  const html = page([FIRST, NORTH], { initial: { text: 'zzz-no-such-book' } });
  assert.match(html, /No books match/);
  assert.match(html, /<buttonb[^>]*>s*Clear filterss*</);
  assert.doesNotMatch(html, /No books here yet/);
  assert.equal(cardLinks(html).length, 0);
  // a library holding only an archived book (hidden by default) is not the empty-library state
  const onlyArchived = page([OLD]);
  assert.match(onlyArchived, /No books match/);
  assert.doesNotMatch(onlyArchived, /No books here yet/);
});

test('word progress: role=progressbar with aria values and "42,100 of 90,000 words"; absent without a target', () => {
  const html = page([FIRST]);
  const bar = html.match(/<[^>]*role="progressbar"[^>]*>/);
  assert.ok(bar, 'progressbar');
  assert.match(bar[0], /aria-valuenow="42100"/);
  assert.match(bar[0], /aria-valuemin="0"/);
  assert.match(bar[0], /aria-valuemax="90000"/);
  assert.match(html, /42,100 of 90,000 words/);
  assert.doesNotMatch(page([LOST]), /role="progressbar"/);
  assert.match(page([LOST]), /1,200/, 'plain word count without a target');
});

test('card shows title, subtitle, pen name display and scene count', () => {
  const html = page([FIRST]);
  assert.match(html, /First Light/);
  assert.match(html, /The Beacon Is Lit/);
  assert.match(html, /R\. Fenwick/);
  assert.match(html, /2 scenes/);
});

test('the whole card is one link to /books/:id, with no nested interactive elements', () => {
  const html = page([FIRST, SECOND, NORTH, LOST, SVG, OUTSIDE]);
  const links = cardLinks(html);
  assert.equal(links.length, 6, 'exactly one link per card');
  assert.deepEqual(links.map((l) => l.id).sort(), [FIRST, SECOND, NORTH, LOST, SVG, OUTSIDE].map((b) => b.id).sort());
  for (const l of links) {
    assert.doesNotMatch(l.inner, /<(a|button|input|select|textarea|details|summary)\b/i, `nested interactive in ${l.id}`);
    assert.doesNotMatch(l.inner, /tabindex="(?!-1)/i);
  }
  const firstLink = links.find((l) => l.id === FIRST.id);
  assert.match(firstLink.inner, /First Light/);
  assert.match(firstLink.inner, /<img\b/);
  assert.match(firstLink.inner, /role="progressbar"/);
});

test('"Needs attention" badge for invalid books, link still opens the book', () => {
  const html = page([book('broken', 'Broken Book', { index_state: 'invalid' }), book('errs', 'Errs Book', { error_count: 2 }), NORTH]);
  assert.equal(count(html, /Needs attention/g), 2);
  assert.equal(cardLinks(html).length, 3);
});

test('loading shows skeleton cards, not the empty state; error shows message and Retry', () => {
  const loading = page(null, { loading: true });
  assert.match(loading, /skeleton/i);
  assert.doesNotMatch(loading, /No books here yet/);
  const err = page(null, { error: 'Could not reach the server', onRetry: () => {} });
  assert.match(err, /Could not reach the server/);
  assert.match(err, /<button\b[^>]*>\s*Retry\s*</);
});

// ---------------------------------------------------------------- 5: pure client filter
// Assumed signature: filterBooks(books, { query, status, showArchived, sort, hits }) -> books[]
// (hits: { [bookId]: { count, snippet } } from /api/search; when non-empty query is a search query).
const slugs = (list) => list.map((b) => b.slug);

test('filter: title, series and pen-name text match (case-insensitive, instant)', () => {
  const f = unit('filter');
  assert.deepEqual(slugs(f(ALL, { query: 'north' })), ['north-road']);
  assert.deepEqual(slugs(f(ALL, { query: 'HARBOUR' })).sort(), ['first-light', 'second-light']);
  assert.deepEqual(slugs(f(ALL, { query: 'a. marsh' })), ['north-road']);
  assert.deepEqual(slugs(f(ALL, { query: 'zzz-no-such' })), []);
  assert.equal(f(ALL, { query: '' }).length, f(ALL, {}).length);
});

test('filter: archived hidden unless showArchived; status chip narrows', () => {
  const f = unit('filter');
  assert.ok(!slugs(f(ALL, {})).includes('old-draft'));
  assert.ok(slugs(f(ALL, { showArchived: true })).includes('old-draft'));
  assert.deepEqual(slugs(f(ALL, { status: 'revising' })), ['north-road']);
  assert.deepEqual(slugs(f(ALL, { status: 'planning' })), ['second-light']);
  assert.deepEqual(slugs(f(ALL, { status: 'complete' })), []);
  assert.deepEqual(slugs(f(ALL, { status: 'all' })).sort(), slugs(f(ALL, {})).sort());
});

test('filter: does not mutate its input', () => {
  const f = unit('filter');
  const before = JSON.stringify(ALL);
  f(ALL, { query: 'light', sort: 'title' });
  assert.equal(JSON.stringify(ALL), before);
});

test('filter: search hits keep only the one book that has them', () => {
  const f = unit('filter');
  const hits = { [NORTH.id]: { count: 1, snippet: 'Collects zephyrquill feathers.' } };
  const out = f(ALL, { hits, query: '' });
  assert.deepEqual(slugs(out), ['north-road']);
});

// ---------------------------------------------------------------- 7: palette contrast
const HEX = /^#[0-9A-Fa-f]{6}$/;
const AA = 4.5;

test('palette: exactly 8 dark tones, each >= 4.5:1 with the cover text colour', () => {
  const palette = unit('palette');
  const textColor = unit('textColor');
  assert.equal(palette.length, 8);
  assert.equal(new Set(palette.map((c) => c.toLowerCase())).size, 8, 'distinct');
  for (const bg of palette) {
    assert.match(bg, HEX);
    const fg = textColor(bg);
    assert.match(fg, HEX);
    assert.ok(contrast(rgb(bg), rgb(fg)) >= AA, `${bg} on ${fg} = ${contrast(rgb(bg), rgb(fg)).toFixed(2)}`);
    assert.ok(lightness(rgb(bg)) < 40, `${bg} is a dark tone`);
  }
});

test('cover text colour: >= 4.5:1 for sample cover_color values; flips to dark on light colours', () => {
  const textColor = unit('textColor');
  const samples = ['#2F4A3A', '#3A5F7D', '#000000', '#7A1F3D', '#808080', '#B0B0B0', '#E8E0C8', '#F5F0E0', '#FFFFFF', '#FFD700', '#FFFF00', '#C0C0C0'];
  for (const bg of samples) {
    const fg = textColor(bg);
    assert.match(fg, HEX, bg);
    assert.ok(contrast(rgb(bg), rgb(fg)) >= AA, `${bg} on ${fg} = ${contrast(rgb(bg), rgb(fg)).toFixed(2)}`);
  }
  for (const light of ['#F5F0E0', '#FFFFFF', '#FFFF00']) {
    assert.ok(lightness(rgb(textColor(light))) < lightness(rgb(light)), `${light} gets dark text`);
  }
  assert.ok(lightness(rgb(textColor('#2F4A3A'))) > lightness(rgb('#2F4A3A')), 'dark colour gets light text');
});

test('generated cover colour is deterministic per book id and drawn from the palette', () => {
  const pick = unit('pickColor');
  const palette = unit('palette').map((c) => c.toLowerCase());
  const ids = Array.from({ length: 40 }, (_, i) => `book_01V3${String(i * 7919).padStart(22, '0')}`);
  const picked = ids.map((id) => pick(id));
  for (const c of picked) assert.ok(palette.includes(String(c).toLowerCase()), `${c} in palette`);
  assert.deepEqual(ids.map((id) => pick(id)), picked, 'same id, same colour');
  assert.ok(new Set(picked).size >= 4, 'ids spread across the palette');
});
