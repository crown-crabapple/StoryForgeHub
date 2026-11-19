// M13-J05: the Book interior page. Server-rendered with renderToStaticMarkup (no browser, no network), like epub-validation-ui.test.mjs: the page in its states (loading, laid out with a
// report, out of date, failed), labelled controls, the Export dialog entry, the route, the messages the page accepts, the requests, and the house rules.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const src = (p) => fileURLToPath(new URL(`../src/${p}`, import.meta.url));

let vite;
let Screen;
let Dialog;
let R;
let routes;
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  Screen = (await vite.ssrLoadModule('/src/interior/InteriorView.jsx')).InteriorScreen;
  Dialog = (await vite.ssrLoadModule('/src/export/ExportDialog.jsx')).ExportDialog;
  R = await vite.ssrLoadModule('/src/interior/requests.js');
  routes = await vite.ssrLoadModule('/src/routes.js');
});
after(async () => {
  await vite?.close();
});

const BOOK_ID = 'book_01S5000000000000000000000A';
const render = (el) => renderToStaticMarkup(el);
const decode = (html) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const plain = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const tagWith = (html, tag, needle) => (html.match(new RegExp(`<${tag}\\b[^>]*>`, 'g')) ?? []).find((t) => t.includes(needle)) ?? null;
const NOTE = 'Experimental. A preview of a printed interior; not print-ready, not checked by any printer or store, and no PDF/X.';

const REPORT = {
  words: 52000,
  scenes: 40,
  chapters: 12,
  unsupported: [
    { kind: 'table', sceneId: 'scene_X', count: 2 },
    { kind: 'image', sceneId: 'scene_Y', count: 1 },
  ],
  missingGlyphs: [{ char: '中', codePoint: 0x4e2d, count: 3, sceneIds: ['scene_X'] }],
};
const SNAP = { snapshotId: 'snap_abc', report: REPORT };
const DONE = {
  state: 'done',
  pages: 142,
  ms: 3100,
  message: '',
  problems: [
    { kind: 'clipped', page: 12, message: 'x' },
    { kind: 'widow', page: 40, message: 'x' },
    { kind: 'orphan', page: 41, message: 'x' },
    { kind: 'strandedHeading', page: 77, message: 'x' },
    { kind: 'missingText', page: null, message: 'The text differs from character 9.' },
  ],
};
const screen = (props) => render(h(Screen, { bookId: BOOK_ID, layout: R.layoutOf(null), phase: 'idle', ...props }));

