// M07-J02 acceptance 3: goals and session files round trip. Parse and write back byte-identical when untouched, malformed rows and items are kept,
// and `daily_word_goal` stays compatible (shown as a goal, never written twice). Pure parts here; the routes are in apps/server/test/goals-sessions-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { GOALS_PATH, applyGoalOp, freeGoalId, goalLine, newGoalsFile, parseGoals } from '../src/goals.mjs';
import { appendSession, newSessionsFile, parseSessions, rowLine, sessionsPath } from '../src/sessions.mjs';
import { copyFixture } from './helpers.mjs';

const GOALS = `---
schema: storyforge.goals/v1
id: note_01J00000000000000000000001
goals:
  - { id: g1, kind: words,   target: 500,   period: day }
  - { id: g2, kind: words,   target: 90000, period: total, due: 2027-03-01 }
  - { id: g3, kind: scenes,  target: 5,     period: week }
  - { id: g4, kind: minutes, target: 300,   period: week, scope: chap_01J00000000000000000000002 }
---
Notes the author keeps here.
`;

test('goals: the contract example parses into four goals, none skipped', () => {
  const { goals, skipped } = parseGoals(GOALS);
  assert.equal(skipped, 0);
  assert.deepEqual(goals.map((g) => g.id), ['g1', 'g2', 'g3', 'g4']);
  assert.deepEqual(goals[1], { id: 'g2', kind: 'words', target: 90000, period: 'total', due: '2027-03-01' });
  assert.equal(goals[3].scope, 'chap_01J00000000000000000000002');
});

test('goals: setting a goal that is already there changes nothing (byte-identical), whatever its spacing', () => {
  assert.equal(applyGoalOp(GOALS, { set: { id: 'g1', kind: 'words', target: 500, period: 'day' } }), GOALS);
  assert.equal(applyGoalOp(GOALS, { set: { id: 'g2', kind: 'words', target: 90000, period: 'total', due: '2027-03-01' } }), GOALS);
});

test('goals: changing one goal rewrites that line only; adding appends after the last item; removing drops one item', () => {
  const changed = applyGoalOp(GOALS, { set: { id: 'g3', kind: 'scenes', target: 6, period: 'week' } });
  const a = GOALS.split('\n');
  const b = changed.split('\n');
  assert.equal(b.length, a.length);
  assert.deepEqual(b.map((l, i) => (l === a[i] ? null : i)).filter((x) => x !== null), [a.findIndex((l) => l.includes('id: g3'))]);
  assert.equal(b.find((l) => l.includes('id: g3')), goalLine({ id: 'g3', kind: 'scenes', target: 6, period: 'week' }));

  const added = applyGoalOp(GOALS, { set: { id: 'g5', kind: 'chapters', target: 2, period: 'month' } });
  assert.equal(added, GOALS.replace('---\nNotes', `${goalLine({ id: 'g5', kind: 'chapters', target: 2, period: 'month' })}\n---\nNotes`));
  assert.equal(parseGoals(added).goals.length, 5);

  const removed = applyGoalOp(GOALS, { remove: 'g3' });
  assert.equal(removed, GOALS.split('\n').filter((l) => !l.includes('id: g3')).join('\n'));
  assert.equal(applyGoalOp(GOALS, { remove: 'nope' }), null);
});

test('goals: malformed items are kept as written and skipped when reading; other goals still change', () => {
  const text = GOALS.replace(
    '  - { id: g3, kind: scenes,  target: 5,     period: week }',
    '  - { id: g3, kind: pages, target: 5, period: week }\n  - just some words\n  - { id: g6, kind: words, target: 0, period: day }',
  );
  const { goals, skipped } = parseGoals(text);
  assert.deepEqual(goals.map((g) => g.id), ['g1', 'g2', 'g4']);
  assert.equal(skipped, 3);
  const out = applyGoalOp(text, { set: { id: 'g1', kind: 'words', target: 800, period: 'day' } });
  for (const kept of ['- { id: g3, kind: pages, target: 5, period: week }', '- just some words', '- { id: g6, kind: words, target: 0, period: day }']) assert.ok(out.includes(kept), kept);
  assert.deepEqual(parseGoals(out).goals.map((g) => g.target), [800, 90000, 300]);
  const removed = applyGoalOp(text, { remove: 'g4' });
  for (const kept of ['- just some words', 'kind: pages']) assert.ok(removed.includes(kept));
});

