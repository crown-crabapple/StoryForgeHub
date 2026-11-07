// Plan on the canvas (M10 C3/C4): which planner object a card shows, counts, layer settings, findings to cards and the picker groups. No DOM, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LAYERS,
  activeStructure,
  canvasRefIds,
  chapterOf,
  chaptersText,
  excerpt,
  findingOnCanvas,
  findingRefIds,
  groupTargets,
  layersKey,
  parseLayers,
  planCounts,
  planFindings,
  planItemFor,
  nodesForRefIds,
} from '../src/canvas/plan/selectors.js';

const plan = {
  storyPlan: { fields: { logline: 'A ferry sinks.' } },
  structures: {
    structures: [
      { id: 's2', name: 'Heroine', primary: false, beats: [{ id: 'b3', name: 'Call' }] },
      { id: 's1', name: 'Three acts', primary: true, beats: [{ id: 'b1', name: 'Setup' }, { id: 'b2', name: 'Turn' }] },
    ],
  },
  arcs: { arcs: [{ id: 'a1', slug: 'maren' }] },
  relationships: { relationships: [{ id: 'r1' }, { id: 'r2' }] },
  synopses: { synopses: [{ id: 'y1', stale: true }] },
  clues: { clues: [{ id: 'c1', fact: 'The key' }] },
  links: { links: [{ slug: 'a' }, { slug: 'b', broken: true }, { slug: 'c', archived: true }] },
  scenes: [{ id: 'sc1', chapter: 2 }, { id: 'sc2', chapter: null }],
};

test('planItemFor finds the object of each kind by id', () => {
  assert.equal(planItemFor(plan, { kind: 'story-plan', id: 'x' }).fields.logline, 'A ferry sinks.');
  assert.equal(planItemFor(plan, { kind: 'structure', id: 's1' }).name, 'Three acts');
  assert.equal(planItemFor(plan, { kind: 'arc', id: 'a1' }).slug, 'maren');
  assert.equal(planItemFor(plan, { kind: 'relationship', id: 'r2' }).id, 'r2');
  assert.equal(planItemFor(plan, { kind: 'synopsis', id: 'y1' }).stale, true);
  assert.equal(planItemFor(plan, { kind: 'clue', id: 'c1' }).fact, 'The key');
  const beat = planItemFor(plan, { kind: 'beat', id: 'b3' });
  assert.equal(beat.name, 'Call');
  assert.equal(beat.structure.id, 's2', 'a beat knows its structure');
});

test('planItemFor is null for unknown ids, unknown kinds and a plan that is not loaded', () => {
  assert.equal(planItemFor(plan, { kind: 'arc', id: 'nope' }), null);
  assert.equal(planItemFor(plan, { kind: 'scene', id: 'sc1' }), null);
  assert.equal(planItemFor(plan, { kind: 'beat', id: 'nope' }), null);
  assert.equal(planItemFor(null, { kind: 'arc', id: 'a1' }), null);
  assert.equal(planItemFor({ arcs: null }, { kind: 'arc', id: 'a1' }), null);
  assert.equal(planItemFor(plan, null), null);
});

test('chapterOf and chaptersText', () => {
  assert.equal(chapterOf(plan.scenes, 'sc1'), 2);
  assert.equal(chapterOf(plan.scenes, 'sc2'), null);
  assert.equal(chapterOf(plan.scenes, 'zz'), null);
  assert.equal(chapterOf([{ ref: 'sc9', chapter: 4 }], 'sc9'), 4, 'targets work too');
  assert.equal(chapterOf(undefined, 'sc1'), null);
  assert.equal(chaptersText([5, 3, 3, null]), 'Ch 3, 5');
  assert.equal(chaptersText([null]), '');
});

test('excerpt cuts at a word and leaves short text alone', () => {
  assert.equal(excerpt('short  text'), 'short text');
  const long = 'word '.repeat(80);
  const e = excerpt(long, 200);
  assert.ok(e.endsWith('…') && e.length <= 201);
  assert.equal(excerpt(null), '');
});

