// M02-J03 acceptance 1, 2, 3, 4, 6: createBook for every template, an independent reader, cache deletion,
// validation failures that write nothing, and creating into a series.
//
// createBook is called as a method of the repository (like createScene); the library is a copy of the
// `valid/covers` fixture (pen names r-fenwick / a-marsh, series harbour-lights with books 1 and 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, snapshot } from './helpers.mjs';

const COVERS = 'valid/covers';
const NAMES = ['blank', 'story-circle', 'heros-journey', 'seven-point'];
const plain = (v) => JSON.parse(JSON.stringify(v));

async function setup() {
  const root = await copyFixture(COVERS);
  const repo = createFsRepository(root);
  assert.equal(typeof repo.createBook, 'function', 'implementation missing: repository.createBook');
  return { root, repo };
}

/** listTemplates() from the templates package (relative path: the workspace link may not exist yet). */
async function templates() {
  const mod = await import('../../templates/src/index.mjs');
  return mod.listTemplates();
}

const folderOf = (root, r) => (path.isAbsolute(r.path) ? r.path : path.join(root, r.path));

// ---- the independent reader: plain text front-matter split + yaml + sort by (chapter, sequence) ----

function splitFrontMatter(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  return { fm: YAML.parse(lines.slice(1, end).join('\n')) ?? {}, body: lines.slice(end + 1).join('\n') };
}

async function mdFiles(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await mdFiles(full, base)));
    else if (e.name.endsWith('.md')) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Everything a second reader needs from a book folder. */
async function readBookIndependently(dir) {
  const docs = [];
  for (const rel of await mdFiles(dir)) {
    const text = await fs.readFile(path.join(dir, rel), 'utf8');
    const parsed = splitFrontMatter(text);
    if (parsed) docs.push({ rel, text, ...parsed });
  }
  const scenes = docs
    .filter((d) => d.rel.startsWith('manuscript/') && d.fm.schema === 'storyforge.scene/v1' && d.fm.variant_of === undefined)
    .sort((a, b) => a.fm.chapter - b.fm.chapter || a.fm.sequence - b.fm.sequence);
  return {
    docs,
    scenes,
    book: docs.find((d) => d.rel === 'book.md')?.fm,
    sceneIds: scenes.map((s) => s.fm.id),
    ids: docs.map((d) => d.fm.id).filter(Boolean),
    acts: new Set(scenes.map((s) => s.fm.act)).size,
    chapters: new Set(scenes.map((s) => s.fm.chapter)).size,
  };
}

/** Like snapshot() but a link is recorded as a link, never followed or read. */
async function snapshotNoLinks(root) {
  const out = {};
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === '.storyforge') continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isSymbolicLink()) out[rel] = 'link';
      else if (e.isDirectory()) {
        out[rel + '/'] = 'dir';
        await walk(full);
      } else out[rel] = (await fs.readFile(full)).toString('base64');
    }
  }
  await walk(root);
  return out;
}

const flat = (book) => book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));

async function removeStoryforgeDirs(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (e.name === '.storyforge') await fs.rm(full, { recursive: true, force: true });
    else await removeStoryforgeDirs(full);
  }
}

async function allFilesText(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFilesText(full)));
    else out.push({ file: full, text: await fs.readFile(full, 'utf8') });
  }
  return out;
}

// ---------------------------------------------------------------- acceptance 1 + 2 + 3, per template

