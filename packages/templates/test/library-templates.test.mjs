// M07-J01 section 5: library templates (_templates/<name>/) and "save a book as a template" (the pure part).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../format/src/index.mjs';
import { listTemplates, renderTemplate, templateFromBook } from '../src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../format/fixtures');
const temps = [];
after(async () => {
  for (const t of temps) await fs.rm(t, { recursive: true, force: true });
});
async function tmp() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-tpl-'));
  temps.push(d);
  return d;
}
async function copyFixture(rel) {
  const dest = path.join(await tmp(), path.basename(rel));
  await fs.cp(path.join(FIXTURES, rel), dest, { recursive: true });
  return dest;
}
async function writeTree(root, files) {
  for (const [rel, bytes] of files) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), bytes);
  }
}
const VARS = { book_title: 'A New Book', book_slug: 'a-new-book', pen_name: 'r-fenwick', today: '2026-01-02' };

test('listTemplates() with no library is the built-ins, each marked source builtin', async () => {
  const list = await listTemplates();
  assert.deepEqual(list.map((t) => t.name), ['blank', 'story-circle', 'heros-journey', 'seven-point']);
  assert.ok(list.every((t) => t.source === 'builtin' && t.shadows_builtin === undefined));
});

test('listTemplates({ libraryRoot }) adds the library templates after the built-ins', async () => {
  const lib = await copyFixture('valid/tidewater');
  const list = await listTemplates({ libraryRoot: lib });
  assert.deepEqual(list.map((t) => `${t.source}:${t.name}`), ['builtin:blank', 'builtin:story-circle', 'builtin:heros-journey', 'builtin:seven-point', 'library:mystery-arc']);
  const mine = list.at(-1);
  assert.deepEqual({ acts: mine.acts, chapters: mine.chapters, scenes: mine.scenes, shadows_builtin: mine.shadows_builtin }, { acts: 1, chapters: 0, scenes: 1, shadows_builtin: false });
  assert.deepEqual(mine.beats, ['The crime', 'The clue']);
  // a library with no _templates/ has none
  assert.equal((await listTemplates({ libraryRoot: path.join(lib, 'pilgrims-road') })).length, 4);
});

test('a library template with a built-in name is listed as library with shadows_builtin; both render by source + name', async () => {
  const lib = await copyFixture('valid/tidewater');
  await fs.cp(path.join(lib, '_templates', 'mystery-arc'), path.join(lib, '_templates', 'blank'), { recursive: true });
  await fs.writeFile(path.join(lib, '_templates', 'blank', 'template.md'), '---\nschema: storyforge.template/v1\nname: blank\ntitle: My blank\ndescription: Mine.\n---\n');
  const list = await listTemplates({ libraryRoot: lib });
  const mine = list.find((t) => t.source === 'library' && t.name === 'blank');
  assert.equal(mine.shadows_builtin, true);
  assert.equal(list.filter((t) => t.name === 'blank').length, 2);
  const fromLibrary = await renderTemplate('blank', VARS, { libraryRoot: lib, source: 'library' });
  const fromBuiltin = await renderTemplate('blank', VARS, { libraryRoot: lib, source: 'builtin' });
  assert.ok(fromLibrary.has('planning/threads/the-mystery.md'));
  assert.ok(!fromBuiltin.has('planning/threads/the-mystery.md'));
  assert.deepEqual([...(await renderTemplate('blank', VARS, { libraryRoot: lib })).keys()], [...fromBuiltin.keys()], 'no source: the built-in one');
  await assert.rejects(renderTemplate('blank', VARS, { source: 'library' }), { code: 'NO_SUCH_TEMPLATE' });
});

test('a library template renders a validator-clean book with fresh ids', async () => {
  const lib = await copyFixture('valid/tidewater');
  const files = await renderTemplate('mystery-arc', VARS, { libraryRoot: lib });
  const book = path.join(await tmp(), 'a-new-book');
  await writeTree(book, files);
  const diags = (await validate(book)).diagnostics;
  assert.deepEqual(diags.filter((d) => d.severity === 'error'), []);
  const again = await renderTemplate('mystery-arc', VARS, { libraryRoot: lib });
  const ids = (m) => [...m.values()].map((b) => /^id: (.+)$/m.exec(b.toString())?.[1]).filter(Boolean);
  assert.equal(new Set([...ids(files), ...ids(again)]).size, ids(files).length * 2, 'every render gets new ids');
});

