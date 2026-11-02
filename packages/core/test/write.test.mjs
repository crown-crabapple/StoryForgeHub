import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, readExpected, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const SCENE = 'scene_01S50000000000000000000002';
const ARCHIVE_SCENE = 'scene_01S50000000000000000000009';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const allScenes = (book) => book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));

async function setup() {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  return { root, repo };
}

/** Bytes of the original file up to and including the closing front-matter `---` line terminator. */
function frontMatterBytes(buf) {
  const text = buf.toString('utf8');
  const close = text.indexOf('\n---\n', 3);
  assert.ok(close > 0, 'fixture has closing front matter');
  return Buffer.from(text.slice(0, close + 5), 'utf8');
}

const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');

test('getScene returns the sha256 of the whole file', async () => {
  const { root, repo } = await setup();
  const scene = await repo.getScene(BOOK, SCENE);
  const bytes = await fs.readFile(path.join(root, scene.path));
  assert.equal(scene.sha256, sha(bytes));
});

test('updateSceneBody replaces only the body; front matter bytes, validity and order are unchanged', async () => {
  const { root, repo } = await setup();
  const expected = await readExpected('valid/salt-orchard');
  const scene = await repo.getScene(BOOK, SCENE);
  const file = path.join(root, scene.path);
  const original = await fs.readFile(file);

  const newBody = 'A completely new body with é and 中文.\n\nSecond paragraph.\n';
  const r = await repo.updateSceneBody(BOOK, SCENE, newBody, { baseSha256: scene.sha256 });
  assert.notEqual(r.code, 'CONFLICT');
  assert.notEqual(r.ok, false, JSON.stringify(r));

  const after = await fs.readFile(file);
  const fm = frontMatterBytes(original);
  assert.equal(Buffer.compare(after.subarray(0, fm.length), fm), 0, 'front-matter bytes identical');
  assert.equal(Buffer.compare(after, Buffer.concat([fm, Buffer.from(newBody, 'utf8')])), 0);

  const reread = await repo.getScene(BOOK, SCENE);
  assert.equal(reread.body, newBody);
  assert.equal(reread.sha256, sha(after));
  assert.deepEqual(reread.front_matter, scene.front_matter);

  assert.deepEqual(await errorsOf(root), []);
  const book = await repo.getBook(BOOK);
  assert.deepEqual(allScenes(book).map((s) => s.id), expected.order);
});

test('updateSceneBody writes mixed CRLF/LF bodies exactly as given, and accepts an empty body', async () => {
  const { root, repo } = await setup();
  const scene = await repo.getScene(BOOK, SCENE);
  const file = path.join(root, scene.path);
  const fm = frontMatterBytes(await fs.readFile(file));

  const mixed = 'one\r\ntwo\nthree\r\n';
  const r1 = await repo.updateSceneBody(BOOK, SCENE, mixed, { baseSha256: scene.sha256 });
  assert.notEqual(r1.ok, false, JSON.stringify(r1));
  assert.equal(Buffer.compare(await fs.readFile(file), Buffer.concat([fm, Buffer.from(mixed)])), 0);

  const s2 = await repo.getScene(BOOK, SCENE);
  const r2 = await repo.updateSceneBody(BOOK, SCENE, '', { baseSha256: s2.sha256 });
  assert.notEqual(r2.ok, false, JSON.stringify(r2));
  assert.equal(Buffer.compare(await fs.readFile(file), fm), 0);
});

test('updateSceneBody after an external edit returns CONFLICT with current; disk keeps the external version', async () => {
  const { root, repo } = await setup();
  const scene = await repo.getScene(BOOK, SCENE); // sha A
  const file = path.join(root, scene.path);
  const original = await fs.readFile(file);
  const externalBody = 'EDITED ELSEWHERE\n';
  const external = Buffer.concat([frontMatterBytes(original), Buffer.from(externalBody)]);
  await fs.writeFile(file, external); // sha B

  const r = await repo.updateSceneBody(BOOK, SCENE, 'my stale edit\n', { baseSha256: scene.sha256 });
  assert.equal(r.code, 'CONFLICT');
  assert.equal(r.current.sha256, sha(external));
  assert.equal(r.current.body, externalBody);
  assert.equal(Buffer.compare(await fs.readFile(file), external), 0, 'disk still holds B');
});

test('a second update using the previous sha is a CONFLICT (each save needs the latest sha)', async () => {
  const { repo } = await setup();
  const scene = await repo.getScene(BOOK, SCENE);
  const r1 = await repo.updateSceneBody(BOOK, SCENE, 'first\n', { baseSha256: scene.sha256 });
  assert.notEqual(r1.ok, false, JSON.stringify(r1));
  const r2 = await repo.updateSceneBody(BOOK, SCENE, 'second\n', { baseSha256: scene.sha256 });
  assert.equal(r2.code, 'CONFLICT');
  assert.equal((await repo.getScene(BOOK, SCENE)).body, 'first\n');
});

