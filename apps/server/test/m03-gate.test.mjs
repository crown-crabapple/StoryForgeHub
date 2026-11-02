// M03 milestone gate, end to end with real server processes (main.mjs) on a temp copy of salt-orchard.
// "The fixture manuscript can be written, reordered, externally inspected as Markdown, restored after a simulated
// interruption, and read in the supplied reference layout."
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { REPO_ROOT, copyFixture, request, snapshot } from './helpers.mjs';
import { GOOD, flatScenes, killAll, startServer } from './proc-helpers.mjs';
import { independentOrder, readAll } from './move-helpers.mjs';

after(killAll);

const BOOK = 'book_01S5000000000000000000000A';
const sid = (n) => `scene_01S500000000000000000000${String(n).padStart(2, '0')}`;
const ARRIVAL = sid(2);
const KEY = sid(3);
const FERRY = sid(5);
const GRAFTING = sid(6); // the CRLF scene
const LOWTIDE = sid(8);
const sha = (b) => createHash('sha256').update(b).digest('hex');

function useTempConfig() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sf-m03-cfg-')).then((home) => {
    Object.assign(process.env, { APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, 'xdg'), HOME: home, USERPROFILE: home });
  });
}

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

const b = (p = '') => `/api/books/${BOOK}${p}`;
const getScene = async (port, id) => (await request(port, 'GET', b(`/scenes/${id}`))).json;
const put = (port, id, body, base) => send(port, 'PUT', b(`/scenes/${id}/body`), { body, base_sha256: base });

function frontMatterOf(buf) {
  const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n');
  const end = lines.indexOf('---', 1);
  return YAML.parse(lines.slice(1, end).join('\n'));
}
const bodyOf = (buf) => {
  const t = buf.toString('utf8');
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(t);
  return t.slice(m[0].length);
};

test('M03 gate: write, reorder (and undo), inspect on disk, revision restore, read in the reference layout', async () => {
  await useTempConfig();
  const root = await copyFixture('valid/salt-orchard');
  const s = await startServer(root);
  const port = s.port;
  const start = await snapshot(root, { skipStoryforge: true });

  // ---- 1. written: two scenes, one of them CRLF
  const arrival = await getScene(port, ARRIVAL);
  const grafting = await getScene(port, GRAFTING);
  const arrivalBytes = await fs.readFile(path.join(root, arrival.path));
  const arrivalText = 'Gate text one, written by the editor.\n\nA second paragraph with five words.\n';
  const graftText = 'Grafting rewritten line one\r\nGrafting rewritten line two\r\n';
  const w1 = await put(port, ARRIVAL, arrivalText, arrival.sha256);
  assert.equal(w1.status, 200, w1.text);
  assert.ok(w1.json.words.added > 0, 'words.added reported');
  const w2 = await put(port, GRAFTING, graftText, grafting.sha256);
  assert.equal(w2.status, 200, w2.text);
  assert.ok(w2.json.words.added > 0);
  const wordsAdded = w1.json.words.added + w2.json.words.added;

  // ---- 2. reordered: move KEY into chapter 3 after LOWTIDE with `expect`, undo once, move again
  const dry = await send(port, 'POST', b(`/scenes/${KEY}/move`), { chapter: 3, after: LOWTIDE, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  const expect = dry.json.changes.map((c) => ({ path: c.from, sha256: c.before_sha256 })).filter((e) => e.sha256);
  assert.ok(expect.length >= 1);
  const moved = await send(port, 'POST', b(`/scenes/${KEY}/move`), { chapter: 3, after: LOWTIDE, expect });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(typeof moved.json.opId, 'string');
  let order = flatScenes((await request(port, 'GET', b())).json);
  assert.equal(order.find((x) => x.id === KEY).chapter, 3);

  const undone = await send(port, 'POST', b(`/ops/${encodeURIComponent(moved.json.opId)}/restore`), {});
  assert.equal(undone.status, 200, undone.text);
  order = flatScenes((await request(port, 'GET', b())).json);
  assert.equal(order.find((x) => x.id === KEY).chapter, 1, 'undo put it back');

  const again = await send(port, 'POST', b(`/scenes/${KEY}/move`), { chapter: 3, after: LOWTIDE });
  assert.equal(again.status, 200, again.text);

  // ---- 3. externally inspected: straight from disk
  const files = await readAll(root);
  const keyApi = (await getScene(port, KEY));
  assert.equal(keyApi.chapter ?? frontMatterOf(files.get(keyApi.path)).chapter, 3);
  const keyFm = frontMatterOf(files.get(keyApi.path));
  assert.equal(keyFm.id, KEY);
  assert.equal(keyFm.chapter, 3);
  assert.ok(Number.isInteger(keyFm.sequence));
  const arrFile = files.get(arrival.path);
  assert.equal(frontMatterOf(arrFile).id, ARRIVAL);
  assert.equal(frontMatterOf(arrFile).chapter, 1);
  assert.equal(bodyOf(arrFile), arrivalText);
  const grFile = files.get(grafting.path);
  assert.equal(bodyOf(grFile), graftText);
  assert.equal(frontMatterOf(grFile).sequence, 20);
  assert.ok(!/[^\r]\n/.test(grFile.toString('utf8')), 'the CRLF file is still all CRLF');
  const independent = independentOrder(files).map((r) => r.id);
  assert.deepEqual(flatScenes((await request(port, 'GET', b())).json).map((x) => x.id).filter((id) => independent.includes(id)), independent, 'files and API agree on reading order');

  // nothing else changed (hash snapshot, ignoring .storyforge): only the two edits and the moved scene
  const end = await snapshot(root, { skipStoryforge: true });
  const startFiles = Object.keys(start).filter((k) => !k.endsWith('/'));
  const endFiles = Object.keys(end).filter((k) => !k.endsWith('/'));
  const keyOld = Object.keys(start).find((k) => k.endsWith('0020-the-key.md'));
  const allowed = new Set([arrival.path, grafting.path, keyOld, keyApi.path]);
  for (const f of startFiles) if (!allowed.has(f)) assert.equal(end[f], start[f], `${f} must be untouched`);
  for (const f of endFiles) if (!allowed.has(f)) assert.ok(f in start, `${f} must not be new`);

  // ---- 5. reference layout reads
  const book = (await request(port, 'GET', b())).json;
  const ids = flatScenes(book).map((x) => x.id);
  assert.deepEqual(book.acts.map((a) => a.act), [...book.acts.map((a) => a.act)].sort((x, y) => x - y));
  assert.ok(ids.indexOf(KEY) > ids.indexOf(LOWTIDE), 'KEY now reads after LOWTIDE');
  const objects = (await request(port, 'GET', b('/objects'))).json;
  const objList = Array.isArray(objects) ? objects : objects.objects;
  const full = await getScene(port, ARRIVAL);
  assert.equal(full.body, arrivalText);
  for (const ref of full.front_matter.characters) assert.ok(objList.some((o) => o.slug === ref && typeof o.title === 'string'), `${ref} resolves to a name`);
  const act = (await request(port, 'GET', b('/activity'))).json;
  assert.ok(act.today.added >= wordsAdded, `today shows the words: ${JSON.stringify(act.today)}`);

  // ---- 4b. revision restore "into": earlier text back, replaced text is the newest revision
  const beforeRestore = await fs.readFile(path.join(root, full.path));
  const revs = (await request(port, 'GET', b(`/scenes/${ARRIVAL}/revisions`))).json;
  const list = Array.isArray(revs) ? revs : revs.revisions;
  const oldest = list[list.length - 1];
  assert.equal(oldest.sha256, sha(arrivalBytes), 'the first save snapshotted the original');
  const restored = await send(port, 'POST', b(`/scenes/${ARRIVAL}/revisions/${oldest.file}/restore`), { mode: 'into', base_sha256: full.sha256 });
  assert.equal(restored.status, 200, restored.text);
  const afterRestore = await fs.readFile(path.join(root, full.path));
  assert.equal(bodyOf(afterRestore), bodyOf(arrivalBytes), 'earlier text is back');
  const list2 = (await request(port, 'GET', b(`/scenes/${ARRIVAL}/revisions`))).json;
  const newest = (Array.isArray(list2) ? list2 : list2.revisions)[0];
  assert.equal(newest.reason, 'restore');
  assert.equal(newest.sha256, sha(beforeRestore));
  const stored = await fs.readFile(path.join(root, '.storyforge', 'revisions', ARRIVAL, newest.file));
  assert.equal(Buffer.compare(stored, beforeRestore), 0, 'the replaced text exists byte-for-byte');
  await s.stop();
});

// ---- 4a. simulated interruption: a child process dies mid-save; the next start settles it
const STORE_URL = pathToFileURL(path.join(REPO_ROOT, 'packages', 'store', 'src', 'index.mjs')).href;
const CORE_URL = pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'src', 'index.mjs')).href;
const CHILD = `
import { __faults } from ${JSON.stringify(STORE_URL)};
import { createFsRepository } from ${JSON.stringify(CORE_URL)};
const [root, book, scene, at, body] = process.argv.slice(1);
const repo = createFsRepository(root);
const s = await repo.getScene(book, scene);
__faults.at = at;
__faults.mode = 'exit';
await repo.updateSceneBody(book, scene, body, { baseSha256: s.sha256 });
process.exit(0);
`;

