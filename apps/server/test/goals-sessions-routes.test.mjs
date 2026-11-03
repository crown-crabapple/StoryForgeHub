// M07-J02 acceptance 3 at the route level: goals and sessions files.
//   GET    /api/books/:b/goals                   -> { goals, skipped, daily_word_goal, effective }
//   POST   /api/books/:b/goals                   { goal: { id?, kind, target, period, due?, scope? } }   (add or change one goal)
//   DELETE /api/books/:b/goals/:id
//   POST   /api/books/:b/activity/session        { start, end, kind, scenes } (a row in activity/sessions/<YYYY>/<YYYY-MM>.md) | the old { minutes }
// Contract: docs/contracts/M07-J02-goals-analytics-tasks.md sections 1 and 2, acceptance 3.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validate } from '../../../packages/format/src/index.mjs';
import { ARRIVAL, BOOK, KEY, closeAll, freshBook, readAll, send } from './move-helpers.mjs';

after(closeAll);

const CHAP = 'chap_01S5000000000000000000000E';
const GOALS = 'activity/goals.md';
const b = (p = '') => `/api/books/${BOOK}${p}`;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const read = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.stat(path.join(root, ...rel.split('/'))).then(() => true, () => false);
const goalsOf = async (port) => (await send(port, 'GET', b('/goals'))).json;
const activityDiags = async (root) => (await validate(root)).diagnostics.filter((d) => d.file.startsWith('activity/'));
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sessionFile = (ms) => {
  const d = new Date(ms);
  return `activity/sessions/${d.getFullYear()}/${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.md`;
};

test('3. goals: add, change, remove through the routes; the file is created on the first goal and validates; untouched goals stay byte for byte', async () => {
  const ctx = await freshBook();
  assert.deepEqual((await goalsOf(ctx.port)).goals, []);
  assert.equal(await exists(ctx.root, GOALS), false, 'reading makes no file');

  const a = await send(ctx.port, 'POST', b('/goals'), { body: { goal: { kind: 'words', target: 500, period: 'day' } } });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.json.goal.id, 'g1');
  const t1 = await read(ctx.root, GOALS);
  assert.match(t1, /^---\nschema: storyforge\.goals\/v1\nid: note_[0-9A-HJKMNP-TV-Z]{26}\ngoals:\n {2}- \{ id: g1, kind: words, target: 500, period: day \}\n---\n$/);
  const bb = await send(ctx.port, 'POST', b('/goals'), { body: { goal: { kind: 'words', target: 90000, period: 'total', due: '2027-03-01' } } });
  assert.equal(bb.json.goal.id, 'g2');
  const c = await send(ctx.port, 'POST', b('/goals'), { body: { goal: { kind: 'minutes', target: 300, period: 'week', scope: CHAP } } });
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(await activityDiags(ctx.root), []);
  assert.deepEqual((await goalsOf(ctx.port)).goals.map((g) => [g.id, g.kind, g.target, g.period, g.due ?? null, g.scope ?? null]), [
    ['g1', 'words', 500, 'day', null, null],
    ['g2', 'words', 90000, 'total', '2027-03-01', null],
    ['g3', 'minutes', 300, 'week', null, CHAP],
  ]);

  // the same goal again: not one byte moves; a change moves one line
  const t2 = await read(ctx.root, GOALS);
  assert.equal((await send(ctx.port, 'POST', b('/goals'), { body: { goal: { id: 'g2', kind: 'words', target: 90000, period: 'total', due: '2027-03-01' } } })).status, 200);
  assert.equal(await read(ctx.root, GOALS), t2);
  assert.equal((await send(ctx.port, 'POST', b('/goals'), { body: { goal: { id: 'g1', kind: 'words', target: 700, period: 'day' } } })).status, 200);
  const t3 = await read(ctx.root, GOALS);
  assert.deepEqual(t3.split('\n').filter((l, i) => l !== t2.split('\n')[i]), ['  - { id: g1, kind: words, target: 700, period: day }']);

  const del = await send(ctx.port, 'DELETE', b('/goals/g2'));
  assert.equal(del.status, 200, del.text);
  assert.deepEqual((await goalsOf(ctx.port)).goals.map((g) => g.id), ['g1', 'g3']);
  assert.equal((await send(ctx.port, 'DELETE', b('/goals/nope'))).status, 404);
  assert.deepEqual(await activityDiags(ctx.root), []);
});

