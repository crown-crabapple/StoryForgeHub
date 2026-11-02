// M02-J03 acceptance 7: open another folder through POST /api/library/open, with real main.mjs child processes.
// Recents live in a per-user config file; every server here gets a temp APPDATA / XDG_CONFIG_HOME / HOME.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { copyFixture, request } from './helpers.mjs';
import { GOOD, LOCK_NAME, killAll, startServer, waitFor } from './proc-helpers.mjs';

after(killAll);

const BOOK_SALT = 'book_01S5000000000000000000000A';
const exists = (p) => fs.access(p).then(() => true, () => false);

/** A fresh per-user config area; children spawned inside `withConfig` inherit it. */
async function newConfig() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-cfg-'));
  return {
    home,
    env: { APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, 'xdg'), HOME: home, USERPROFILE: home },
    recentFile: process.platform === 'win32' ? path.join(home, 'AppData', 'StoryForge', 'recent.json') : path.join(home, 'xdg', 'storyforge', 'recent.json'),
  };
}

async function startWith(cfg, root) {
  const saved = Object.fromEntries(Object.keys(cfg.env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, cfg.env);
  const pending = startServer(root); // spawn happens synchronously, so the child has its env already
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return pending;
}

function post(port, pathname, body, headers = GOOD) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: pathname, headers: { Host: `127.0.0.1:${port}`, 'content-length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const openLib = (port, p) => post(port, '/api/library/open', { path: p });
const health = async (port) => (await request(port, 'GET', '/api/health')).json;
const books = async (port) => (await request(port, 'GET', '/api/books')).json;
const readLock = async (root) => JSON.parse(await fs.readFile(path.join(root, LOCK_NAME), 'utf8'));
const lockExists = (root) => exists(path.join(root, LOCK_NAME));

/** GET /api/library/recent -> list of paths (items may be strings or { path, ... }). */
async function recentItems(port) {
  const r = await request(port, 'GET', '/api/library/recent');
  assert.equal(r.status, 200, r.text);
  const list = Array.isArray(r.json) ? r.json : (r.json.recent ?? r.json.libraries ?? r.json.paths ?? r.json.items);
  assert.ok(Array.isArray(list), `recent list not found in ${r.text}`);
  return list.map((i) => (typeof i === 'string' ? { path: i } : i));
}
const recentPaths = async (port) => (await Promise.all((await recentItems(port)).map(async (i) => i.path))).map((p) => path.resolve(p).toLowerCase());
const norm = (p) => path.resolve(p).toLowerCase();

/** Two servers' worth of fixtures: A (a book root) and B (the covers library). */
async function twoLibraries() {
  const a = await copyFixture('valid/salt-orchard');
  const b = await copyFixture('valid/covers');
  const cfg = await newConfig();
  const s = await startWith(cfg, a);
  return { a, b, cfg, s };
}

test('switch A -> B: listBooks shows B, A lock released, B lock held, recents updated, then back to A', async () => {
  const { a, b, cfg, s } = await twoLibraries();
  assert.equal(norm((await health(s.port)).library), norm(a));
  assert.equal((await readLock(a)).pid, s.pid);
  assert.equal(await lockExists(b), false);
  const aBooks = (await books(s.port)).map((x) => x.id);
  assert.deepEqual(aBooks, [BOOK_SALT]);

  const r = await openLib(s.port, b);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  const libRoot = typeof r.json.library === 'string' ? r.json.library : r.json.library?.root;
  assert.equal(norm(libRoot), norm(b), 'response names the new library');

  assert.equal(norm((await health(s.port)).library), norm(b));
  const bBooks = await books(s.port);
  assert.equal(bBooks.length, 6, 'the covers library has six books');
  assert.ok(!bBooks.some((x) => x.id === BOOK_SALT), 'A is no longer served');
  assert.equal(await lockExists(a), false, 'A lock released');
  assert.equal((await readLock(b)).pid, s.pid, 'B lock held by this instance');
  assert.equal((await request(s.port, 'GET', '/api/status')).json.instance.pid, s.pid);

  // recents: B most recent, A (opened from the command line) also there; stored in the per-user file
  const recent = await recentPaths(s.port);
  assert.equal(recent[0], norm(b));
  assert.ok(recent.includes(norm(a)), 'the --library path is in recents');
  assert.equal(await exists(cfg.recentFile), true, `recents file at ${cfg.recentFile}`);
  JSON.parse(await fs.readFile(cfg.recentFile, 'utf8'));
  assert.equal(await exists(path.join(b, 'recent.json')), false, 'recents are not written into author data');

  // and back
  const back = await openLib(s.port, a);
  assert.equal(back.status, 200, back.text);
  assert.deepEqual((await books(s.port)).map((x) => x.id), [BOOK_SALT]);
  assert.equal(await lockExists(b), false, 'B lock released on the way back');
  assert.equal((await readLock(a)).pid, s.pid);
  assert.equal((await recentPaths(s.port))[0], norm(a));
});

test('after a switch the write routes act on the new library only', async () => {
  const { a, b, s } = await twoLibraries();
  assert.equal((await openLib(s.port, b)).status, 200);
  const list = await books(s.port);
  const first = list.find((x) => x.slug === 'north-road');
  const detail = (await request(s.port, 'GET', `/api/books/${first.id}`)).json;
  const scene = detail.acts[0].chapters[0].scenes[0];
  const full = (await request(s.port, 'GET', `/api/books/${first.id}/scenes/${scene.id}`)).json;
  const w = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ body: 'Changed in B.\n', base_sha256: full.sha256 });
    const req = http.request(
      { host: '127.0.0.1', port: s.port, method: 'PUT', path: `/api/books/${first.id}/scenes/${scene.id}/body`, headers: { Host: `127.0.0.1:${s.port}`, 'content-length': Buffer.byteLength(payload), ...GOOD } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end(payload);
  });
  assert.equal(w, 200);
  assert.ok((await fs.readFile(path.join(b, scene.path), 'utf8')).includes('Changed in B.'));
  assert.equal(await exists(path.join(a, scene.path)), false, 'A is untouched');
});

