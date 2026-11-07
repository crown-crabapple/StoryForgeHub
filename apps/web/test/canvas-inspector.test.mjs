// The rows of the canvas Inspector (M10 C6): each kind, the PL6 warn row, the missing scene plan, and beat membership. No DOM, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beatChoices, beatListWithScene, buildInspector, canEditKind, canOpenKind } from '../src/canvas/plan/inspectorRows.js';
import { planItemFor } from '../src/canvas/plan/selectors.js';

const plan = {
  scenes: [
    { id: 'sc1', title: 'The Ferry', chapter: 1 },
    { id: 'sc2', title: 'The Key', chapter: 2 },
    { id: 'sc3', title: null, chapter: 3 },
  ],
  storyPlan: { fields: { logline: 'A ferry sinks.', premise: 'Salvage.', theme_question: 'Who pays?', protagonist_goal: 'Find the key' } },
  structures: {
    structures: [
      { id: 'st1', slug: 'three-acts', name: 'Three acts', primary: true, sha256: 'x', beats: [{ id: 'b1', name: 'Setup', scenes: ['sc1'] }, { id: 'b2', name: 'Turn', position: 'about 50%', question: 'Does she go?', state: 'done', scenes: [{ id: 'sc1' }, 'sc2'] }, { id: 'b3', name: 'End', scenes: [] }] },
      { id: 'st2', slug: 'hero', name: 'Heroine', beats: [{ id: 'b9', name: 'Call', scenes: ['sc2'] }] },
    ],
  },
  arcs: { arcs: [{ id: 'a1', slug: 'maren', character: { name: 'Maren' }, arc_type: 'positive', fields: { want: 'The key', need: 'Trust', false_belief: 'Alone', wound: 'Loss', start_state: 'Closed', end_state: 'Open' }, milestones: [{ index: 0, scene: 'sc1', choice: 'Takes the key' }] }] },
  relationships: { relationships: [{ id: 'r1', slug: 'm-p', a: { name: 'Maren' }, b: { name: 'Pell' }, baseline: 'Allies', end_state: 'Estranged', developments: [{ scene: 'sc2', change: 'Trust breaks' }] }] },
  synopses: { synopses: [{ id: 'y1', slug: 'short', name: 'Short', type: 'short', words: 120, target_words: 200, stale: true }] },
  clues: {
    clues: [
      { id: 'c1', slug: 'key', fact: 'The key is brass', kind: 'clue', planted: [{ id: 'sc2' }], revealed: { id: 'sc1' }, knowers: [{ who: { reader: true }, scene: { id: 'sc2' } }, { who: { name: 'Pell' }, scene: { id: 'sc1' }, reliable: false }] },
      { id: 'c2', slug: 'map', fact: 'The map is old', kind: 'secret', planted: [{ id: 'sc1' }], revealed: null, knowers: [] },
    ],
  },
  links: { links: [{ relation: 'pays_off', from: 'sc1', to: 'sc2', from_title: 'The Ferry', to_title: 'The Key' }, { relation: 'but', from: 'sc3', to: 'sc1', from_title: null, to_title: 'The Ferry' }, { relation: 'therefore', from: 'sc1', to: 'sc3', archived: true }] },
};
const pl6 = { rule: 'PL6', title: '"The key is brass" is revealed before it is planted', subject: { kind: 'clue', id: 'c1' }, related: ['sc1', 'sc2'] };
const view = (kind, id, extra = {}) => {
  const refInfo = { state: 'ok', kind, id, title: extra.title ?? 'T', path: `planning/${id}.md` };
  return buildInspector({ plan, refInfo, item: planItemFor(plan, refInfo), ...extra });
};
const section = (v, id) => v.sections.find((s) => s.id === id);
const row = (v, sid, label) => section(v, sid).rows.find((r) => r.label === label);

test('scene: plan fields, feeling arrow, characters', () => {
  const v = view('scene', 'sc1', { title: 'The Ferry', scenePlan: { fields: { goal: 'Cross', stakes: 'Life', emotional_start: 'Calm', emotional_end: 'Dread', purpose: 'Open' }, characters: [{ name: 'Maren' }, 'Pell'] } });
  assert.equal(v.kindLabel, 'Scene');
  assert.equal(v.title, 'The Ferry');
  assert.equal(v.path, 'planning/sc1.md');
  const labels = section(v, 'scene-plan').rows.map((r) => r.label);
  assert.deepEqual(labels, ['Goal', 'Stakes', 'Emotional start → end', 'Purpose', 'Characters']);
  assert.equal(row(v, 'scene-plan', 'Emotional start → end').value, 'Calm → Dread');
  assert.deepEqual(row(v, 'scene-plan', 'Characters').items, ['Maren', 'Pell']);
});