test('3. goals: bad goals are refused and write nothing; a scope must be a chapter or act of the book', async () => {
  const ctx = await freshBook();
  const bad = [
    { kind: 'pages', target: 5, period: 'day' }, { kind: 'words', target: 0, period: 'day' }, { kind: 'words', target: 5.5, period: 'day' }, { kind: 'words', target: 5, period: 'year' },
    { kind: 'words', target: 5, period: 'day', due: '2027-03-01' }, { kind: 'words', target: 5, period: 'total', due: '2027-02-30' }, { kind: 'words', target: 5, period: 'day', scope: 'chap_01ZZZZZZZZZZZZZZZZZZZZZZZZ' },
    { kind: 'words', target: 5, period: 'day', scope: ARRIVAL }, { id: 'has space', kind: 'words', target: 5, period: 'day' },
  ];
  for (const goal of bad) assert.equal((await send(ctx.port, 'POST', b('/goals'), { body: { goal } })).status, 400, JSON.stringify(goal));
  assert.equal((await send(ctx.port, 'POST', b('/goals'), { body: {} })).status, 400);
  assert.equal(await exists(ctx.root, GOALS), false);
  assert.equal((await send(ctx.port, 'POST', `/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/goals`, { body: { goal: { kind: 'words', target: 5, period: 'day' } } })).status, 404);
  const act = await send(ctx.port, 'POST', b('/goals'), { body: { goal: { kind: 'scenes', target: 2, period: 'month', scope: 'act_01S5000000000000000000000B' } } });
  assert.equal(act.status, 200, 'an act id is a valid scope too');
});

test('3. goals: items the app cannot read are kept as written when other goals change', async () => {
  const text = `---
schema: storyforge.goals/v1
id: note_01J00000000000000000000001
goals:
  - { id: g1, kind: words, target: 500, period: day }
  - { id: g2, kind: pages, target: 3, period: day }
  - a note to myself
---
My own text.
`;
  const ctx = await freshBook('valid/salt-orchard', async (root) => {
    await fs.mkdir(path.join(root, 'activity'), { recursive: true });
    await fs.writeFile(path.join(root, GOALS), text);
  });
  const got = await goalsOf(ctx.port);
  assert.deepEqual(got.goals.map((g) => g.id), ['g1']);
  assert.equal(got.skipped, 2);
  assert.equal((await send(ctx.port, 'POST', b('/goals'), { body: { goal: { id: 'g1', kind: 'words', target: 600, period: 'day' } } })).status, 200);
  assert.equal(await read(ctx.root, GOALS), text.replace('target: 500', 'target: 600'));
  assert.equal((await send(ctx.port, 'DELETE', b('/goals/g1'))).status, 200);
  assert.equal(await read(ctx.root, GOALS), text.replace('  - { id: g1, kind: words, target: 500, period: day }\n', ''));
});

test('3. daily_word_goal stays compatible: shown as a words/day goal when there is no such goal, never written into goals.md, and book.md is never touched by goals', async () => {
  const ctx = await freshBook();
  assert.equal((await send(ctx.port, 'POST', b('/goal'), { body: { daily_word_goal: 400 } })).status, 200);
  const bookMd = await read(ctx.root, 'book.md');
  let got = await goalsOf(ctx.port);
  assert.equal(got.daily_word_goal, 400);
  assert.deepEqual(got.goals, []);
  assert.deepEqual(got.effective.map((g) => [g.id, g.kind, g.period, g.target, g.legacy]), [['daily_word_goal', 'words', 'day', 400, true]]);
  assert.equal(await exists(ctx.root, GOALS), false, 'showing it writes nothing');
  assert.equal((await send(ctx.port, 'GET', b('/activity'))).json.goal, 400, 'the writing log and goal card still read it');

  // a words/day goal of its own replaces the legacy one in the list; book.md is the same bytes
  await send(ctx.port, 'POST', b('/goals'), { body: { goal: { kind: 'minutes', target: 30, period: 'day' } } });
  got = await goalsOf(ctx.port);
  assert.deepEqual(got.effective.map((g) => g.id), ['daily_word_goal', 'g1']);
  await send(ctx.port, 'POST', b('/goals'), { body: { goal: { kind: 'words', target: 800, period: 'day' } } });
  got = await goalsOf(ctx.port);
  assert.deepEqual(got.effective.map((g) => [g.id, g.legacy ?? false]), [['g1', false], ['g2', false]]);
  assert.equal(await read(ctx.root, 'book.md'), bookMd);
  assert.ok(!(await read(ctx.root, GOALS)).includes('daily_word_goal'));
  assert.deepEqual(await activityDiags(ctx.root), []);
});

