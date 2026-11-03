// M07-J01b: the routes for series shared worlds, labels, typed fields and library templates, over HTTP, on a copy of the tidewater fixture.
// Written against docs/contracts/M07-J01-shared-worlds-customization.md section 7. Every refusal is checked to change nothing (a snapshot of every file).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { matchWriteRoute } from '../src/router.mjs';
import { close, copyFixture, listen, request, snapshot } from './helpers.mjs';

const SO = 'book_01W10000000000000000000006';
const LT = 'book_01W1000000000000000000000A';
const PR = 'book_01W1000000000000000000000E';
const ILSE = 'entry_01W10000000000000000000003';
const MAREN = 'entry_01W10000000000000000000008';
const VESSEL = 'entry_01W10000000000000000000009';
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function fresh() {
  const root = await copyFixture('valid/tidewater');
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const repository = createFsRepository(root);
  const server = createServer({ repository, webRoot });
  servers.push(server);
  const port = await listen(server);
  return { root, port };
}

function send(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}`, ...GOOD };
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const get = (port, p) => request(port, 'GET', p);
const text = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.access(path.join(root, ...rel.split('/'))).then(() => true, () => false);
const snap = (root) => snapshot(root, { skipStoryforge: true });
const errors = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');

test('the new write routes are matched by name, and nothing else is', () => {
  const m = (method, p) => matchWriteRoute(method, p)?.route ?? null;
  assert.equal(m('POST', `/api/books/${SO}/entries/${ILSE}/move-to-series`), 'entry-move-to-series');
  assert.equal(m('POST', `/api/books/${SO}/entries/${ILSE}/copy-to-book`), 'entry-copy-to-book');
  assert.equal(m('POST', `/api/books/${SO}/labels`), 'labels-set');
  assert.equal(m('POST', `/api/books/${SO}/save-as-template`), 'template-save');
  assert.equal(m('GET', `/api/books/${SO}/labels`), null);
  assert.equal(m('PUT', `/api/books/${SO}/labels`), null);
  assert.equal(m('DELETE', `/api/books/${SO}/save-as-template`), null);
});

test('GET codex/entries: a shared entry is in both books of the series, flagged, with its series; the standalone book does not see it', async () => {
  const { port } = await fresh();
  for (const book of [SO, LT]) {
    const r = await get(port, `/api/books/${book}/codex/entries`);
    assert.equal(r.status, 200, r.text);
    const ilse = r.json.entries.find((e) => e.slug === 'ilse-hollis');
    assert.equal(ilse.shared, true);
    assert.equal(ilse.series.title, 'The Tidewater Books');
    assert.equal(r.json.series.slug, 'tidewater');
  }
  const alone = (await get(port, `/api/books/${PR}/codex/entries`)).json;
  assert.equal(alone.entries.some((e) => e.shared), false);
  assert.equal((await get(port, `/api/books/${PR}/entries/ilse-hollis`)).status, 404);
  const one = await get(port, `/api/books/${LT}/entries/${ILSE}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.shared, true);
  assert.equal(one.json.path, 'tidewater/codex/characters/ilse-hollis.md');
});

