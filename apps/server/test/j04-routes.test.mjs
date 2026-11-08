// M03-J04 routes (contract sections 2, 5, 6; acceptance 2, 4, 5 and the PUT body `words` field):
//   GET  /api/books/:b/activity[?days=N]        POST /api/books/:b/activity/session   POST /api/books/:b/goal
//   GET  /api/books/:b/entries/:id
//   GET|POST /api/books/:b/scenes/:s/revisions  GET .../revisions/:file   POST .../revisions/:file/restore
// The server has no injectable clock, so nothing here depends on today's date: streak/date maths are tested
// against the pure functions (packages/core/test/writing-log.test.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { countWords, createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const SCENE = 'scene_01S50000000000000000000002'; // Arrival
const KEY = 'scene_01S50000000000000000000003';
const UNKNOWN_SCENE = 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const UNKNOWN_BOOK = 'book_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
const MAREN = 'entry_01S5000000000000000000000G';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };

const servers = [];
after(async () => {
  for (const s of servers) await close(s);
});

async function fresh(prep) {
  const root = await copyFixture('valid/salt-orchard');
  if (prep) await prep(root);
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const server = createServer({ repository: createFsRepository(root), webRoot });
  servers.push(server);
  const port = await listen(server);
  return { root, port };
}

function send(port, method, pathname, { headers = GOOD, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
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

const b = (p = '') => `/api/books/${BOOK}${p}`;
const getScene = async (port, id = SCENE) => (await request(port, 'GET', b(`/scenes/${id}`))).json;
const put = (port, id, body, base) => send(port, 'PUT', b(`/scenes/${id}/body`), { body: { body, base_sha256: base } });
const activity = async (port, q = '') => (await request(port, 'GET', b(`/activity${q}`))).json;
const listOf = (json) => (Array.isArray(json) ? json : json.revisions);
const listRevs = async (port, id = SCENE) => {
  const r = await request(port, 'GET', b(`/scenes/${id}/revisions`));
  assert.equal(r.status, 200, r.text);
  return listOf(r.json);
};
const frontMatterOf = (text) => text.slice(0, text.indexOf('\n---\n', 3) + 5);

// ------------------------------------------------------------------ PUT body response: words

test('PUT body response carries words { added, removed } matching a word-level recount', async () => {
  const { port } = await fresh();
  const scene = await getScene(port);
  const oldWords = countWords(scene.body);
  const r = await put(port, SCENE, 'alpha beta gamma\n', scene.sha256);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.sha256, 'sha256 still returned');
  assert.deepEqual(r.json.words, { added: 3, removed: oldWords });
});

test('PUT body with an identical body reports words 0/0', async () => {
  const { port } = await fresh();
  const scene = await getScene(port);
  const r = await put(port, SCENE, scene.body, scene.sha256);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.words, { added: 0, removed: 0 });
});

test('PUT body: appending words counts only the appended words; Unicode counts per whitespace token', async () => {
  const { port } = await fresh();
  const scene = await getScene(port);
  const r = await put(port, SCENE, scene.body + '\n潮が引く、そして戻る。 émigré naïve\n', scene.sha256);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.words, { added: 3, removed: 0 });
});

test('PUT body: comments and fenced code never count', async () => {
  const { port } = await fresh();
  const scene = await getScene(port);
  const r = await put(port, SCENE, scene.body + '\n<!-- note: one two three four -->\n\n```\nfive six seven\n```\n', scene.sha256);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.words, { added: 0, removed: 0 });
});

test('a stale-base PUT (409) does not add to the day total', async () => {
  const { port } = await fresh();
  const scene = await getScene(port);
  const before = (await activity(port)).today;
  const r = await put(port, SCENE, 'x y z\n', 'a'.repeat(64));
  assert.equal(r.status, 409);
  assert.deepEqual((await activity(port)).today, before);
  assert.equal((await getScene(port)).sha256, scene.sha256);
});

// ------------------------------------------------------------------ activity

test('GET activity: fresh book has the documented shape, zeros, goal null, streak 0', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', b('/activity?days=30'));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.goal, null);
  assert.deepEqual(r.json.today, { added: 0, removed: 0, net: 0, minutes: 0, sessions: 0, ai_words: 0 });
  assert.deepEqual(r.json.totals, { human_words: 0, ai_words: 0, ai_share: 0 });
  assert.ok(Array.isArray(r.json.days));
  assert.equal(r.json.streak, 0);
});