test('sessions: a finished sprint or timer is a row in the month file; the writing log keeps the per-day summary and only sessions of kind session count in it', async () => {
  const ctx = await freshBook();
  const now = Date.now();
  const start = now - 25 * 60_000;
  const body = (kind, scenes = [ARRIVAL, KEY]) => ({ start: iso(start), end: iso(now), kind, scenes });

  // a save inside the window gives the row its Added / Removed
  const scene = (await send(ctx.port, 'GET', b(`/scenes/${ARRIVAL}`))).json;
  const put = await send(ctx.port, 'PUT', b(`/scenes/${ARRIVAL}/body`), { body: { body: `${scene.body.trimEnd()} Seven new words were added right here.\n`, base_sha256: scene.sha256 } });
  assert.equal(put.status, 200, put.text);
  const added = put.json.words.added;
  assert.ok(added >= 7);

  const r = await send(ctx.port, 'POST', b('/activity/session'), { body: { ...body('sprint'), end: iso(Date.now() + 2000) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.row.kind, 'sprint');
  assert.equal(r.json.row.minutes, 25);
  assert.equal(r.json.row.added, added);
  const file = sessionFile(start);
  const text = await read(ctx.root, file);
  assert.match(text, /^---\nschema: storyforge\.doc\/v1\nid: note_[0-9A-HJKMNP-TV-Z]{26}\ntitle: Sessions \d{4}-\d{2}\n---\n\n\| Start \| End \| Minutes \| Added \| Removed \| Kind \| Scenes \|\n\|---\|---\|---\|---\|---\|---\|---\|\n\| \d{4}-\d{2}-\d{2}T[0-9:]+Z \| \d{4}-\d{2}-\d{2}T[0-9:]+Z \| 25 \| \d+ \| 0 \| sprint \| scene_\S+ scene_\S+ \|\n$/);
  assert.deepEqual(await activityDiags(ctx.root), []);

  const t = await send(ctx.port, 'POST', b('/activity/session'), { body: body('timer', []) });
  assert.equal(t.status, 200, t.text);
  const sess = await send(ctx.port, 'POST', b('/activity/session'), { body: body('session', [ARRIVAL]) });
  assert.equal(sess.status, 200, sess.text);
  const lines = (await read(ctx.root, file)).trimEnd().split('\n');
  assert.deepEqual(lines.slice(-3).map((l) => l.split('|')[6].trim()), ['sprint', 'timer', 'session'], 'newest last');

  await ctx.repo.flushActivity();
  // summed over the days shown: a run just after midnight puts the 25-minute session on the day it started, not "today"
  const days = (await send(ctx.port, 'GET', b('/activity'))).json.days;
  assert.equal(days.reduce((n, d) => n + d.sessions, 0), 1, 'only the session counts in the writing log');
  assert.equal(days.reduce((n, d) => n + d.minutes, 0), 25);
});

test('sessions: the old { minutes } body works as before and writes no row; refusals write nothing', async () => {
  const ctx = await freshBook();
  assert.equal((await send(ctx.port, 'POST', b('/activity/session'), { body: { minutes: 12 } })).status, 200);
  assert.equal(await exists(ctx.root, 'activity/sessions'), false);
  const now = Date.now();
  const refused = [
    { start: iso(now), end: iso(now - 60_000), kind: 'timer' }, { start: iso(now), end: iso(now + 10_000), kind: 'timer' }, { start: iso(now - 90_000_000), end: iso(now), kind: 'timer' },
    { start: iso(now - 60_000), end: iso(now), kind: 'nap' }, { start: 'yesterday', end: iso(now), kind: 'timer' }, { start: iso(now - 600_000), end: iso(now), kind: 'timer', scenes: ['scene_01ZZZZZZZZZZZZZZZZZZZZZZZZ'] },
    { start: iso(now - 600_000), end: iso(now), kind: 'timer', scenes: 'all' }, { start: iso(now - 600_000), kind: 'timer' },
  ];
  for (const body of refused) assert.equal((await send(ctx.port, 'POST', b('/activity/session'), { body })).status, 400, JSON.stringify(body));
  assert.equal(await exists(ctx.root, 'activity/sessions'), false);
  assert.equal((await send(ctx.port, 'POST', `/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/activity/session`, { body: { start: iso(now - 600_000), end: iso(now), kind: 'timer' } })).status, 404);
});

test('3. sessions: rows the app cannot read stay where they are; the new row goes after the last table row; the rest of the file is byte for byte', async () => {
  const now = Date.now();
  const rel = sessionFile(now - 600_000);
  const before = `---
schema: storyforge.doc/v1
id: note_01J00000000000000000000003
title: Sessions
---
Hand-written intro.

| Start | End | Minutes | Added | Removed | Kind | Scenes |
|---|---|---|---|---|---|---|
| 2026-01-02T10:00:00Z | 2026-01-02T10:25:00Z | 25 | 410 | 12 | sprint |  |
| not | a | row |

Closing words.
`;
  const ctx = await freshBook('valid/salt-orchard', async (root) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), before);
  });
  const r = await send(ctx.port, 'POST', b('/activity/session'), { body: { start: iso(now - 600_000), end: iso(now), kind: 'timer', scenes: [KEY] } });
  assert.equal(r.status, 200, r.text);
  const after = await read(ctx.root, rel);
  const row = after.split('\n').find((l) => l.includes('| timer |'));
  assert.equal(after, before.replace('| not | a | row |\n', `| not | a | row |\n${row}\n`));
  assert.ok(sha(Buffer.from(after)) !== sha(Buffer.from(before)));
  assert.deepEqual(await activityDiags(ctx.root), []);
  // Everything else in the book is untouched by session rows
  const files = await readAll(ctx.root);
  assert.ok([...files.keys()].every((p) => p === rel || !p.startsWith('activity/')));
});
