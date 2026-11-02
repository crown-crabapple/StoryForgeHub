// M03-J01 acceptance 1: the manuscript tree (getBook: acts -> chapters -> scenes) equals what the parser
// (`validate()` plus an independent read of each file) says, for salt-orchard and a book made from every
// template, and is identical after `.storyforge/` is deleted and rebuilt.
// Also: archive / restore of a scene through core never loses a scene body (acceptance 2, the part core owns).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '@storyforge/format';
import { createFsRepository, countWords } from '../src/index.mjs';
import { copyFixture, readExpected } from './helpers.mjs';

const SALT_BOOK = 'book_01S5000000000000000000000A';
const KEY = 'scene_01S50000000000000000000003';
const plain = (v) => JSON.parse(JSON.stringify(v));
const sha = (b) => createHash('sha256').update(b).digest('hex');

const repos = [];
const open = (root) => {
  const r = createFsRepository(root, { watch: false });
  repos.push(r);
  return r;
};
after(async () => {
  for (const r of repos) await r.close();
});

async function templateNames() {
  const mod = await import('../../templates/src/index.mjs');
  return (await mod.listTemplates()).map((t) => t.name);
}

// ---- the independent reader -------------------------------------------------------------------

function split(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  return { fm: YAML.parse(lines.slice(1, end).join('\n')) ?? {}, body: lines.slice(end + 1).join('\n') };
}
const readDoc = async (file) => split(await fs.readFile(file, 'utf8'));

/** What the parser says the tree must be: validate() order + each file read independently. */
async function expectedTree(bookDir) {
  const v = await validate(bookDir);
  const book = v.books[0];
  const scenes = [];
  for (const row of book.order) {
    const doc = await readDoc(path.join(bookDir, row.path));
    scenes.push({
      id: row.id,
      position: row.position,
      act: row.act,
      act_label: row.act_label,
      chapter: row.chapter,
      chapter_label: row.chapter_label,
      title: row.title,
      sequence: row.sequence,
      status: typeof doc.fm.status === 'string' ? doc.fm.status : null,
      pov: typeof doc.fm.pov === 'string' ? doc.fm.pov : null,
      word_count: countWords(doc.body),
      path: row.path,
    });
  }
  return { scenes, excluded: book.excluded };
}

/** Flatten getBook() into the same row shape, checking the nesting as it goes. */
function treeRows(book) {
  const rows = [];
  // tree paths are relative to the library root; the parser is run on the book folder
  const inBook = (p) => (book.path && p.startsWith(`${book.path}/`) ? p.slice(book.path.length + 1) : p);
  const actNumbers = book.acts.map((a) => a.act);
  assert.deepEqual(actNumbers, [...new Set(actNumbers)], 'each act appears once');
  for (const act of book.acts) {
    assert.ok(act.chapters.length > 0, `act ${act.act} has chapters`);
    for (const ch of act.chapters) {
      assert.ok(ch.scenes.length > 0, `chapter ${ch.chapter} has scenes`);
      for (const s of ch.scenes) {
        assert.equal(s.act, act.act, `scene ${s.id} sits under its own act`);
        assert.equal(s.chapter, ch.chapter, `scene ${s.id} sits under its own chapter`);
        rows.push({
          id: s.id,
          position: s.position,
          act: act.act,
          act_label: act.label,
          chapter: ch.chapter,
          chapter_label: ch.label,
          title: s.title,
          sequence: s.sequence,
          status: s.status,
          pov: s.pov,
          word_count: s.word_count,
          path: inBook(s.path),
        });
      }
    }
  }
  return rows;
}

async function removeStoryforgeDirs(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === '.storyforge') await fs.rm(full, { recursive: true, force: true });
    else await removeStoryforgeDirs(full);
  }
}

async function chapterTitles(bookDir, rows) {
  const out = new Map();
  for (const r of rows) {
    if (out.has(r.chapter)) continue;
    const meta = path.join(bookDir, ...path.posix.dirname(r.path).split('/'), 'chapter.md');
    const doc = fsSync.existsSync(meta) ? await readDoc(meta) : null;
    out.set(r.chapter, typeof doc?.fm.title === 'string' ? doc.fm.title : null);
  }
  return out;
}

