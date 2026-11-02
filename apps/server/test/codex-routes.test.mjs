// M04-J02 acceptance 2 (API half), 3, 4, 5: appears_in order, every Codex GET identical with and without an index,
// the entry / type write routes and their file effects and refusals, and the entry body PUT.
//
// Written against docs/contracts/M04-J02-codex-browser.md. Where the contract leaves a route or a response shape open,
// the guess is named in ROUTES below (one line to change) and the assertions stay on files, which are the contract.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, readExpected, request, snapshot } from './helpers.mjs';

const CG = 'book_01CG0000000000000000000001';
const SO = 'book_01S5000000000000000000000A';
const ID = {
  landfall: 'scene_01CG0000000000000000000002',
  maren: 'entry_01CG0000000000000000000005',
  tobin: 'entry_01CG0000000000000000000006',
  portAldine: 'entry_01CG0000000000000000000007',
  brassKey: 'entry_01CG0000000000000000000009',
  gull: 'entry_01CG000000000000000000000B',
};
const P = {
  maren: 'codex/characters/maren-hollis.md',
  tobin: 'codex/characters/tobin-reyes.md',
  gull: 'codex/ships/the-gull.md',
  brassKey: 'codex/objects/brass-key.md',
};
const ENTRY_ID = /^entry_[0-9A-HJKMNP-TV-Z]{26}$/;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };
const WRITE_ERR = (s) => s >= 400 && s < 500;

// Routes the contract names exactly: POST /entries, /entries/:id/fields, /entries/:id/archive, /entries/:id/body (PUT),
// POST /codex/types. Not named exactly: change slug and restore.
const ROUTES = {
  create: (b) => `/api/books/${b}/entries`,
  fields: (b, id) => `/api/books/${b}/entries/${id}/fields`,
  slug: (b, id) => `/api/books/${b}/entries/${id}/slug`, // GUESS: "Change slug…" action, body { slug }
  archive: (b, id) => `/api/books/${b}/entries/${id}/archive`,
  restore: (b) => `/api/books/${b}/entries/restore`, // GUESS: body { path, base_sha256 } like POST /archive/restore for scenes
  body: (b, id) => `/api/books/${b}/entries/${id}/body`,
  types: (b) => `/api/books/${b}/codex/types`,
};

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function fresh({ fixture = 'valid/codex-graph', book = CG, build = true, prep } = {}) {
  const root = await copyFixture(fixture);
  if (prep) await prep(root);
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const repository = createFsRepository(root);
  if (build) await repository.rebuildIndex(book);
  const server = createServer({ repository, webRoot });
  servers.push(server);
  const port = await listen(server);
  return { root, port, book };
}

function send(port, method, pathname, { headers = GOOD, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const read = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')));
const readText = async (root, rel) => (await read(root, rel)).toString('utf8');
const exists = (root, rel) => fs.access(path.join(root, ...rel.split('/'))).then(() => true, () => false);
const snap = (root) => snapshot(root, { skipStoryforge: true });

function frontMatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  assert.equal(lines[0], '---');
  const end = lines.indexOf('---', 1);
  return { fm: YAML.parse(lines.slice(1, end).join('\n')), body: lines.slice(end + 1).join('\n'), keys: Object.keys(YAML.parse(lines.slice(1, end).join('\n'))) };
}

/** Lines removed and added between two texts (LCS), independent of the code under test. */
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) added.push(b[j++]);
    else removed.push(a[i++]);
  }
  return { removed, added };
}

/** The text with the top-level `key:` line and its indented continuation lines taken out (works for LF and CRLF). */
function withoutBlock(text, key) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const l of lines) {
    const bare = l.replace(/\r$/, '');
    if (!skipping && bare.startsWith(`${key}:`)) { skipping = true; continue; }
    if (skipping && (/^\s+\S/.test(bare) || /^\s*-\s/.test(bare))) continue;
    skipping = false;
    out.push(l);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------- 2

test('acceptance 2: entry appears_in is in manuscript order and starts with the first explicit scene (codex-graph)', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', `/api/books/${CG}/entries/${ID.maren}`);
  assert.equal(r.status, 200, r.text);
  const a = r.json.appears_in;
  assert.equal(a[0].kind, 'explicit');
  assert.equal(a[0].scene_id, ID.landfall, 'the first row is the first scene of the book that links her explicitly');
  const explicit = a.filter((x) => x.kind === 'explicit');
  const inferred = a.filter((x) => x.kind === 'inferred');
  assert.ok(explicit.length > 0 && inferred.length > 0);
  assert.deepEqual(a, [...explicit, ...inferred], 'explicit rows first');
  for (const rows of [explicit, inferred]) {
    const pos = rows.map((x) => x.position);
    assert.deepEqual(pos, [...pos].sort((x, y) => x - y), 'manuscript order within a kind');
  }
});