test('templateFromBook keeps the structure and drops the story, and the result renders a clean book', async () => {
  const src = await copyFixture('valid/salt-orchard');
  const files = await templateFromBook(src, { name: 'my-saved', title: 'My saved', description: 'Structure of a book.' });
  const names = [...files.keys()];
  assert.ok(names.includes('template.md'));
  assert.ok(names.includes('book/book.md'));
  assert.ok(names.some((n) => /^book\/manuscript\/.+\/\d{4}-.+\.md$/.test(n)), 'scenes are kept');
  assert.ok(!names.some((n) => /^book\/(archive|legacy|provenance|research|assets)\//.test(n)));
  assert.ok(!names.some((n) => n.startsWith('book/codex/') && !n.startsWith('book/codex/_types/')), 'codex entries are dropped');
  const text = (n) => files.get(n).toString('utf8');

  // no scene body survives; no id survives
  for (const n of names.filter((x) => /\/\d{4}-.+\.md$/.test(x))) {
    const body = text(n).split('\n---\n').slice(1).join('\n---\n');
    assert.equal(body.trim(), '', `${n} has no body`);
  }
  for (const [n, b] of files) assert.ok(!/(scene|entry|thread|event|book|act|chap|note)_[0-9A-HJKMNP-TV-Z]{26}/.test(b.toString()), `${n} has no real id`);
  assert.match(text('book/book.md'), /^id: \{\{id:book\}\}$/m);
  assert.match(text('book/book.md'), /^slug: \{\{book_slug\}\}$/m);
  assert.doesNotMatch(text('book/book.md'), /^cover:|^subtitle:/m);
  assert.doesNotMatch(text('book/book.md'), /\n---\n[^]*\S/, 'no blurb');

  // it is a template the app can list and render
  const lib = await tmp();
  await writeTree(path.join(lib, '_templates', 'my-saved'), files);
  const list = await listTemplates({ libraryRoot: lib });
  const info = list.find((t) => t.source === 'library');
  assert.equal(info.name, 'my-saved');
  assert.ok(info.scenes >= 5 && info.acts >= 2);
  const rendered = await renderTemplate('my-saved', VARS, { libraryRoot: lib });
  const book = path.join(await tmp(), 'a-new-book');
  await writeTree(book, rendered);
  const result = await validate(book);
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.equal(result.books[0].slug, 'a-new-book');
  assert.equal(result.books[0].order.length, info.scenes);
  // and the ids are new
  const oldIds = new Set([...(await fs.readFile(path.join(src, 'book.md'), 'utf8')).matchAll(/^id: (.+)$/gm)].map((m) => m[1]));
  assert.ok(!oldIds.has(result.books[0].id));
});

test('templateFromBook keeps labels, _types and planning docs and threads, drops entries, and its template.md validates', async () => {
  const src = await copyFixture('valid/tidewater/tidewater');
  const book = path.join(src, 'salt-orchard-2');
  await fs.mkdir(path.join(book, 'codex', '_types'), { recursive: true });
  await fs.cp(path.join(src, 'codex', '_types', 'vessel.md'), path.join(book, 'codex', '_types', 'vessel.md'));
  await fs.mkdir(path.join(book, 'planning', 'threads'), { recursive: true });
  await fs.cp(path.join(src, 'low-tide', 'planning', 'threads', 'the-lost-ledger.md'), path.join(book, 'planning', 'threads', 'the-lost-ledger.md'));
  const files = await templateFromBook(book, { name: 'tide', title: 'Tide' });
  const text = (n) => files.get(n).toString('utf8');
  assert.match(text('book/book.md'), /^labels:\n {2}- name: Draft Two\n {4}color: "#2E7D32"$/m);
  assert.match(text('book/book.md'), /^series_number: \{\{series_number\}\}$/m);
  assert.match(text('book/book.md'), /^pen_name: \{\{pen_name\}\}$/m);
  assert.match(text('book/manuscript/act-01-one/ch-001-one/0010-arrival.md'), /^labels: \[Mystery, Draft Two\]$/m);
  assert.doesNotMatch(text('book/manuscript/act-01-one/ch-001-one/0010-arrival.md'), /^(pov|characters|locations):/m);
  assert.ok(files.has('book/codex/_types/vessel.md'));
  assert.match(text('book/codex/_types/vessel.md'), /^id: \{\{id:note-type-vessel\}\}$/m);
  assert.match(text('book/codex/_types/vessel.md'), /kind: number/);
  assert.ok(files.has('book/planning/threads/the-lost-ledger.md'));
  assert.ok(![...files.keys()].some((n) => n.includes('codex/characters') || n.includes('codex/vessels')));

  const lib = await tmp();
  await writeTree(path.join(lib, '_templates', 'tide'), files);
  const result = await validate(lib);
  assert.deepEqual(result.diagnostics, [], 'the saved template.md is valid');
});

test('templateFromBook refuses a bad name, and is deterministic', async () => {
  const src = await copyFixture('valid/salt-orchard');
  await assert.rejects(templateFromBook(src, { name: 'Bad Name', title: 'x' }), { code: 'BAD_TEMPLATE_NAME' });
  await assert.rejects(templateFromBook(src, { name: 'ok', title: '' }), { code: 'BAD_TEMPLATE_TITLE' });
  const a = await templateFromBook(src, { name: 'same', title: 'Same' });
  const b = await templateFromBook(src, { name: 'same', title: 'Same' });
  assert.deepEqual([...a.keys()], [...b.keys()]);
  for (const [k, v] of a) {
    if (k !== 'template.md') assert.ok(v.equals(b.get(k)), k);
  }
});