/** The whole acceptance-1 check for one book. `bookDir` is the folder, `root` the library the repo opens. */
async function checkTreeEqualsParser(root, bookDir, bookId, label) {
  const repo = open(root);
  const book = await repo.getBook(bookId);
  assert.ok(book, `${label}: getBook finds the book`);
  const want = await expectedTree(bookDir);
  const got = treeRows(book);
  assert.deepEqual(got, want.scenes, `${label}: tree rows == validate() order, labels, statuses, POV, word counts`);
  assert.deepEqual(got.map((r) => r.position), got.map((_, i) => i + 1), `${label}: positions run 1..N`);
  assert.equal(book.scene_count, want.scenes.length, `${label}: scene_count`);
  assert.equal(book.word_count, want.scenes.reduce((n, s) => n + s.word_count, 0), `${label}: book word_count is the sum of scenes`);
  assert.deepEqual(plain(book.excluded), plain(want.excluded), `${label}: excluded (variants, archived) == parser`);

  // chapter titles come from chapter.md
  const titles = await chapterTitles(bookDir, got);
  for (const act of book.acts) for (const ch of act.chapters) assert.equal(ch.title, titles.get(ch.chapter), `${label}: chapter ${ch.chapter} title`);

  // rebuild: delete every .storyforge/ and read again from a fresh repository
  const before = plain(book);
  await repo.close();
  await removeStoryforgeDirs(root);
  const repo2 = open(root);
  const again = await repo2.getBook(bookId);
  assert.deepEqual(plain(again), before, `${label}: tree is identical after .storyforge/ is deleted and rebuilt`);
  assert.deepEqual(treeRows(again), want.scenes, `${label}: rebuilt tree still == parser`);
  assert.deepEqual((await expectedTree(bookDir)).scenes, want.scenes, `${label}: parser order unchanged by the rebuild`);
  return repo2;
}

// ---------------------------------------------------------------- acceptance 1

test('salt-orchard: tree equals the parser, before and after .storyforge/ is rebuilt', async () => {
  const root = await copyFixture('valid/salt-orchard');
  await checkTreeEqualsParser(root, root, SALT_BOOK, 'salt-orchard');
  const expected = await readExpected('valid/salt-orchard');
  const tree = treeRows(await open(root).getBook(SALT_BOOK));
  assert.deepEqual(tree.map((r) => r.id), expected.order, 'and matches the fixture expected.json order');
});

test('salt-orchard: the tree shows each status and POV the files hold, with integer word counts', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const rows = treeRows(await open(root).getBook(SALT_BOOK));
  assert.ok(rows.some((r) => r.pov !== null), 'some scene has a POV');
  assert.ok(rows.every((r) => r.status === null || ['outline', 'drafting', 'revised', 'final'].includes(r.status)));
  assert.ok(rows.every((r) => Number.isInteger(r.word_count) && r.word_count >= 0));
});