test('bad paths: right codes, 400, and library A stays open and locked', async () => {
  const { a, s } = await twoLibraries();
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-badpath-'));
  const file = path.join(tmp, 'a-file.txt');
  await fs.writeFile(file, 'x');
  const empty = path.join(tmp, 'empty');
  await fs.mkdir(empty);
  const tooDeep = path.join(tmp, 'deep');
  await fs.mkdir(path.join(tooDeep, 'one', 'two', 'three'), { recursive: true });
  await fs.writeFile(path.join(tooDeep, 'one', 'two', 'three', 'book.md'), '---\nschema: storyforge.book/v1\nid: book_01S5000000000000000000000Z\nslug: deep\ntitle: Deep\nprofile: fiction\nstatus: planning\n---\n');

  const cases = [
    ['missing path', path.join(tmp, 'does-not-exist'), 'NOT_FOUND'],
    ['a file, not a folder', file, 'NOT_A_FOLDER'],
    ['a folder with no books', empty, 'NO_BOOKS'],
    ['a book three levels down (deeper than two)', tooDeep, 'NO_BOOKS'],
  ];
  for (const [label, p, code] of cases) {
    const r = await openLib(s.port, p);
    assert.equal(r.status, 400, `${label}: ${r.text}`);
    assert.equal(r.json.ok, false, label);
    assert.equal(r.json.code, code, `${label}: ${r.text}`);
  }

  // relative path, and a folder inside a .storyforge/ folder: refused (code from the contract's set)
  await fs.mkdir(path.join(a, '.storyforge', 'inner'), { recursive: true });
  for (const [label, p] of [['relative path', 'some/relative/path'], ['inside .storyforge', path.join(a, '.storyforge', 'inner')]]) {
    const r = await openLib(s.port, p);
    assert.equal(r.status, 400, `${label}: ${r.text}`);
    assert.equal(r.json.ok, false, label);
    assert.ok(['NOT_FOUND', 'NOT_A_FOLDER', 'NO_BOOKS'].includes(r.json.code), `${label}: ${r.text}`);
  }

  // missing / non-string path
  for (const body of [{}, { path: 42 }, { path: '' }]) {
    const r = await post(s.port, '/api/library/open', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await post(s.port, '/api/library/open', 'not json')).status, 400);

  // A is unharmed
  assert.equal(norm((await health(s.port)).library), norm(a));
  assert.deepEqual((await books(s.port)).map((x) => x.id), [BOOK_SALT]);
  assert.equal((await readLock(a)).pid, s.pid);
  const recent = await recentPaths(s.port);
  for (const p of [empty, file, tooDeep]) assert.ok(!recent.includes(norm(p)), `${p} must not be in recents`);
});