test('editing a shared entry in one book is seen in the other; the series file is written, nothing else, and no receipts', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const dry = await send(port, 'POST', `/api/books/${SO}/entries/${ILSE}/fields`, { role: 'Lamp keeper', dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(await snap(root), before, 'a dry run writes nothing');
  const w = await send(port, 'POST', `/api/books/${SO}/entries/${ILSE}/fields`, { role: 'Lamp keeper' });
  assert.equal(w.status, 200, w.text);
  const after = await snap(root);
  assert.deepEqual(Object.keys(after).filter((k) => after[k] !== before[k]), ['tidewater/codex/characters/ilse-hollis.md']);
  assert.equal(await exists(root, 'tidewater/salt-orchard-2/provenance'), false);
  assert.match(await text(root, 'tidewater/codex/characters/ilse-hollis.md'), /^role: Lamp keeper$/m);
  const other = (await get(port, `/api/books/${LT}/codex/entries`)).json.entries.find((e) => e.id === ILSE);
  assert.equal(other.role, 'Lamp keeper');
  // the text, with the base the author saw
  const seen = (await get(port, `/api/books/${LT}/entries/${ILSE}`)).json;
  const stale = await send(port, 'PUT', `/api/books/${SO}/entries/${ILSE}/body`, { body: 'x', base_sha256: 'e'.repeat(64) });
  assert.equal(stale.status, 409);
  const ok = await send(port, 'PUT', `/api/books/${SO}/entries/${ILSE}/body`, { body: `${seen.body}Also here.\n`, base_sha256: seen.sha256 });
  assert.equal(ok.status, 200, ok.text);
  assert.match((await get(port, `/api/books/${LT}/entries/${ILSE}`)).json.body, /Also here\./);
  assert.deepEqual(await errors(root), []);
});

test('New entry: where series makes a shared entry; for a standalone book it is refused and changes nothing', async () => {
  const { root, port } = await fresh();
  const dry = await send(port, 'POST', `/api/books/${SO}/entries`, { type: 'character', name: 'Tobin Reyes', where: 'series', dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(await exists(root, 'tidewater/codex/characters/tobin-reyes.md'), false);
  const r = await send(port, 'POST', `/api/books/${SO}/entries`, { type: 'character', name: 'Tobin Reyes', where: 'series' });
  assert.equal(r.status, 201, r.text);
  assert.equal(await exists(root, 'tidewater/codex/characters/tobin-reyes.md'), true);
  const here = await send(port, 'POST', `/api/books/${SO}/entries`, { type: 'character', name: 'Local One', where: 'book' });
  assert.equal(here.status, 201, here.text);
  assert.equal(await exists(root, 'tidewater/salt-orchard-2/codex/characters/local-one.md'), true);
  const before = await snap(root);
  const alone = await send(port, 'POST', `/api/books/${PR}/entries`, { type: 'character', name: 'Nobody', where: 'series' });
  assert.equal(alone.status, 400);
  assert.equal(alone.json.code, 'REFUSED_NO_SERIES');
  const dup = await send(port, 'POST', `/api/books/${LT}/entries`, { type: 'character', name: 'Tobin Reyes', where: 'series' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.code, 'SLUG_TAKEN');
  assert.deepEqual(await snap(root), before);
});

test('Move to series: the file moves, the id is kept, links keep resolving; refused when the series has the slug', async () => {
  const { root, port } = await fresh();
  const route = (id) => `/api/books/${SO}/entries/${id}/move-to-series`;
  const before = await snap(root);
  const dry = await send(port, 'POST', route(MAREN), { dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.changes[0].to, 'tidewater/codex/characters/maren-hollis.md');
  assert.deepEqual(await snap(root), before);

  const w = await send(port, 'POST', route(MAREN), {});
  assert.equal(w.status, 200, w.text);
  assert.equal(w.json.id, MAREN);
  assert.equal(await exists(root, 'tidewater/salt-orchard-2/codex/characters/maren-hollis.md'), false);
  assert.match(await text(root, 'tidewater/codex/characters/maren-hollis.md'), new RegExp(`^id: ${MAREN}$`, 'm'));
  assert.deepEqual(await errors(root), []);
  const lt = (await get(port, `/api/books/${LT}/codex/entries`)).json.entries.find((e) => e.id === MAREN);
  assert.equal(lt.shared, true);
  assert.equal((await get(port, `/api/books/${SO}/entries/${MAREN}`)).status, 200);

  const mid = await snap(root);
  const clash = await send(port, 'POST', `/api/books/${LT}/entries/port-aldine/move-to-series`, {});
  assert.equal(clash.status, 409);
  assert.equal(clash.json.code, 'SLUG_TAKEN');
  assert.equal((await send(port, 'POST', `/api/books/${PR}/entries/captain-vane/move-to-series`, {})).status, 400);
  assert.equal((await send(port, 'POST', `/api/books/${SO}/entries/entry_NONE/move-to-series`, {})).status, 404);
  assert.deepEqual(await snap(root), mid);
});

test('Copy into this book: a new id and the same slug, W309 in the answer and in the book\'s problems; a second copy is refused', async () => {
  const { root, port } = await fresh();
  const w = await send(port, 'POST', `/api/books/${LT}/entries/${ILSE}/copy-to-book`, {});
  assert.equal(w.status, 201, w.text);
  assert.notEqual(w.json.id, ILSE);
  assert.deepEqual(w.json.warnings.map((x) => x.code), ['W309']);
  assert.equal(await exists(root, 'tidewater/low-tide/codex/characters/ilse-hollis.md'), true);
  assert.equal(await exists(root, 'tidewater/salt-orchard-2/codex/characters/ilse-hollis.md'), false, 'the other book is not touched');
  const diag = (await get(port, `/api/books/${LT}/diagnostics`)).json;
  assert.ok(diag.some((d) => d.code === 'W309' && d.file === 'tidewater/low-tide/codex/characters/ilse-hollis.md'));
  const before = await snap(root);
  const again = await send(port, 'POST', `/api/books/${LT}/entries/${ILSE}/copy-to-book`, {});
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'SLUG_TAKEN');
  assert.equal((await send(port, 'POST', `/api/books/${PR}/entries/${ILSE}/copy-to-book`, {})).status, 400);
  assert.deepEqual(await snap(root), before);
});

test('typed fields: GET codex/types carries the kinds; a value that does not fit is saved and reported as W312', async () => {
  const { root, port } = await fresh();
  const types = (await get(port, `/api/books/${SO}/codex/types`)).json;
  const vessel = types.find((t) => t.type === 'vessel');
  assert.deepEqual(vessel.field_defs.map((f) => f.kind), ['text', 'number', 'date', 'link', 'choice', 'list', 'text']);
  assert.deepEqual(vessel.field_defs.find((f) => f.kind === 'choice').choices, ['sloop', 'ketch', 'schooner']);
  const r = await send(port, 'POST', `/api/books/${SO}/entries/${VESSEL}/fields`, {
    fields: [{ label: 'Master', value: 'Captain Pell' }, { label: 'Tonnage', value: 'heavy' }, { label: 'Launched', value: '1891-04-12' }, { label: 'Cargoes', value: ['salt', 'tar'] }],
  });
  assert.equal(r.status, 200, r.text);
  const entry = (await get(port, `/api/books/${SO}/codex/entries`)).json.entries.find((e) => e.id === VESSEL);
  assert.deepEqual(entry.problems.map((p) => [p.code, p.location]), [['W312', 'fields.Tonnage']]);
  assert.deepEqual(entry.fields.Cargoes, ['salt', 'tar']);
  assert.match(await text(root, 'tidewater/salt-orchard-2/codex/vessels/gull-and-ledger.md'), /^ {2}Tonnage: heavy$/m);
  const nope = await send(port, 'POST', `/api/books/${SO}/entries/${VESSEL}/fields`, { fields: [{ label: 'Cargoes', value: { a: 1 } }] });
  assert.equal(nope.status, 400);
});

test('labels: the lists are read, written with their own block, and a bad colour writes nothing', async () => {
  const { root, port } = await fresh();
  const got = (await get(port, `/api/books/${SO}/labels`)).json;
  assert.deepEqual(got.book.labels, [{ name: 'Draft Two', color: '#2E7D32' }]);
  assert.equal(got.series.slug, 'tidewater');
  assert.equal((await get(port, `/api/books/${PR}/labels`)).json.series, null);
  assert.equal((await get(port, '/api/books/book_NONE/labels')).status, 404);
  const before = await snap(root);
  const bad = await send(port, 'POST', `/api/books/${SO}/labels`, { scope: 'book', labels: [{ name: 'Oops', color: 'green' }] });
  assert.equal(bad.status, 400);
  assert.equal((await send(port, 'POST', `/api/books/${SO}/labels`, { scope: 'galaxy', labels: [] })).status, 400);
  assert.equal((await send(port, 'POST', `/api/books/${PR}/labels`, { scope: 'series', labels: [] })).status, 400);
  assert.deepEqual(await snap(root), before);
  const dry = await send(port, 'POST', `/api/books/${SO}/labels`, { scope: 'book', labels: [{ name: 'Rewrite', color: '#C77DFF' }], dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual(await snap(root), before);
  const w = await send(port, 'POST', `/api/books/${SO}/labels`, { scope: 'series', labels: [...got.series.labels, { name: 'Clue', color: '#E0A64B' }] });
  assert.equal(w.status, 200, w.text);
  assert.deepEqual((await get(port, `/api/books/${LT}/labels`)).json.series.labels.map((l) => l.name), ['Mystery', 'Backstory', 'Clue']);
  assert.match(await text(root, 'tidewater/series.md'), /name: Clue\n {4}color: "#E0A64B"/);
  // a scene's label shows with the planning answer, with the definitions to draw chips from
  const planning = (await get(port, `/api/books/${SO}/threads`)).json;
  assert.deepEqual(planning.scenes[0].labels, ['Mystery', 'Draft Two']);
  assert.deepEqual(planning.labels.map((l) => [l.name, l.scope]), [['Draft Two', 'book'], ['Mystery', 'series'], ['Backstory', 'series'], ['Clue', 'series']]);
});

test("a shared entry's own problems are in each book's diagnostics, marked as the series'", async () => {
  const { port } = await fresh();
  const made = await send(port, 'POST', `/api/books/${SO}/entries`, { type: 'vessel', name: 'The Gull', slug: 'the-gull', where: 'series', fields: [{ label: 'Tonnage', value: 'heavy' }] });
  assert.equal(made.status, 201, made.text);
  for (const book of [SO, LT]) {
    const hit = (await get(port, `/api/books/${book}/diagnostics`)).json.find((d) => d.code === 'W312');
    assert.equal(hit?.scope, 'series');
    assert.equal(hit.file, 'tidewater/codex/vessels/the-gull.md');
  }
  assert.equal((await get(port, `/api/books/${PR}/diagnostics`)).json.some((d) => d.scope === 'series'), false);
});

test('GET link-targets: this book, its series, other books as book-slug:slug', async () => {
  const { port } = await fresh();
  const r = await get(port, `/api/books/${LT}/link-targets`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.book.map((i) => i.link).sort(), ['[[port-aldine]]', '[[the-lost-ledger]]']);
  assert.deepEqual(r.json.series.items.map((i) => i.link), ['[[ilse-hollis]]', '[[port-aldine]]']);
  assert.ok(r.json.books.find((b) => b.slug === 'salt-orchard-2').items.some((i) => i.link === '[[salt-orchard-2:maren-hollis]]'));
  assert.equal((await get(port, '/api/books/book_NONE/link-targets')).status, 404);
});

test('Save as template, then a new book from it validates clean; a taken name is refused and changes nothing', async () => {
  const { root, port } = await fresh();
  const w = await send(port, 'POST', `/api/books/${SO}/save-as-template`, { name: 'book-two-shape', title: 'Book two shape', description: 'Acts and scenes of book two.' });
  assert.equal(w.status, 201, w.text);
  assert.equal(w.json.path, '_templates/book-two-shape');
  const list = (await get(port, '/api/templates')).json;
  assert.deepEqual(list.filter((t) => t.source === 'library').map((t) => t.name), ['book-two-shape', 'mystery-arc']);
  assert.deepEqual(list.slice(0, 4).map((t) => t.source), ['builtin', 'builtin', 'builtin', 'builtin'], 'built-in first');
  const made = await send(port, 'POST', '/api/books', { title: 'Book Three', template: 'book-two-shape', templateSource: 'library', seriesSlug: 'tidewater' });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual(await errors(root), []);
  assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.file.startsWith('tidewater/book-three/')), []);
  assert.equal((await get(port, `/api/books/${made.json.bookId}`)).json.title, 'Book Three');
  const before = await snap(root);
  const again = await send(port, 'POST', `/api/books/${SO}/save-as-template`, { name: 'book-two-shape', title: 'Other' });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'TEMPLATE_EXISTS');
  const bad = await send(port, 'POST', `/api/books/${SO}/save-as-template`, { name: 'Not A Slug', title: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.field, 'name');
  assert.equal((await send(port, 'POST', `/api/books/${SO}/save-as-template`, { name: 'ok', title: '' })).status, 400);
  assert.equal((await send(port, 'POST', '/api/books/book_NONE/save-as-template', { name: 'ok', title: 'x' })).status, 404);
  assert.equal((await send(port, 'POST', '/api/books', { title: 'Nope', template: 'nope', templateSource: 'library' })).status, 400);
  assert.deepEqual(await snap(root), before);
});

test('a new write route needs the write header like every other write', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  for (const [method, p] of [
    ['POST', `/api/books/${SO}/entries/${MAREN}/move-to-series`],
    ['POST', `/api/books/${LT}/entries/${ILSE}/copy-to-book`],
    ['POST', `/api/books/${SO}/labels`],
    ['POST', `/api/books/${SO}/save-as-template`],
  ]) {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': 2 } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(r, 403, p);
  }
  assert.deepEqual(await snap(root), before);
});