describe('the page in its states', () => {
  test('loading: no controls yet, Refresh preview disabled, the note is there', () => {
    const html = screen({ layout: null, phase: 'loading' });
    assert.ok(plain(html).includes('Loading'));
    assert.match(html, /<button[^>]*disabled=""[^>]*>Refresh preview<\/button>/);
    assert.ok(plain(html).includes(NOTE));
    assert.ok(!html.includes('<iframe'));
    assert.ok(!html.includes('interior-trim'));
  });

  test('before the first refresh: a prompt, no frame, an empty report', () => {
    const html = screen({});
    assert.ok(plain(html).includes('Choose Refresh preview to lay the book out.'));
    assert.ok(!html.includes('<iframe'));
    assert.ok(plain(html).includes('Not laid out yet'));
    assert.ok(plain(html).includes(NOTE));
  });

  test('laying out: the frame is sandboxed and titled, the status says so', () => {
    const html = screen({ phase: 'laying-out', snapshot: SNAP, previewSrc: R.interiorUrls(BOOK_ID).preview('snap_abc') });
    const frame = tagWith(html, 'iframe', 'Book interior preview');
    assert.ok(frame);
    assert.ok(frame.includes('sandbox="allow-scripts allow-same-origin"'));
    assert.ok(/referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/.test(frame));
    assert.ok(frame.includes(`src="/api/books/${BOOK_ID}/interior/snapshots/snap_abc/preview.html"`));
    assert.ok(plain(html).includes('Laying out pages…'));
  });

  test('laid out with the report: pages, words, unsupported content with scene links, missing glyphs with the fallback note, problems with page numbers', () => {
    const html = screen({ phase: 'done', snapshot: SNAP, summary: DONE, previewSrc: 'x' });
    const text = plain(html);
    assert.ok(text.includes('142 pages in 3.1 s'));
    assert.ok(text.includes('52000'));
    assert.ok(text.includes('Tables: 2') && text.includes('Images: 1'));
    assert.ok(html.includes(`href="/books/${BOOK_ID}?scene=scene_X"`));
    assert.ok(text.includes('中') && text.includes('U+4E2D') && text.includes('3 times'));
    assert.ok(text.includes('show in a fallback font') && text.includes('estimate'));
    assert.ok(text.includes('Clipped text') && text.includes('On page 12.'));
    assert.ok(text.includes('Stranded headings') && text.includes('On page 77.'));
    assert.ok(text.includes('Widows and orphans, for review') && text.includes('On pages 40 and 41.'));
    assert.ok(text.includes('The text differs from character 9.'));
    assert.ok(!text.includes('Preview out of date'));
  });

  test('a clean layout says nothing to review', () => {
    const clean = { snapshotId: 's', report: { ...REPORT, unsupported: [], missingGlyphs: [] } };
    assert.ok(plain(screen({ phase: 'done', snapshot: clean, summary: { ...DONE, problems: [] }, previewSrc: 'x' })).includes('Nothing to review.'));
  });

  test('out of date: the banner shows', () => {
    const html = screen({ phase: 'done', snapshot: SNAP, summary: DONE, outOfDate: true, previewSrc: 'x' });
    assert.ok(plain(html).includes('Preview out of date'));
    assert.ok(tagWith(html, 'p', 'interior-stale')?.includes('role="status"'));
  });

  test('failed: the reason is in the status line, the report says the pages were not checked', () => {
    const failed = { state: 'failed', pages: 0, ms: 10, message: 'paged.js did not load', problems: [] };
    const html = screen({ phase: 'failed', snapshot: SNAP, summary: failed, previewSrc: 'x' });
    assert.ok(plain(html).includes('Layout failed: paged.js did not load'));
    assert.ok(plain(html).includes('could not be laid out, so they were not checked'));
    const refused = screen({ phase: 'idle', error: 'The book could not be prepared for the preview. Nothing in your book was changed.' });
    assert.match(refused, /role="alert"[^>]*>The book could not be prepared/);
  });
});

describe('the controls', () => {
  test('every setting has a label tied to its control', () => {
    const html = screen({});
    const fields = [
      ['interior-trim', 'Trim size'],
      ['interior-font', 'Font'],
      ['interior-font-size', 'Font size \\(points\\)'],
      ['interior-line-height', 'Line spacing'],
      ['interior-margin-inside', 'Inside margin \\(spine side\\)'],
      ['interior-margin-outside', 'Outside margin'],
      ['interior-margin-top', 'Top margin'],
      ['interior-margin-bottom', 'Bottom margin'],
      ['interior-chapter-start', 'Chapters start'],
      ['interior-scene-break', 'Scene break'],
      ['interior-copyright', 'Copyright page text'],
      ['interior-dedication', 'Dedication'],
      ['interior-about-author', 'About the author'],
    ];
    for (const [id, label] of fields) {
      assert.match(html, new RegExp(`<label for="${id}">${label}</label>`), label);
      assert.match(html, new RegExp(`<(input|select|textarea)[^>]* id="${id}"`), id);
    }
    assert.ok(plain(html).includes('Running heads') && plain(html).includes('Page numbers'));
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
    assert.ok(html.includes('<legend>Margins (inches)</legend>'));
    assert.ok(html.includes('aria-label="Book interior settings"'));
  });
  test('they show the layout given', () => {
    const layout = { ...R.layoutOf(null), trim: '5.5x8.5', font: 'inter', fontSize: 12.5, frontMatter: { copyright: 'Mine', dedication: 'For R.' } };
    const custom = render(h(Screen, { bookId: BOOK_ID, phase: 'idle', layout }));
    assert.match(custom, /<option value="5.5x8.5" selected="">/);
    assert.match(custom, /<option value="inter" selected="">/);
    assert.ok(tagWith(custom, 'input', 'id="interior-font-size"').includes('value="12.5"'));
    assert.ok(custom.includes('>Mine</textarea>') && custom.includes('>For R.</textarea>'));
  });
  test('a bad number is said next to its field and Refresh preview is disabled', () => {
    const layout = { ...R.layoutOf(null), fontSize: '15' };
    const problems = R.layoutProblems(layout);
    assert.deepEqual(problems.map((p) => p.field), ['fontSize']);
    const bad = render(h(Screen, { bookId: BOOK_ID, phase: 'idle', layout, problems }));
    assert.ok(tagWith(bad, 'input', 'id="interior-font-size"').includes('aria-invalid="true"'));
    assert.ok(plain(bad).includes('Font size must be from 9 to 14 points'));
    assert.match(bad, /<button[^>]*disabled=""[^>]*>Refresh preview<\/button>/);
  });
});