test('archiveScene after an external edit returns CONFLICT and archives nothing', async () => {
  const { root, repo } = await setup();
  const scene = await repo.getScene(BOOK, ARCHIVE_SCENE);
  const file = path.join(root, scene.path);
  const external = Buffer.from((await fs.readFile(file)).toString('utf8') + '\nappended elsewhere\n');
  await fs.writeFile(file, external);

  const r = await repo.archiveScene(BOOK, ARCHIVE_SCENE, { baseSha256: scene.sha256 });
  assert.equal(r.code, 'CONFLICT');
  assert.equal(Buffer.compare(await fs.readFile(file), external), 0);
  await assert.rejects(fs.access(path.join(root, 'archive', scene.path)));
});

test('archiveScene / restoreScene round trip: byte-identical, order excludes it while archived', async () => {
  const { root, repo } = await setup();
  const expected = await readExpected('valid/salt-orchard');
  const scene = await repo.getScene(BOOK, ARCHIVE_SCENE);
  const original = await fs.readFile(path.join(root, scene.path));
  const archivedPath = `archive/${scene.path}`;

  const a = await repo.archiveScene(BOOK, ARCHIVE_SCENE, { baseSha256: scene.sha256 });
  assert.notEqual(a.ok, false, JSON.stringify(a));
  assert.notEqual(a.code, 'ROLLED_BACK', JSON.stringify(a));
  assert.equal(Buffer.compare(await fs.readFile(path.join(root, archivedPath)), original), 0);
  await assert.rejects(fs.access(path.join(root, scene.path)));
  assert.equal(await repo.getScene(BOOK, ARCHIVE_SCENE), null);
  const during = await repo.getBook(BOOK);
  assert.deepEqual(
    allScenes(during).map((s) => s.id),
    expected.order.filter((id) => id !== ARCHIVE_SCENE),
  );
  assert.ok(during.excluded.some((e) => e.id === ARCHIVE_SCENE && e.reason === 'archived'));
  assert.deepEqual(await errorsOf(root), []);

  const rr = await repo.restoreScene(BOOK, archivedPath, { baseSha256: sha(original) });
  assert.notEqual(rr.ok, false, JSON.stringify(rr));
  assert.equal(Buffer.compare(await fs.readFile(path.join(root, scene.path)), original), 0);
  await assert.rejects(fs.access(path.join(root, archivedPath)));
  assert.deepEqual(allScenes(await repo.getBook(BOOK)).map((s) => s.id), expected.order);
  assert.deepEqual(await errorsOf(root), []);
});

test('createScene delegates to insertScene and the new scene appears right after its anchor', async () => {
  const { root, repo } = await setup();
  const expected = await readExpected('valid/salt-orchard');
  const r = await repo.createScene(BOOK, {
    chapter: 1,
    after: SCENE,
    title: 'Fresh Scene',
    slug: 'fresh-scene',
    body: 'Brand new prose.\n',
  });
  assert.notEqual(r.ok, false, JSON.stringify(r));
  assert.equal(typeof r.id, 'string');
  assert.equal(typeof r.path, 'string');
  assert.equal((await fs.readFile(path.join(root, r.path), 'utf8')).endsWith('\nBrand new prose.\n'), true);

  const ids = allScenes(await repo.getBook(BOOK)).map((s) => s.id);
  const i = expected.order.indexOf(SCENE);
  assert.deepEqual(ids, [...expected.order.slice(0, i + 1), r.id, ...expected.order.slice(i + 1)]);
  assert.deepEqual(await errorsOf(root), []);

  const doc = await repo.getScene(BOOK, r.id);
  assert.equal(doc.title, 'Fresh Scene');
  assert.equal(doc.body, 'Brand new prose.\n');
});

test('createScene with bad args fails without touching disk', async () => {
  const { root, repo } = await setup();
  const before = (await fs.readdir(path.join(root, 'manuscript'), { recursive: true })).sort();
  const r = await repo.createScene(BOOK, { chapter: 1, after: 'scene_does_not_exist', title: 'X', slug: 'x', body: '' });
  assert.ok(r.ok === false || typeof r.code === 'string');
  const after = (await fs.readdir(path.join(root, 'manuscript'), { recursive: true })).sort();
  assert.deepEqual(after, before);
});

test('recover() on a clean library resolves and changes no project file', async () => {
  const { root, repo } = await setup();
  const before = await snapshot(root);
  const report = await repo.recover();
  assert.ok(report && typeof report === 'object');
  const after = await snapshot(root);
  for (const [rel, h] of Object.entries(before)) {
    if (!rel.startsWith('.storyforge/')) assert.equal(after[rel], h);
  }
});
