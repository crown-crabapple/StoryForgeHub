// Rename a book, New series, Move to series: the dialogs and the Settings -> Books section, server-rendered with renderToStaticMarkup like new-book.test.mjs.
// Click handlers are not in static markup, so what a submit posts is checked on the source, and the rename call (saveTitle) runs against a stubbed fetch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const src = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

let vite;
let m = {};
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  for (const p of ['/src/library/NewSeriesDialog.jsx', '/src/library/MoveToSeriesDialog.jsx', '/src/prefs/BookAdminSettings.jsx', '/src/library/LibraryPage.jsx']) {
    m = { ...m, ...(await vite.ssrLoadModule(p)) };
  }
});
after(async () => {
  await vite?.close();
});

const noop = () => {};
const render = (el) => renderToStaticMarkup(el);
const text = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const plain = (html) => text(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const SERIES = [{ slug: 'harbour-lights', title: 'Harbour Lights', status: 'active' }, { slug: 'tidewater', title: null, status: 'planned' }];
const BOOKS = [
  { id: 'book_A', title: 'North Road', series: null },
  { id: 'book_B', title: 'First Light', series: 'harbour-lights' },
];

test('New series dialog: an accessible modal with Title, Folder name, Create series and Cancel', () => {
  const html = render(h(m.NewSeriesDialog, { onClose: noop, onCreated: noop }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="New series"/);
  assert.match(html, /<label for="ns-title">Title<\/label><input id="ns-title"[^>]*required/);
  assert.match(html, /<label for="ns-slug">Folder name<\/label><input id="ns-slug"/);
  assert.match(html, /<button type="button" class="btn">Cancel<\/button>/);
  assert.match(html, /<button type="submit" class="btn btn-primary">Create series<\/button>/);
  assert.doesNotMatch(html, /aria-invalid="true"/);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 0);
});

test('New series dialog: an error on a field shows next to it; any other error is shown at the top', () => {
  for (const [field, label] of [['title', 'ns-title'], ['slug', 'ns-slug']]) {
    const message = `Problem with ${field}.`;
    const html = render(h(m.NewSeriesDialog, { onClose: noop, error: { code: 'X', field, message } }));
    assert.equal((plain(html).match(new RegExp(message.replace('.', '\\.'), 'g')) ?? []).length, 1);
    assert.match(html, new RegExp(`id="${label}"[^>]*aria-invalid="true"[^>]*aria-describedby="ns-${field}-error"`));
    assert.equal((html.match(/aria-invalid="true"/g) ?? []).length, 1);
  }
  const general = render(h(m.NewSeriesDialog, { onClose: noop, error: { code: 'ROLLED_BACK', message: 'The series could not be written.' } }));
  assert.ok(plain(general).includes('The series could not be written.'));
  assert.doesNotMatch(general, /aria-invalid="true"/);
});

test('New series dialog posts { title, slug? } to /api/series and uses the shared Dialog', () => {
  const s = src('library/NewSeriesDialog.jsx');
  assert.match(s, /postJson\('\/api\/series', body\)/);
  assert.match(s, /const body = \{ title \};\s*if \(slug !== ''\) body\.slug = slug;/);
  assert.match(s, /import \{ Dialog \} from '\.\.\/shell\/Dialog\.jsx'/);
});

test('Move to series dialog: lists the series, an optional number, Move book and Cancel', () => {
  const html = render(h(m.MoveToSeriesDialog, { book: BOOKS[0], series: SERIES, onClose: noop, onMoved: noop }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-label="Move to series"/);
  const select = /<label for="mv-series">Series<\/label><select id="mv-series"[\s\S]*?<\/select>/.exec(html)?.[0];
  assert.ok(select, 'Series select tied to its label');
  assert.equal((select.match(/<option\b/g) ?? []).length, 3, 'a prompt plus two series');
  assert.match(select, /Harbour Lights/);
  assert.match(select, /<option value="tidewater">tidewater<\/option>/, 'an untitled series shows its slug');
  assert.match(html, /<label for="mv-number">Number in series<\/label><input id="mv-number" type="number"/);
  assert.ok(plain(html).includes('North Road'));
  assert.match(html, /<button type="submit" class="btn btn-primary">Move book<\/button>/);
  assert.match(html, /<button type="button" class="btn">Cancel<\/button>/);
});

test('Move to series dialog: the server message is shown on a refusal, next to the field it names', () => {
  const taken = render(h(m.MoveToSeriesDialog, { book: BOOKS[0], series: SERIES, onClose: noop, error: { code: 'SERIES_NUMBER_TAKEN', field: 'seriesNumber', message: 'Book 1 of that series already exists.' } }));
  assert.ok(plain(taken).includes('Book 1 of that series already exists.'));
  assert.match(taken, /id="mv-number"[^>]*aria-invalid="true"[^>]*aria-describedby="mv-seriesNumber-error"/);
  const gone = render(h(m.MoveToSeriesDialog, { book: BOOKS[0], series: SERIES, onClose: noop, error: { code: 'ALREADY_IN_SERIES', message: 'That book is already in a series.' } }));
  assert.ok(plain(gone).includes('That book is already in a series.'));
  assert.doesNotMatch(gone, /aria-invalid="true"/);
});

test('Move to series dialog posts { seriesSlug, seriesNumber? } to the book route and shows a success warning', () => {
  const s = src('library/MoveToSeriesDialog.jsx');
  assert.match(s, /postJson\(`\/api\/books\/\$\{encodeURIComponent\(book\.id\)\}\/move-to-series`, body\)/);
  assert.match(s, /const body = \{ seriesSlug \};\s*if \(seriesNumber !== ''\) body\.seriesNumber = Number\(seriesNumber\);/);
  assert.match(s, /json\.warning/);
  assert.match(s, /import \{ Dialog \} from '\.\.\/shell\/Dialog\.jsx'/);
});

test('Settings -> Books: a "Book title" field with Save per book; Move to series… only for standalone books', () => {
  const html = render(h(m.BookAdminView, { books: BOOKS, series: SERIES, status: 'Renamed to X.' }));
  assert.match(html, /aria-labelledby="book-admin-heading"/);
  assert.equal((html.match(/<label for="[^"]+-title">Book title/g) ?? []).length, 2, 'one labelled title field per book');
  assert.match(html, /value="North Road"/);
  assert.match(html, /value="First Light"/);
  assert.equal((html.match(/>Save<\/button>/g) ?? []).length, 2);
  assert.equal((html.match(/Move to series…/g) ?? []).length, 1, 'only the standalone book offers it');
  assert.ok(plain(html).includes('Renamed to X.'));
  const empty = render(h(m.BookAdminView, { books: [], series: [] }));
  assert.ok(plain(empty).includes('No books yet.'));
});

test('saveTitle posts { title } to the book title route and reports the server message on refusal', async () => {
  const real = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      const bad = body.title === '';
      return { status: bad ? 400 : 200, json: async () => (bad ? { ok: false, code: 'BAD_TITLE', field: 'title', message: 'Give the book a title.' } : { ok: true, title: body.title.trim() }) };
    };
    const ok = await m.saveTitle('book_A', '  New Name ');
    assert.deepEqual(ok, { ok: true, title: 'New Name' });
    assert.equal(calls[0].url, '/api/books/book_A/title');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['x-storyforge'], '1');
    assert.deepEqual(JSON.parse(calls[0].init.body), { title: '  New Name ' });
    assert.deepEqual(await m.saveTitle('book_A', ''), { ok: false, message: 'Give the book a title.' });
  } finally {
    globalThis.fetch = real;
  }
});

test('Library page: a New series… button opens the New series dialog', () => {
  const html = render(h(m.LibraryPage, { books: [], error: null, loading: false }));
  assert.match(text(html), /<button type="button" class="btn">New series…<\/button>/);
  assert.match(src('library/LibraryPage.jsx'), /dialog === 'new-series' && <NewSeriesFlow/);
});
