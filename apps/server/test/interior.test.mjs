// M13-J05: the Book interior preview on the server. A fake renderer stands in for @storyforge/export's renderInterior (its own tests live in packages/export): the snapshot lifecycle
// (create, expire, latest five), the fingerprint (changes with the text and with the layout), the preview document (exact headers and CSP, no script but the two allowed src tags),
// the layout route, the /interior-assets/ allow-list (an unlisted name is 404, path tricks refused), the boot script's own rules, and the policy of every new route.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { after, afterEach, test } from 'node:test';
import * as exportPackage from '@storyforge/export';
import { WRITE_CLASSES, allowed, classifyRead } from '../src/policy.mjs';
import { matchWriteRoute } from '../src/router.mjs';
import { PREVIEW_CSP, previewDocument, setInteriorHooks } from '../src/interior-routes.mjs';
import { createInteriorSnapshots, interiorSnapshots } from '../src/interior-snapshots.mjs';
import { interiorAssetTable } from '../src/static.mjs';
import { BOOK, SCENE, bootPersonal, closeAll, raw } from './plugin-helpers.mjs';

after(closeAll);
afterEach(() => {
  setInteriorHooks({});
  interiorSnapshots.setHooks({ now: null });
});

const B = `/api/books/${BOOK}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A renderer that is a pure function of the manuscript text and the layout (what the real one promises), and records its calls. */
function fakeRenderer() {
  const calls = [];
  const fn = (manuscript, layout, options) => {
    calls.push({ layout, options });
    const scenes = manuscript.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes));
    const words = scenes.reduce((n, s) => n + s.markdown.split(/\s+/).filter(Boolean).length, 0);
    return {
      html: `<section class="chapter">${scenes.map((s) => `<div class="scene" id="${s.id}"><p>${esc(s.markdown)}</p></div>`).join('')}</section>`,
      css: `@page { size: ${layout.trim === '5.5x8.5' ? '5.5in 8.5in' : '6in 9in'} } body { font-size: ${layout.fontSize}pt }`,
      report: { words, scenes: scenes.length, chapters: 1, unsupported: [], missingGlyphs: [] },
    };
  };
  fn.calls = calls;
  return fn;
}

const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

async function boot() {
  const render = fakeRenderer();
  setInteriorHooks({ renderInterior: render, coverage: { literata: [[0, 255]], inter: [[0, 255]] } });
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  return { t, render };
}

const snapshot = (t, body = {}) => t.member('POST', `${B}/interior/snapshots`, body);
const fingerprint = async (t) => (await t.member('GET', `${B}/interior/fingerprint`)).json.fingerprint;

// ------------------------------------------------------------------------------------------------------------------------------ snapshots and the preview document

test('snapshot lifecycle: create, preview.html, expiry, the latest five of a book', async () => {
  const { t, render } = await boot();
  const made = await snapshot(t);
  assert.equal(made.status, 201, made.text);
  assert.match(made.json.snapshotId, /^snap_[0-9a-f]+$/);
  assert.match(made.json.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(made.json.report.chapters, 1);
  assert.ok(made.json.report.words > 0);
  assert.deepEqual(Object.keys(made.json).sort(), ['fingerprint', 'report', 'snapshotId']);
  // the renderer got the effective layout and the glyph coverage
  assert.equal(render.calls.at(-1).layout.trim, '6x9');
  assert.deepEqual(render.calls.at(-1).options.coverage.literata, [[0, 255]]);

  const page = await t.member('GET', `${B}/interior/snapshots/${made.json.snapshotId}/preview.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['content-security-policy'], CSP);
  assert.equal(PREVIEW_CSP, CSP);
  assert.ok(page.text.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>The Salt Orchard</title><style>'));
  assert.ok(page.text.includes('<script src="/interior-assets/paged.js"></script><script src="/interior-assets/interior-boot.js"></script></head><body>'));
  assert.ok(page.text.endsWith('</body></html>'));
  // no script but the two allowed src tags, and no inline script
  const scripts = [...page.text.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script src="/interior-assets/paged.js">', '<script src="/interior-assets/interior-boot.js">']);
  assert.equal([...page.text.matchAll(/<script\b[^>]*>([^<]*)<\/script>/gi)].every((m) => m[1] === ''), true);
  assert.ok(!/https?:/i.test(page.text), 'no external URL in the document');

  assert.equal((await t.member('GET', `${B}/interior/snapshots/snap_nope/preview.html`)).status, 404);
  assert.equal((await t.member('GET', `/api/books/book_nope/interior/snapshots/${made.json.snapshotId}/preview.html`)).status, 404);
  assert.equal((await snapshot(t, { nonsense: 1 })).status, 400);

  // latest five of the book
  const ids = [made.json.snapshotId];
  for (let i = 0; i < 5; i++) ids.push((await snapshot(t)).json.snapshotId);
  assert.equal((await t.member('GET', `${B}/interior/snapshots/${ids[0]}/preview.html`)).status, 404, 'the oldest of six is forgotten');
  for (const id of ids.slice(1)) assert.equal((await t.member('GET', `${B}/interior/snapshots/${id}/preview.html`)).status, 200);

  // 30 minutes
  const t0 = Date.now();
  interiorSnapshots.setHooks({ now: () => t0 + 31 * 60 * 1000 });
  assert.equal((await t.member('GET', `${B}/interior/snapshots/${ids[5]}/preview.html`)).status, 404, 'expired');
});