for (const name of ['blank', 'story-circle', 'heros-journey', 'seven-point']) {
  test(`template ${name}: tree equals the parser, before and after .storyforge/ is rebuilt`, async () => {
    assert.ok((await templateNames()).includes(name), `listTemplates() has ${name}`);
    const root = await copyFixture('valid/covers');
    const repo = open(root);
    const r = await repo.createBook({ title: 'The Lantern Road', template: name, penName: 'r-fenwick' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const bookDir = path.isAbsolute(r.path) ? r.path : path.join(root, ...r.path.split('/'));
    await repo.close();
    await checkTreeEqualsParser(root, bookDir, r.bookId, `template ${name}`);
  });
}

test('every template in listTemplates() is covered by the tree tests above', async () => {
  assert.deepEqual((await templateNames()).sort(), ['blank', 'heros-journey', 'seven-point', 'story-circle']);
});

test('after createScene the tree still equals the parser', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = open(root);
  const r = await repo.createScene(SALT_BOOK, { chapter: 1, after: KEY, title: 'Fresh', slug: 'fresh', body: 'Fresh words here.\n' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const rows = treeRows(await repo.getBook(SALT_BOOK));
  assert.deepEqual(rows, (await expectedTree(root)).scenes);
  assert.ok(rows.some((x) => x.id === r.id && x.word_count === 3));
});

// ---------------------------------------------------------------- acceptance 2 (core's part): archive / restore

async function walkFiles(dir, base = dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkFiles(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}
/** sha256 of every scene body anywhere under dir (book, archive, trash). */
async function allBodies(dir) {
  const s = new Set();
  for (const rel of await walkFiles(dir)) {
    if (!rel.endsWith('.md')) continue;
    const doc = split(await fs.readFile(path.join(dir, rel), 'utf8'));
    if (doc && doc.fm.schema === 'storyforge.scene/v1') s.add(sha(await bodyBytes(path.join(dir, rel))));
  }
  return s;
}
async function bodyBytes(file) {
  const t = (await fs.readFile(file)).toString('latin1');
  const m = /^---\r?\n[\s\S]*?\n---\r?(?:\n|$)/.exec(t);
  return Buffer.from(t.slice(m[0].length), 'latin1');
}
async function bookFiles(dir) {
  const out = {};
  for (const rel of await walkFiles(dir)) if (!rel.startsWith('.storyforge/')) out[rel] = sha(await fs.readFile(path.join(dir, rel)));
  return out;
}

test('archive then restore a scene: every body survives, and restore puts the file back byte-for-byte', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = open(root);
  const bodiesBefore = await allBodies(root);
  const filesBefore = await bookFiles(root);
  const scene = await repo.getScene(SALT_BOOK, KEY);

  const a = await repo.archiveScene(SALT_BOOK, KEY, { baseSha256: scene.sha256 });
  assert.equal(a.ok, true, JSON.stringify(a));
  for (const h of bodiesBefore) assert.ok((await allBodies(root)).has(h), 'no body lost by archive');
  assert.ok(a.path.startsWith('archive/'), 'archived under archive/');
  assert.ok(!(await bookFiles(root))[scene.path], 'the original path is gone');
  const archivedSha = sha(await fs.readFile(path.join(root, ...a.path.split('/'))));
  assert.equal(archivedSha, scene.sha256, 'archive moves the bytes unchanged');
  const during = treeRows(await repo.getBook(SALT_BOOK));
  assert.ok(!during.some((r) => r.id === KEY), 'archived scene is out of the tree');
  const excluded = (await repo.getBook(SALT_BOOK)).excluded;
  assert.ok(excluded.some((e) => e.id === KEY && e.reason === 'archived'), 'and listed as archived (this feeds the Archived section)');

  const r = await repo.restoreScene(SALT_BOOK, a.path, { baseSha256: archivedSha });
  assert.equal(r.ok, true, JSON.stringify(r));
  for (const h of bodiesBefore) assert.ok((await allBodies(root)).has(h), 'no body lost by restore');
  assert.deepEqual(await bookFiles(root), filesBefore, 'book is byte-identical to the start');
  assert.deepEqual(treeRows(await repo.getBook(SALT_BOOK)), (await expectedTree(root)).scenes);
});

// ---------------------------------------------------------------- empty acts and chapters (FORMAT-v1 4.5: shown empty, not an error)

const FERRY = 'scene_01S50000000000000000000005';
const GRAFTING = 'scene_01S50000000000000000000006';

test('an act with no scenes and a chapter whose scenes are all archived are listed empty, from files and from a fresh index', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = open(root);
  const act = await repo.createAct(SALT_BOOK, { title: 'Ebb Tide' });
  assert.equal(act.ok, true, JSON.stringify(act));
  for (const id of [FERRY, GRAFTING]) {
    const s = await repo.getScene(SALT_BOOK, id);
    const r = await repo.archiveScene(SALT_BOOK, id, { baseSha256: s.sha256 });
    assert.equal(r.ok, true, JSON.stringify(r));
  }

  const check = (book, label) => {
    assert.deepEqual(book.acts.map((a) => a.act), [1, 2, 3], `${label}: acts in number order, empty act 3 included`);
    const a1 = book.acts[0];
    assert.deepEqual(a1.chapters.map((c) => c.chapter), [0, 1, 2], `${label}: chapter 2 still listed`);
    const ch2 = a1.chapters[2];
    assert.deepEqual(ch2.scenes, [], `${label}: chapter 2 has no scenes`);
    assert.equal(ch2.label, 'Chapter Two');
    assert.equal(ch2.title, 'The Grafting', `${label}: its title still comes from chapter.md`);
    const a3 = book.acts[2];
    assert.equal(a3.label, 'Act 3');
    assert.deepEqual(a3.chapters, [], `${label}: act 3 has no chapters`);
    const ids = book.acts.flatMap((x) => x.chapters.flatMap((c) => c.scenes.map((sc) => sc.id)));
    assert.ok(!ids.includes(FERRY) && !ids.includes(GRAFTING), `${label}: archived scenes are out of the tree`);
    assert.equal(book.scene_count, 5, `${label}: scene_count counts scenes only`);
  };

  const fromFiles = await repo.getBook(SALT_BOOK);
  check(fromFiles, 'from files');
  await repo.rebuildIndex(SALT_BOOK);
  await repo.close();
  const repoB = open(root);
  const fromIndex = await repoB.getBook(SALT_BOOK);
  check(fromIndex, 'from index');
  assert.deepEqual(plain(fromIndex), plain(fromFiles), 'index and files give the same tree');
  await repoB.close();
  await removeStoryforgeDirs(root);
  const fromScratch = await open(root).getBook(SALT_BOOK);
  assert.deepEqual(plain(fromScratch), plain(fromFiles), 'and so does a rebuilt index');
});