test('scene without a plan: a warn row; while loading: a loading row', () => {
  for (const scenePlan of [null, { fields: {} }]) {
    const r = row(view('scene', 'sc2', { scenePlan }), 'scene-plan', 'Plan');
    assert.equal(r.value, 'No plan yet');
    assert.equal(r.warn, true);
  }
  const loading = row(view('scene', 'sc2', { scenePlan: undefined }), 'scene-plan', 'Plan');
  assert.equal(loading.value, 'Loading…');
  assert.notEqual(loading.warn, true);
});

test('scene: causal links in and out with relation words (broken and archived left out)', () => {
  const v = view('scene', 'sc1', { scenePlan: null });
  assert.deepEqual(row(v, 'links', 'Leads to').items, ['pays off The Key']);
  assert.deepEqual(row(v, 'links', 'Comes from').items, ['Untitled scene but']);
  assert.equal(row(view('scene', 'sc2', { scenePlan: null }), 'links', 'Comes from').items[0], 'The Ferry pays off');
});

test('scene: beat rows list every structure; clues and arc milestones here', () => {
  const v = view('scene', 'sc2', { scenePlan: null });
  assert.deepEqual(row(v, 'beats', 'In beats').items, ['Three acts: Turn', 'Heroine: Call']);
  assert.equal(row(view('scene', 'sc3', { scenePlan: null }), 'beats', 'Beats').value, 'No beat uses this scene');
  assert.deepEqual(row(v, 'clues', 'Planted here').items, ['The key is brass']);
  assert.equal(row(v, 'clues', 'Revealed here'), undefined);
  assert.deepEqual(row(view('scene', 'sc1', { scenePlan: null }), 'clues', 'Revealed here').items, ['The key is brass']);
  assert.deepEqual(row(view('scene', 'sc1', { scenePlan: null }), 'arcs', 'Milestones').items, ['Maren: Takes the key']);
  assert.equal(row(v, 'arcs', 'Milestones').value, 'No character arc has a milestone here');
});

test('beat membership checkboxes follow the active structure (rail pick, else primary)', () => {
  const primary = view('scene', 'sc1', { scenePlan: null }).beatChoices;
  assert.equal(primary.structure.name, 'Three acts');
  assert.deepEqual(primary.beats, [{ id: 'b1', name: 'Setup', member: true }, { id: 'b2', name: 'Turn', member: true }, { id: 'b3', name: 'End', member: false }]);
  const picked = view('scene', 'sc1', { scenePlan: null, structureId: 'st2' }).beatChoices;
  assert.deepEqual(picked.beats, [{ id: 'b9', name: 'Call', member: false }]);
  assert.equal(beatChoices(null, 'sc1'), null);
});

test('beatListWithScene adds and removes one scene and keeps the other beats', () => {
  const s = plan.structures.structures[0];
  const added = beatListWithScene(s, 'b3', 'sc1', true);
  assert.deepEqual(added.map((b) => b.scenes), [['sc1'], ['sc1', 'sc2'], ['sc1']]);
  assert.deepEqual(added.map((b) => b.id), ['b1', 'b2', 'b3']);
  const removed = beatListWithScene(s, 'b2', 'sc1', false);
  assert.deepEqual(removed[1].scenes, ['sc2']);
  assert.deepEqual(beatListWithScene(s, 'b1', 'sc1', true)[0].scenes, ['sc1']); // no duplicate
  assert.deepEqual(s.beats[1].scenes, [{ id: 'sc1' }, 'sc2']); // input untouched
});

test('clue: kind, fact, planted, revealed, who knows', () => {
  const v = view('clue', 'c1', { findings: [] });
  assert.equal(v.title, 'The key is brass');
  assert.equal(row(v, 'clue', 'Kind').value, 'Clue');
  assert.deepEqual(row(v, 'clue', 'Planted').items, ['The Key']);
  assert.equal(row(v, 'clue', 'Revealed').value, 'The Ferry');
  assert.deepEqual(row(v, 'clue', 'Who knows').items, ['The reader in The Key', 'Pell in The Ferry (believes something false)']);
});