describe('the Export dialog entry and the route', () => {
  test('the dialog offers Book interior (experimental) as a button that opens the page; the PDF option is unchanged', () => {
    const html = render(h(Dialog, { book: { id: BOOK_ID, slug: 'salt-orchard', acts: [] }, onClose: () => {} }));
    const button = tagWith(html, 'button', 'aria-describedby="export-interior-hint"');
    assert.ok(button !== null && button.includes('type="button"'));
    assert.match(html, /<button[^>]*export-interior-hint[^>]*>Book interior \(experimental\)<\/button>/);
    assert.equal(R.interiorPath(BOOK_ID), `/books/${BOOK_ID}/interior`);
    assert.ok(plain(html).includes('Book interior (experimental)'));
    assert.ok(plain(html).includes('PDF A manuscript .pdf file (double-spaced pages)'));
    assert.match(html, /name="export-format" value="pdf"/);
  });
  test('/books/:id/interior is a page of its own, not a tab', () => {
    assert.deepEqual(routes.parseRoute(`/books/${BOOK_ID}/interior`), { name: 'interior', bookId: BOOK_ID });
    assert.deepEqual(routes.parseRoute(`/books/${BOOK_ID}/interior/`), { name: 'interior', bookId: BOOK_ID });
    for (const t of [...routes.PROJECT_TABS, ...routes.MORE_TABS]) assert.notEqual(t.key, 'interior');
    assert.equal(routes.parseRoute(`/books/${BOOK_ID}/interior/x`).name, 'notfound');
  });
});