test('GET activity: saves accumulate into today (added, removed, net)', async () => {
  const { port } = await fresh();
  let scene = await getScene(port);
  const oldWords = countWords(scene.body);
  const r1 = await put(port, SCENE, 'alpha beta gamma\n', scene.sha256);
  scene = await getScene(port);
  const r2 = await put(port, SCENE, 'alpha beta gamma delta epsilon\n', scene.sha256);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json.words, { added: 2, removed: 0 });
  const today = (await activity(port)).today;
  assert.equal(today.added, 5);
  assert.equal(today.removed, oldWords);
  assert.equal(today.net, 5 - oldWords);
});

test('GET activity: raw saves and split do not count', async () => {
  const { root, port } = await fresh();
  const key = await getScene(port, KEY);
  const file = path.join(root, key.path);
  const content = (await fs.readFile(file, 'utf8')) + '\nplenty of brand new words appended here\n';
  const raw = await send(port, 'PUT', b(`/scenes/${KEY}/raw`), { body: { content, base_sha256: key.sha256 } });
  assert.equal(raw.status, 200, raw.text);
  assert.equal((await activity(port)).today.added, 0, 'raw save is not a body save');

  const split = await send(port, 'POST', b(`/scenes/${KEY}/split`), { body: { atLine: 3 } });
  assert.equal(split.status, 200, split.text);
  const t = (await activity(port)).today;
  assert.equal(t.added, 0);
  assert.equal(t.removed, 0);
});

test('GET activity: days query never causes a 500; days=7 returns at most 7 rows', async () => {
  const { port } = await fresh();
  for (const q of ['days=0', 'days=-1', 'days=abc', 'days=100000', 'days=7']) {
    const r = await request(port, 'GET', b(`/activity?${q}`));
    assert.ok(r.status === 200 || r.status === 400, `${q} -> ${r.status}`);
  }
  assert.ok((await activity(port, '?days=7')).days.length <= 7);
});

test('GET activity: unknown book is 404', async () => {
  const { port } = await fresh();
  assert.equal((await request(port, 'GET', `/api/books/${UNKNOWN_BOOK}/activity`)).status, 404);
});

// ------------------------------------------------------------------ activity/session

test('POST activity/session { minutes } adds minutes and one session each to today', async () => {
  const { port } = await fresh();
  const r = await send(port, 'POST', b('/activity/session'), { body: { minutes: 12 } });
  assert.ok(r.status === 200 || r.status === 204, r.text);
  const r2 = await send(port, 'POST', b('/activity/session'), { body: { minutes: 3 } });
  assert.ok(r2.status === 200 || r2.status === 204, r2.text);
  const today = (await activity(port)).today;
  assert.equal(today.minutes, 15);
  assert.equal(today.sessions, 2);
});

