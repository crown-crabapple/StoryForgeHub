// M02-J03 acceptance 9: the M02 milestone gate, end to end with a real server process.
// "A user can create, open, search, and archive a fixture book through the reference-style library with no
// database setup."
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { copyFixture, request } from './helpers.mjs';
import { GOOD, LOCK_NAME, flatScenes, killAll, startServer, waitFor } from './proc-helpers.mjs';

after(killAll);

const exists = (p) => fs.access(p).then(() => true, () => false);
const norm = (p) => path.resolve(p).toLowerCase();

function send(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${port}`, ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload), ...GOOD }) };
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function findStoryforgeDirs(dir) {
  const found = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === '.storyforge') found.push(full);
    else found.push(...(await findStoryforgeDirs(full)));
  }
  return found;
}

function frontMatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const end = lines.indexOf('---', 1);
  return { fm: YAML.parse(lines.slice(1, end).join('\n')), body: lines.slice(end + 1).join('\n') };
}

test('M02 gate: create from story-circle, see it as a cover card, search its plan, archive a scene, switch folders and back', async () => {
  // user-level config in a temp area: no real recents file is touched
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gate-cfg-'));
  Object.assign(process.env, { APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, 'xdg'), HOME: home, USERPROFILE: home });

  const libA = await copyFixture('valid/covers');
  const libB = await copyFixture('valid/library');
  assert.deepEqual(await findStoryforgeDirs(libA), [], 'no .storyforge/ anywhere to begin with');
  assert.deepEqual(await findStoryforgeDirs(libB), []);

  const s = await startServer(libA);
  const port = s.port;

  // templates are offered
  const t = await request(port, 'GET', '/api/templates');
  assert.equal(t.status, 200, t.text);
  const tlist = Array.isArray(t.json) ? t.json : t.json.templates;
  assert.deepEqual(tlist.map((x) => x.name).sort(), ['blank', 'heros-journey', 'seven-point', 'story-circle']);
  const circle = tlist.find((x) => x.name === 'story-circle');
  assert.deepEqual({ acts: circle.acts, chapters: circle.chapters, scenes: circle.scenes }, { acts: 2, chapters: 8, scenes: 8 });

  // 1. create
  const startCount = (await request(port, 'GET', '/api/books')).json.length;
  const created = await send(port, 'POST', '/api/books', { title: 'The Gate Book', template: 'story-circle', penName: 'a-marsh' });
  assert.ok([200, 201].includes(created.status), `${created.status} ${created.text}`);
  assert.equal(created.json.ok, true, created.text);
  const bookId = created.json.bookId;
  assert.match(bookId, /^book_/);
  const folder = path.isAbsolute(created.json.path) ? created.json.path : path.join(libA, created.json.path);
  assert.equal(await exists(path.join(folder, 'book.md')), true);

  // 2. it is a cover card entry
  const list = (await request(port, 'GET', '/api/books')).json;
  assert.equal(list.length, startCount + 1);
  const card = list.find((b) => b.id === bookId);
  assert.ok(card, 'the new book is in /api/books');
  assert.equal(card.title, 'The Gate Book');
  assert.equal(card.slug, 'the-gate-book');
  assert.equal(card.cover_state, 'none');
  assert.equal(card.pen_name, 'a-marsh');
  assert.equal(card.pen_name_display, 'A. Marsh');
  assert.equal(card.scene_count, 8);

  // 3. search finds a word from its plan
  const plan = frontMatter(await fs.readFile(path.join(folder, 'planning', 'plan.md'), 'utf8'));
  const word = (plan.body.match(/[A-Za-z]{7,}/g) ?? []).map((w) => w.toLowerCase()).sort((x, y) => y.length - x.length)[0];
  assert.ok(word, 'plan.md has a searchable word');
  await waitFor(async () => (await request(port, 'GET', '/api/status')).json.books.find((b) => b.book_id === bookId)?.index === 'fresh', { what: 'fresh index for the new book', timeout: 30000 });
  const hits = (await request(port, 'GET', `/api/search?q=${encodeURIComponent(word)}&book=${bookId}`)).json;
  assert.ok(hits.some((h) => h.id === plan.fm.id), `search for "${word}" finds the plan doc: ${JSON.stringify(hits)}`);

  // 4. archive one scene through the J02 route; the book stays valid
  const detail = (await request(port, 'GET', `/api/books/${bookId}`)).json;
  const scenes = flatScenes(detail);
  assert.equal(scenes.length, 8);
  const victim = scenes[2];
  const full = (await request(port, 'GET', `/api/books/${bookId}/scenes/${victim.id}`)).json;
  const arch = await send(port, 'POST', `/api/books/${bookId}/scenes/${victim.id}/archive`, { base_sha256: full.sha256 });
  assert.equal(arch.status, 200, arch.text);
  assert.equal(await exists(path.join(libA, victim.path)), false, 'the scene file left manuscript/');
  assert.equal(await exists(path.join(folder, 'archive')), true, 'archived under archive/');
  const after = flatScenes((await request(port, 'GET', `/api/books/${bookId}`)).json);
  assert.equal(after.length, 7);
  assert.ok(!after.some((x) => x.id === victim.id));
  const diags = (await request(port, 'GET', `/api/books/${bookId}/diagnostics`)).json;
  assert.deepEqual(diags.filter((d) => d.severity === 'error'), [], 'book has no errors after archiving');
  const lib = (await request(port, 'GET', '/api/library')).json;
  assert.deepEqual(lib.diagnostics.filter((d) => d.severity === 'error'), []);

  // 5. open another folder and back, with no setup step in between
  const open = await send(port, 'POST', '/api/library/open', { path: libB });
  assert.equal(open.status, 200, open.text);
  const bBooks = (await request(port, 'GET', '/api/books')).json;
  assert.ok(bBooks.length >= 1);
  assert.ok(!bBooks.some((b) => b.id === bookId), 'the new book belongs to the other library');
  assert.equal(await exists(path.join(libA, LOCK_NAME)), false, 'first library released');
  assert.equal(JSON.parse(await fs.readFile(path.join(libB, LOCK_NAME), 'utf8')).pid, s.pid);

  const back = await send(port, 'POST', '/api/library/open', { path: libA });
  assert.equal(back.status, 200, back.text);
  const again = (await request(port, 'GET', '/api/books')).json;
  assert.equal(again.length, startCount + 1);
  const cardAgain = again.find((b) => b.id === bookId);
  assert.ok(cardAgain, 'the created book is still there');
  assert.equal(cardAgain.scene_count, 7, 'and still has the archive applied');
  assert.equal(cardAgain.cover_state, 'none');
  await waitFor(async () => (await request(port, 'GET', '/api/status')).json.books.find((b) => b.book_id === bookId)?.index === 'fresh', { what: 'fresh index after returning', timeout: 30000 });
  const hits2 = (await request(port, 'GET', `/api/search?q=${encodeURIComponent(word)}&book=${bookId}`)).json;
  assert.ok(hits2.some((h) => h.id === plan.fm.id), 'search still works after the round trip');

  // the creation left nothing half-done behind
  const staging = await fs.readdir(path.join(libA, '.storyforge', 'staging')).catch(() => []);
  assert.deepEqual(staging, [], 'no staging folder left');
});

test('M02 gate: a second book from another template can be created right after, and ids never collide', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gate-cfg-'));
  Object.assign(process.env, { APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, 'xdg'), HOME: home, USERPROFILE: home });
  const lib = await copyFixture('valid/covers');
  const s = await startServer(lib);
  const a = await send(s.port, 'POST', '/api/books', { title: 'Alpha', template: 'blank' });
  const b = await send(s.port, 'POST', '/api/books', { title: 'Beta', template: 'seven-point', seriesSlug: 'harbour-lights' });
  assert.equal(a.json.ok, true, a.text);
  assert.equal(b.json.ok, true, b.text);
  const list = (await request(s.port, 'GET', '/api/books')).json;
  const alpha = list.find((x) => x.id === a.json.bookId);
  const beta = list.find((x) => x.id === b.json.bookId);
  assert.equal(alpha.scene_count, 1);
  assert.equal(beta.scene_count, 7);
  assert.equal(beta.series, 'harbour-lights');
  assert.equal(beta.series_number, 3);
  const lib2 = (await request(s.port, 'GET', '/api/library')).json;
  assert.deepEqual(lib2.diagnostics, [], 'whole library validates clean');
});

test('POST /api/books: refusals come back as { ok:false, code, field, message } with a 4xx and nothing written', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-gate-cfg-'));
  Object.assign(process.env, { APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, 'xdg'), HOME: home, USERPROFILE: home });
  const lib = await copyFixture('valid/covers');
  const s = await startServer(lib);
  const before = (await request(s.port, 'GET', '/api/books')).json.length;
  for (const [body, code, field] of [
    [{ title: '', template: 'blank' }, 'BAD_TITLE', 'title'],
    [{ title: 'North Road', template: 'blank' }, 'SLUG_TAKEN', 'slug'],
    [{ title: 'X', template: 'nope' }, 'NO_SUCH_TEMPLATE', 'template'],
    [{ title: 'X', template: 'blank', seriesSlug: 'harbour-lights', seriesNumber: 1 }, 'SERIES_NUMBER_TAKEN', 'seriesNumber'],
  ]) {
    const r = await send(s.port, 'POST', '/api/books', body);
    assert.ok(r.status >= 400 && r.status < 500, `${code}: status ${r.status}`);
    assert.equal(r.json.ok, false, r.text);
    assert.equal(r.json.code, code, r.text);
    assert.equal(r.json.field, field, r.text);
    assert.ok(r.json.message);
  }
  assert.equal((await request(s.port, 'GET', '/api/books')).json.length, before);
  // the guard: no x-storyforge header -> 403
  const raw = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ title: 'Sneaky', template: 'blank' });
    const req = http.request(
      { host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/books', headers: { Host: `127.0.0.1:${s.port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end(payload);
  });
  assert.equal(raw, 403);
  assert.equal(await exists(path.join(lib, 'sneaky')), false);
  assert.equal(norm((await request(s.port, 'GET', '/api/health')).json.library), norm(lib));
});
