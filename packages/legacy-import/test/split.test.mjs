// M06-J01 acceptance 3 (byte-preserving split) and the chapter-order rules of contract section 2, on hand-built dumps.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chapterDump, chapterFileOf, chapterRow, frontMatterSplit, loadImporter, rejoinProblem, scenesOf } from './helpers.mjs';

const { planImport } = await loadImporter();

async function planOf(chapters, extra) {
  return planImport(chapterDump(chapters, extra), {});
}

/** One chapter per body; returns [{ body, id, plan }] using a single plan. */
async function planBodies(bodies) {
  const rows = bodies.map((body, i) => chapterRow({ id: 500 + i, num: String(i + 1), sort_order: i + 1, body }));
  const plan = await planOf(rows);
  return { plan, cases: bodies.map((body, i) => ({ body, id: 500 + i })) };
}

const FENCE = 'Intro line.\n\n```\n---\ncode after rule\n```\n\nAfter the fence.\n';
const TABLE = '| Name | Value |\n|---|---|\n| a | 1 |\n| b | 2 |\n\nAfter the table.\n';
const MIXED = 'One.\n\n---\n\nTwo.\n\n***\n\nThree.\n\n___\n\nFour.\n';

test('rejoin oracle itself: rejects dropped text and accepts a plain separator', () => {
  assert.equal(rejoinProblem('A\n\n---\n\nB\n', ['A', 'B\n']), null);
  assert.notEqual(rejoinProblem('A\n\n---\n\nB\n', ['A', 'B']), null, 'lost trailing newline must be detected');
  assert.notEqual(rejoinProblem('A\n\n---\n\nB\n', ['B\n']), null, 'lost first scene must be detected');
});

test('re-joining scenes reproduces the original body for every awkward body', async () => {
  const bodies = [
    FENCE,
    TABLE,
    MIXED,
    'A',
    'A\n',
    'A\n\n',
    'A\n\n\n',
    '\n\nA\n',
    'A\n---\nB\n',
    'A\n\n---\n\nB',
    'A\n---\n',
    '---\nA\n',
    'One\r\n\r\n---\r\n\r\nTwo\r\n',
    'Mixed\r\nendings\n\n---\n\nhere\r\n',
    'A\n\n----\n\nB\n',
    '<!-- only a comment -->\n',
    'Real.\n\n---\n\n<!-- note to self -->\n\n---\n\nMore.\n',
    'Real.\n\n---\n\n# Heading only\n\n---\n\nMore.\n',
    '# Title\n\nText with unicode é中😀 and tabs\t.\n\n---\n\nSecond.\n',
  ];
  const { plan, cases } = await planBodies(bodies);
  for (const { body, id } of cases) {
    const scenes = scenesOf(plan, id);
    const problem = rejoinProblem(body, scenes.map((s) => s.body));
    assert.equal(problem, null, `body ${JSON.stringify(body.slice(0, 50))}: ${problem}`);
  }
});

test('--- inside a fenced code block, a table delimiter row and a longer dash run do not split', async () => {
  const { plan, cases } = await planBodies([FENCE, TABLE, 'A\n\n----\n\nB\n']);
  for (const { body, id } of cases) assert.equal(scenesOf(plan, id).length, 1, `should stay one scene: ${JSON.stringify(body.slice(0, 40))}`);
});

test('---, *** and ___ on their own lines each split', async () => {
  const { plan, cases } = await planBodies([MIXED]);
  const scenes = scenesOf(plan, cases[0].id);
  assert.equal(scenes.length, 4);
  assert.deepEqual(scenes.map((s) => s.fm.sequence), [10, 20, 30, 40], 'sequence = 10 x ordinal');
  for (const [i, word] of ['One', 'Two', 'Three', 'Four'].entries()) assert.match(scenes[i].body, new RegExp(word));
});

test('a tilde-fenced block also protects a --- line', async () => {
  const tilde = 'Top\n\n~~~\n---\n~~~\n\nBottom\n';
  const { plan, cases } = await planBodies([tilde]);
  assert.equal(scenesOf(plan, cases[0].id).length, 1);
});

test('comment-only and heading-only segments are kept as their own scenes, with an info issue', async () => {
  const comment = 'Real.\n\n---\n\n<!-- note to self -->\n\n---\n\nMore.\n';
  const heading = 'Real.\n\n---\n\n# Heading only\n\n---\n\nMore.\n';
  const { plan, cases } = await planBodies([comment, heading]);
  for (const { id } of cases) {
    const scenes = scenesOf(plan, id);
    assert.equal(scenes.length, 3, 'the middle segment must not be dropped');
    assert.ok(
      plan.issues.some((i) => i.severity === 'info' && String(i.id) === String(id)),
      `an info issue naming chapter ${id}`,
    );
  }
  assert.ok(scenesOf(plan, cases[0].id)[1].body.includes('<!-- note to self -->'));
  assert.ok(scenesOf(plan, cases[1].id)[1].body.includes('# Heading only'));
});