test('POST activity/session refuses minutes < 1 and non-numbers (4xx) and records nothing', async () => {
  const { port } = await fresh();
  for (const body of [{ minutes: 0 }, { minutes: -4 }, { minutes: 'ten' }, {}, { minutes: null }]) {
    const r = await send(port, 'POST', b('/activity/session'), { body });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status}`);
  }
  const today = (await activity(port)).today;
  assert.equal(today.minutes, 0);
  assert.equal(today.sessions, 0);
});

test('POST activity/session: unknown book 404, malformed JSON 400', async () => {
  const { port } = await fresh();
  assert.equal((await send(port, 'POST', `/api/books/${UNKNOWN_BOOK}/activity/session`, { body: { minutes: 5 } })).status, 404);
  assert.equal((await send(port, 'POST', b('/activity/session'), { body: '{nope' })).status, 400);
});

// ------------------------------------------------------------------ goal (acceptance 2)

test('POST goal sets daily_word_goal as a single-line book.md edit; body untouched; activity reflects it', async () => {
  const { root, port } = await fresh();
  const bookFile = path.join(root, 'book.md');
  const before = await fs.readFile(bookFile, 'utf8');
  const r = await send(port, 'POST', b('/goal'), { body: { daily_word_goal: 500 } });
  assert.equal(r.status, 200, r.text);
  const after = await fs.readFile(bookFile, 'utf8');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert.equal(afterLines.length, beforeLines.length + 1, 'exactly one line added');
  assert.ok(afterLines.includes('daily_word_goal: 500'));
  assert.deepEqual(afterLines.filter((l) => l !== 'daily_word_goal: 500'), beforeLines);
  assert.equal(after.slice(after.indexOf('\n---\n', 3)), before.slice(before.indexOf('\n---\n', 3)), 'body untouched');
  assert.equal((await activity(port)).goal, 500);
});

test('POST goal changes an existing goal in place (exactly one line differs)', async () => {
  const { root, port } = await fresh();
  await send(port, 'POST', b('/goal'), { body: { daily_word_goal: 500 } });
  const mid = (await fs.readFile(path.join(root, 'book.md'), 'utf8')).split('\n');
  const r = await send(port, 'POST', b('/goal'), { body: { daily_word_goal: 750 } });
  assert.equal(r.status, 200, r.text);
  const end = (await fs.readFile(path.join(root, 'book.md'), 'utf8')).split('\n');
  assert.equal(end.length, mid.length);
  assert.deepEqual(end.filter((l, i) => l !== mid[i]), ['daily_word_goal: 750']);
  assert.equal((await activity(port)).goal, 750);
});

test('POST goal null is 400 NOT_SUPPORTED and writes nothing', async () => {
  const { root, port } = await fresh();
  await send(port, 'POST', b('/goal'), { body: { daily_word_goal: 500 } });
  const before = await snapshot(root);
  const r = await send(port, 'POST', b('/goal'), { body: { daily_word_goal: null } });
  assert.equal(r.status, 400, r.text);
  assert.match(JSON.stringify(r.json), /not_supported/i);
  assert.deepEqual(await snapshot(root), before);
});

test('POST goal refuses 0, negatives, fractions, strings and a missing field (4xx), writes nothing', async () => {
  const { root, port } = await fresh();
  const before = await snapshot(root);
  for (const body of [{ daily_word_goal: 0 }, { daily_word_goal: -3 }, { daily_word_goal: 2.5 }, { daily_word_goal: '500' }, {}]) {
    const r = await send(port, 'POST', b('/goal'), { body });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status}`);
  }
  assert.deepEqual(await snapshot(root), before);
});

test('POST goal: unknown book 404, malformed JSON 400', async () => {
  const { port } = await fresh();
  assert.equal((await send(port, 'POST', `/api/books/${UNKNOWN_BOOK}/goal`, { body: { daily_word_goal: 5 } })).status, 404);
  assert.equal((await send(port, 'POST', b('/goal'), { body: 'nope' })).status, 400);
});

// ------------------------------------------------------------------ entry preview (acceptance 5)

test('GET entries/:id returns name, type, status, fields and plain sections', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', b(`/entries/${MAREN}`));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.id, MAREN);
  assert.equal(r.json.slug, 'maren-hollis');
  assert.equal(r.json.name, 'Maren Hollis');
  assert.equal(r.json.type, 'character');
  assert.equal(r.json.status, 'canon');
  assert.equal(r.json.fields.Eyes, 'Grey');
  assert.equal(r.json.fields.Age, 34);
  assert.deepEqual(r.json.sections.map((s) => s.heading), ['Overview', 'Arc', 'Open threads']);
  assert.equal(r.json.sections[0].text, 'Cartographer who maps coastlines for a living and avoids her own.');
});

test('GET entries/:id: an entry without fields has empty fields', async () => {
  const { port } = await fresh();
  const r = await request(port, 'GET', b('/entries/entry_01S5000000000000000000000M'));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.slug, 'salt-orchard');
  assert.ok(r.json.fields === null || (typeof r.json.fields === 'object' && Object.keys(r.json.fields).length === 0));
  assert.equal(r.json.sections[0].heading, 'Overview');
});

test('GET entries/:id: section text is truncated to 600 characters', async () => {
  const { port } = await fresh(async (root) => {
    const f = path.join(root, 'codex/characters/maren-hollis.md');
    const t = await fs.readFile(f, 'utf8');
    await fs.writeFile(f, t.replace('Cartographer who maps coastlines for a living and avoids her own.', 'w'.repeat(2000)));
  });
  const r = await request(port, 'GET', b(`/entries/${MAREN}`));
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.sections[0].text.length <= 600);
  assert.ok(r.json.sections[0].text.length >= 590, 'truncated, not dropped');
});