for (const name of NAMES) {
  test(`${name}: creates a validator-clean book matching listTemplates(), with fresh ids and no placeholders`, async () => {
    const { root, repo } = await setup();
    const info = (await templates()).find((t) => t.name === name);
    assert.ok(info, `listTemplates() has ${name}`);

    const r = await repo.createBook({ title: 'The Lantern Road', template: name, penName: 'r-fenwick' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.bookId, /^book_[0-9A-HJKMNP-TV-Z]{26}$/);
    const folder = folderOf(root, r);
    assert.equal(path.resolve(folder), path.resolve(root, 'the-lantern-road'));
    assert.ok((await fs.stat(folder)).isDirectory());

    // validator-clean: the new book on its own, and the whole library
    const own = await validate(folder);
    assert.deepEqual(own.diagnostics, [], 'book alone has zero diagnostics');
    assert.deepEqual((await validate(root)).diagnostics, [], 'library has zero diagnostics');

    // structure matches the template description
    const book = await repo.getBook(r.bookId);
    assert.ok(book, 'getBook finds the new book');
    assert.equal(book.title, 'The Lantern Road');
    assert.equal(book.slug, 'the-lantern-road');
    assert.equal(book.acts.length, info.acts);
    assert.equal(book.acts.flatMap((a) => a.chapters).length, info.chapters);
    assert.equal(flat(book).length, info.scenes);
    assert.equal(book.scene_count, info.scenes);
    book.acts.forEach((a, i) => {
      assert.equal(a.act, i + 1, 'acts are numbered 1..n');
      assert.ok(typeof a.label === 'string' && a.label.length > 0, 'act label');
    });
    book.acts.flatMap((a) => a.chapters).forEach((c, i) => {
      assert.equal(c.chapter, i + 1, 'chapters are numbered 1..n book-wide');
      assert.ok(typeof c.label === 'string' && c.label.length > 0, 'chapter label');
    });

    // no placeholder left in any file, in any file name
    for (const f of await allFilesText(folder)) {
      assert.ok(!f.text.includes('{{'), `${f.file} still has {{`);
      assert.ok(!f.file.includes('{{'), `${f.file}: path has a placeholder`);
    }

    // acceptance 2: second reader agrees on scene order
    const ind = await readBookIndependently(folder);
    assert.equal(ind.sceneIds.length, info.scenes);
    assert.deepEqual(ind.sceneIds, own.books[0].order.map((s) => s.id), 'independent reader == validate() order');
    assert.deepEqual(ind.sceneIds, flat(book).map((s) => s.id), 'independent reader == getBook() order');
    assert.equal(ind.acts, info.acts);
    assert.equal(ind.chapters, info.chapters);

    // book.md front matter
    assert.equal(ind.book.schema, 'storyforge.book/v1');
    assert.equal(ind.book.id, r.bookId);
    assert.equal(ind.book.slug, 'the-lantern-road');
    assert.equal(ind.book.title, 'The Lantern Road');
    assert.equal(ind.book.profile, 'fiction');
    assert.equal(ind.book.status, 'planning');
    assert.equal(ind.book.language, 'en');
    assert.equal(ind.book.pen_name, 'r-fenwick');
    assert.equal(ind.book.series_number, undefined, 'standalone book has no series_number');

    // scene content per the template table
    if (name === 'blank') {
      assert.equal(ind.scenes[0].fm.title, 'Untitled scene');
      assert.equal(ind.scenes[0].fm.status, 'drafting');
      assert.equal(ind.scenes[0].body.trim(), '');
    } else {
      for (const s of ind.scenes) assert.equal(s.fm.status, 'outline', s.rel);
    }
    // planning/plan.md ships with every book
    assert.ok(ind.docs.some((d) => d.rel === 'planning/plan.md'), 'planning/plan.md exists');

    // the new book is visible, and nothing was left behind in the staging area
    const list = await repo.listBooks();
    assert.ok(list.some((b) => b.id === r.bookId), 'listBooks shows the new book');
    const staging = path.join(root, '.storyforge', 'staging');
    const left = await fs.readdir(staging).catch(() => []);
    assert.deepEqual(left, [], 'staging is empty after a successful create');
  });

  test(`${name}: two books from the same template share no ids`, async () => {
    const { root, repo } = await setup();
    const a = await repo.createBook({ title: 'First Copy', template: name });
    const b = await repo.createBook({ title: 'Second Copy', template: name });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(b.ok, true, JSON.stringify(b));
    const ia = await readBookIndependently(folderOf(root, a));
    const ib = await readBookIndependently(folderOf(root, b));
    assert.ok(ia.ids.length >= 3);
    assert.equal(new Set(ia.ids).size, ia.ids.length, 'ids unique inside one book');
    const shared = ia.ids.filter((id) => ib.ids.includes(id));
    assert.deepEqual(shared, [], 'no id is shared between the two books');
    assert.deepEqual((await validate(root)).diagnostics, [], 'library still has zero diagnostics (E201)');
  });

  test(`${name}: deleting every .storyforge/ gives an identical getBook structure`, async () => {
    const { root, repo } = await setup();
    const r = await repo.createBook({ title: 'Cache Test', template: name });
    assert.equal(r.ok, true, JSON.stringify(r));
    await repo.rebuildIndex();
    const before = plain(await repo.getBook(r.bookId));
    const listBefore = plain(await repo.listBooks());
    await repo.close();

    await removeStoryforgeDirs(root);
    await assert.rejects(fs.access(path.join(root, '.storyforge')));

    const again = createFsRepository(root);
    const after = plain(await again.getBook(r.bookId));
    assert.deepEqual(after.acts, before.acts);
    assert.deepEqual(after.excluded, before.excluded);
    assert.deepEqual(after, before);
    assert.deepEqual(plain(await again.listBooks()), listBefore);
    await again.close();
  });
}

// ---------------------------------------------------------------- inputs and defaults

test('title is trimmed, slug defaults to slugify(title), and the new book is a cover card with no cover', async () => {
  const { root, repo } = await setup();
  const r = await repo.createBook({ title: '  My Fancy -- Title!  ', template: 'blank' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ind = await readBookIndependently(folderOf(root, r));
  assert.equal(ind.book.title, 'My Fancy -- Title!');
  assert.equal(ind.book.slug, 'my-fancy-title');
  assert.ok(ind.book.slug.match(/^[a-z0-9]+(-[a-z0-9]+)*$/));
  assert.equal(ind.book.pen_name, undefined, 'no pen_name when none given');
  const summary = (await repo.listBooks()).find((b) => b.id === r.bookId);
  assert.equal(summary.cover_state, 'none');
});

test('an explicit slug is used for the folder and the slug field', async () => {
  const { root, repo } = await setup();
  const r = await repo.createBook({ title: 'Anything', slug: 'my-own-slug', template: 'blank' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok((await fs.stat(path.join(root, 'my-own-slug', 'book.md'))).isFile());
  assert.equal((await readBookIndependently(path.join(root, 'my-own-slug'))).book.slug, 'my-own-slug');
});

test('titles that need YAML quoting survive: colon, quotes, hash, leading dash, unicode', async () => {
  const { root, repo } = await setup();
  const titles = ['Ode: A "Quoted" Title #1', '- starts with a dash', "It's a 'single' quote", 'Café — Noël', 'true', '123'];
  for (const [i, title] of titles.entries()) {
    const r = await repo.createBook({ title, slug: `quoted-${i}`, template: 'blank' });
    assert.equal(r.ok, true, `${title}: ${JSON.stringify(r)}`);
    const ind = await readBookIndependently(folderOf(root, r));
    assert.equal(ind.book.title, title, 'title round-trips through an independent YAML parser');
  }
  assert.deepEqual((await validate(root)).diagnostics, []);
});

test('a 120-character title is accepted (boundary)', async () => {
  const { root, repo } = await setup();
  const title = 'x'.repeat(120);
  const r = await repo.createBook({ title, slug: 'long-title', template: 'blank' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await readBookIndependently(folderOf(root, r))).book.title, title);
});

test('a 60-character slug is accepted, a book can be created into a library that has no library.md', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-core-nolib-'));
  const seed = await copyFixture('valid/salt-orchard');
  await fs.cp(seed, path.join(root, 'salt-orchard'), { recursive: true });
  const repo = createFsRepository(root);
  const slug = 'a'.repeat(60);
  const r = await repo.createBook({ title: 'Long Slug', slug, template: 'blank' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok((await fs.stat(path.join(root, slug, 'book.md'))).isFile());
  assert.deepEqual((await validate(root)).diagnostics, []);
  await repo.close();
});

// ---------------------------------------------------------------- acceptance 4: every failure code writes nothing

const LONG_TITLE = 'x'.repeat(121);
const FAILURES = [
  // [label, input, code, field]
  ['empty title', { title: '', template: 'blank' }, 'BAD_TITLE', 'title'],
  ['whitespace-only title', { title: '   \t ', template: 'blank' }, 'BAD_TITLE', 'title'],
  ['121-character title', { title: LONG_TITLE, slug: 'ok-slug', template: 'blank' }, 'BAD_TITLE', 'title'],
  ['title with a NUL control character', { title: 'bad\u0000title', slug: 'ok-slug', template: 'blank' }, 'BAD_TITLE', 'title'],
  ['title with a newline', { title: 'two\nlines', slug: 'ok-slug', template: 'blank' }, 'BAD_TITLE', 'title'],
  ['title missing', { template: 'blank' }, 'BAD_TITLE', 'title'],
  ['title is not a string', { title: 42, template: 'blank' }, 'BAD_TITLE', 'title'],
  ['slug with upper case', { title: 'T', slug: 'Bad', template: 'blank' }, 'BAD_SLUG', 'slug'],
  ['slug with a space', { title: 'T', slug: 'bad slug', template: 'blank' }, 'BAD_SLUG', 'slug'],
  ['slug with a double hyphen', { title: 'T', slug: 'bad--slug', template: 'blank' }, 'BAD_SLUG', 'slug'],
  ['slug starting with a hyphen', { title: 'T', slug: '-bad', template: 'blank' }, 'BAD_SLUG', 'slug'],
  ['slug with a path separator', { title: 'T', slug: 'a/b', template: 'blank' }, 'BAD_SLUG', 'slug'],
  ['slug that climbs out', { title: 'T', slug: '..', template: 'blank' }, 'BAD_SLUG', 'slug'],
  ['61-character slug', { title: 'T', slug: 'a'.repeat(61), template: 'blank' }, 'BAD_SLUG', 'slug'],
  ['default slug is empty (title has no a-z0-9)', { title: '!!! ???', template: 'blank' }, 'BAD_SLUG', 'slug'],
  ['slug used by a standalone book', { title: 'T', slug: 'north-road', template: 'blank' }, 'SLUG_TAKEN', 'slug'],
  ['slug used by a book inside a series', { title: 'T', slug: 'first-light', template: 'blank' }, 'SLUG_TAKEN', 'slug'],
  ['default slug used by an existing book', { title: 'North Road', template: 'blank' }, 'SLUG_TAKEN', 'slug'],
  ['folder already exists (standalone)', { title: 'T', slug: 'empty-folder', template: 'blank' }, 'FOLDER_EXISTS', 'slug'],
  ['folder already exists (in a series)', { title: 'T', slug: 'empty-in-series', seriesSlug: 'harbour-lights', template: 'blank' }, 'FOLDER_EXISTS', 'slug'],
  ['unknown series', { title: 'T', slug: 'ok-slug', seriesSlug: 'no-such-series', template: 'blank' }, 'NO_SUCH_SERIES', 'seriesSlug'],
  ['series number already used', { title: 'T', slug: 'ok-slug', seriesSlug: 'harbour-lights', seriesNumber: 1, template: 'blank' }, 'SERIES_NUMBER_TAKEN', 'seriesNumber'],
  ['series number 2 already used', { title: 'T', slug: 'ok-slug', seriesSlug: 'harbour-lights', seriesNumber: 2, template: 'blank' }, 'SERIES_NUMBER_TAKEN', 'seriesNumber'],
  ['unknown pen name', { title: 'T', slug: 'ok-slug', penName: 'nobody', template: 'blank' }, 'NO_SUCH_PEN_NAME', 'penName'],
  ['unknown template', { title: 'T', slug: 'ok-slug', template: 'no-such-template' }, 'NO_SUCH_TEMPLATE', 'template'],
  ['template missing', { title: 'T', slug: 'ok-slug' }, 'NO_SUCH_TEMPLATE', 'template'],
  ['template name that climbs out', { title: 'T', slug: 'ok-slug', template: '../../etc' }, 'NO_SUCH_TEMPLATE', 'template'],
];

for (const [label, input, code, field] of FAILURES) {
  test(`validation: ${label} -> ${code} on field ${field}, nothing written`, async () => {
    const { root, repo } = await setup();
    await fs.mkdir(path.join(root, 'empty-folder'));
    await fs.mkdir(path.join(root, 'harbour-lights', 'empty-in-series'));
    const before = await snapshot(root, { skipStoryforge: true });
    const r = await repo.createBook(input);
    assert.equal(r.ok, false, `expected a refusal, got ${JSON.stringify(r)}`);
    assert.equal(r.code, code, JSON.stringify(r));
    assert.equal(r.field, field, JSON.stringify(r));
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0, 'message is plain words');
    assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before, 'the library is byte-for-byte unchanged');
  });
}

test('validation: a non-integer or zero series number is refused with the seriesNumber field and writes nothing', async () => {
  const { root, repo } = await setup();
  const before = await snapshot(root, { skipStoryforge: true });
  for (const seriesNumber of [0, -3, 1.5, 'two']) {
    const r = await repo.createBook({ title: 'T', slug: 'ok-slug', seriesSlug: 'harbour-lights', seriesNumber, template: 'blank' });
    assert.equal(r.ok, false, `seriesNumber ${JSON.stringify(seriesNumber)} must be refused`);
    assert.equal(r.field, 'seriesNumber', JSON.stringify(r));
  }
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

test('validation: a series folder that is a link to somewhere outside the library -> OUTSIDE_ROOT, nothing written anywhere', async (t) => {
  const { root, repo } = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-outside-'));
  await fs.writeFile(
    path.join(outside, 'series.md'),
    '---\nschema: storyforge.series/v1\nid: series_01V30000000000000000000099\nslug: sneaky\ntitle: Sneaky\nstatus: active\n---\n',
  );
  try {
    await fs.symlink(outside, path.join(root, 'sneaky'), 'junction');
  } catch (e) {
    t.skip(`cannot create a directory link here (${e.code})`);
    return;
  }
  const outsideBefore = await snapshot(outside);
  const rootBefore = await snapshotNoLinks(root);
  const r = await repo.createBook({ title: 'Escape', slug: 'escape', seriesSlug: 'sneaky', template: 'blank' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'OUTSIDE_ROOT', JSON.stringify(r));
  assert.deepEqual(await snapshot(outside), outsideBefore, 'nothing was written outside the library');
  assert.deepEqual(await snapshotNoLinks(root), rootBefore);
});

test('a refusal does not stop a later valid create (no half state)', async () => {
  const { root, repo } = await setup();
  const bad = await repo.createBook({ title: 'T', slug: 'north-road', template: 'blank' });
  assert.equal(bad.code, 'SLUG_TAKEN');
  const good = await repo.createBook({ title: 'T', slug: 'fresh-one', template: 'blank' });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.deepEqual((await validate(root)).diagnostics, []);
});

test('creating the same slug twice: the second is SLUG_TAKEN and the first book is untouched', async () => {
  const { root, repo } = await setup();
  const a = await repo.createBook({ title: 'Twin', template: 'story-circle' });
  assert.equal(a.ok, true, JSON.stringify(a));
  const snap = await snapshot(folderOf(root, a));
  const b = await repo.createBook({ title: 'Twin', template: 'blank' });
  assert.equal(b.ok, false);
  assert.equal(b.code, 'SLUG_TAKEN');
  assert.deepEqual(await snapshot(folderOf(root, a)), snap);
});

// ---------------------------------------------------------------- acceptance 6: into a series

test('series: the book lands in the series folder with series_number = max + 1, then 4, then an explicit number', async () => {
  const { root, repo } = await setup();
  const a = await repo.createBook({ title: 'Third Light', seriesSlug: 'harbour-lights', template: 'blank' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(path.resolve(folderOf(root, a)), path.resolve(root, 'harbour-lights', 'third-light'));
  assert.ok((await fs.stat(path.join(root, 'harbour-lights', 'third-light', 'book.md'))).isFile());
  assert.equal((await readBookIndependently(folderOf(root, a))).book.series_number, 3, 'max(1, 2) + 1');

  const b = await repo.createBook({ title: 'Fourth Light', seriesSlug: 'harbour-lights', template: 'story-circle' });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal((await readBookIndependently(folderOf(root, b))).book.series_number, 4);

  const c = await repo.createBook({ title: 'Seventh Light', seriesSlug: 'harbour-lights', seriesNumber: 7, template: 'blank' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal((await readBookIndependently(folderOf(root, c))).book.series_number, 7);

  const d = await repo.createBook({ title: 'Eighth Light', seriesSlug: 'harbour-lights', template: 'blank' });
  assert.equal((await readBookIndependently(folderOf(root, d))).book.series_number, 8, 'default follows the new max');

  // taken explicit number
  const before = await snapshot(root, { skipStoryforge: true });
  const dup = await repo.createBook({ title: 'Dup', seriesSlug: 'harbour-lights', seriesNumber: 7, template: 'blank' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'SERIES_NUMBER_TAKEN');
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before, 'refusal wrote nothing');

  // library view: books sit in the series, in series_number order
  assert.deepEqual((await validate(root)).diagnostics, []);
  const list = await repo.listBooks();
  const mine = list.find((x) => x.id === a.bookId);
  assert.equal(mine.series, 'harbour-lights');
  assert.equal(mine.series_number, 3);
  const info = await repo.libraryInfo();
  const series = info.series.find((s) => s.slug === 'harbour-lights');
  assert.equal(series.book_ids.length, 6);
  assert.deepEqual(series.book_ids.slice(2), [a.bookId, b.bookId, c.bookId, d.bookId]);
});

test('series: an explicit unused number below the max is allowed (gap filling is not required, taken is the only clash)', async () => {
  const { root, repo } = await setup();
  const a = await repo.createBook({ title: 'Ten', seriesSlug: 'harbour-lights', seriesNumber: 10, template: 'blank' });
  assert.equal(a.ok, true, JSON.stringify(a));
  const b = await repo.createBook({ title: 'Five', seriesSlug: 'harbour-lights', seriesNumber: 5, template: 'blank' });
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.deepEqual((await validate(root)).diagnostics, []);
});