test('acceptance 2: salt-orchard Maren appears_in follows expected.json manuscript order', async () => {
  const { port } = await fresh({ fixture: 'valid/salt-orchard', book: SO });
  const order = (await readExpected('valid/salt-orchard')).order;
  const r = await request(port, 'GET', `/api/books/${SO}/entries/maren-hollis`);
  assert.equal(r.status, 200, r.text);
  const explicit = r.json.appears_in.filter((x) => x.kind === 'explicit');
  assert.ok(explicit.length >= 1);
  const idx = explicit.map((x) => order.indexOf(x.scene_id));
  assert.ok(idx.every((i) => i >= 0), 'every row is a scene in the reading order');
  assert.deepEqual(idx, [...idx].sort((x, y) => x - y));
  assert.deepEqual(r.json.appears_in.slice(0, explicit.length), explicit);
});

// ---------------------------------------------------------------------------------------------------------------- 3

async function codexGets(port, book) {
  const b = (rest) => `/api/books/${book}${rest}`;
  const out = {};
  const get = async (key, p) => {
    const r = await request(port, 'GET', p);
    assert.equal(r.status, 200, `${p}: ${r.text}`);
    out[key] = r.json;
    return r.json;
  };
  await get('types', b('/codex/types'));
  const list = await get('codexEntries', b('/codex/entries')); // the Codex page's own list (M04-J02)
  assert.ok(Array.isArray(list.entries) && Array.isArray(list.chapters), 'GET codex/entries answers { entries, chapters }');
  const objects = await get('objects', b('/objects'));
  await get('entryObjects', b('/objects?kinds=entry'));
  const graph = await get('graph', b('/graph'));
  graph.nodes.sort((x, y) => (x.id < y.id ? -1 : 1));
  graph.edges.sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)); // edge order is not part of the contract
  for (const o of objects.filter((x) => x.kind === 'entry')) await get(`entry:${o.id}`, b(`/entries/${o.id}`));
  await get('search', `/api/search?q=${encodeURIComponent('Maren')}&book=${book}&kinds=entry`);
  return out;
}

for (const [fixture, book] of [['valid/codex-graph', CG], ['valid/salt-orchard', SO]]) {
  test(`acceptance 3: every Codex GET is identical with a fresh index and with no index (${path.basename(fixture)})`, async () => {
    const withIndex = await codexGets((await fresh({ fixture, book, build: true })).port, book);
    const without = await codexGets((await fresh({ fixture, book, build: false })).port, book);
    assert.ok(Object.keys(withIndex).filter((k) => k.startsWith('entry:')).length >= 5, 'entries were actually compared');
    assert.deepEqual(without, withIndex);
  });
}

test('acceptance 3: still identical after the index is deleted from a built book', async () => {
  const a = await fresh({ build: true });
  const withIndex = await codexGets(a.port, CG);
  await fs.rm(path.join(a.root, '.storyforge'), { recursive: true, force: true });
  const gone = await codexGets(a.port, CG);
  assert.deepEqual(gone, withIndex);
});

// ---------------------------------------------------------------------------------------------------------------- 4 create