test('GET entries/:id: section text is plain (no emphasis or [[link]] markup)', async () => {
  const { port } = await fresh(async (root) => {
    const f = path.join(root, 'codex/characters/maren-hollis.md');
    const t = await fs.readFile(f, 'utf8');
    await fs.writeFile(f, t.replace('Cartographer who', '**Cartographer** who knows [[pell]] and who'));
  });
  const r = await request(port, 'GET', b(`/entries/${MAREN}`));
  const text = r.json.sections[0].text;
  assert.ok(!text.includes('**'), text);
  assert.ok(!text.includes('[['), text);
  assert.match(text, /Cartographer/);
});

test('GET entries/:id: unknown entry 404, unknown book 404, a non-entry id 404', async () => {
  const { port } = await fresh();
  assert.equal((await request(port, 'GET', b('/entries/entry_01S5ZZZZZZZZZZZZZZZZZZZZZZ'))).status, 404);
  assert.equal((await request(port, 'GET', `/api/books/${UNKNOWN_BOOK}/entries/${MAREN}`)).status, 404);
  assert.equal((await request(port, 'GET', b(`/entries/${SCENE}`))).status, 404);
});

// ------------------------------------------------------------------ revisions

test('GET revisions: a scene with no snapshots lists []; unknown scene/book are 404', async () => {
  const { port } = await fresh();
  assert.deepEqual(await listRevs(port), []);
  assert.equal((await request(port, 'GET', b(`/scenes/${UNKNOWN_SCENE}/revisions`))).status, 404);
  assert.equal((await request(port, 'GET', `/api/books/${UNKNOWN_BOOK}/scenes/${SCENE}/revisions`)).status, 404);
});

test('POST revisions { label }: manual snapshot of the whole file with sha, words and label', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const bytes = await fs.readFile(path.join(root, scene.path));
  const r = await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: { label: 'before the rewrite' } });
  assert.ok(r.status === 200 || r.status === 201, r.text);
  const list = await listRevs(port);
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'manual');
  assert.equal(list[0].label, 'before the rewrite');
  assert.equal(list[0].sha256, sha(bytes));
  assert.equal(list[0].words, countWords(scene.body));
  assert.match(list[0].file, /^\d{8}T\d{6}Z-manual\.md$/);
  const dir = path.join(root, '.storyforge', 'revisions', SCENE);
  assert.equal(Buffer.compare(await fs.readFile(path.join(dir, list[0].file)), bytes), 0);
  assert.ok(JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')));
});

test('POST revisions without a label works; unchanged content is not stored twice', async () => {
  const { port } = await fresh();
  const a = await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: {} });
  assert.ok(a.status === 200 || a.status === 201, a.text);
  const again = await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: {} });
  assert.ok(again.status < 500, again.text);
  assert.equal((await listRevs(port)).length, 1);
});

test('GET revisions/:file returns body, front matter and sha; unknown file 404', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: { label: 'v1' } });
  const [rev] = await listRevs(port);
  const r = await request(port, 'GET', b(`/scenes/${SCENE}/revisions/${rev.file}`));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.body, scene.body);
  assert.equal(r.json.sha256, sha(await fs.readFile(path.join(root, scene.path))));
  assert.equal(r.json.front_matter.title, 'Arrival');
  assert.equal((await request(port, 'GET', b(`/scenes/${SCENE}/revisions/20200101T000000Z-manual.md`))).status, 404);
});

test('GET revisions/:file cannot be used to read outside the revisions folder', async () => {
  const { port } = await fresh();
  for (const evil of ['..%2F..%2F..%2Fbook.md', '..%5C..%5Cbook.md', 'index.json', '%2e%2e']) {
    const r = await request(port, 'GET', b(`/scenes/${SCENE}/revisions/${evil}`));
    assert.ok(r.status === 400 || r.status === 404, `${evil} -> ${r.status}`);
    assert.ok(!/schema: storyforge\.book/.test(r.text));
  }
});