test('clue: a PL6 finding naming it adds a warn row; an unrelated one does not', () => {
  const warn = row(view('clue', 'c1', { findings: [pl6] }), 'clue', 'Plan check (PL6)');
  assert.equal(warn.warn, true);
  assert.match(warn.value, /revealed before it is planted/);
  assert.equal(row(view('clue', 'c1', { findings: [{ ...pl6, subject: { id: 'c2' } }] }), 'clue', 'Plan check (PL6)'), undefined);
  assert.equal(row(view('clue', 'c1', { findings: [{ ...pl6, rule: 'PL5' }] }), 'clue', 'Plan check (PL6)'), undefined);
});

test('clue never revealed: a warn row "Not yet"', () => {
  const r = row(view('clue', 'c2'), 'clue', 'Revealed');
  assert.equal(r.value, 'Not yet');
  assert.equal(r.warn, true);
  assert.equal(row(view('clue', 'c2'), 'clue', 'Kind').value, 'Secret');
  assert.equal(row(view('clue', 'c2'), 'clue', 'Who knows').value, 'Nobody yet');
});

test('arc: type, fields, start to end, milestones per scene', () => {
  const v = view('arc', 'a1');
  assert.equal(v.title, 'Maren');
  assert.equal(row(v, 'arc', 'Type').value, 'Positive');
  assert.deepEqual(section(v, 'arc').rows.map((r) => r.label), ['Type', 'Want', 'Need', 'False belief', 'Wound', 'Start → end']);
  assert.equal(row(v, 'arc', 'Start → end').value, 'Closed → Open');
  assert.deepEqual(row(v, 'milestones', 'Per scene').items, ['The Ferry: Takes the key']);
});

test('relationship: baseline, end state, developments per scene', () => {
  const v = view('relationship', 'r1');
  assert.equal(v.title, 'Maren & Pell');
  assert.equal(row(v, 'relationship', 'Baseline').value, 'Allies');
  assert.equal(row(v, 'relationship', 'End state').value, 'Estranged');
  assert.deepEqual(row(v, 'developments', 'Per scene').items, ['The Key: Trust breaks']);
});

test('synopsis: type, words against target, stale flag row', () => {
  const v = view('synopsis', 'y1');
  assert.equal(row(v, 'synopsis', 'Type').value, 'Short synopsis');
  assert.match(row(v, 'synopsis', 'Words').value, /120/);
  assert.equal(row(v, 'synopsis', 'Sources').warn, true);
});

test('story plan: logline, premise, theme, goal, primary structure', () => {
  const v = view('story-plan', 'story');
  assert.deepEqual(section(v, 'story-plan').rows.map((r) => r.label), ['Premise', 'Logline', 'Theme / question', "Protagonist's goal", 'Primary structure']);
  assert.equal(row(v, 'story-plan', 'Primary structure').value, 'Three acts');
});

test('beat and structure', () => {
  const b = view('beat', 'b2');
  assert.equal(b.title, 'Turn');
  assert.deepEqual(section(b, 'beat').rows.map((r) => r.label), ['Name', 'Position', 'Question', 'State', 'Scenes']);
  assert.equal(row(b, 'beat', 'State').value, 'Done');
  assert.deepEqual(row(b, 'beat', 'Scenes').items, ['The Ferry', 'The Key']);
  assert.equal(row(view('beat', 'b3'), 'beat', 'Scenes').value, 'No scene assigned');
  const s = view('structure', 'st1');
  assert.equal(row(s, 'structure', 'Beats').value, '3');
  assert.equal(row(s, 'structure', 'Primary').value, 'Yes');
});

test('any other kind: title and summary only', () => {
  const refInfo = { state: 'ok', kind: 'entry', id: 'e1', title: 'Maren', summary: 'A salvager.', path: 'codex/maren.md' };
  const v = buildInspector({ plan, refInfo, item: null });
  assert.equal(v.title, 'Maren');
  assert.equal(v.kindLabel, 'Codex');
  assert.deepEqual(v.sections.map((s) => s.id), ['summary']);
  assert.equal(v.beatChoices, null);
});

test('an item the plan does not hold still gives a header (and no rows)', () => {
  const v = view('clue', 'nope', { title: 'Gone' });
  assert.equal(v.title, 'Gone');
  assert.deepEqual(v.sections, []);
});

test('which kinds can be edited or opened', () => {
  for (const k of ['scene', 'story-plan', 'structure', 'beat', 'arc', 'relationship', 'synopsis', 'clue']) assert.equal(canEditKind(k), true, k);
  assert.equal(canEditKind('entry'), false);
  assert.equal(canOpenKind('scene'), true);
  assert.equal(canOpenKind('entry'), true);
  assert.equal(canOpenKind('clue'), false);
});
