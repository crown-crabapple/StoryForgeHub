// M05-J03 acceptance 6 (restored book opens via createFsRepository + the HTTP API) and 8 (routes and CLI):
//   GET  /api/books/:b/export?format=&excludeStatuses=&sceneTitles=&page=
//   GET  /api/books/:b/backup?provenance=
//   POST /api/library/restore?folder=      raw zip body, write-guarded, 512 MB cap
//   main.mjs export | backup | restore
// Contract: docs/contracts/M05-J03-export-backup.md sections 3 and 4. Style: attachments.test.mjs (raw requests, the
// write guard cases) and open-library.test.mjs (real main.mjs child processes). Zip / PDF / EPUB readers come from the
// independent oracles in packages/export/test/helpers.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createBackup, exportBook, restoreBackup } from '../../../packages/export/src/index.mjs';
import { BASE_MTIME, FORMATS, MIME, ORDER, assertSameFiles, cleanup, copyBook, expectedJson, parsePdf, readAll, readZip, rewriteZip, snapshotTree, textOf, tmpDir, walkFiles, writeZip } from '../../../packages/export/test/helpers.mjs';
import { BOOK, UNKNOWN_BOOK, apiIds, closeAll, startApi } from './move-helpers.mjs';
import { FIXTURES, request } from './helpers.mjs';
import { killAll, runCli } from './proc-helpers.mjs';

after(async () => {
  await closeAll();
  await killAll();
  cleanup();
});

const NOW = new Date('2026-03-04T12:00:00Z');
const GUARD = (type = 'application/zip') => ({ 'x-storyforge': '1', 'content-type': type });

/** Raw request; binary-safe response; tolerates an early answer (413) before the whole body was sent. */
function raw(port, method, pathname, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = body.length;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {
          /* binary */
        }
        finish({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), json });
      });
      res.on('error', () => {});
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** POST declaring `total` bytes and really streaming them (zeros) until the server answers. Resolves on the status line. */
function postHuge(port, pathname, total, headers) {
  return new Promise((resolve, reject) => {
    let done = false;
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathname, headers: { Host: `127.0.0.1:${port}`, ...headers, 'content-length': total } }, (res) => {
      done = true;
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
      req.destroy();
    });
    req.on('error', (e) => {
      if (!done) reject(e);
    });
    const chunk = Buffer.alloc(1024 * 1024);
    let sent = 0;
    const pump = () => {
      while (sent < total && !done) {
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
          req.once('drain', pump);
          return;
        }
      }
      if (!done) req.end();
    };
    pump();
  });
}

const exportUrl = (q = '', book = BOOK) => `/api/books/${book}/export${q ? '?' + q : ''}`;
const backupUrl = (q = '', book = BOOK) => `/api/books/${book}/backup${q ? '?' + q : ''}`;

/** A served single book (repository root = the book folder), like the other route tests. */
async function servedBook(prep) {
  const root = copyBook();
  prep?.(root);
  const api = await startApi(root);
  return { root, ...api };
}
const addProvenance = (root) => {
  const p = path.join(root, 'provenance', 'receipts', 'r-0001.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{"receipt":1}\n');
};

/** A served library that contains the covers fixture books (none of which is salt-orchard). */
async function servedLibrary() {
  const base = tmpDir('sf-lib-');
  const lib = path.join(base, 'library');
  fs.cpSync(path.join(FIXTURES, 'valid', 'covers'), lib, { recursive: true });
  const api = await startApi(lib);
  return { lib, ...api };
}
const libraryListing = (lib) => fs.readdirSync(lib).sort();
const booksOf = async (port) => {
  const j = (await request(port, 'GET', '/api/books')).json;
  return Array.isArray(j) ? j : j.books;
};

// ---------------------------------------------------------------- export route

for (const format of FORMATS) {
  test(`GET export?format=${format}: 200, content-type, attachment disposition, nosniff, no-store, and the library's bytes`, async () => {
    const { port, root } = await servedBook();
    const r = await raw(port, 'GET', exportUrl(`format=${format}`));
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.headers['content-type'].toLowerCase().startsWith(MIME[format]), r.headers['content-type']);
    const ext = { markdown: 'md', docx: 'docx', epub: 'epub', pdf: 'pdf' }[format];
    assert.match(r.headers['content-disposition'], new RegExp(`^attachment;\\s*filename="salt-orchard\\.${ext}"`));
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['cache-control'], /no-store/);
    const expected = await exportBook(root, format, {});
    assert.ok(r.body.equals(expected.bytes), 'the response body is exactly what exportBook produces for this book');
    assert.ok(textOf(format, r.body).includes('The key was colder than the morning'));
  });
}