test('a body save snapshots the previous file (session) before writing, once per session', async () => {
  const { root, port } = await fresh();
  const scene = await getScene(port);
  const original = await fs.readFile(path.join(root, scene.path));
  const r1 = await put(port, SCENE, 'first edit\n', scene.sha256);
  assert.equal(r1.status, 200, r1.text);
  const after1 = await listRevs(port);
  assert.equal(after1.length, 1);
  assert.equal(after1[0].reason, 'session');
  assert.equal(after1[0].sha256, sha(original));
  const dir = path.join(root, '.storyforge', 'revisions', SCENE);
  assert.equal(Buffer.compare(await fs.readFile(path.join(dir, after1[0].file)), original), 0, 'pre-save bytes preserved');

  const s2 = await getScene(port);
  await put(port, SCENE, 'second edit\n', s2.sha256);
  assert.equal((await listRevs(port)).filter((x) => x.reason === 'session').length, 1, 'no second session snapshot in the same session');
});

test('revisions are listed newest first', async () => {
  const { port } = await fresh();
  await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: { label: 'one' } });
  const s = await getScene(port);
  await put(port, SCENE, 'changed text here\n', s.sha256);
  await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: { label: 'two' } });
  const list = await listRevs(port);
  const ats = list.map((x) => x.at);
  assert.deepEqual([...ats].sort().reverse(), ats);
  assert.equal(list[0].label, 'two');
  assert.ok(list.some((x) => x.label === 'one'));
});

test('revisions follow the scene id when its title changes (J01 fields edit)', async () => {
  const { port } = await fresh();
  await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: { label: 'keep me' } });
  const r = await send(port, 'POST', b(`/scenes/${SCENE}/fields`), { body: { title: 'Arrival, renamed' } });
  assert.equal(r.status, 200, r.text);
  const list = await listRevs(port);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'keep me');
});

// restore ------------------------------------------------------------------

const restoreUrl = (file, id = SCENE) => b(`/scenes/${id}/revisions/${file}/restore`);

async function withRevision() {
  const ctx = await fresh();
  const { port } = ctx;
  const orig = await getScene(port);
  await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: { label: 'v1' } });
  let cur = await getScene(port);
  const w = await put(port, SCENE, 'The rewritten body, quite different.\n', cur.sha256);
  assert.equal(w.status, 200, w.text);
  const fr = await send(port, 'POST', b(`/scenes/${SCENE}/fields`), { body: { title: 'Arrival (current title)' } });
  assert.equal(fr.status, 200, fr.text);
  cur = await getScene(port);
  const manual = (await listRevs(port)).find((x) => x.label === 'v1');
  assert.ok(manual, 'manual revision exists');
  return { ...ctx, orig, cur, manual };
}

test('restore into: current file kept as newest `restore` revision byte-for-byte; body = revision body; front matter = current', async () => {
  const { root, port, orig, cur, manual } = await withRevision();
  const curBytes = await fs.readFile(path.join(root, cur.path));
  const r = await send(port, 'POST', restoreUrl(manual.file), { body: { mode: 'into', base_sha256: cur.sha256 } });
  assert.equal(r.status, 200, r.text);

  const after = await getScene(port);
  assert.equal(after.body, orig.body);
  assert.equal(after.front_matter.title, 'Arrival (current title)', 'front matter of the current file is kept');
  const fileText = await fs.readFile(path.join(root, after.path), 'utf8');
  assert.ok(fileText.startsWith(frontMatterOf(curBytes.toString('utf8'))), 'front-matter bytes identical to current');

  const list = await listRevs(port);
  assert.equal(list[0].reason, 'restore');
  assert.equal(list[0].sha256, sha(curBytes));
  const dir = path.join(root, '.storyforge', 'revisions', SCENE);
  assert.equal(Buffer.compare(await fs.readFile(path.join(dir, list[0].file)), curBytes), 0, 'nothing erased');
  assert.ok(list.some((x) => x.label === 'v1'), 'the restored revision is still listed');
});

test('restore into with a stale base_sha256 is 409 and writes nothing', async () => {
  const { root, port, cur, manual } = await withRevision();
  const before = await snapshot(root);
  const r = await send(port, 'POST', restoreUrl(manual.file), { body: { mode: 'into', base_sha256: 'a'.repeat(64) } });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(await snapshot(root), before);
  assert.equal((await getScene(port)).sha256, cur.sha256);
});

