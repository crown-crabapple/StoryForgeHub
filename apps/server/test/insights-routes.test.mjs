// M07-J02 acceptance 1: the Insights dashboard numbers (GET /api/books/:b/insights) are rebuildable from the files.
//   - byte-identical when every .storyforge/ is deleted and the index rebuilt, and identical when computed without an index
//   - a golden for the tidewater fixture's counts
// The M06-J03 large synthetic book runs the same check in insights.large.mjs (npm run test:large).
// Contract: docs/contracts/M07-J02-goals-analytics-tasks.md section 3 and acceptance 1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARRIVAL, BOOK, KEY, closeAll, freshBook, readAll, send } from './move-helpers.mjs';
import { copyFixture } from './helpers.mjs';
import { insightsParity, openRepo } from './insights-helpers.mjs';

after(closeAll);

const CLOCK = () => new Date(2026, 10, 4, 12, 0).getTime(); // Wednesday 2026-11-04, local time
const local = (y, m, d, h = 10) => new Date(y, m - 1, d, h, 0).toISOString().replace(/\.\d{3}Z$/, 'Z');

test('1. tidewater: insights are identical from the files, from a fresh index, after deleting every .storyforge/ and rebuilding, and over HTTP', async () => {
  const root = await copyFixture('valid/tidewater');
  const out = await insightsParity(root, CLOCK);
  assert.equal(out.size, 3);
});

test('1. tidewater: the golden counts', async () => {
  const root = await copyFixture('valid/tidewater');
  const repo = openRepo(root, CLOCK);
  try {
    const books = await repo.listBooks();
    const bySlug = {};
    for (const b of books) bySlug[b.slug] = (await repo.getInsights(b.id, { from: 'files' })).insights;
    assert.deepEqual(Object.keys(bySlug).sort(), ['low-tide', 'pilgrims-road', 'salt-orchard-2']);
    const brief = (i) => ({
      scenes: i.book.scenes, words: i.book.words,
      status: Object.fromEntries(i.manuscript.status.filter((s) => s.scenes > 0).map((s) => [s.status, s.scenes])),
      labels: i.manuscript.labels.rows.map((l) => [l.label, l.scenes, l.defined]), unlabeled: i.manuscript.labels.unlabeled,
      pov: i.manuscript.pov.map((p) => [p.name, p.scenes, p.share, p.shared]),
      heat: i.story.characters.rows.map((r) => [r.name, r.cells, r.shared]), no_scenes: i.story.characters.without_scenes,
      threads: i.story.threads.rows.map((t) => [t.title, t.planted, t.developed, t.paid, t.linked]),
      relationships: i.story.relationships.map((r) => [r.name, r.count, r.shared]),
      events: [i.story.events.total, i.story.events.unplaced], tasks: i.tasks.total,
    });
    assert.deepEqual(brief(bySlug['salt-orchard-2']), {
      scenes: 1, words: 14, status: { drafting: 1 },
      labels: [['Draft Two', 1, true], ['Mystery', 1, true], ['Backstory', 0, true]], unlabeled: 0,
      pov: [['Ilse Hollis', 1, 100, true]],
      heat: [['Ilse Hollis', [1], true]], no_scenes: 1,
      threads: [], relationships: [['Ilse Hollis', 2, true], ['Maren Hollis', 1, false]], events: [0, 0], tasks: 0,
    });
    assert.deepEqual(brief(bySlug['low-tide']), {
      scenes: 1, words: 13, status: { drafting: 1 },
      labels: [['Backstory', 0, true], ['Mystery', 0, true]], unlabeled: 1,
      pov: [['Ilse Hollis', 1, 100, true]],
      heat: [['Ilse Hollis', [1], true]], no_scenes: 0,
      threads: [['The lost ledger', 0, 0, 0, 1]], relationships: [['Ilse Hollis', 1, true]], events: [0, 0], tasks: 0,
    });
    assert.deepEqual(brief(bySlug['pilgrims-road']), {
      scenes: 1, words: 7, status: { drafting: 1 },
      labels: [], unlabeled: 1,
      pov: [['Captain Vane', 1, 100, false]],
      heat: [['Captain Vane', [1], false]], no_scenes: 0,
      threads: [], relationships: [], events: [0, 0], tasks: 0,
    });
    // the shape: sorted keys, 90 days, the goal card's legacy goal absent without a daily_word_goal
    const i = bySlug['low-tide'];
    assert.deepEqual(Object.keys(i), ['as_of', 'book', 'manuscript', 'progress', 'schema', 'story', 'tasks']);
    assert.equal(i.schema, 'storyforge.insights/v1');
    assert.equal(i.as_of, '2026-11-04');
    assert.equal(i.progress.days.length, 90);
    assert.deepEqual(i.progress.goals, []);
  } finally {
    await repo.close();
  }
});