test('a folder is a valid target when it is itself a book, or has books one or two levels down', async () => {
  const { s } = await twoLibraries();
  const covers = await copyFixture('valid/covers');
  const libraryFx = await copyFixture('valid/library');
  const lone = await copyFixture('valid/spec-example');
  for (const p of [covers, libraryFx, lone]) {
    const r = await openLib(s.port, p);
    assert.equal(r.status, 200, `${p}: ${r.text}`);
    assert.equal(norm((await health(s.port)).library), norm(p));
    assert.ok((await books(s.port)).length >= 1);
  }
});

test('a folder locked by another instance: 409 LOCKED with the holder, library A stays open', async () => {
  const { a, b, s } = await twoLibraries();
  const holderCfg = await newConfig();
  const holder = await startWith(holderCfg, b); // a second main.mjs holds B
  assert.equal((await readLock(b)).pid, holder.pid);

  const r = await openLib(s.port, b);
  assert.equal(r.status, 409, r.text);
  assert.equal(String(r.json.code ?? r.json.error).toUpperCase(), 'LOCKED', r.text);
  assert.ok(r.text.includes(String(holder.pid)), `response names the holder pid ${holder.pid}: ${r.text}`);

  // A is still served, still locked by us; B is still locked by the other instance
  assert.equal(norm((await health(s.port)).library), norm(a));
  assert.deepEqual((await books(s.port)).map((x) => x.id), [BOOK_SALT]);
  assert.equal((await readLock(a)).pid, s.pid);
  assert.equal((await readLock(b)).pid, holder.pid, 'the other instance keeps its lock');
  assert.equal((await health(holder.port)).ok, true, 'the other instance is unharmed');
  assert.ok(!(await recentPaths(s.port)).includes(norm(b)), 'a refused open is not added to recents');

  // once the holder is gone, the same request works
  await holder.stop();
  const again = await waitFor(async () => {
    const x = await openLib(s.port, b);
    return x.status === 200 ? x : null;
  }, { what: 'open B after the other instance stopped' });
  assert.equal(again.json.ok, true);
  assert.equal((await readLock(b)).pid, s.pid);
  assert.equal(await lockExists(a), false);
});

test('recents: newest first, no duplicates, at most 8, survives a restart', async () => {
  const cfg = await newConfig();
  const start = await copyFixture('valid/salt-orchard');
  const s = await startWith(cfg, start);
  const dirsOpened = [];
  for (let i = 0; i < 10; i++) {
    const d = await copyFixture('valid/salt-orchard');
    dirsOpened.push(d);
    const r = await openLib(s.port, d);
    assert.equal(r.status, 200, r.text);
  }
  let recent = await recentPaths(s.port);
  assert.equal(recent.length, 8, 'only the last 8 are kept');
  assert.deepEqual(recent, dirsOpened.slice(2).reverse().map(norm), 'newest first; the two oldest (and the CLI one) dropped');

  // reopening an older entry moves it to the front without duplicating it
  const older = dirsOpened[5];
  assert.equal((await openLib(s.port, older)).status, 200);
  recent = await recentPaths(s.port);
  assert.equal(recent.length, 8);
  assert.equal(recent[0], norm(older));
  assert.equal(new Set(recent).size, 8, 'no duplicates');

  // a restart reads the same list back from the user config file
  await s.stop();
  const s2 = await startWith(cfg, start);
  const after = await recentPaths(s2.port);
  assert.equal(after[0], norm(start), 'the new --library path goes to the front');
  assert.deepEqual(after.slice(1, 8), recent.slice(0, 7), 'the rest of the list survived the restart');
  assert.ok(after.length <= 8);
});

