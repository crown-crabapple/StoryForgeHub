import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../../core/src/index.mjs';
import {
  ALL_FIXTURES, INDEX_SRC, bookRootsOf, copyFixture, dbPathOf, dumpTables, openFor, plain, readExpected, sortedJson,
} from './helpers.mjs';

const QUERIES = ['orchard', 'ferry', 'key', 'cafe', 'Maren', 'tide'];
const diagShape = ({ code, severity, file, location, message }) => ({ code, severity, file, location, message });

async function recordState(idx, dbPath) {
  const q = idx.query;
  const searches = {};
  for (const s of QUERIES) searches[s] = plain(await q.search(s));
  return {
    tables: dumpTables(dbPath),
    scenes: plain(await q.scenes()),
    excluded: plain(await q.excluded()),
    links: plain(await q.links()),
    mentions: plain(await q.mentions()),
    diagnostics: plain(await q.diagnostics()),
    counts: plain(await q.counts()),
    searches,
  };
}

/** Count `.md` files outside archive/ and .storyforge/ whose front matter declares `schema`. */
async function schemaCount(bookRoot, schema) {
  let n = 0;
  const re = new RegExp(`^schema: ${schema.replace('/', '\\/')}\\s*$`, 'm');
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === '.storyforge' || e.name === 'archive') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.md') && re.test((await fs.readFile(full, 'utf8')).slice(0, 400))) n++;
    }
  }
  await walk(bookRoot);
  return n;
}

for (const fixture of ALL_FIXTURES) {
  test(`${fixture}: deleting .storyforge and rebuilding gives identical tables and query results`, async () => {
    const root = await copyFixture(fixture);
    for (const bookRoot of bookRootsOf(fixture, root)) {
      const first = await openFor(bookRoot);
      const built = await first.idx.rebuild();
      assert.equal(built.ok, true, `${bookRoot}: ${JSON.stringify(built)}`);
      assert.equal((await first.idx.status()).state, 'fresh');
      const before = await recordState(first.idx, first.dbPath);
      assert.ok(before.tables.files.length > 0, 'files table is populated');

      await fs.rm(path.join(bookRoot, '.storyforge'), { recursive: true, force: true });

      const second = await openFor(bookRoot);
      assert.equal((await second.idx.status()).state, 'missing');
      const rebuilt = await second.idx.rebuild();
      assert.equal(rebuilt.ok, true);
      const after = await recordState(second.idx, second.dbPath);

      assert.deepEqual(after.tables, before.tables, 'every table identical');
      for (const key of ['scenes', 'excluded', 'links', 'mentions', 'diagnostics', 'counts', 'searches']) {
        assert.deepEqual(after[key], before[key], key);
      }
    }
  });

  test(`${fixture}: index scenes, diagnostics, links and counts agree with the files`, async () => {
    const root = await copyFixture(fixture);
    const expected = await readExpected(fixture);
    for (const bookRoot of bookRootsOf(fixture, root)) {
      const { idx } = await openFor(bookRoot);
      await idx.rebuild();
      const result = await validate(bookRoot);
      const book = result.books[0];

      const scenes = plain(await idx.query.scenes());
      assert.deepEqual(scenes.map((s) => s.id), book.order.map((s) => s.id));
      const positions = scenes.map((s) => s.position);
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'positions ascend');
      assert.equal(new Set(positions).size, scenes.length, 'positions are distinct');
      if (bookRoot === root && expected.order) {
        assert.deepEqual(scenes.map((s) => s.id), expected.order, 'matches expected.json order');
      }
      if (bookRoot === root && expected.excluded) {
        const byId = (a, b) => (a.id < b.id ? -1 : 1);
        const ex = plain(await idx.query.excluded());
        assert.deepEqual(
          ex.map((e) => ({ id: e.id, path: e.path, reason: e.reason })).sort(byId),
          [...expected.excluded].sort(byId),
        );
      }

      assert.deepEqual(
        sortedJson((await idx.query.diagnostics()).map(diagShape)),
        sortedJson(result.diagnostics.map(diagShape)),
      );

      const links = plain(await idx.query.links());
      const byRes = (r) => links.filter((l) => l.resolution === r).length;
      const diag = (c) => result.diagnostics.filter((d) => d.code === c).length;
      assert.equal(byRes('broken'), diag('E301'), 'broken links = E301');
      assert.equal(byRes('previous_slug'), diag('W301'), 'previous_slug links = W301');
      assert.equal(byRes('archived'), diag('W303'), 'archived links = W303');
      assert.equal(byRes('wrong_kind'), diag('E302'), 'wrong_kind links = E302');
      assert.equal(byRes('cross_book'), diag('I402'), 'cross_book links = I402');

      const repo = createFsRepository(bookRoot);
      const [summary] = await repo.listBooks();
      const counts = plain(await idx.query.counts());
      assert.equal(counts.scenes, summary.scene_count);
      assert.equal(counts.words, summary.word_count);
      assert.equal(counts.broken_links, diag('E301'));
      assert.equal(counts.links, links.length);
      assert.equal(counts.entries, await schemaCount(bookRoot, 'storyforge.entry/v1'));
      assert.equal(counts.threads, await schemaCount(bookRoot, 'storyforge.thread/v1'));
      assert.equal(counts.events, await schemaCount(bookRoot, 'storyforge.event/v1'));
    }
  });
}

test('salt-orchard: a known wiki-link target has resolved backlink rows', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const { idx } = await openFor(root);
  await idx.rebuild();
  const links = plain(await idx.query.links({ targetId: 'entry_01S5000000000000000000000N' }));
  assert.ok(links.length >= 2, 'port-aldine is linked from at least two entries');
  assert.ok(links.every((l) => l.resolution === 'ok'));
});

test('index source never calls the store mutators other than writeMeta', async () => {
  const files = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.m?js$/.test(e.name)) files.push(full);
    }
  }
  await walk(INDEX_SRC);
  assert.ok(files.length > 0, 'packages/index/src has source files');
  let sawWriteMeta = false;
  for (const f of files) {
    const text = await fs.readFile(f, 'utf8');
    const bad = text.match(/\b(?:store|tx)\??\.(write|create|move|archive|restore|batch)\s*\(/g);
    assert.equal(bad, null, `${f} calls a forbidden store mutator: ${bad}`);
    if (/\.writeMeta\s*\(/.test(text)) sawWriteMeta = true;
  }
  assert.ok(sawWriteMeta, 'index persists through store.writeMeta');
});

test('building an index leaves every Markdown file untouched', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const listing = async () => {
    const out = {};
    async function walk(dir) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (e.name === '.storyforge') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out[path.relative(root, full)] = (await fs.readFile(full)).toString('base64');
      }
    }
    await walk(root);
    return out;
  };
  const before = await listing();
  const { idx } = await openFor(root);
  await idx.rebuild();
  assert.deepEqual(await listing(), before);
  await fs.access(dbPathOf(root));
});
