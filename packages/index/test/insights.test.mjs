// M07-J02 section 3: the pure Insights computation. Goal progress by period, streaks, projected finish, status / label / POV tables, the heat map, the thread
// matrix, relationships and event density, on a small hand-made book. The route and the index-versus-files parity are in apps/server/test/insights-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, computeInsights, monthStart, periodStart, sortKeys, weekStart } from '../src/insights.mjs';

test('dates: ISO weeks start on Monday, months on the 1st', () => {
  assert.equal(weekStart('2026-11-02'), '2026-11-02'); // a Monday
  assert.equal(weekStart('2026-11-08'), '2026-11-02'); // the Sunday after
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.equal(monthStart('2026-11-17'), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(periodStart('week', '2026-11-04'), '2026-11-02');
  assert.equal(periodStart('total', '2026-11-04'), null);
});

test('sortKeys sorts objects all the way down and leaves arrays in order', () => {
  assert.equal(JSON.stringify(sortKeys({ b: 1, a: { d: [{ y: 1, x: 2 }, 3], c: null } })), '{"a":{"c":null,"d":[{"x":2,"y":1},3]},"b":1}');
});

const SC = (n, over = {}) => ({ id: `scene_${n}`, title: `Scene ${n}`, position: n, act: 1, chapter: n <= 2 ? 1 : 2, status: 'drafting', pov: null, word_count: 100 * n, path: `manuscript/act-01-a/ch-00${n <= 2 ? 1 : 2}-x/00${n}0-s.md`, labels: [], ...over });
const base = () => ({
  today: '2026-11-04', // a Wednesday
  book: { id: 'book_1', title: 'T', word_target: 1000 },
  scenes: [SC(1, { status: 'final', pov: 'ilse', labels: ['Mystery'] }), SC(2, { labels: ['mystery', 'Odd one'] }), SC(3, { status: 'outline', pov: 'maren' }), SC(4, { status: 'final' })],
  chapters: [{ act: 1, chapter: 1, label: 'Chapter 1', title: null }, { act: 1, chapter: 2, label: 'Chapter 2', title: 'Two' }],
  containers: [
    { id: 'chap_1', kind: 'chapter', dir: 'manuscript/act-01-a/ch-001-x' },
    { id: 'chap_2', kind: 'chapter', dir: 'manuscript/act-01-a/ch-002-x' },
    { id: 'act_1', kind: 'act', dir: 'manuscript/act-01-a' },
  ],
  nodes: [
    { id: 'entry_ilse', kind: 'entry', type: 'character', name: 'Ilse' },
    { id: 'entry_maren', kind: 'entry', type: 'character', name: 'Maren', owner: 'series' },
    { id: 'entry_nobody', kind: 'entry', type: 'character', name: 'Nobody' },
    { id: 'thread_a', kind: 'thread', type: null, name: 'The ledger' },
    { id: 'event_a', kind: 'event', type: null, name: 'Storm' },
    { id: 'event_b', kind: 'event', type: null, name: 'Nowhere' },
    { id: 'scene_1', kind: 'scene', type: null, name: 'Scene 1' },
  ],
  edges: [
    { from: 'scene_1', to: 'entry_ilse', kind: 'explicit', rel: 'pov', location: 'pov' },
    { from: 'scene_1', to: 'entry_ilse', kind: 'explicit', rel: 'character', location: 'characters[0]' },
    { from: 'scene_2', to: 'entry_ilse', kind: 'inferred', rel: 'mention', location: '' },
    { from: 'scene_3', to: 'entry_maren', kind: 'explicit', rel: 'pov', location: 'pov' },
    { from: 'scene_4', to: 'entry_maren', kind: 'explicit', rel: 'character', location: 'characters[0]' },
    { from: 'entry_ilse', to: 'entry_maren', kind: 'explicit', rel: 'related', location: 'related[0].to' },
    { from: 'thread_a', to: 'scene_1', kind: 'explicit', rel: 'link', location: 'setup[0]' },
    { from: 'thread_a', to: 'scene_3', kind: 'explicit', rel: 'link', location: 'payoff[0]' },
    { from: 'thread_a', to: 'scene_3', kind: 'explicit', rel: 'link', location: 'develop[0]' },
    { from: 'scene_2', to: 'thread_a', kind: 'explicit', rel: 'thread', location: 'plot_threads[0]' },
    { from: 'event_a', to: 'scene_1', kind: 'explicit', rel: 'link', location: 'scenes[0]' },
    { from: 'scene_3', to: 'event_a', kind: 'explicit', rel: 'event', location: 'events[0]' },
  ],
  labelDefs: [{ name: 'Mystery', color: '#B5446E' }, { name: 'Backstory', color: '#3A5F7D' }],
  goals: [],
  dailyWordGoal: null,
  days: [],
  sessions: [],
  tasks: [],
});
const day = (date, added, removed = 0, minutes = 0) => ({ date, added, removed, net: added - removed, minutes, sessions: minutes ? 1 : 0 });

test('manuscript: words per chapter and scene, scenes by status (the four in order), labels (case-insensitive, undefined ones listed), POV share', () => {
  const m = computeInsights(base()).manuscript;
  assert.deepEqual(m.chapters.map((c) => [c.chapter, c.words, c.scenes, c.final]), [[1, 300, 2, 1], [2, 700, 2, 1]]);
  assert.deepEqual(m.scenes.map((s) => [s.id, s.words]), [['scene_1', 100], ['scene_2', 200], ['scene_3', 300], ['scene_4', 400]]);
  assert.deepEqual(m.status.map((s) => [s.status, s.scenes, s.words]), [['outline', 1, 300], ['drafting', 1, 200], ['revised', 0, 0], ['final', 2, 500]]);
  assert.deepEqual(m.labels.rows.map((l) => [l.label, l.scenes, l.defined]), [['Mystery', 2, true], ['Odd one', 1, false], ['Backstory', 0, true]]);
  assert.equal(m.labels.unlabeled, 2);
  assert.deepEqual(m.pov.map((p) => [p.name, p.words, p.share]), [['Maren', 300, 30], ['Ilse', 100, 10], [null, 600, 60]].sort((a, b) => b[1] - a[1]));
});

test('story: heat map (explicit and mentioned, either direction), unplaced characters counted, shared badge, relationships, thread matrix, event density', () => {
  const s = computeInsights(base()).story;
  assert.deepEqual(s.chapters.map((c) => c.chapter), [1, 2]);
  assert.deepEqual(s.characters.rows.map((r) => [r.name, r.cells, r.total, r.shared]), [['Ilse', [2, 0], 2, false], ['Maren', [0, 2], 2, true]]);
  assert.equal(s.characters.without_scenes, 1);
  assert.deepEqual(s.relationships.map((r) => [r.name, r.count]), [['Ilse', 1], ['Maren', 1]]);
  const t = s.threads.rows[0];
  assert.deepEqual([t.title, t.planted, t.developed, t.paid, t.linked], ['The ledger', 1, 1, 1, 1]);
  assert.deepEqual(t.cells, [[1, 0, 0, 1], [0, 1, 1, 0]]);
  assert.deepEqual(s.events.by_chapter.map((c) => c.events), [1, 1]);
  assert.deepEqual([s.events.total, s.events.unplaced], [2, 1]);
});

test('goals: progress by period from the writing log (net words), week starts on Monday, percent and met', () => {
  const inp = base();
  inp.goals = [
    { id: 'g1', kind: 'words', target: 500, period: 'day' },
    { id: 'g2', kind: 'words', target: 1000, period: 'week' },
    { id: 'g3', kind: 'words', target: 2000, period: 'month' },
  ];
  inp.days = [day('2026-10-31', 900), day('2026-11-01', 700), day('2026-11-02', 300, 50), day('2026-11-03', 100), day('2026-11-04', 600, 100)];
  const g = Object.fromEntries(computeInsights(inp).progress.goals.map((x) => [x.id, x]));
  assert.deepEqual([g.g1.value, g.g1.percent, g.g1.met], [500, 100, true]);
  assert.deepEqual([g.g2.value, g.g2.period_start, g.g2.percent, g.g2.met], [850, '2026-11-02', 85, false]);
  assert.deepEqual([g.g3.value, g.g3.period_start], [1550, '2026-11-01']);
});

test('goals: streak over every day goal; today short of the goal does not break it, and a missed day ends it', () => {
  const inp = base();
  inp.goals = [{ id: 'g1', kind: 'words', target: 500, period: 'day' }, { id: 'g2', kind: 'minutes', target: 30, period: 'day' }];
  inp.days = [day('2026-11-01', 100), day('2026-11-02', 600, 0, 40), day('2026-11-03', 500, 0, 30), day('2026-11-04', 200, 0, 10)];
  const g = Object.fromEntries(computeInsights(inp).progress.goals.map((x) => [x.id, x]));
  assert.equal(g.g1.streak, 2); // Nov 2 and 3 count; today (200) is still short and does not end it; Nov 1 (100) does
  assert.equal(g.g2.streak, 2);
  inp.days.push(day('2026-11-04', 0)); // (same date twice would be a bug in the caller; the last one in the list wins)
  inp.days = inp.days.slice(0, 3);
  assert.equal(computeInsights(inp).progress.goals[0].streak, 2);
  inp.days = [day('2026-11-02', 600)];
  assert.equal(computeInsights(inp).progress.goals[0].streak, 0, 'yesterday missed: no streak');
});

test('goals: the legacy daily_word_goal shows as a words/day goal unless one exists; it is never listed twice', () => {
  const inp = base();
  inp.dailyWordGoal = 250;
  inp.days = [day('2026-11-04', 300)];
  let goals = computeInsights(inp).progress.goals;
  assert.deepEqual(goals.map((g) => [g.id, g.legacy, g.target, g.met]), [['daily_word_goal', true, 250, true]]);
  inp.goals = [{ id: 'g1', kind: 'words', target: 400, period: 'day' }];
  goals = computeInsights(inp).progress.goals;
  assert.deepEqual(goals.map((g) => [g.id, g.legacy]), [['g1', false]]);
  inp.goals = [{ id: 'g2', kind: 'minutes', target: 30, period: 'day' }];
  assert.deepEqual(computeInsights(inp).progress.goals.map((g) => g.id), ['daily_word_goal', 'g2']);
});

test('goals: total goals read the manuscript (scoped to a chapter or act), minutes use the larger of log and session rows, scene and chapter goals use sessions', () => {
  const inp = base();
  inp.goals = [
    { id: 'w', kind: 'words', target: 2000, period: 'total' },
    { id: 'wc', kind: 'words', target: 1000, period: 'total', scope: 'chap_2' },
    { id: 'sc', kind: 'scenes', target: 4, period: 'total' },
    { id: 'ch', kind: 'chapters', target: 2, period: 'total' },
    { id: 'm', kind: 'minutes', target: 100, period: 'week' },
    { id: 'ms', kind: 'minutes', target: 100, period: 'week', scope: 'chap_1' },
    { id: 'ss', kind: 'scenes', target: 3, period: 'week' },
    { id: 'cs', kind: 'chapters', target: 2, period: 'week' },
    { id: 'gone', kind: 'words', target: 10, period: 'total', scope: 'chap_9' },
  ];
  inp.days = [day('2026-11-02', 0, 0, 20), day('2026-11-03', 0, 0, 60)];
  inp.sessions = [
    { date: '2026-11-03', minutes: 45, added: 100, removed: 0, kind: 'sprint', scenes: ['scene_1', 'scene_3'] },
    { date: '2026-11-04', minutes: 25, added: 50, removed: 10, kind: 'timer', scenes: ['scene_1'] },
    { date: '2026-10-20', minutes: 99, added: 0, removed: 0, kind: 'session', scenes: ['scene_4'] },
  ];
  const g = Object.fromEntries(computeInsights(inp).progress.goals.map((x) => [x.id, x]));
  assert.equal(g.w.value, 1000);
  assert.equal(g.wc.value, 700);
  assert.equal(g.sc.value, 2, 'two scenes are final');
  assert.equal(g.ch.value, 0, 'no chapter has every scene final');
  assert.equal(g.m.value, 20 + 60 + 25, 'Nov 2: log 20; Nov 3: max(60, 45) = 60; Nov 4: rows 25');
  assert.equal(g.ms.value, 45 + 25, 'only rows that touch a scene of chapter 1');
  assert.equal(g.ss.value, 2);
  assert.equal(g.cs.value, 2);
  assert.deepEqual([g.gone.scope_found, g.gone.value], [false, 0]);
  assert.deepEqual([g.wc.scope_name, g.gone.scope_name], ['Chapter 2: Two', null]);
  assert.deepEqual(computeInsights(inp).progress.scopes, [
    { id: 'act_1', kind: 'act', name: 'Act 1' },
    { id: 'chap_1', kind: 'chapter', name: 'Chapter 1' },
    { id: 'chap_2', kind: 'chapter', name: 'Chapter 2: Two' },
  ]);
});

test('goals: projected finish for a total words goal with a due date, from the last 30 days; reached goals have none', () => {
  const inp = base();
  inp.goals = [{ id: 'p', kind: 'words', target: 2000, period: 'total', due: '2026-12-01' }];
  inp.days = Array.from({ length: 30 }, (_, i) => day(addDays('2026-11-04', -i), 30));
  const g = computeInsights(inp).progress.goals[0];
  // 1000 words so far, 1000 to go at 30 a day: 34 days (the ceiling of 33.3) after Nov 4
  assert.deepEqual([g.projected_finish, g.on_track, g.reached], ['2026-12-08', false, false]);
  inp.goals[0].due = '2027-01-01';
  assert.equal(computeInsights(inp).progress.goals[0].on_track, true);
  inp.goals[0].target = 900;
  const done = computeInsights(inp).progress.goals[0];
  assert.deepEqual([done.reached, done.projected_finish], [true, null]);
  inp.goals[0].target = 5000;
  inp.days = [];
  assert.equal(computeInsights(inp).progress.goals[0].projected_finish, null, 'no recent writing, no date');
});

test('days: always the last 90 days, oldest first, with zeros filled in', () => {
  const inp = base();
  inp.days = [day('2026-11-04', 10), day('2026-08-07', 5), day('2026-01-01', 99)];
  const d = computeInsights(inp).progress.days;
  assert.equal(d.length, 90);
  assert.deepEqual([d[0].date, d[89].date], ['2026-08-07', '2026-11-04']);
  assert.deepEqual([d[0].net, d[1].net, d[89].net], [5, 0, 10]);
});

test('tasks: counts by status; the output has sorted keys and does not depend on input order', () => {
  const inp = base();
  inp.tasks = [{ status: 'open' }, { status: 'open' }, { status: 'done' }];
  const a = computeInsights(inp);
  assert.deepEqual(a.tasks, { doing: 0, done: 1, dropped: 0, open: 2, total: 3 });
  const shuffled = { ...inp, scenes: [...inp.scenes].reverse(), nodes: [...inp.nodes].reverse(), edges: [...inp.edges].reverse() };
  assert.equal(JSON.stringify(computeInsights(shuffled)), JSON.stringify(a));
  const keysSorted = (v) => (Array.isArray(v) ? v.every(keysSorted) : v && typeof v === 'object' ? Object.keys(v).join() === Object.keys(v).sort().join() && Object.values(v).every(keysSorted) : true);
  assert.ok(keysSorted(a));
});