test('create entry: exact file for a type with default fields, id and slug generated, folder <type>s', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const r = await send(port, 'POST', ROUTES.create(CG), { body: { type: 'ship', name: 'Corvid Star' } });
  assert.equal(r.status, 201, r.text);
  assert.match(r.json.id, ENTRY_ID);
  assert.equal(r.json.path, 'codex/ships/corvid-star.md');
  const after_ = await snap(root);
  assert.deepEqual(Object.keys(after_).filter((k) => !(k in before)), ['codex/ships/corvid-star.md'], 'exactly one file was added');
  for (const k of Object.keys(before)) assert.equal(after_[k], before[k], `${k} untouched`);

  const text = await readText(root, 'codex/ships/corvid-star.md');
  assert.ok(text.startsWith('---\nschema: storyforge.entry/v1\n'), 'schema is the first line');
  assert.ok(text.endsWith('\n---\n## Overview\n\n'), 'body is "## Overview" and a blank line');
  assert.ok(!text.includes('\r'));
  const { fm, body, keys } = frontMatter(text);
  assert.deepEqual(keys, ['schema', 'id', 'slug', 'type', 'name', 'status', 'fields']);
  assert.equal(fm.id, r.json.id);
  assert.equal(fm.slug, 'corvid-star');
  assert.equal(fm.type, 'ship');
  assert.equal(fm.name, 'Corvid Star');
  assert.equal(fm.status, 'seed', 'status defaults to seed');
  assert.deepEqual(Object.keys(fm.fields), ['Captain', 'Home port', 'Tonnage'], 'the type definition labels, in order');
  for (const v of Object.values(fm.fields)) assert.ok(v === null || v === '', 'values are empty');
  assert.equal(body, '## Overview\n\n');
});

