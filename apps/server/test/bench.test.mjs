// M08-J04 section 4: the benchmark's generators and report are themselves checked, small and fast (the measuring is `npm run bench`, not a test).
// A generated book validates clean, two runs write identical bytes, and the table the report writes lists every fixture and says so when a run did not finish.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validate } from '../../../packages/format/src/index.mjs';
import { generateBook } from '../../../bench/gen-book.mjs';
import { measureSize, makeS, readScenes } from '../../../bench/fixtures.mjs';
import { OPERATIONS } from '../../../bench/operations.mjs';
import { formatMs, renderRun } from '../../../bench/report.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-bench-test-'));
const SMALL = { acts: 2, chapters: 4, scenesPerChapter: 3, wordsPerScene: 120, characters: 12, locations: 6 };

/** A hash over every file's relative path and bytes. */
function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
      else h.update(`${rel}/${e.name}\0`).update(fs.readFileSync(p));
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

test('the XL generator writes a book that validates with no errors, with the counts it was asked for', async () => {
  const dir = tmp();
  const { root, stats } = generateBook(path.join(dir, 'book'), SMALL);
  assert.equal(stats.scenes, 12);
  assert.equal(stats.chapters, 4);
  assert.ok(stats.words > 12 * 100 && stats.words < 12 * 160, String(stats.words));
  const v = await validate(root);
  assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.equal(v.books.length, 1);
  assert.equal(readScenes(root).ids.length, 12);
  const size = measureSize(root, [root]);
  assert.equal(size.scenes, 12);
  assert.ok(Math.abs(size.words - stats.words) <= 12, 'the measured words match the generated ones');
});

test('the generator is deterministic: the same options write the same bytes, a different seed does not', () => {
  const a = generateBook(path.join(tmp(), 'book'), SMALL).root;
  const b = generateBook(path.join(tmp(), 'book'), SMALL).root;
  const c = generateBook(path.join(tmp(), 'book'), { ...SMALL, seed: 7 }).root;
  assert.equal(treeHash(a), treeHash(b));
  assert.notEqual(treeHash(a), treeHash(c));
});

test('fixture S is the committed sample, copied (the sample itself is not touched)', async () => {
  const dir = tmp();
  const s = makeS(dir);
  assert.ok(s.sceneIds.length > 3);
  assert.equal(s.name, 'S');
  assert.ok(path.resolve(s.root).startsWith(path.resolve(dir)), 'the fixture lives in the temp folder, not in the repository');
  const v = await validate(s.root);
  assert.deepEqual(v.diagnostics.filter((d) => d.severity === 'error'), []);
});

test('the report: time formatting, one column per fixture, and a note for a run that did not finish', () => {
  assert.equal(formatMs(842.4), '842 ms');
  assert.equal(formatMs(12345), '12.3 s');
  assert.equal(formatMs(190_000), '3 min 10 s');
  assert.equal(formatMs(null), '-');
  const ok = (ms) => ({ status: 'ok', runs_ms: [ms, ms, ms], median_ms: ms });
  const operations = Object.fromEntries(OPERATIONS.map(([k]) => [k, ok(100)]));
  operations.export_pdf = { status: 'partial', runs_ms: [5000, 6000], median_ms: 6000, note: 'time budget used up' };
  operations.restore = { status: 'error', runs_ms: [], median_ms: null, note: 'RESTORE_LIMIT_EXCEEDED' };
  const result = {
    date: '2026-11-02', git: 'abc1234', reps: 5, machine: { hash: 'deadbeef', node: 'v24', os: 'test os', cpu: 'test cpu', cores: 8, ram_mb: 16000 },
    fixtures: {
      S: { size: { scenes: 8, words: 250, books: 1, bytes: 12_000 }, total_ms: 3000, operations },
      XL: { size: { scenes: 1500, words: 600_000, books: 1, bytes: 4_000_000 }, total_ms: 900_000, operations },
    },
  };
  const md = renderRun(result, 'bench/results/2026-11-02-deadbeef.json');
  assert.match(md, /^### Run 2026-11-02, machine deadbeef, commit abc1234/);
  assert.match(md, /\| Fixture \| S \| XL \|/);
  assert.match(md, /250 words/);
  assert.match(md, /600k words/);
  for (const [, label] of OPERATIONS) assert.ok(md.includes(`| ${label} |`), label);
  assert.match(md, /6\.0 s \(2 runs\)/);
  assert.match(md, /failed/);
  assert.match(md, /only 2 of 5 runs finished/);
  assert.match(md, /RESTORE_LIMIT_EXCEEDED/);
  assert.match(md, /bench\/results\/2026-11-02-deadbeef\.json/);
});