test('goals: no goals key, an empty flow list, CRLF files and a new file', () => {
  const bare = '---\nschema: storyforge.goals/v1\nid: note_01J00000000000000000000001\n---\n';
  const g1 = { id: 'g1', kind: 'words', target: 100, period: 'day' };
  assert.equal(applyGoalOp(bare, { set: g1 }), '---\nschema: storyforge.goals/v1\nid: note_01J00000000000000000000001\ngoals:\n  - { id: g1, kind: words, target: 100, period: day }\n---\n');
  const withFlow = '---\nschema: storyforge.goals/v1\nid: note_01J00000000000000000000001\ngoals: []\n---\n';
  assert.deepEqual(parseGoals(applyGoalOp(withFlow, { set: g1 })).goals.map((g) => g.id), ['g1']);
  const crlf = GOALS.replace(/\n/g, '\r\n');
  const edited = applyGoalOp(crlf, { set: { id: 'g1', kind: 'words', target: 501, period: 'day' } });
  assert.ok(!/[^\r]\n/.test(edited), 'every line break is still CRLF');
  assert.equal(parseGoals(edited).goals[0].target, 501);
  assert.equal(parseGoals(newGoalsFile([g1], 'note_01J00000000000000000000009')).goals.length, 1);
  assert.equal(freeGoalId([{ id: 'g1' }, { id: 'g3' }]), 'g2');
});

const SESSIONS = `---
schema: storyforge.doc/v1
id: note_01J00000000000000000000003
title: Sessions 2026-11
---

| Start | End | Minutes | Added | Removed | Kind | Scenes |
|---|---|---|---|---|---|---|
| 2026-11-02T10:00:00Z | 2026-11-02T10:25:00Z | 25 | 410 | 12 | sprint | scene_A scene_B |
| 2026-11-02T11:00:00Z | oops | a row the app cannot read |
`;

test('sessions: rows parse (scene ids split), unreadable rows are skipped and kept', () => {
  const rows = parseSessions(SESSIONS);
  assert.deepEqual(rows, [{ start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:25:00Z', minutes: 25, added: 410, removed: 12, kind: 'sprint', scenes: ['scene_A', 'scene_B'] }]);
  const row = { start: '2026-11-02T12:00:00Z', end: '2026-11-02T12:10:00Z', minutes: 10, added: 0, removed: 0, kind: 'timer', scenes: [] };
  const out = appendSession(SESSIONS, row);
  assert.equal(out, `${SESSIONS}${rowLine(row)}\n`);
  assert.ok(out.includes('| 2026-11-02T11:00:00Z | oops | a row the app cannot read |'));
  assert.equal(parseSessions(out).length, 2);
  assert.equal(parseSessions(out)[1].kind, 'timer');
});

test('sessions: a new file, no final line break, CRLF, and a file with no table', () => {
  const row = { start: '2026-11-02T12:00:00Z', end: '2026-11-02T12:30:00Z', minutes: 30, added: 5, removed: 1, kind: 'session', scenes: ['scene_A'] };
  const fresh = appendSession(newSessionsFile('2026-11', 'note_01J00000000000000000000004'), row);
  assert.deepEqual(parseSessions(fresh), [row]);
  const noEol = appendSession(SESSIONS.trimEnd(), row);
  assert.equal(parseSessions(noEol).length, 2);
  const crlf = appendSession(SESSIONS.replace(/\n/g, '\r\n'), row);
  assert.ok(!/[^\r]\n/.test(crlf));
  assert.equal(parseSessions(crlf).length, 2);
  const prose = appendSession('---\nschema: storyforge.doc/v1\nid: note_01J00000000000000000000005\ntitle: S\n---\nhand-written intro\n', row);
  assert.ok(prose.includes('hand-written intro'));
  assert.equal(parseSessions(prose).length, 1);
});

test('sessions: the file is named for the local year and month of the start', () => {
  assert.equal(sessionsPath(new Date(2026, 10, 2, 9, 0)), 'activity/sessions/2026/2026-11.md');
  assert.equal(sessionsPath(new Date(2027, 0, 31, 23, 59)), 'activity/sessions/2027/2027-01.md');
});

test('goals and sessions files in a real book validate clean apart from a scope that does not resolve; daily_word_goal stays valid', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const w = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  await w(GOALS_PATH, GOALS);
  await w('activity/sessions/2026/2026-11.md', SESSIONS);
  const mine = (await validate(root)).diagnostics.filter((d) => d.file.startsWith('activity/')).map((d) => `${d.code} ${d.file} ${d.location}`);
  assert.deepEqual(mine, ['E301 activity/goals.md goals[3].scope']);
});
