// M02-J03 acceptance 10: the Start section buttons, the New book dialog and the Open folder dialog.
// Server-rendered with renderToStaticMarkup (no browser, no network), like library.test.mjs.
//
// The contract names behaviour, not modules or props, so the dialogs are looked up by likely locations
// and export names (LOCATE below) and are given every plausible spelling of each prop. A missing unit
// fails with "implementation missing: ..." rather than skipping.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));

const DIRS = ['/src', '/src/library', '/src/shell', '/src/dialogs', '/src/books', '/src/library/dialogs'];
const MODULES = [
  '/src/LibraryView.jsx',
  '/src/library/LibraryPage.jsx',
  ...['NewBookDialog', 'OpenFolderDialog', 'OpenLibraryDialog', 'NewBook', 'OpenFolder'].flatMap((n) => DIRS.map((d) => `${d}/${n}.jsx`)),
];
const LOCATE = {
  NewBook: ['NewBookDialog', 'NewBook'],
  OpenFolder: ['OpenFolderDialog', 'OpenLibraryDialog', 'OpenFolder'],
  Page: ['LibraryPage'],
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
  assert.fail(`implementation missing: no export named one of ${LOCATE[kind].join(' | ')} under apps/web/src (${DIRS.join(', ')})`);
}

const render = (el) => renderToStaticMarkup(el);
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plainText = (html) => text(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const count = (html, re) => (html.match(re) ?? []).length;
const noop = () => {};

// ---------------------------------------------------------------- fixtures (the shapes /api returns)

const TEMPLATES = [
  { name: 'blank', title: 'Blank', description: 'One empty scene, nothing else.', beats: ['Start writing'], acts: 1, chapters: 1, scenes: 1 },
  { name: 'story-circle', title: 'Story Circle', description: 'Eight beats around a circle.', beats: ['You', 'Need', 'Go', 'Search', 'Find', 'Take', 'Return', 'Change'], acts: 2, chapters: 8, scenes: 8 },
  { name: 'heros-journey', title: "Hero's Journey", description: 'Twelve stages in three acts.', beats: ['Ordinary World', 'Call to Adventure', 'Refusal of the Call'], acts: 3, chapters: 12, scenes: 12 },
  { name: 'seven-point', title: 'Seven-Point Structure', description: 'Hook to resolution in seven points.', beats: ['Hook', 'Plot Turn 1', 'Pinch 1', 'Midpoint', 'Pinch 2', 'Plot Turn 2', 'Resolution'], acts: 3, chapters: 7, scenes: 7 },
];
const SERIES = [{ slug: 'harbour-lights', title: 'Harbour Lights', status: 'active', book_ids: ['a', 'b'] }];
const PEN_NAMES = [
  { name: 'R. Fenwick', slug: 'r-fenwick' },
  { name: 'A. Marsh', slug: 'a-marsh' },
];

function newBook(extra = {}) {
  const Dialog = unit('NewBook');
  const library = { root: 'C:\\lib', title: null, series: SERIES, pen_names: PEN_NAMES, penNames: PEN_NAMES };
  return render(
    h(Dialog, {
      templates: TEMPLATES,
      series: SERIES,
      penNames: PEN_NAMES,
      pen_names: PEN_NAMES,
      library,
      onClose: noop,
      onCancel: noop,
      onCreated: noop,
      onCreate: noop,
      ...extra,
    }),
  );
}

const RECENT = [
  { path: 'C:\\Books\\Present Library', exists: true, missing: false },
  { path: 'C:\\Books\\Gone Library', exists: false, missing: true, found: false, not_found: true },
];
function openFolder(extra = {}) {
  const Dialog = unit('OpenFolder');
  return render(h(Dialog, { recent: RECENT, recents: RECENT, items: RECENT, onClose: noop, onCancel: noop, onOpen: noop, onOpened: noop, onRemove: noop, ...extra }));
}

/** The <input|select|textarea> a label points at, as { tag, attrs, html }; works for wrapped and `for=` labels. */
function fieldFor(html, labelText) {
  const labels = [...html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)];
  const label = labels.find((l) => plainText(l[2]).toLowerCase().startsWith(labelText.toLowerCase())) ?? labels.find((l) => plainText(l[2]).toLowerCase().includes(labelText.toLowerCase()));
  assert.ok(label, `a <label> reading "${labelText}" exists; labels: ${labels.map((l) => plainText(l[2])).join(' | ')}`);
  const forId = /\bfor="([^"]+)"/.exec(label[1])?.[1];
  let el;
  if (forId) el = [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].find((m) => new RegExp(`\\bid="${forId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(m[2]));
  else el = /<(input|select|textarea)\b([^>]*)>/.exec(label[2]);
  assert.ok(el, `"${labelText}" label is tied to a form control`);
  return { tag: el[1], attrs: el[2], html: el[0] };
}
const attr = (attrs, name) => new RegExp(`\\b${name}(?:="([^"]*)")?`).exec(attrs)?.[1];
const hasAttr = (attrs, name) => new RegExp(`\\b${name}\\b`).test(attrs);

// ---------------------------------------------------------------- Start section

test('library page: the Start section has exactly two real buttons, New book… and Open folder…', () => {
  const Page = unit('Page');
  const html = text(render(h(Page, { books: [{ id: 'b', title: 'Book', slug: 'book', status: 'drafting', scene_count: 1, word_count: 10, error_count: 0, warning_count: 0 }], error: null, loading: false })));
  const start = html.match(/<section aria-labelledby="start-heading"[\s\S]*?<\/section>/);
  assert.ok(start, 'Start something new section present');
  const buttons = [...start[0].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.equal(buttons.length, 2, `exactly two buttons: ${buttons.map((b) => plainText(b[2]))}`);
  assert.deepEqual(buttons.map((b) => plainText(b[2])), ['New book\u2026', 'Open folder\u2026']);
  for (const b of buttons) assert.match(b[1], /type="button"/);
  assert.doesNotMatch(start[0], /<(a|input|select|textarea)\b/);
  assert.doesNotMatch(start[0], /arrives in the next update/);
});

test('library page: the Start section is present with no books too (empty library)', () => {
  const Page = unit('Page');
  const html = text(render(h(Page, { books: [], error: null, loading: false })));
  const start = html.match(/<section aria-labelledby="start-heading"[\s\S]*?<\/section>/);
  assert.ok(start);
  assert.equal(count(start[0], /<button\b/g), 2);
});

// ---------------------------------------------------------------- New book dialog

test('New book dialog: an accessible modal with Title, Folder name, Pen name, Series, Template, Create and Cancel', () => {
  const html = newBook();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="[^"]*new book[^"]*"/i);

  const title = fieldFor(html, 'Title');
  assert.equal(title.tag, 'input');
  assert.ok(hasAttr(title.attrs, 'required') || attr(title.attrs, 'aria-required') === 'true', 'Title is required');
  const slug = fieldFor(html, 'Folder name');
  assert.equal(slug.tag, 'input');
  assert.notEqual(attr(slug.attrs, 'type'), 'hidden');
  assert.ok(!hasAttr(slug.attrs, 'readonly') && !hasAttr(slug.attrs, 'disabled'), 'folder name is editable');

  const pen = fieldFor(html, 'Pen name');
  assert.equal(pen.tag, 'select');
  const penSelect = new RegExp(`${pen.html.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?</select>`).exec(html)[0];
  assert.match(penSelect, /R\. Fenwick/);
  assert.match(penSelect, /A\. Marsh/);
  assert.ok(count(penSelect, /<option\b/g) === 3, 'two pen names plus a "none" choice');

  const series = fieldFor(html, 'Series');
  assert.equal(series.tag, 'select');
  const seriesSelect = new RegExp(`${series.html.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?</select>`).exec(html)[0];
  assert.match(seriesSelect, /Standalone/);
  assert.match(seriesSelect, /Harbour Lights/);
  assert.equal(count(seriesSelect, /<option\b/g), 2);

  assert.match(plainText(html), /Template/);
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((b) => ({ attrs: b[1], label: plainText(b[2]) }));
  const create = buttons.find((b) => /^create\b/i.test(b.label));
  const cancel = buttons.find((b) => /^cancel$/i.test(b.label));
  assert.ok(create, `a Create button; buttons: ${buttons.map((b) => b.label)}`);
  assert.ok(cancel, 'a Cancel button');
  assert.match(cancel.attrs, /type="button"/, 'Cancel never submits');
  assert.match(create.attrs, /type="submit"/);
});

test('New book dialog: one radio card per template with name, description, "N chapters · N scenes", and its beats', () => {
  const html = newBook();
  const radios = [...html.matchAll(/<input\b([^>]*type="radio"[^>]*)>/g)];
  assert.equal(radios.length, 4, 'four template radios');
  assert.equal(new Set(radios.map((r) => attr(r[1], 'name'))).size, 1, 'they form one radio group');
  assert.deepEqual(radios.map((r) => attr(r[1], 'value')).sort(), TEMPLATES.map((t) => t.name).sort());
  assert.equal(count(radios.map((r) => r[1]).join('\n'), /\bchecked\b/g), 1, 'exactly one is preselected');

  const plain = plainText(html);
  for (const t of TEMPLATES) {
    assert.ok(plain.includes(t.title), `${t.title} shown`);
    assert.ok(plain.includes(t.description), `${t.name} description shown`);
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    assert.ok(plain.includes(`${plural(t.chapters, 'chapter')} \u00b7 ${plural(t.scenes, 'scene')}`), `${t.name}: "${plural(t.chapters, 'chapter')} \u00b7 ${plural(t.scenes, 'scene')}" shown; text: ${plain.slice(0, 600)}`);
  }
  // the beat list is in the markup, inside an expandable element
  const details = [...html.matchAll(/<details\b[\s\S]*?<\/details>/g)];
  assert.ok(details.length >= 4, 'each card has an expandable beat list');
  const seven = details.find((d) => d[0].includes('Midpoint'));
  assert.ok(seven, 'the seven-point beats are listed');
  for (const beat of TEMPLATES[3].beats) assert.ok(seven[0].includes(beat), `${beat} in the beat list`);
  assert.ok(/<(ol|ul)\b/.test(seven[0]), 'beats are a list');
  assert.doesNotMatch(seven[0], /\sopen(=|\s|>)/, 'collapsed by default');
});

test('New book dialog: no error text when there is no error, and no dead controls', () => {
  const html = newBook();
  assert.doesNotMatch(html, /aria-invalid="true"/);
  assert.equal(count(html, /role="alert"/g), 0);
  assert.equal(count(html, /<a\b/g), 0, 'no links inside the dialog');
});

const FIELD_ERRORS = [
  ['title', 'BAD_TITLE', 'Give the book a title of 1 to 120 characters.', 'Title'],
  ['slug', 'SLUG_TAKEN', 'A book called "north-road" already exists in this library.', 'Folder name'],
  ['penName', 'NO_SUCH_PEN_NAME', 'That pen name is not in library.md.', 'Pen name'],
  ['seriesSlug', 'NO_SUCH_SERIES', 'That series does not exist.', 'Series'],
];
for (const [field, code, message, label] of FIELD_ERRORS) {
  test(`New book dialog: an API error on "${field}" shows next to that field and marks it invalid`, () => {
    const err = { ok: false, code, field, message };
    const html = newBook({ error: err, errors: { [field]: message }, initialError: err, serverError: err, apiError: err, result: err });
    const plain = plainText(html);
    assert.equal(count(plain.replace(/\s+/g, ' '), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 1, `the message appears exactly once: ${plain.slice(0, 500)}`);
    const control = fieldFor(html, label);
    assert.equal(attr(control.attrs, 'aria-invalid'), 'true', `${label} control is aria-invalid`);
    const describedBy = attr(control.attrs, 'aria-describedby');
    assert.ok(describedBy, `${label} control has aria-describedby`);
    const target = describedBy.split(/\s+/).map((id) => new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</`).exec(html)?.[1]).filter(Boolean).join(' ');
    assert.ok(plainText(target).includes(message), `aria-describedby points at the message; got "${plainText(target)}"`);
    // only that one field is flagged
    assert.equal(count(html, /aria-invalid="true"/g), 1);
  });
}

test('New book dialog: an error on the template or series number is shown too (no field label to tie to)', () => {
  for (const [field, code, message] of [
    ['template', 'NO_SUCH_TEMPLATE', 'Pick one of the templates below.'],
    ['seriesNumber', 'SERIES_NUMBER_TAKEN', 'Book 2 of Harbour Lights already exists.'],
  ]) {
    const err = { ok: false, code, field, message };
    const html = newBook({ error: err, errors: { [field]: message }, initialError: err, serverError: err, apiError: err, result: err });
    assert.ok(plainText(html).includes(message), `${field}: message shown`);
  }
});

test('New book dialog: an error for an unknown field is not lost', () => {
  const err = { ok: false, code: 'TEMPLATE_INVALID', message: 'The template did not make a valid book.' };
  const html = newBook({ error: err, initialError: err, serverError: err, apiError: err, result: err });
  assert.ok(plainText(html).includes(err.message), 'the message is shown somewhere in the dialog');
});

test('New book dialog: with no series in the library the Series control still offers Standalone', () => {
  const html = newBook({ series: [], library: { series: [], pen_names: [] }, penNames: [], pen_names: [] });
  const series = fieldFor(html, 'Series');
  assert.equal(series.tag, 'select');
  assert.match(html, /Standalone/);
  assert.doesNotMatch(html, /Harbour Lights/);
});

// ---------------------------------------------------------------- Open folder dialog

test('Open folder dialog: a modal with a path field, Open and Cancel', () => {
  const html = openFolder();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="[^"]*(open|folder)[^"]*"/i);
  const pathField = fieldFor(html, 'Folder');
  assert.equal(pathField.tag, 'input');
  assert.ok(['text', undefined].includes(attr(pathField.attrs, 'type')), 'a plain text field (no native picker)');
  assert.doesNotMatch(html, /type="file"/);
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((b) => ({ attrs: b[1], label: plainText(b[2]) }));
  assert.ok(buttons.some((b) => /^open$/i.test(b.label)), `an Open button; buttons: ${buttons.map((b) => b.label)}`);
  const cancel = buttons.find((b) => /^cancel$/i.test(b.label));
  assert.ok(cancel);
  assert.match(cancel.attrs, /type="button"/);
});

test('Open folder dialog: recents list each path with a Remove button; a missing folder says "not found"', () => {
  const html = openFolder();
  const plain = plainText(html);
  assert.ok(plain.includes('C:\\Books\\Present Library'), 'present path listed');
  assert.ok(plain.includes('C:\\Books\\Gone Library'), 'missing path still listed');
  const removes = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter((b) => /remove/i.test(plainText(b[2])) || /aria-label="[^"]*remove/i.test(b[1]));
  assert.equal(removes.length, 2, 'one Remove per recent');
  assert.equal(count(plain, /not found/gi), 1, 'only the missing folder is marked "not found"');
  const gone = html.slice(html.indexOf('Gone Library') - 400, html.indexOf('Gone Library') + 400);
  assert.match(gone, /not found/i, 'the note sits with the missing item');
  // each present recent can be clicked to open
  const items = [...html.matchAll(/<li\b[\s\S]*?<\/li>/g)].map((m) => m[0]);
  const presentItem = items.find((i) => i.includes('Present Library'));
  assert.ok(presentItem, 'recents are list items');
  assert.match(presentItem, /<button\b/, 'present item is a real button');
  assert.doesNotMatch(presentItem, /not found/i);
});

test('Open folder dialog: no recents -> no Remove buttons and no "not found"', () => {
  const html = openFolder({ recent: [], recents: [], items: [] });
  const plain = plainText(html);
  assert.equal(count(plain, /remove/gi), 0);
  assert.doesNotMatch(plain, /not found/i);
  assert.match(html, /role="dialog"/);
});

test('Open folder dialog: errors are in plain words, never raw codes', () => {
  for (const [code, words] of [
    ['NO_BOOKS', /That folder has no books in it/],
    ['LOCKED', /Another StoryForge window is using that folder/],
  ]) {
    const err = { ok: false, code, message: code };
    const html = openFolder({ error: err, initialError: err, serverError: err, apiError: err, result: err });
    const plain = plainText(html);
    assert.match(plain, words, `${code} -> plain words; text: ${plain.slice(0, 400)}`);
    assert.doesNotMatch(plain, new RegExp(`\\b${code}\\b`), 'the raw code is not shown to the user');
  }
});

// ---------------------------------------------------------------- source checks (handlers are not in static markup)

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.jsx') ? [join(dir, e.name)] : []));
}
const srcOf = (re) => sourceFiles(join(webDir, 'src')).map((f) => ({ f, s: readFileSync(f, 'utf8') })).filter((x) => re.test(x.s));

test('both dialogs are built on the shared focus-trapped Dialog (Escape closes, Tab stays inside)', () => {
  for (const name of ['NewBookDialog', 'OpenFolderDialog']) {
    const defs = srcOf(new RegExp(`export function ${name}\\b`));
    assert.equal(defs.length, 1, `${name} is defined once`);
    assert.match(defs[0].s, /import\s*\{\s*Dialog\s*\}\s*from\s*'[^']*shell\/Dialog\.jsx'|from\s*'\.\/Dialog\.jsx'/, `${name} uses shell/Dialog.jsx`);
    assert.match(defs[0].s, /<Dialog\b/);
  }
});

test('the top-bar BookSwitcher ends with an "Open another folder…" item', () => {
  const src = readFileSync(join(webDir, 'src', 'shell', 'BookSwitcher.jsx'), 'utf8');
  assert.ok(src.includes('Open another folder\u2026'), 'BookSwitcher has the "Open another folder…" item');
});