test('activeStructure and planCounts', () => {
  assert.equal(activeStructure(plan.structures, null).id, 's1', 'the primary one by default');
  assert.equal(activeStructure(plan.structures, 's2').id, 's2');
  assert.equal(activeStructure(plan.structures, 'gone').id, 's1');
  assert.equal(activeStructure(null, null), null);
  assert.deepEqual(planCounts(plan, null), { links: 1, beats: 2, arcs: 1, clues: 1, relationships: 2 });
  assert.equal(planCounts(plan, 's2').beats, 1);
  assert.deepEqual(planCounts(null, null), { links: 0, beats: 0, arcs: 0, clues: 0, relationships: 0 });
});

test('planFindings keeps the PL rules only', () => {
  const r = { findings: [{ rule: 'PL3' }, { rule: 'CH1' }, { rule: 'PL6' }, {}] };
  assert.deepEqual(planFindings(r).map((f) => f.rule), ['PL3', 'PL6']);
  assert.deepEqual(planFindings(null), []);
});

test('parseLayers: defaults all on, keeps booleans, ignores junk', () => {
  assert.deepEqual(parseLayers(null), DEFAULT_LAYERS);
  assert.deepEqual(parseLayers('not json'), DEFAULT_LAYERS);
  assert.deepEqual(parseLayers('[]'), DEFAULT_LAYERS);
  assert.deepEqual(parseLayers(JSON.stringify({ clues: false, arcs: 'no', extra: false })), { ...DEFAULT_LAYERS, clues: false });
  const round = parseLayers(JSON.stringify({ links: false, beats: false }));
  assert.deepEqual(parseLayers(JSON.stringify(round)), round);
  assert.equal(layersKey('book_1'), 'storyforge.canvas.layers.book_1');
});

const story = (id, ref) => ({ id, type: 'file', file: 'x.md', x: 0, y: 0, width: 10, height: 10, storyforge: { ref } });
const nodes = [story('n1', 'sc1'), story('n2', 'c1'), { id: 'n3', type: 'text', text: 'note', x: 0, y: 0, width: 1, height: 1 }];
const refs = { n1: { state: 'ok', kind: 'scene', id: 'sc1' }, n2: { state: 'ok', kind: 'clue', id: 'c1' } };

test('findingRefIds: subject then related, no duplicates', () => {
  assert.deepEqual(findingRefIds({ subject: { id: 'c1' }, related: ['sc1', 'c1', 'sc2'] }), ['c1', 'sc1', 'sc2']);
  assert.deepEqual(findingRefIds({ subject: { id: 'c1' } }), ['c1']);
  assert.deepEqual(findingRefIds({}), []);
});

test('finding to cards: matched on the ref id, notes and unknown ids never match', () => {
  const f = { subject: { id: 'c1' }, related: ['sc1', 'sc2'] };
  assert.deepEqual(nodesForRefIds(nodes, refs, findingRefIds(f)), ['n1', 'n2']);
  assert.deepEqual(nodesForRefIds(nodes, refs, ['sc2']), []);
  assert.deepEqual(nodesForRefIds(nodes, {}, ['sc1']), ['n1'], 'falls back to the id in the file');
  const on = canvasRefIds(nodes, refs);
  assert.deepEqual([...on].sort(), ['c1', 'sc1']);
  assert.equal(findingOnCanvas(f, on), true);
  assert.equal(findingOnCanvas({ subject: { id: 'zz' }, related: [] }, on), false);
  assert.equal(findingOnCanvas({ subject: { id: 'zz' } }, null), true, 'no canvas open: nothing to say');
});

test('groupTargets: the book kinds first, then the planner kinds in a fixed order', () => {
  const t = (kind, ref) => ({ kind, ref });
  const groups = groupTargets([t('clue', 'c'), t('scene', 's1'), t('arc', 'a'), t('entry', 'e'), t('scene', 's2'), t('story-plan', 'p')]);
  assert.deepEqual(groups.map((g) => g.kind), ['scene', 'entry', 'story-plan', 'arc', 'clue']);
  assert.deepEqual(groups[0].items.map((i) => i.ref), ['s1', 's2']);
  assert.deepEqual(groupTargets([]), []);
});