test('create entry: built-in folder, explicit slug, status and field values; the new entry is readable and valid', async () => {
  const { root, port } = await fresh();
  const r = await send(port, 'POST', ROUTES.create(CG), {
    body: { type: 'location', name: 'The Long Jetty', slug: 'jetty', status: 'sketch', fields: { Region: 'Estuary' } },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.path, 'codex/locations/jetty.md');
  const { fm } = frontMatter(await readText(root, r.json.path));
  assert.deepEqual([fm.slug, fm.name, fm.status, fm.fields?.Region], ['jetty', 'The Long Jetty', 'sketch', 'Estuary']);
  const got = await request(port, 'GET', `/api/books/${CG}/entries/${r.json.id}`);
  assert.equal(got.status, 200, got.text);
  assert.equal(got.json.name, 'The Long Jetty');
  const diag = await request(port, 'GET', `/api/books/${CG}/diagnostics`);
  assert.deepEqual((diag.json.items ?? diag.json).filter((d) => d.severity === 'error'), []);
});

test('create entry: a type with no definition still gets codex/<type>s and no invented fields block content', async () => {
  const { root, port } = await fresh();
  const r = await send(port, 'POST', ROUTES.create(CG), { body: { type: 'spell', name: 'Calm Water' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.path, 'codex/spells/calm-water.md');
  assert.equal(frontMatter(await readText(root, r.json.path)).fm.type, 'spell');
});

test('create entry refusals write nothing: SLUG_TAKEN (entry, thread and event slugs), empty name, missing type', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  for (const slug of ['maren-hollis', 'the-key-mystery', 'the-landfall']) {
    const r = await send(port, 'POST', ROUTES.create(CG), { body: { type: 'character', name: 'Another', slug } });
    assert.ok(WRITE_ERR(r.status), `${slug}: ${r.status}`);
    assert.equal(r.json.code, 'SLUG_TAKEN', `${slug}: ${r.text}`);
  }
  // a name whose derived slug collides
  const derived = await send(port, 'POST', ROUTES.create(CG), { body: { type: 'character', name: 'Maren Hollis' } });
  assert.equal(derived.json.code, 'SLUG_TAKEN');
  for (const body of [{ type: 'character', name: '' }, { type: 'character' }, { name: 'No Type' }]) {
    const r = await send(port, 'POST', ROUTES.create(CG), { body });
    assert.ok(WRITE_ERR(r.status), JSON.stringify(body));
  }
  assert.deepEqual(await snap(root), before);
});

// ---------------------------------------------------------------------------------------------------------------- 4 edit fields

async function editFields(opts, body, file = P.maren, id = ID.maren) {
  const ctx = await fresh(opts);
  const before = await readText(ctx.root, file);
  const r = await send(ctx.port, 'POST', ROUTES.fields(CG, id), { body });
  return { ...ctx, before, r, after: await readText(ctx.root, file) };
}

test('edit fields: name changes only the name line and never the slug', async () => {
  const { r, before, after: text } = await editFields({}, { name: 'Maren H. Hollis' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(lineDiff(before, text), { removed: ['name: Maren Hollis'], added: ['name: Maren H. Hollis'] });
  assert.equal(frontMatter(text).fm.slug, 'maren-hollis');
});

test('edit fields: status and role (a new scalar key) change only their own lines', async () => {
  const { r, before, after: text } = await editFields({}, { status: 'sketch', role: 'Pilot' });
  assert.equal(r.status, 200, r.text);
  const d = lineDiff(before, text);
  assert.deepEqual(d.removed, ['status: canon']);
  assert.deepEqual([...d.added].sort(), ['role: Pilot', 'status: sketch']);
});

test('edit fields: aliases is replaced as a YAML flow list and nothing outside that line changes', async () => {
  const { r, before, after: text } = await editFields({}, { aliases: ['Maren', 'Skipper', 'Mare'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(lineDiff(before, text), { removed: ['aliases: [Maren, Skipper]'], added: ['aliases: [Maren, Skipper, Mare]'] });
});

test('edit fields: related is replaced as a block list of { to, as }; every other line is identical', async () => {
  const related = [{ to: 'tobin-reyes', as: 'ferryman' }, { to: 'brass-key', as: 'carries' }];
  const { r, before, after: text } = await editFields({}, { related });
  assert.equal(r.status, 200, r.text);
  assert.equal(withoutBlock(text, 'related'), withoutBlock(before, 'related'));
  assert.deepEqual(frontMatter(text).fm.related, related);
  assert.ok(text.includes('related:\n  - to: tobin-reyes\n    as: ferryman\n  - to: brass-key\n    as: carries\n'), 'block list, two-space indent');
});

test('edit fields: fields map replaced as a block map; the rest of the file is identical', async () => {
  const map = { Captain: 'Maren Hollis', 'Home port': 'Port Aldine', Tonnage: 45 };
  const { r, before, after: text } = await editFields({}, { fields: map }, P.gull, ID.gull);
  assert.equal(r.status, 200, r.text);
  assert.equal(withoutBlock(text, 'fields'), withoutBlock(before, 'fields'));
  assert.deepEqual(frontMatter(text).fm.fields, map);
  assert.ok(text.includes('fields:\n  Captain: Maren Hollis\n  Home port: Port Aldine\n  Tonnage: 45\n'));
});

test('edit fields on a CRLF entry: only the named block changes and every line keeps CRLF', async () => {
  const toCrlf = async (root) => {
    const f = path.join(root, ...P.gull.split('/'));
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/\n/g, '\r\n'));
  };
  const map = { Captain: 'Maren Hollis', 'Home port': 'Port Aldine', Tonnage: 41 };
  const a = await editFields({ prep: toCrlf }, { fields: map }, P.gull, ID.gull);
  assert.ok(a.before.includes('\r\n') && !/[^\r]\n/.test(a.before), 'precondition: the fixture copy is CRLF');
  assert.equal(a.r.status, 200, a.r.text);
  assert.ok(!/[^\r]\n/.test(a.after), 'no bare LF appeared');
  assert.equal(withoutBlock(a.after, 'fields'), withoutBlock(a.before, 'fields'));
  assert.deepEqual(frontMatter(a.after).fm.fields, map);

  const s = await editFields({ prep: toCrlf }, { name: 'The Gull II' }, P.gull, ID.gull);
  assert.equal(s.r.status, 200, s.r.text);
  assert.deepEqual(lineDiff(s.before, s.after), { removed: ['name: The Gull\r'], added: ['name: The Gull II\r'] });
});

test('edit fields: slug in the body is never applied through this route', async () => {
  const { root, port } = await fresh();
  const r = await send(port, 'POST', ROUTES.fields(CG, ID.maren), { body: { name: 'Maren X', slug: 'hijack' } });
  assert.notEqual(r.status, 405, 'the fields route exists');
  assert.equal(frontMatter(await readText(root, P.maren)).fm.slug, 'maren-hollis');
});

test('edit fields refusals write nothing: unsimple block, stale base, unknown entry', async () => {
  const unsimple = async (root) => {
    const f = path.join(root, ...P.gull.split('/'));
    const t = await fs.readFile(f, 'utf8');
    await fs.writeFile(f, t.replace('  Captain: Tobin Reyes\n', '  Captain: &cap Tobin Reyes # the skipper\n'));
  };
  const a = await fresh({ prep: unsimple });
  const snapA = await snap(a.root);
  const r1 = await send(a.port, 'POST', ROUTES.fields(CG, ID.gull), { body: { fields: { Captain: 'Maren Hollis', 'Home port': 'Port Aldine', Tonnage: 40 } } });
  assert.ok(WRITE_ERR(r1.status), r1.text);
  assert.equal(r1.json.code, 'REFUSED_UNSIMPLE_FIELD');
  assert.deepEqual(await snap(a.root), snapA);

  const b = await fresh();
  const bytes = await read(b.root, P.maren);
  await fs.writeFile(path.join(b.root, ...P.maren.split('/')), Buffer.concat([bytes, Buffer.from('\nAn external edit.\n')]));
  const snapB = await snap(b.root);
  const r2 = await send(b.port, 'POST', ROUTES.fields(CG, ID.maren), { body: { name: 'Stale', base_sha256: sha(bytes) } });
  assert.equal(r2.status, 409, r2.text);
  assert.deepEqual(await snap(b.root), snapB);

  const missing = await send(b.port, 'POST', ROUTES.fields(CG, 'entry_01CG00000000000000000000ZZ'), { body: { name: 'x' } });
  assert.equal(missing.status, 404);
  assert.deepEqual(await snap(b.root), snapB);
});

// ---------------------------------------------------------------------------------------------------------------- 4 slug

test('change slug: adds previous_slugs and changes the slug line, nothing else', async () => {
  const { root, port } = await fresh();
  const before = await readText(root, P.maren);
  const r = await send(port, 'POST', ROUTES.slug(CG, ID.maren), { body: { slug: 'maren-of-aldine' } });
  assert.equal(r.status, 200, r.text);
  const text = await readText(root, P.maren);
  const d = lineDiff(before, text);
  assert.deepEqual(d.removed, ['slug: maren-hollis']);
  assert.ok(d.added.includes('slug: maren-of-aldine'));
  const rest = d.added.filter((l) => l !== 'slug: maren-of-aldine');
  assert.ok(rest.length >= 1 && rest.every((l) => /previous_slugs|maren-hollis/.test(l)), `only previous_slugs lines were added: ${JSON.stringify(rest)}`);
  assert.deepEqual(frontMatter(text).fm.previous_slugs, ['maren-hollis']);
  assert.equal(frontMatter(text).body, frontMatter(before).body);
  assert.equal(await exists(root, P.maren), true, 'the file is not renamed');
});

test('change slug refusals write nothing: SLUG_TAKEN', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const r = await send(port, 'POST', ROUTES.slug(CG, ID.maren), { body: { slug: 'tobin-reyes' } });
  assert.ok(WRITE_ERR(r.status), r.text);
  assert.equal(r.json.code, 'SLUG_TAKEN');
  assert.deepEqual(await snap(root), before);
});

// ---------------------------------------------------------------------------------------------------------------- 4 archive / restore

test('archive: the dry run lists every scene and entry that links to it and writes nothing', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const r = await send(port, 'POST', ROUTES.archive(CG, ID.tobin), { body: { dryRun: true } });
  assert.equal(r.status, 200, r.text);
  const text = JSON.stringify(r.json);
  for (const source of ['0010-landfall.md', '0020-night-lines.md', '0030-last-ferry.md', 'maren-hollis.md']) {
    assert.ok(text.includes(source), `the preview names ${source}`);
  }
  assert.deepEqual(await snap(root), before);
});

test('archive then restore: the file moves under archive/codex byte-for-byte and comes back', async () => {
  const { root, port } = await fresh();
  const bytes = await read(root, P.tobin);
  const r = await send(port, 'POST', ROUTES.archive(CG, ID.tobin), { body: { base_sha256: sha(bytes) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(await exists(root, P.tobin), false);
  const all = Object.keys(await snap(root));
  const moved = all.filter((k) => k.startsWith('archive/codex/') && k.endsWith('/tobin-reyes.md'));
  assert.equal(moved.length, 1, `archived under archive/codex: ${moved}`);
  assert.equal(Buffer.compare(await read(root, moved[0]), bytes), 0, 'content unchanged');
  const diag = (await request(port, 'GET', `/api/books/${CG}/diagnostics`)).json;
  const items = diag.items ?? diag;
  assert.ok(items.some((d) => d.code === 'W303'), 'links into the archive now show W303');
  assert.ok(!items.some((d) => d.severity === 'error'));

  const back = await send(port, 'POST', ROUTES.restore(CG), { body: { path: moved[0], base_sha256: sha(bytes) } });
  assert.equal(back.status, 200, back.text);
  assert.equal(Buffer.compare(await read(root, P.tobin), bytes), 0);
  assert.equal(await exists(root, moved[0]), false);
  assert.equal((await request(port, 'GET', `/api/books/${CG}/entries/${ID.tobin}`)).status, 200);
});

test('archive refuses a stale base and writes nothing', async () => {
  const { root, port } = await fresh();
  const bytes = await read(root, P.tobin);
  await fs.writeFile(path.join(root, ...P.tobin.split('/')), Buffer.concat([bytes, Buffer.from('\nedited\n')]));
  const before = await snap(root);
  const r = await send(port, 'POST', ROUTES.archive(CG, ID.tobin), { body: { base_sha256: sha(bytes) } });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(await snap(root), before);
});

// ---------------------------------------------------------------------------------------------------------------- 4 types

test('new type: creates codex/_types/<type>.md and the type is then defined', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const r = await send(port, 'POST', ROUTES.types(CG), { body: { type: 'spell', name: 'Spell', plural: 'Spells', fields: ['School', 'Cost'] } });
  assert.equal(r.status, 201, r.text);
  const after_ = await snap(root);
  assert.deepEqual(Object.keys(after_).filter((k) => !(k in before)), ['codex/_types/spell.md']);
  const text = await readText(root, 'codex/_types/spell.md');
  assert.ok(text.startsWith('---\nschema: storyforge.codex-type/v1\n'));
  const { fm } = frontMatter(text);
  assert.match(fm.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual([fm.type, fm.name, fm.plural, fm.fields], ['spell', 'Spell', 'Spells', ['School', 'Cost']]);
  const types = (await request(port, 'GET', `/api/books/${CG}/codex/types`)).json;
  const spell = types.find((t) => t.type === 'spell');
  assert.equal(spell.defined, true);
  assert.deepEqual(spell.fields, ['School', 'Cost']);
});

test('new type refusals write nothing: TYPE_EXISTS', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const r = await send(port, 'POST', ROUTES.types(CG), { body: { type: 'ship', name: 'Ship' } });
  assert.ok(WRITE_ERR(r.status), r.text);
  assert.equal(r.json.code, 'TYPE_EXISTS');
  assert.deepEqual(await snap(root), before);
});

// ---------------------------------------------------------------------------------------------------------------- 4 dry run, guard

test('dry runs write nothing and return the would-be changes', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const calls = [
    ['POST', ROUTES.create(CG), { type: 'ship', name: 'Dry Ship', dryRun: true }],
    ['POST', ROUTES.fields(CG, ID.maren), { name: 'Dry', aliases: ['x'], dryRun: true }],
    ['POST', ROUTES.slug(CG, ID.maren), { slug: 'dry-slug', dryRun: true }],
    ['POST', ROUTES.archive(CG, ID.maren), { dryRun: true }],
    ['POST', ROUTES.types(CG), { type: 'dryspell', name: 'Dry', dryRun: true }],
  ];
  for (const [m, p, body] of calls) {
    const r = await send(port, m, p, { body });
    assert.equal(r.status, 200, `${p}: ${r.text}`);
    assert.equal(r.json.dryRun ?? true, true);
    assert.deepEqual(await snap(root), before, p);
  }
  const fieldsPreview = (await send(port, 'POST', ROUTES.fields(CG, ID.maren), { body: { name: 'Dry', dryRun: true } })).json;
  assert.ok(Array.isArray(fieldsPreview.changes) && fieldsPreview.changes.length > 0, 'the fields preview carries diffs');
});

test('every write route is 403 without the write guard and writes nothing', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const bytes = await read(root, P.maren);
  const calls = [
    ['POST', ROUTES.create(CG), { type: 'ship', name: 'Nope' }],
    ['POST', ROUTES.fields(CG, ID.maren), { name: 'Nope' }],
    ['POST', ROUTES.slug(CG, ID.maren), { slug: 'nope' }],
    ['POST', ROUTES.archive(CG, ID.maren), {}],
    ['POST', ROUTES.restore(CG), { path: 'archive/codex/characters/maren-hollis.md', base_sha256: sha(bytes) }],
    ['POST', ROUTES.types(CG), { type: 'nope', name: 'Nope' }],
    ['PUT', ROUTES.body(CG, ID.maren), { body: 'x\n', base_sha256: sha(bytes) }],
  ];
  for (const [m, p, body] of calls) {
    const noHeader = await send(port, m, p, { headers: { 'content-type': 'application/json' }, body });
    assert.equal(noHeader.status, 403, `${m} ${p} without x-storyforge`);
    const wrongType = await send(port, m, p, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' }, body });
    assert.equal(wrongType.status, 403, `${m} ${p} with a wrong content type`);
  }
  assert.deepEqual(await snap(root), before);
});

// ---------------------------------------------------------------------------------------------------------------- 5

test('entry body PUT: new body saved, front matter bytes identical, new sha256 returned', async () => {
  const { root, port } = await fresh();
  const bytes = await read(root, P.maren);
  const text = bytes.toString('utf8');
  const split = text.indexOf('\n---\n', 3) + 5;
  const r = await send(port, 'PUT', ROUTES.body(CG, ID.maren), { body: { body: '## Overview\nRewritten, with [[port-aldine]].\n', base_sha256: sha(bytes) } });
  assert.equal(r.status, 200, r.text);
  const now = await read(root, P.maren);
  assert.equal(Buffer.compare(now.subarray(0, split), bytes.subarray(0, split)), 0, 'front matter bytes unchanged');
  assert.equal(now.subarray(split).toString('utf8'), '## Overview\nRewritten, with [[port-aldine]].\n');
  assert.equal(r.json.sha256, sha(now));
  // the new sha is a valid base for the next save
  const again = await send(port, 'PUT', ROUTES.body(CG, ID.maren), { body: { body: 'Second.\n', base_sha256: r.json.sha256 } });
  assert.equal(again.status, 200, again.text);
});

test('entry body PUT keeps CRLF front matter bytes', async () => {
  const toCrlf = async (root) => {
    const f = path.join(root, ...P.tobin.split('/'));
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/\n/g, '\r\n'));
  };
  const { root, port } = await fresh({ prep: toCrlf });
  const bytes = await read(root, P.tobin);
  const split = bytes.indexOf(Buffer.from('\r\n---\r\n', 'utf8'), 3) + 7;
  const r = await send(port, 'PUT', ROUTES.body(CG, ID.tobin), { body: { body: 'New text.\n', base_sha256: sha(bytes) } });
  assert.equal(r.status, 200, r.text);
  const now = await read(root, P.tobin);
  assert.equal(Buffer.compare(now.subarray(0, split), bytes.subarray(0, split)), 0);
  assert.ok(now.toString('utf8').includes('New text.'));
});

test('entry body PUT: a stale base is a 409 with the current version and the disk keeps the external edit', async () => {
  const { root, port } = await fresh();
  const bytes = await read(root, P.maren);
  const external = Buffer.concat([bytes, Buffer.from('External line.\n')]);
  await fs.writeFile(path.join(root, ...P.maren.split('/')), external);
  const r = await send(port, 'PUT', ROUTES.body(CG, ID.maren), { body: { body: 'stale\n', base_sha256: sha(bytes) } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, 'conflict');
  assert.equal(r.json.current.sha256, sha(external));
  assert.match(r.json.current.body, /External line\./);
  assert.equal(Buffer.compare(await read(root, P.maren), external), 0);
});

test('entry body PUT: malformed body 400, unknown entry 404, nothing written', async () => {
  const { root, port } = await fresh();
  const before = await snap(root);
  const bad = await send(port, 'PUT', ROUTES.body(CG, ID.maren), { body: '{not json' });
  assert.equal(bad.status, 400);
  const noBase = await send(port, 'PUT', ROUTES.body(CG, ID.maren), { body: { body: 'x\n' } });
  assert.equal(noBase.status, 400);
  const nf = await send(port, 'PUT', ROUTES.body(CG, 'entry_01CG00000000000000000000ZZ'), { body: { body: 'x\n', base_sha256: 'a'.repeat(64) } });
  assert.equal(nf.status, 404);
  assert.deepEqual(await snap(root), before);
});