for (const [at, outcome] of [['after-tmp', 'old'], ['after-rename', 'new']]) {
  test(`M03 gate: a save interrupted at ${at} leaves exactly the ${outcome} file; restart recovers it and the next save works`, async () => {
    await useTempConfig();
    const root = await copyFixture('valid/salt-orchard');
    const probe = await startServer(root);
    const scene = await getScene(probe.port, FERRY);
    await probe.stop();
    const file = path.join(root, scene.path);
    const oldBytes = await fs.readFile(file);
    const newBody = 'Interrupted save text, new.\n';
    const newBytes = Buffer.concat([oldBytes.subarray(0, oldBytes.length - Buffer.byteLength(scene.body)), Buffer.from(newBody)]);

    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, root, BOOK, FERRY, at, newBody], { cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true });
    const code = await new Promise((r) => child.once('exit', r));
    assert.equal(code, 86, 'the child died at the injected fault');

    const s = await startServer(root);
    const now = await fs.readFile(file);
    assert.equal(Buffer.compare(now, outcome === 'old' ? oldBytes : newBytes), 0, `file is exactly the ${outcome} version`);
    const report = (await request(s.port, 'GET', '/api/recover/last')).json;
    const key = outcome === 'old' ? 'rolledBack' : 'completed';
    assert.ok(report[key].length >= 1, `recovery report lists it under ${key}: ${JSON.stringify(report)}`);
    assert.ok(JSON.stringify(report[key]).includes(path.basename(scene.path)), 'the report names the scene file');
    assert.deepEqual(report.needsAttention, []);

    const fresh = await getScene(s.port, FERRY);
    assert.equal(fresh.body, outcome === 'old' ? scene.body : newBody);
    const next = await put(s.port, FERRY, 'The next save works.\n', fresh.sha256);
    assert.equal(next.status, 200, next.text);
    assert.equal((await getScene(s.port, FERRY)).body, 'The next save works.\n');
    await s.stop();
  });
}