test('recents: a folder that disappeared is flagged not found, and Remove drops it', async () => {
  const cfg = await newConfig();
  const start = await copyFixture('valid/salt-orchard');
  const s = await startWith(cfg, start);
  const gone = await copyFixture('valid/covers');
  assert.equal((await openLib(s.port, gone)).status, 200);
  assert.equal((await openLib(s.port, start)).status, 200);
  assert.equal(await lockExists(gone), false);
  await fs.rm(gone, { recursive: true, force: true });

  const items = await recentItems(s.port);
  const missing = items.find((i) => norm(i.path) === norm(gone));
  assert.ok(missing, 'a vanished folder stays in the list');
  assert.ok(missing.exists === false || missing.missing === true || missing.found === false || missing.not_found === true, `flagged as not found: ${JSON.stringify(missing)}`);
  const present = items.find((i) => norm(i.path) === norm(start));
  assert.ok(!(present.exists === false || present.missing === true || present.found === false || present.not_found === true), 'an existing folder is not flagged');

  // opening it says so in the contract's words
  const r = await openLib(s.port, gone);
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'NOT_FOUND');

  const rm = await post(s.port, '/api/library/recent/remove', { path: gone });
  assert.equal(rm.status, 200, rm.text);
  assert.ok(!(await recentPaths(s.port)).includes(norm(gone)), 'removed from the list');
  assert.ok((await recentPaths(s.port)).includes(norm(start)), 'others stay');
  // removing something that is not listed is harmless
  assert.equal((await post(s.port, '/api/library/recent/remove', { path: gone })).status, 200);
  assert.equal((await post(s.port, '/api/library/recent/remove', {})).status, 400);
  // the file on disk agrees
  assert.ok(!(await fs.readFile(cfg.recentFile, 'utf8')).toLowerCase().includes(path.basename(gone).toLowerCase()), 'recent.json no longer names it');
});

test('the new write routes are guarded like the others: no x-storyforge header -> 403 and nothing changes', async () => {
  const { a, b, s } = await twoLibraries();
  const noHeader = { 'content-type': 'application/json' };
  const r1 = await post(s.port, '/api/library/open', { path: b }, noHeader);
  assert.equal(r1.status, 403, r1.text);
  const r2 = await post(s.port, '/api/library/recent/remove', { path: a }, noHeader);
  assert.equal(r2.status, 403, r2.text);
  assert.equal(norm((await health(s.port)).library), norm(a), 'still on A');
  assert.ok((await recentPaths(s.port)).includes(norm(a)), 'recents untouched');
  // GET on the write route is not a way in
  const g = await request(s.port, 'GET', '/api/library/open');
  assert.notEqual(g.status, 200);
  assert.equal(norm((await health(s.port)).library), norm(a));
});

test('GET /api/library/recent on a fresh config is an empty-or-just-this-library list, never an error', async () => {
  const cfg = await newConfig();
  const start = await copyFixture('valid/salt-orchard');
  const s = await startWith(cfg, start);
  const recent = await recentPaths(s.port);
  assert.ok(recent.length <= 1);
  if (recent.length === 1) assert.equal(recent[0], norm(start));
  // a corrupt recents file does not break serving
  await s.stop();
  await fs.mkdir(path.dirname(cfg.recentFile), { recursive: true });
  await fs.writeFile(cfg.recentFile, '{ this is not json');
  const s2 = await startWith(cfg, start);
  assert.equal((await health(s2.port)).ok, true);
  const again = await request(s2.port, 'GET', '/api/library/recent');
  assert.equal(again.status, 200, again.text);
});