test('restore into with dryRun writes nothing', async () => {
  const { root, port, cur, manual } = await withRevision();
  const before = await snapshot(root);
  const r = await send(port, 'POST', restoreUrl(manual.file), { body: { mode: 'into', base_sha256: cur.sha256, dryRun: true } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await snapshot(root), before);
});

test('restore as new: a scene right after the current one holds the revision body; original untouched', async () => {
  const { root, port, orig, cur, manual } = await withRevision();
  const curBytes = await fs.readFile(path.join(root, cur.path));
  const r = await send(port, 'POST', restoreUrl(manual.file), { body: { mode: 'new', base_sha256: cur.sha256 } });
  assert.ok(r.status === 200 || r.status === 201, r.text);
  assert.equal(Buffer.compare(await fs.readFile(path.join(root, cur.path)), curBytes), 0, 'original scene bytes untouched');

  const book = (await request(port, 'GET', b())).json;
  const scenes = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));
  const next = scenes[scenes.findIndex((s) => s.id === SCENE) + 1];
  assert.match(next.title, /^Arrival \(current title\) \(revision .+\)$/);
  assert.equal((await getScene(port, next.id)).body, orig.body);
});

test('restore as new with a stale base is 409 and creates nothing', async () => {
  const { root, port, manual } = await withRevision();
  const before = await snapshot(root);
  const r = await send(port, 'POST', restoreUrl(manual.file), { body: { mode: 'new', base_sha256: 'b'.repeat(64) } });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(await snapshot(root), before);
});

test('restore: bad mode is 4xx; unknown revision file, scene and book are 404; nothing written', async () => {
  const { root, port, cur, manual } = await withRevision();
  const before = await snapshot(root);
  const bad = await send(port, 'POST', restoreUrl(manual.file), { body: { mode: 'sideways', base_sha256: cur.sha256 } });
  assert.ok(bad.status >= 400 && bad.status < 500, bad.text);
  const nofile = await send(port, 'POST', restoreUrl('20200101T000000Z-manual.md'), { body: { mode: 'into', base_sha256: cur.sha256 } });
  assert.equal(nofile.status, 404);
  const noscene = await send(port, 'POST', restoreUrl(manual.file, UNKNOWN_SCENE), { body: { mode: 'into', base_sha256: cur.sha256 } });
  assert.equal(noscene.status, 404);
  const nobook = await send(port, 'POST', `/api/books/${UNKNOWN_BOOK}/scenes/${SCENE}/revisions/${manual.file}/restore`, { body: { mode: 'into', base_sha256: cur.sha256 } });
  assert.equal(nobook.status, 404);
  assert.deepEqual(await snapshot(root), before);
});

test('POST revisions: unknown scene 404, malformed JSON 400', async () => {
  const { port } = await fresh();
  assert.equal((await send(port, 'POST', b(`/scenes/${UNKNOWN_SCENE}/revisions`), { body: {} })).status, 404);
  assert.equal((await send(port, 'POST', b(`/scenes/${SCENE}/revisions`), { body: '{no' })).status, 400);
});

// ------------------------------------------------------------------ guards

const WRITE_ROUTES = [
  ['POST', b('/activity/session'), { minutes: 5 }],
  ['POST', b('/goal'), { daily_word_goal: 500 }],
  ['POST', b(`/scenes/${SCENE}/revisions`), { label: 'x' }],
  ['POST', b(`/scenes/${SCENE}/revisions/20200101T000000Z-manual.md/restore`), { mode: 'into', base_sha256: 'a'.repeat(64) }],
];

for (const [method, url, payload] of WRITE_ROUTES) {
  test(`guards: ${method} ${url.replace(BOOK, ':b').replace(SCENE, ':s')} rejects missing header, wrong content-type and foreign Host with 403`, async () => {
    const { root, port } = await fresh();
    const before = await snapshot(root);
    const noHeader = await send(port, method, url, { headers: { 'content-type': 'application/json' }, body: payload });
    assert.equal(noHeader.status, 403);
    assert.deepEqual(noHeader.json, { error: 'forbidden' });
    const wrongType = await send(port, method, url, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' }, body: payload });
    assert.equal(wrongType.status, 403);
    const evil = await send(port, method, url, { host: 'evil.example', body: payload });
    assert.equal(evil.status, 403);
    assert.deepEqual(await snapshot(root), before, 'rejected writes change nothing');
  });
}

test('guards: read routes reject a foreign Host with 403', async () => {
  const { port } = await fresh();
  for (const p of [b('/activity'), b(`/entries/${MAREN}`), b(`/scenes/${SCENE}/revisions`)]) {
    const r = await request(port, 'GET', p, { host: 'evil.example' });
    assert.equal(r.status, 403, p);
  }
});