test('1. a book with everything the numbers read (goals, log, sessions, tasks, labels, shared entries): files == index == rebuilt', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const w = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  await w('activity/goals.md', `---\nschema: storyforge.goals/v1\nid: note_01J00000000000000000000001\ngoals:\n  - { id: g1, kind: words, target: 300, period: day }\n  - { id: g2, kind: words, target: 5000, period: total, due: 2026-12-31 }\n  - { id: g3, kind: scenes, target: 3, period: week }\n  - { id: g4, kind: minutes, target: 90, period: week, scope: chap_01S5000000000000000000000E }\n---\n`);
  await w('activity/writing-log.md', `---\nschema: storyforge.doc/v1\nid: note_01J00000000000000000000002\ntitle: Writing log\n---\n\n| Date | Words added | Words removed | Minutes | Sessions |\n|---|---|---|---|---|\n| 2026-11-01 | 100 | 0 | 20 | 1 |\n| 2026-11-02 | 450 | 50 | 60 | 2 |\n| 2026-11-03 | 320 | 10 | 45 | 1 |\n| 2026-11-04 | 120 | 0 | 15 | 1 |\n`);
  await w('activity/sessions/2026/2026-11.md', `---\nschema: storyforge.doc/v1\nid: note_01J00000000000000000000003\ntitle: Sessions 2026-11\n---\n\n| Start | End | Minutes | Added | Removed | Kind | Scenes |\n|---|---|---|---|---|---|---|\n| ${local(2026, 11, 3)} | ${local(2026, 11, 3, 11)} | 60 | 300 | 10 | sprint | ${ARRIVAL} ${KEY} |\n| ${local(2026, 11, 4)} | ${local(2026, 11, 4, 11)} | 15 | 120 | 0 | timer | ${KEY} |\nnot a row\n`);
  await w('planning/tasks/a.md', `---\nschema: storyforge.task/v1\nid: note_01J00000000000000000000004\nslug: a\ntitle: A\nstatus: open\nsource: { kind: manual }\ntargets:\n  - { id: ${ARRIVAL} }\n---\n`);
  await w('planning/tasks/b.md', `---\nschema: storyforge.task/v1\nid: note_01J00000000000000000000005\nslug: b\ntitle: B\nstatus: done\n---\n`);
  const out = await insightsParity(root, CLOCK, { ids: [BOOK] });
  const i = JSON.parse(out.get(BOOK));
  const g = Object.fromEntries(i.progress.goals.map((x) => [x.id, x]));
  assert.deepEqual([g.g1.value, g.g1.met, g.g1.streak], [120, false, 2], 'today +120 is short of 300; Nov 3 (310) and Nov 2 (400) made it; Nov 1 (100) did not');
  assert.equal(g.g2.value, i.book.words);
  assert.deepEqual([g.g3.value, g.g3.period_start], [2, '2026-11-02']);
  assert.equal(g.g4.value, 75, 'minutes in chapter 1: rows touching a scene of the chapter (Arrival and The Key are chapter 1)');
  assert.deepEqual(i.tasks, { doing: 0, done: 1, dropped: 0, open: 1, total: 2 });
});

test('1. the route: GET /insights answers 200 with the numbers, 404 for an unknown book, and writes nothing', async () => {
  const ctx = await freshBook();
  const before = JSON.stringify([...(await readAll(ctx.root))].map(([p, b]) => [p, b.length]));
  const r = await send(ctx.port, 'GET', `/api/books/${BOOK}/insights`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.schema, 'storyforge.insights/v1');
  assert.equal(r.json.book.id, BOOK);
  assert.equal(r.json.book.scenes, 7);
  assert.equal((await send(ctx.port, 'GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/insights')).status, 404);
  assert.equal(JSON.stringify([...(await readAll(ctx.root))].map(([p, b]) => [p, b.length])), before);
});