test('scene title is the first heading in the segment, else "<chapter title> - part N"', async () => {
  const body = '# Opening\n\nText.\n\n---\n\nNo heading here.\n';
  const plan = await planOf([chapterRow({ id: 600, title: 'The Tide', body })]);
  const [a, b] = scenesOf(plan, 600);
  assert.equal(a.fm.title, 'Opening');
  assert.match(b.fm.title, /^The Tide .{1,3} part 2$/);
});

test('an empty chapter body does not crash and loses nothing', async () => {
  const { plan, cases } = await planBodies(['', '\n']);
  for (const { body, id } of cases) assert.equal(rejoinProblem(body, scenesOf(plan, id).map((s) => s.body)), null);
});

// ---- chapter order ----------------------------------------------------------------------------------------------------------------

const chapterNumbers = (plan, ids) =>
  ids.map((id) => {
    const f = chapterFileOf(plan, id);
    assert.ok(f, `chapter file for legacy chapter ${id}`);
    return frontMatterSplit(f.bytes).fm;
  });

test('chapters are numbered by sort_order, original num kept as x-legacy-num (3.5 and prologue included)', async () => {
  const rows = [
    chapterRow({ id: 1, num: '2', sort_order: 30 }),
    chapterRow({ id: 2, num: 'prologue', sort_order: 10 }),
    chapterRow({ id: 3, num: '3.5', sort_order: 50 }),
    chapterRow({ id: 4, num: '3', sort_order: 40 }),
    chapterRow({ id: 5, num: '1', sort_order: 20 }),
  ];
  const plan = await planOf(rows);
  const fms = chapterNumbers(plan, [2, 5, 1, 4, 3]);
  assert.deepEqual(fms.map((f) => f.chapter), [1, 2, 3, 4, 5]);
  assert.deepEqual(fms.map((f) => String(f['x-legacy-num'])), ['prologue', '1', '2', '3', '3.5']);
});

test('equal sort_order falls back to natural num order (2 < 3 < 3.5 < 10)', async () => {
  const rows = [
    chapterRow({ id: 1, num: '10', sort_order: 0 }),
    chapterRow({ id: 2, num: '3.5', sort_order: 0 }),
    chapterRow({ id: 3, num: '2', sort_order: 0 }),
    chapterRow({ id: 4, num: '3', sort_order: 0 }),
  ];
  const plan = await planOf(rows);
  const fms = chapterNumbers(plan, [3, 4, 2, 1]);
  assert.deepEqual(fms.map((f) => f.chapter), [1, 2, 3, 4]);
  assert.deepEqual(fms.map((f) => String(f['x-legacy-num'])), ['2', '3', '3.5', '10']);
});

test('a full tie (same sort_order and num) falls back to id and warns naming both ids', async () => {
  const rows = [chapterRow({ id: 71, num: '7', sort_order: 5 }), chapterRow({ id: 70, num: '7', sort_order: 5 })];
  const plan = await planOf(rows);
  const [first, second] = chapterNumbers(plan, [70, 71]);
  assert.equal(first.chapter, 1);
  assert.equal(second.chapter, 2);
  const w = plan.issues.find((i) => i.severity === 'warning' && JSON.stringify(i).includes('70') && JSON.stringify(i).includes('71'));
  assert.ok(w, 'a warning issue naming both chapter ids');
});

test('chapters with no acts land in act 1', async () => {
  const plan = await planOf([chapterRow({ id: 1 })]);
  assert.match(chapterFileOf(plan, 1).path, /manuscript\/act-01-[^/]*\/ch-001-/);
});

test('a stale legacy scenes cache (wrong segment count and hash) is not trusted: its label never reaches the output', async () => {
  const body = 'One.\n\n---\n\nTwo.\n';
  // one cached scene for a two-segment body, with a hash that matches nothing: the cache is stale
  const scenes = [{ id: 1, book_id: 'bk-test', chapter_id: 1, ordinal: 1, title: '', word_count: 0, body_hash: 'deadbeef', label: 'STALE-LABEL-XYZ', summary: 'stale', note: '', seq: null, updated_at: '2026-01-01 00:00:00' }];
  const plan = await planOf([chapterRow({ id: 1, file: 'ch-1.md', body })], { scenes });
  assert.ok(!JSON.stringify(plan.books.map((b) => b.files.map((f) => Buffer.from(f.bytes).toString('utf8')))).includes('STALE-LABEL-XYZ'));
});