test('the preview document: the escaped manuscript text only, the css cannot close its style element', () => {
  const doc = previewDocument({ title: 'A <b>"Book"</b> & more', language: 'en"><script>x</script>', css: 'a{} </style><script>alert(1)</script>', html: '<p>x</p>' });
  assert.ok(doc.includes('<title>A &lt;b&gt;&quot;Book&quot;&lt;/b&gt; &amp; more</title>'));
  assert.ok(doc.startsWith('<!doctype html><html lang="en">'), 'a bad language falls back to en');
  assert.deepEqual([...doc.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]), ['<script src="/interior-assets/paged.js">', '<script src="/interior-assets/interior-boot.js">']);
  assert.equal(doc.split("</style>").length, 2);
});

test('the snapshot manager: injectable clock, per-book limit, other books are not reachable', () => {
  let now = 1000;
  const m = createInteriorSnapshots({ now: () => now, keepMs: 100, perBook: 2 });
  const content = { html: '<p>x</p>', css: '', layout: {}, fingerprint: 'f', report: {} };
  const a = m.add('book_A', content).snapshotId;
  const b = m.add('book_A', content).snapshotId;
  const c = m.add('book_A', content).snapshotId;
  const other = m.add('book_B', content).snapshotId;
  assert.equal(m.get('book_A', a), null);
  assert.ok(m.get('book_A', b) && m.get('book_A', c));
  assert.equal(m.get('book_B', b), null, 'a snapshot of one book is not another book\'s');
  assert.ok(m.get('book_B', other));
  now += 101;
  assert.equal(m.get('book_A', c), null);
  assert.equal(m.get('book_B', other), null);
});

// ------------------------------------------------------------------------------------------------------------------------------ fingerprint

test('fingerprint: equals the snapshot\'s, changes with the text and with the layout, a given layout is checked and not saved', async () => {
  const { t } = await boot();
  const made = await snapshot(t);
  const first = await fingerprint(t);
  assert.equal(first, made.json.fingerprint);
  assert.equal(await fingerprint(t), first, 'stable');

  // a given layout: validated, rendered, not saved
  const other = await snapshot(t, { layout: { fontSize: 13, trim: '5.5x8.5' } });
  assert.equal(other.status, 201, other.text);
  assert.notEqual(other.json.fingerprint, first);
  assert.equal(await fingerprint(t), first, 'the book itself did not change');
  const prefs = await t.member('GET', `/api/preferences?book=${BOOK}`);
  assert.equal(prefs.json.effective.interior.fontSize, 11);
  assert.equal((await snapshot(t, { layout: { fontSize: 99 } })).status, 400);
  assert.match((await snapshot(t, { layout: { fontSize: 99 } })).json.message, /fontSize/);
  assert.equal((await snapshot(t, { layout: [] })).status, 400);
  assert.equal((await snapshot(t, { layout: { nope: 1 } })).status, 400);

  // the layout route changes it
  assert.equal((await t.member('POST', `${B}/interior/layout`, { fontSize: 12 })).status, 200);
  const afterLayout = await fingerprint(t);
  assert.notEqual(afterLayout, first);
  // the text changes it
  const scene = (await t.member('GET', `${B}/scenes/${SCENE}`)).json;
  const put = await t.member('PUT', `${B}/scenes/${SCENE}/body`, { body: `${scene.body ?? ''}\n\nA new paragraph.\n`, base_sha256: scene.sha256 });
  assert.equal(put.status, 200, put.text);
  assert.notEqual(await fingerprint(t), afterLayout);
  assert.equal((await t.member('GET', '/api/books/book_nope/interior/fingerprint')).status, 404);
  assert.equal((await t.member('POST', '/api/books/book_nope/interior/snapshots', {})).status, 404);
});