describe('the requests and the messages', () => {
  test("layoutOf puts the book's settings over the defaults, group by group", () => {
    const l = R.layoutOf({ effective: { interior: { fontSize: 12, margins: { inside: 1 } } } });
    assert.equal(l.fontSize, 12);
    assert.deepEqual(l.margins, { inside: 1, outside: 0.5, top: 0.6, bottom: 0.6 });
    assert.equal(l.trim, '6x9');
  });
  test('patchOf sends only what changed, groups whole, numbers as numbers', () => {
    const saved = R.layoutOf(null);
    assert.deepEqual(R.patchOf(saved, saved), {});
    assert.deepEqual(R.patchOf({ ...saved, fontSize: '12.5', margins: { ...saved.margins, inside: '0.9' } }, saved), { fontSize: 12.5, margins: { inside: 0.9, outside: 0.5, top: 0.6, bottom: 0.6 } });
  });
  test('layoutProblems: ranges, half points, empty text', () => {
    const base = R.layoutOf(null);
    assert.deepEqual(R.layoutProblems(base), []);
    assert.equal(R.layoutProblems({ ...base, fontSize: '11.3' }).length, 1);
    assert.equal(R.layoutProblems({ ...base, fontSize: '' }).length, 1);
    assert.equal(R.layoutProblems({ ...base, lineHeight: 2 }).length, 1);
    assert.equal(R.layoutProblems({ ...base, margins: { ...base.margins, top: 0.1, bottom: 2 } }).length, 2);
  });
  test('saveLayout, createSnapshot and readFingerprint call the routes and word the refusals', async () => {
    const calls = [];
    const fake = (status, json) => async (url, init) => {
      calls.push({ url, init });
      return { status, json: async () => json };
    };
    assert.deepEqual(await R.saveLayout(BOOK_ID, { fontSize: 12 }, fake(200, { ok: true })), { ok: true });
    assert.equal(calls[0].url, `/api/books/${BOOK_ID}/interior/layout`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['x-storyforge'], '1');
    assert.equal(calls[0].init.body, '{"fontSize":12}');
    assert.match((await R.saveLayout(BOOK_ID, {}, fake(400, { message: 'fontSize: nope' }))).message, /fontSize: nope/);
    const down = async () => {
      throw new Error('down');
    };
    assert.match((await R.saveLayout(BOOK_ID, {}, down)).message, /could not be reached/);
    const snap = await R.createSnapshot(BOOK_ID, fake(201, { snapshotId: 'snap_1', fingerprint: 'f'.repeat(64), report: { words: 1 } }));
    assert.deepEqual(snap, { ok: true, snapshotId: 'snap_1', fingerprint: 'f'.repeat(64), report: { words: 1 } });
    assert.equal(calls.at(-1).url, `/api/books/${BOOK_ID}/interior/snapshots`);
    assert.equal((await R.createSnapshot(BOOK_ID, fake(500, { error: 'export_failed' }))).ok, false);
    assert.equal(await R.readFingerprint(BOOK_ID, fake(200, { fingerprint: 'abc' })), 'abc');
    assert.equal(calls.at(-1).url, `/api/books/${BOOK_ID}/interior/fingerprint`);
    assert.equal(await R.readFingerprint(BOOK_ID, fake(404, null)), null);
  });
  test("only a message from the frame's own window and this origin is accepted", () => {
    const frame = {};
    const here = 'https://here.test';
    const data = { type: 'storyforge-interior', state: 'done', pages: 3, ms: 50, problems: [{ kind: 'clipped', page: 2, message: 'm' }, 7] };
    assert.deepEqual(R.summaryFrom({ origin: here, source: frame, data }, frame, here), { state: 'done', pages: 3, ms: 50, message: '', problems: [{ kind: 'clipped', page: 2, message: 'm' }] });
    assert.equal(R.summaryFrom({ origin: 'https://evil.test', source: frame, data }, frame, here), null);
    assert.equal(R.summaryFrom({ origin: here, source: {}, data }, frame, here), null);
    assert.equal(R.summaryFrom({ origin: here, source: frame, data }, null, here), null);
    assert.equal(R.summaryFrom({ origin: here, source: frame, data: { ...data, type: 'other' } }, frame, here), null);
    assert.equal(R.summaryFrom({ origin: here, source: frame, data: { type: 'storyforge-interior', state: 'running' } }, frame, here), null);
    assert.equal(R.summaryFrom({ origin: here, source: frame, data: 'storyforge-interior' }, frame, here), null);
  });
  test('timing and words: the debounce is 800 ms, the poll 5 s, the note is fixed', () => {
    assert.equal(R.DEBOUNCE_MS, 800);
    assert.equal(R.POLL_MS, 5000);
    assert.equal(R.EXPERIMENTAL_NOTE, NOTE);
    assert.equal(R.statusLine({ phase: 'done', summary: { pages: 1, ms: 400, message: '' }, error: null }), '1 page in 0.4 s');
    assert.equal(R.statusLine({ phase: 'failed', summary: null, error: 'x' }), 'Layout failed: x');
  });
});

describe('house rules', () => {
  test("onClick only on a button, a Link or an anchor; no key handling; no URLs; the view's frame and listeners", async () => {
    const files = (await readdir(src('interior'))).map((f) => src(`interior/${f}`));
    for (const f of files) {
      const text = await readFile(f, 'utf8');
      for (const m of text.matchAll(/<(\w+)[^<>]*?onClick=/g)) assert.ok(['button', 'Link', 'a'].includes(m[1]), `${f}: onClick on <${m[1]}>`);
      assert.ok(!/onKey(Down|Up|Press)|keydown|keyup|\b(e|event)\.key\b/.test(text), `${f}: key handling belongs in registry.js`);
      assert.ok(!/https?:\/\//.test(text), `${f}: no URL`);
    }
    const view = await readFile(src('interior/InteriorView.jsx'), 'utf8');
    assert.match(view, /summaryFrom\(e, frameRef\.current\?\.contentWindow/);
    assert.match(view, /window\.location\.origin/);
    assert.match(view, /sandbox="allow-scripts allow-same-origin"/);
    assert.match(view, /referrerPolicy="no-referrer"/);
    assert.match(view, /title="Book interior preview"/);
  });
});