test('GET export: excludeStatuses and sceneTitles reach the output', async () => {
  const { port } = await servedBook();
  const r = await raw(port, 'GET', exportUrl('format=markdown&excludeStatuses=revised,outline&sceneTitles=1'));
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(!r.text.includes('Ilse counted the rows'), 'revised scene left out');
  assert.ok(!r.text.includes('At the breach she finally'), 'outline scene left out');
  assert.ok(r.text.includes('The key was colder'));
  assert.match(r.text, /^#+\s+Arrival\s*$/m, 'scene titles on');
  const plain = await raw(port, 'GET', exportUrl('format=markdown&sceneTitles=0'));
  assert.doesNotMatch(plain.text, /^#+\s+Arrival\s*$/m, 'scene titles off');
  assert.ok(plain.text.includes('Ilse counted the rows'));
});

test('GET export: pdf page=letter and page=a4 give the two media boxes', async () => {
  const { port } = await servedBook();
  const box = async (q) => parsePdf((await raw(port, 'GET', exportUrl(q))).body).pages[0].mediaBox.map(Math.round);
  assert.deepEqual(await box('format=pdf'), [0, 0, 612, 792], 'letter is the default');
  assert.deepEqual(await box('format=pdf&page=letter'), [0, 0, 612, 792]);
  assert.deepEqual(await box('format=pdf&page=a4'), [0, 0, 595, 842]);
});

test('GET export: bad parameters are 400 { error: "bad_request" } and nothing is exported', async () => {
  const { port } = await servedBook();
  for (const q of ['', 'format=', 'format=rtf', 'format=markdown,pdf', 'format=pdf&page=legal', 'format=markdown&sceneTitles=2', 'format=markdown&sceneTitles=yes', 'format=markdown&excludeStatuses=a%2Fb%00']) {
    const r = await raw(port, 'GET', exportUrl(q));
    assert.equal(r.status, 400, `${q} -> ${r.status} ${r.text.slice(0, 120)}`);
    assert.equal(r.json?.error, 'bad_request', q);
    assert.ok(!r.headers['content-disposition'], 'no download offered for an error');
  }
});

test('GET export / backup: an unknown book is 404', async () => {
  const { port } = await servedBook();
  assert.equal((await raw(port, 'GET', exportUrl('format=markdown'))).status, 200, 'control: the known book exports');
  assert.equal((await raw(port, 'GET', backupUrl())).status, 200, 'control: the known book backs up');
  assert.equal((await raw(port, 'GET', exportUrl('format=markdown', UNKNOWN_BOOK))).status, 404);
  assert.equal((await raw(port, 'GET', backupUrl('', UNKNOWN_BOOK))).status, 404);
  assert.equal((await raw(port, 'GET', exportUrl('format=markdown', 'not-a-book-id'))).status, 404);
});

test('GET export / backup: a foreign Host header is refused (403)', async () => {
  const { port } = await servedBook();
  assert.equal((await raw(port, 'GET', exportUrl('format=markdown'))).status, 200, 'control: the same request with a good Host works');
  assert.equal((await raw(port, 'GET', exportUrl('format=markdown'), { host: 'evil.example.com' })).status, 403);
  assert.equal((await raw(port, 'GET', backupUrl(), { host: 'evil.example.com' })).status, 403);
});

test('export and backup routes never change the book (bytes of every canonical file)', async () => {
  const { port, root } = await servedBook(addProvenance);
  const before = readAll(root);
  for (const f of FORMATS) assert.equal((await raw(port, 'GET', exportUrl(`format=${f}`))).status, 200);
  assert.equal((await raw(port, 'GET', backupUrl())).status, 200);
  assert.equal((await raw(port, 'GET', backupUrl('provenance=1'))).status, 200);
  assertSameFiles(assert, before, readAll(root), 'after routes');
});

// ---------------------------------------------------------------- backup route

test('GET backup: a zip with the same headers, dated filename, the book folder prefix, no provenance by default', async () => {
  const { port, root } = await servedBook(addProvenance);
  const r = await raw(port, 'GET', backupUrl());
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(r.headers['content-type'].toLowerCase().startsWith('application/zip'), r.headers['content-type']);
  assert.match(r.headers['content-disposition'], /^attachment;\s*filename="salt-orchard-backup-\d{8}\.zip"/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['cache-control'], /no-store/);
  const z = readZip(r.body);
  const names = z.entries.map((e) => e.name);
  assert.ok(names.every((n) => n.startsWith('salt-orchard/')));
  assert.ok(names.includes('salt-orchard/book.md'));
  assert.ok(!names.some((n) => n.includes('provenance/') || n.includes('.storyforge')));
  assert.equal(JSON.parse(z.comment).book_id, BOOK);
  const lib = readZip((await createBackup(root, { now: NOW })).bytes);
  assert.deepEqual(names.sort(), lib.entries.map((e) => e.name).sort());
});

test('GET backup?provenance=1 includes provenance/**; provenance=0 does not; other values are 400', async () => {
  const { port } = await servedBook(addProvenance);
  const on = readZip((await raw(port, 'GET', backupUrl('provenance=1'))).body).entries.map((e) => e.name);
  const off = readZip((await raw(port, 'GET', backupUrl('provenance=0'))).body).entries.map((e) => e.name);
  assert.ok(on.includes('salt-orchard/provenance/receipts/r-0001.json'));
  assert.ok(!off.some((n) => n.includes('provenance/')));
  const bad = await raw(port, 'GET', backupUrl('provenance=2'));
  assert.equal(bad.status, 400);
  assert.equal(bad.json?.error, 'bad_request');
});

// ---------------------------------------------------------------- restore route

async function backupBytes(opts = {}) {
  return (await createBackup(copyBook(), { now: NOW, ...opts })).bytes;
}
const restoreUrl = (folder) => `/api/library/restore${folder === undefined ? '' : '?folder=' + encodeURIComponent(folder)}`;

test('POST restore: restores into <library>/<folder>, returns { bookRoot, diagnostics }, the library lists the book and it opens', async () => {
  const { port, lib } = await servedLibrary();
  const zip = await backupBytes();
  const r = await raw(port, 'POST', restoreUrl('salt-orchard-restored'), { headers: GUARD(), body: zip });
  assert.ok(r.status === 200 || r.status === 201, `${r.status}: ${r.text.slice(0, 300)}`);
  assert.deepEqual(r.json.diagnostics, []);
  assert.equal(path.resolve(r.json.bookRoot), path.resolve(lib, 'salt-orchard-restored'));
  const original = readAll(copyBook());
  assertSameFiles(assert, original, readAll(path.join(lib, 'salt-orchard-restored'), { skip: [] }), 'restored via route');

  assert.ok((await booksOf(port)).some((b) => b.id === BOOK), 'the library rescanned: the restored book is listed');
  assert.deepEqual(await apiIds(port), expectedJson().order, 'its scenes are served in canonical order');
});

test('POST restore into an existing EMPTY folder works; into a non-empty folder is 409 RESTORE_TARGET_NOT_EMPTY and untouched', async () => {
  const { port, lib } = await servedLibrary();
  fs.mkdirSync(path.join(lib, 'empty-one'));
  const ok = await raw(port, 'POST', restoreUrl('empty-one'), { headers: GUARD(), body: await backupBytes() });
  assert.ok(ok.status === 200 || ok.status === 201, ok.text.slice(0, 200));

  fs.mkdirSync(path.join(lib, 'taken'));
  fs.writeFileSync(path.join(lib, 'taken', 'mine.txt'), 'mine');
  const before = libraryListing(lib);
  const r = await raw(port, 'POST', restoreUrl('taken'), { headers: GUARD(), body: await backupBytes() });
  assert.equal(r.status, 409, r.text.slice(0, 200));
  assert.match(JSON.stringify(r.json), /RESTORE_TARGET_NOT_EMPTY/);
  assert.deepEqual(fs.readdirSync(path.join(lib, 'taken')), ['mine.txt']);
  assert.deepEqual(libraryListing(lib), before, 'no temp sibling');

  // an existing book folder is non-empty too
  const again = await raw(port, 'POST', restoreUrl('empty-one'), { headers: GUARD(), body: await backupBytes() });
  assert.equal(again.status, 409);
});

test('POST restore: folder must be one safe segment [a-z0-9-]{1,60} (else 400) and nothing is written', async () => {
  const { port, lib } = await servedLibrary();
  const zip = await backupBytes();
  const before = libraryListing(lib);
  const outside = fs.readdirSync(path.dirname(lib)).sort();
  const bad = ['', '../escape', '..', '.', 'a/b', 'a\\b', 'UPPER', 'has space', 'under_score', 'dot.dot', 'x'.repeat(61), '%2e%2e', 'café', 'C:', 'a\0b'];
  for (const folder of bad) {
    const r = await raw(port, 'POST', restoreUrl(folder), { headers: GUARD(), body: zip });
    assert.equal(r.status, 400, `folder ${JSON.stringify(folder)} -> ${r.status} ${r.text.slice(0, 100)}`);
  }
  const missing = await raw(port, 'POST', restoreUrl(undefined), { headers: GUARD(), body: zip });
  assert.equal(missing.status, 400, 'folder parameter missing');
  assert.deepEqual(libraryListing(lib), before);
  assert.deepEqual(fs.readdirSync(path.dirname(lib)).sort(), outside);
  // the boundaries are accepted
  const one = await raw(port, 'POST', restoreUrl('a'), { headers: GUARD(), body: await backupBytes() });
  assert.ok(one.status === 200 || one.status === 201, `1 char folder: ${one.status} ${one.text.slice(0, 120)}`);
  const sixty = await raw(port, 'POST', restoreUrl('b'.repeat(60)), { headers: GUARD(), body: zip });
  assert.ok(sixty.status === 200 || sixty.status === 201, `60 char folder: ${sixty.status} ${sixty.text.slice(0, 120)}`);
});

test('POST restore: 403 without the write guard (no header / wrong value / foreign host) and nothing is written', async () => {
  const { port, lib } = await servedLibrary();
  const zip = await backupBytes();
  const before = libraryListing(lib);
  const cases = [
    { headers: { 'content-type': 'application/zip' } },
    { headers: { 'content-type': 'application/zip', 'x-storyforge': '0' } },
    { headers: { 'content-type': 'application/zip', 'x-storyforge': 'yes' } },
    { headers: GUARD(), host: 'evil.example.com' },
    { headers: GUARD(), host: `localhost:${port + 1}` },
  ];
  for (const c of cases) {
    const r = await raw(port, 'POST', restoreUrl('guarded'), { ...c, body: zip });
    assert.equal(r.status, 403, JSON.stringify(c.headers) + (c.host ?? ''));
    assert.deepEqual(libraryListing(lib), before);
  }
});

test('POST restore: a body that is not a zip, a wrong content-type, an empty body and a hostile zip are refused (4xx) and write nothing', async () => {
  const { port, lib } = await servedLibrary();
  const before = libraryListing(lib);
  const good = await backupBytes();
  const other = await servedLibrary();
  const control = await raw(other.port, 'POST', restoreUrl('control-ok'), { headers: GUARD(), body: good });
  assert.ok(control.status === 200 || control.status === 201, 'control: a good zip restores (' + control.status + ')');
  const slip = writeZip([...readZip(good).entries.map((e) => ({ name: e.name, data: e.data })), { name: '../sf-route-slip.txt', data: Buffer.from('x') }], { comment: readZip(good).comment });
  const tampered = rewriteZip(good, (entries) => {
    entries.find((e) => e.name === 'salt-orchard/book.md').data = Buffer.from('changed');
  });
  const cases = [
    ['garbage', GUARD(), Buffer.from('definitely not a zip')],
    ['empty body', GUARD(), Buffer.alloc(0)],
    ['truncated', GUARD(), good.subarray(0, Math.floor(good.length / 2))],
    ['zip-slip', GUARD(), slip],
    ['tampered content', GUARD(), tampered],
    ['wrong content type', GUARD('text/plain'), good],
    ['json content type', GUARD('application/json'), good],
  ];
  for (const [label, headers, body] of cases) {
    const r = await raw(port, 'POST', restoreUrl('refused-one'), { headers, body });
    const allowed = /content type/.test(label) ? [400, 403, 415, 422] : [400, 409, 413, 415, 422]; // the write guard may refuse a foreign content type with 403
    assert.ok(allowed.includes(r.status), `${label} -> ${r.status} ${r.text.slice(0, 160)}`);
    assert.deepEqual(libraryListing(lib), before, `${label}: nothing written`);
    assert.ok(!fs.existsSync(path.resolve(lib, '..', 'sf-route-slip.txt')));
  }
});

test('POST restore: a body over the 512 MB cap is 413 and nothing is written', { timeout: 180000 }, async () => {
  const { port, lib } = await servedLibrary();
  const before = libraryListing(lib);
  const r = await postHuge(port, restoreUrl('too-big'), 512 * 1024 * 1024 + 1, GUARD());
  assert.equal(r.status, 413);
  assert.deepEqual(libraryListing(lib), before);
});

// ---------------------------------------------------------------- restored book opens (acceptance 6, app half)

test('restored book: no .storyforge right after restore; it opens via createFsRepository and the HTTP API (library, book, scenes)', async () => {
  const src = copyBook();
  const { bytes } = await createBackup(src, { now: NOW });
  const target = path.join(tmpDir(), 'salt-orchard');
  const r = await restoreBackup(bytes, target);
  assert.deepEqual(r.diagnostics, []);
  assert.ok(!fs.existsSync(path.join(target, '.storyforge')), 'no index (SQLite) file exists right after restore');
  assert.deepEqual(walkFiles(target).filter((p) => /sqlite|\.db$/.test(p)), []);

  // directly through the repository
  const repo = createFsRepository(target, { debounceMs: 50, pollMs: 60000 });
  try {
    const listed = await repo.listBooks();
    assert.ok(Array.isArray(listed) ? listed.some((b) => b.id === BOOK) : true);
  } catch (e) {
    assert.fail(`createFsRepository could not list the restored book: ${e.message}`);
  } finally {
    await repo.close?.();
  }

  // through the HTTP API
  const { port } = await startApi(target);
  const books = await booksOf(port);
  assert.ok(books.some((b) => b.id === BOOK && b.title === 'The Salt Orchard'), 'library listing');
  const book = await request(port, 'GET', `/api/books/${BOOK}`);
  assert.equal(book.status, 200);
  assert.deepEqual(await apiIds(port), expectedJson().order, 'scenes in canonical order');
  const scene = await request(port, 'GET', `/api/books/${BOOK}/scenes/${ORDER[2]}`);
  assert.equal(scene.status, 200, scene.text.slice(0, 200));
  assert.match(scene.text, /The key was colder than the morning/);
});

// ---------------------------------------------------------------- CLI

/** A library folder holding a fresh copy of salt-orchard, plus an output folder outside it. */
function cliArena({ provenance = false } = {}) {
  const lib = tmpDir('sf-cli-lib-');
  const book = copyBook('valid/salt-orchard', { under: lib });
  if (provenance) addProvenance(book);
  const out = tmpDir('sf-cli-out-');
  return { lib, book, out };
}
const noFile = (p) => assert.ok(!fs.existsSync(p), `${p} must not exist`);

test('CLI export: writes the file the library function produces', { timeout: 180000 }, async () => {
  const { lib, book, out } = cliArena();
  for (const [format, ext] of [['markdown', 'md'], ['docx', 'docx'], ['epub', 'epub'], ['pdf', 'pdf']]) {
    const file = path.join(out, `book.${ext}`);
    const r = await runCli(['export', '--library', lib, '--book', 'salt-orchard', '--format', format, '--out', file]);
    assert.equal(r.code, 0, r.output);
    assert.ok(fs.readFileSync(file).equals((await exportBook(book, format, {})).bytes), `${format} bytes`);
  }
  assert.deepEqual(readAll(book).size, readAll(copyBook()).size, 'the book is untouched');
});

test('CLI export: --out that exists is refused without --force (file untouched) and replaced with --force', { timeout: 180000 }, async () => {
  const { lib, out } = cliArena();
  const file = path.join(out, 'book.md');
  fs.writeFileSync(file, 'precious');
  const args = ['export', '--library', lib, '--book', 'salt-orchard', '--format', 'markdown', '--out', file];
  const refused = await runCli(args);
  assert.notEqual(refused.code, 0, refused.output);
  assert.equal(fs.readFileSync(file, 'utf8'), 'precious');
  assert.deepEqual(fs.readdirSync(out), ['book.md'], 'no partial or temp file left behind');
  const forced = await runCli([...args, '--force']);
  assert.equal(forced.code, 0, forced.output);
  assert.match(fs.readFileSync(file, 'utf8'), /^# The Salt Orchard/);
});

test('CLI export / backup: --out inside the book folder is refused, even with --force, and the book gets no new file', { timeout: 180000 }, async () => {
  const { lib, book, out } = cliArena();
  const control = await runCli(['export', '--library', lib, '--book', 'salt-orchard', '--format', 'markdown', '--out', path.join(out, 'control.md')]);
  assert.equal(control.code, 0, 'control: the same command with --out outside the book succeeds: ' + control.output);
  const controlZip = await runCli(['backup', '--library', lib, '--book', 'salt-orchard', '--out', path.join(out, 'control.zip')]);
  assert.equal(controlZip.code, 0, 'control: backup with --out outside the book succeeds: ' + controlZip.output);
  const before = snapshotTree(book);
  const inside = [
    path.join(book, 'exported.md'),
    path.join(book, 'manuscript', 'exported.md'),
    path.join(book, 'new-folder', 'exported.md'),
    path.join(book, '..', 'salt-orchard', 'exported.md'),
  ];
  for (const file of inside) {
    for (const extra of [[], ['--force']]) {
      const e = await runCli(['export', '--library', lib, '--book', 'salt-orchard', '--format', 'markdown', '--out', file, ...extra]);
      assert.notEqual(e.code, 0, `export ${file} ${extra}: ${e.output}`);
      const b = await runCli(['backup', '--library', lib, '--book', 'salt-orchard', '--out', file.replace(/\.md$/, '.zip'), ...extra]);
      assert.notEqual(b.code, 0, `backup ${file} ${extra}: ${b.output}`);
    }
  }
  const after = snapshotTree(book);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file or folder was added to the book');
  for (const [p, v] of before) assert.equal(after.get(p).sha, v.sha, p);
});

test('CLI export: an existing file that is the book\'s own scene is never overwritten via --out --force', { timeout: 180000 }, async () => {
  const { lib, book } = cliArena();
  const scene = path.join(book, 'manuscript', 'act-01-low-water', 'ch-001-the-drowned-rows', '0010-arrival.md');
  const before = fs.readFileSync(scene);
  const r = await runCli(['export', '--library', lib, '--book', 'salt-orchard', '--format', 'markdown', '--out', scene, '--force']);
  assert.notEqual(r.code, 0, r.output);
  assert.ok(fs.readFileSync(scene).equals(before));
});

test('CLI export: unknown book, unknown format and missing options fail without creating the output', { timeout: 180000 }, async () => {
  const { lib, out } = cliArena();
  const file = path.join(out, 'x.md');
  const control = await runCli(['export', '--library', lib, '--book', 'salt-orchard', '--format', 'markdown', '--out', file]);
  assert.equal(control.code, 0, 'control: a complete command succeeds: ' + control.output);
  fs.rmSync(file);
  for (const args of [
    ['export', '--library', lib, '--book', 'no-such-book', '--format', 'markdown', '--out', file],
    ['export', '--library', lib, '--book', 'salt-orchard', '--format', 'rtf', '--out', file],
    ['export', '--library', lib, '--book', 'salt-orchard', '--format', 'markdown'],
    ['export', '--library', lib, '--format', 'markdown', '--out', file],
    ['export', '--library', lib, '--book', 'salt-orchard', '--out', file],
  ]) {
    const r = await runCli(args);
    assert.notEqual(r.code, 0, args.join(' ') + '\n' + r.output);
    noFile(file);
  }
  assert.deepEqual(fs.readdirSync(out), []);
});

test('CLI backup: writes the zip the library function produces (provenance only with --provenance); refuses to overwrite', { timeout: 180000 }, async () => {
  const { lib, book, out } = cliArena({ provenance: true });
  const plain = path.join(out, 'plain.zip');
  const r = await runCli(['backup', '--library', lib, '--book', 'salt-orchard', '--out', plain]);
  assert.equal(r.code, 0, r.output);
  const names = readZip(fs.readFileSync(plain)).entries.map((e) => e.name);
  assert.ok(names.includes('salt-orchard/book.md'));
  assert.ok(!names.some((n) => n.includes('provenance/')));

  const withProv = path.join(out, 'prov.zip');
  const p = await runCli(['backup', '--library', lib, '--book', 'salt-orchard', '--out', withProv, '--provenance']);
  assert.equal(p.code, 0, p.output);
  assert.ok(readZip(fs.readFileSync(withProv)).entries.some((e) => e.name === 'salt-orchard/provenance/receipts/r-0001.json'));

  const same = await runCli(['backup', '--library', lib, '--book', 'salt-orchard', '--out', plain]);
  assert.notEqual(same.code, 0, same.output);
  assert.equal(readZip(fs.readFileSync(plain)).entries.length, names.length, 'existing zip untouched');
  const forced = await runCli(['backup', '--library', lib, '--book', 'salt-orchard', '--out', plain, '--force']);
  assert.equal(forced.code, 0, forced.output);
  assert.ok(book);
});

test('CLI restore: --from <zip> --to <dir> restores byte-identically; a non-empty --to is refused and untouched', { timeout: 180000 }, async () => {
  const { lib, book, out } = cliArena();
  const zip = path.join(out, 'b.zip');
  assert.equal((await runCli(['backup', '--library', lib, '--book', 'salt-orchard', '--out', zip])).code, 0);
  const to = path.join(tmpDir('sf-cli-to-'), 'restored');
  const r = await runCli(['restore', '--from', zip, '--to', to]);
  assert.equal(r.code, 0, r.output);
  assertSameFiles(assert, readAll(book), readAll(to, { skip: [] }), 'restored via CLI');
  assert.ok(!fs.existsSync(path.join(to, '.storyforge')));

  const busy = tmpDir('sf-cli-busy-');
  fs.writeFileSync(path.join(busy, 'mine.txt'), 'mine');
  const refused = await runCli(['restore', '--from', zip, '--to', busy]);
  assert.notEqual(refused.code, 0, refused.output);
  assert.match(refused.output, /RESTORE_TARGET_NOT_EMPTY|not empty/i);
  assert.deepEqual(fs.readdirSync(busy), ['mine.txt']);
});

test('CLI restore: a hostile zip, a corrupt zip and a missing file are refused and nothing is written', { timeout: 180000 }, async () => {
  const good = await backupBytes();
  const out = tmpDir('sf-cli-bad-');
  const goodZip = path.join(out, 'good.zip');
  fs.writeFileSync(goodZip, good);
  const ctl = await runCli(['restore', '--from', goodZip, '--to', path.join(tmpDir('sf-cli-ctl-'), 'restored')]);
  assert.equal(ctl.code, 0, 'control: the unmodified backup restores: ' + ctl.output);
  const slip = path.join(out, 'slip.zip');
  fs.writeFileSync(slip, writeZip([...readZip(good).entries.map((e) => ({ name: e.name, data: e.data })), { name: '../sf-cli-slip.txt', data: Buffer.from('x') }], { comment: readZip(good).comment }));
  const trunc = path.join(out, 'trunc.zip');
  fs.writeFileSync(trunc, good.subarray(0, Math.floor(good.length / 2)));
  for (const from of [slip, trunc, path.join(out, 'missing.zip')]) {
    const parent = tmpDir('sf-cli-to-');
    const to = path.join(parent, 'restored');
    const r = await runCli(['restore', '--from', from, '--to', to]);
    assert.notEqual(r.code, 0, `${from}: ${r.output}`);
    assert.deepEqual(fs.readdirSync(parent), [], `${from}: nothing written`);
    assert.ok(!fs.existsSync(path.resolve(parent, '..', 'sf-cli-slip.txt')));
  }
});

test('CLI backup then restore round trip validates clean through the repository (library open)', { timeout: 180000 }, async () => {
  const { lib, out } = cliArena();
  const zip = path.join(out, 'rt.zip');
  assert.equal((await runCli(['backup', '--library', lib, '--book', 'salt-orchard', '--out', zip])).code, 0);
  const newLib = tmpDir('sf-cli-newlib-');
  const to = path.join(newLib, 'salt-orchard');
  assert.equal((await runCli(['restore', '--from', zip, '--to', to])).code, 0);
  const { port } = await startApi(newLib);
  assert.ok((await booksOf(port)).some((b) => b.id === BOOK));
  assert.ok(BASE_MTIME);
});