// ------------------------------------------------------------------------------------------------------------------------------ layout route

test('POST interior/layout: shallow merge written to book.md, unchanged, refusals', async () => {
  const { t } = await boot();
  const r = await t.member('POST', `${B}/interior/layout`, { fontSize: 12, margins: { inside: 0.9, outside: 0.5, top: 0.6, bottom: 0.6 }, frontMatter: { copyright: 'Mine', dedication: '' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.interior.version, 1);
  assert.equal(r.json.interior.fontSize, 12);
  assert.equal(r.json.unchanged, undefined);
  const text = await fs.readFile(path.join(t.root, 'book.md'), 'utf8');
  assert.match(text, /interior:\n {4}version: 1\n {4}fontSize: 12/);
  const eff = (await t.member('GET', `/api/preferences?book=${BOOK}`)).json.effective.interior;
  assert.equal(eff.fontSize, 12);
  assert.equal(eff.margins.inside, 0.9);
  assert.equal(eff.font, 'literata', 'the other keys keep their defaults');
  const again = await t.member('POST', `${B}/interior/layout`, { fontSize: 12 });
  assert.equal(again.status, 200);
  assert.equal(again.json.unchanged, true);
  const replaced = await t.member('POST', `${B}/interior/layout`, { frontMatter: { dedication: 'For R.' } });
  assert.deepEqual(replaced.json.interior.frontMatter, { dedication: 'For R.' }, 'frontMatter replaces as a whole');
  assert.equal(replaced.json.interior.fontSize, 12);

  const before = await fs.readFile(path.join(t.root, 'book.md'));
  for (const bad of [{ fontSize: 15 }, { lineHeight: 3 }, { trim: 'a4' }, { margins: { inside: 9 } }, { version: 2 }, { frontMatter: { copyright: 'x'.repeat(2001) } }]) {
    const x = await t.member('POST', `${B}/interior/layout`, bad);
    assert.equal(x.status, 400, JSON.stringify(bad));
    assert.equal(x.json.code, 'BAD_ARGS');
  }
  assert.equal((await t.member('POST', `${B}/interior/layout`, { nonsense: 1 })).status, 400);
  assert.equal((await t.member('POST', `${B}/interior/layout`, {})).status, 400);
  assert.equal((await t.member('POST', '/api/books/book_nope/interior/layout', { fontSize: 12 })).status, 404);
  assert.deepEqual(await fs.readFile(path.join(t.root, 'book.md')), before, 'refusals wrote nothing');
});

// ------------------------------------------------------------------------------------------------------------------------------ the real renderer, when this build has it

test('the real renderer: a snapshot of the sample book lays out and is deterministic', { skip: typeof exportPackage.renderInterior !== 'function' }, async () => {
  setInteriorHooks({});
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  const a = await snapshot(t);
  assert.equal(a.status, 201, a.text);
  assert.equal(a.json.fingerprint, await fingerprint(t));
  assert.equal((await snapshot(t)).json.fingerprint, a.json.fingerprint);
  const page = await t.member('GET', `${B}/interior/snapshots/${a.json.snapshotId}/preview.html`);
  assert.equal(page.headers['content-security-policy'], CSP);
  assert.deepEqual([...page.text.matchAll(/<script\b[^>]*>/gi)].length, 2);
});

// ------------------------------------------------------------------------------------------------------------------------------ /interior-assets/

const FONT_FILES = ['literata', 'inter'].flatMap((f) => ['latin', 'latin-ext'].flatMap((s) => ['normal', 'italic'].map((st) => `${f}-${s}-wght-${st}.woff2`)));

test('/interior-assets/: only the allow-list resolves, with the right type and headers', async () => {
  const t = await bootPersonal({ fixture: 'valid/salt-orchard' });
  const listed = exportPackage.INTERIOR_FONT_FILES ?? FONT_FILES;
  for (const name of FONT_FILES) assert.ok(listed.includes(name), `${name} is in the font list`);
  for (const name of ['paged.js', 'interior-boot.js']) {
    const r = await raw(t.port, 'GET', `/interior-assets/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.bytes.length > 100);
  }
  assert.match((await raw(t.port, 'GET', '/interior-assets/paged.js')).text, /Previewer/);
  for (const name of listed) {
    const r = await raw(t.port, 'GET', `/interior-assets/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers['content-type'], 'font/woff2');
    assert.equal(r.headers['cache-control'], 'no-cache');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.bytes.subarray(0, 4).toString('latin1'), 'wOF2');
  }
  const refused = [
    '/interior-assets/', '/interior-assets', '/interior-assets/package.json', '/interior-assets/paged.min.js', '/interior-assets/paged.polyfill.js', '/interior-assets/wght.css',
    '/interior-assets/literata-cyrillic-wght-normal.woff2', '/interior-assets/paged.js/', '/interior-assets/PAGED.JS', '/interior-assets/paged.js%00', '/interior-assets/__proto__', '/interior-assets/constructor',
    '/interior-assets/../package.json', '/interior-assets/..%2fpackage.json', '/interior-assets/%2e%2e/package.json', '/interior-assets/%2e%2e%2f%2e%2e%2fpackage.json',
    '/interior-assets/..%5cpackage.json', '/interior-assets/sub%2fpaged.js', '/interior-assets//paged.js', '/interior-assets/%2Fetc%2Fpasswd', '/interior-assets/C:/Windows/win.ini',
    '/interior-assets/C%3A%5CWindows%5Cwin.ini', '/interior-assets/%E0%A4%A', `/interior-assets/${FONT_FILES[0]}/../paged.js`,
  ];
  for (const p of refused) {
    const r = await raw(t.port, 'GET', p);
    assert.equal(r.status, 404, p);
    assert.ok(!/Previewer|wOF2/.test(r.text), p);
  }
});

test('the allow-list table: fixed names, every file exists, nothing else', async () => {
  const table = interiorAssetTable(FONT_FILES);
  assert.deepEqual([...table.keys()].sort(), ['interior-boot.js', 'paged.js', ...FONT_FILES].sort());
  for (const [name, { file }] of table) assert.ok((await fs.stat(file)).isFile(), name);
  // a font name that is not a plain woff2 of one of the two packages is dropped
  assert.deepEqual([...interiorAssetTable(['../x.woff2', 'literata-latin-wght-normal.woff2/..', 'other-latin.woff2']).keys()].sort(), ['interior-boot.js', 'paged.js']);
});

// ------------------------------------------------------------------------------------------------------------------------------ the boot script

test('the boot script has no network, eval or imports', async () => {
  const src = await fs.readFile(path.join(here, '../assets/interior/interior-boot.js'), 'utf8');
  for (const re of [/\bfetch\b/, /XMLHttpRequest/, /https?:/i, /\beval\b/, /new\s+Function/, /\bimport\b/, /importScripts/, /WebSocket/, /sendBeacon/, /EventSource/, /\bFunction\s*\(/]) assert.doesNotMatch(src, re, String(re));
  assert.match(src, /storyforgeInterior/);
  assert.match(src, /storyforge-interior/);
  assert.match(src, /location\.origin/);
  assert.match(src, /new Paged\.Previewer\(\)\.preview\(/);
});

async function loadCheck() {
  const src = await fs.readFile(path.join(here, '../assets/interior/interior-boot.js'), 'utf8');
  const sandbox = {};
  vm.runInNewContext(src, sandbox);
  return sandbox.StoryforgeInteriorCheck;
}
const rect = (top, height = 14, left = 0, width = 50) => ({ top, bottom: top + height, left, right: left + width, width, height });

test('the boot script counts line boxes, not rects', async () => {
  const { countLines } = await loadCheck();
  assert.equal(countLines([rect(100)]), 1);
  assert.equal(countLines([rect(100), rect(114), rect(128)]), 3);
  assert.equal(countLines([rect(128), rect(100), rect(114)]), 3, 'order does not matter');
  // text, an inline element and more text on the same line: slightly different tops and heights
  assert.equal(countLines([rect(100, 14, 0, 200), rect(101, 12, 200, 30), rect(100, 14, 230, 100), rect(114, 14, 0, 80), rect(115, 12, 80, 20)]), 2);
  // zero-width and zero-height rects are ignored
  assert.equal(countLines([rect(100), rect(114, 14, 0, 0), rect(300, 0, 0, 10)]), 1);
  assert.equal(countLines([rect(100, 14, 0, 0)]), 0);
  assert.equal(countLines([]), 0);
});

test('the boot script flags a widow or orphan only for a split paragraph of one line', async () => {
  const { edgeProblems } = await loadCheck();
  const p = (continuesFrom, continuesOnto, lines) => ({ paragraph: true, continuesFrom, continuesOnto, lines });
  assert.deepEqual([...edgeProblems(p(true, false, 1), p(false, true, 1))], ['widow', 'orphan']);
  assert.deepEqual([...edgeProblems(p(true, false, 4), p(false, true, 5))], []);
  assert.deepEqual([...edgeProblems(p(false, false, 1), p(false, false, 1))], [], 'not split is never a widow or an orphan');
  assert.deepEqual([...edgeProblems(p(false, true, 1), p(true, false, 1))], [], 'the start of a split paragraph is no widow, its end no orphan');
  assert.deepEqual([...edgeProblems({ paragraph: false, continuesFrom: true, continuesOnto: true, lines: 1 }, null)], []);
  assert.deepEqual([...edgeProblems(null, null)], []);
});

// ------------------------------------------------------------------------------------------------------------------------------ policy

test('policy: the routes are classed, the reads are never shareable, a viewer may preview', () => {
  assert.equal(matchWriteRoute('POST', `${B}/interior/layout`)?.route, 'interior-layout');
  assert.equal(matchWriteRoute('POST', `${B}/interior/snapshots`)?.route, 'interior-snapshot');
  assert.equal(matchWriteRoute('GET', `${B}/interior/layout`)?.route ?? null, null);
  assert.equal(matchWriteRoute('DELETE', `${B}/interior/snapshots`), null);
  assert.equal(matchWriteRoute('POST', `${B}/interior/other`), null);
  assert.equal(WRITE_CLASSES['interior-layout'], 'write');
  assert.equal(WRITE_CLASSES['interior-snapshot'], 'read');
  for (const p of [`${B}/interior/fingerprint`, `${B}/interior/snapshots/snap_X/preview.html`]) {
    assert.deepEqual(classifyRead(p), { cls: 'read', book: BOOK, shareable: false }, p);
  }
  const user = (role) => ({ kind: 'user', id: 'usr_X', username: 'x', display_name: 'X', role });
  const share = { kind: 'share', id: 'shr_X', book: BOOK, scope: ['read'] };
  const read = classifyRead(`${B}/interior/fingerprint`);
  assert.equal(allowed(user('viewer'), 'read', read), true);
  assert.equal(allowed(user('viewer'), WRITE_CLASSES['interior-snapshot'], { book: BOOK }), true);
  assert.equal(allowed(user('viewer'), WRITE_CLASSES['interior-layout'], { book: BOOK }), false);
  assert.equal(allowed(user('editor'), WRITE_CLASSES['interior-layout'], { book: BOOK }), true);
  assert.equal(allowed(share, 'read', read), false, 'never a share link');
});
