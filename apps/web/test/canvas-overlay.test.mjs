// The plan overlay of the canvas (M10 C5): link filtering, beat columns, clue / relationship edges, badges, finding marks and the beat assignment diff. No DOM, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCanvas } from '../../../packages/format/src/canvas.mjs';
import { layoutColumns } from '../src/canvas/model.js';
import { MAX_BADGES, beatColumnNode, beatMoves, beatsAfterMoves, isBeatColumn, planOverlay } from '../src/canvas/plan/overlay.js';

const story = (id, ref, x, y) => ({ id, type: 'file', file: `${ref}.md`, x, y, width: 260, height: 150, storyforge: { ref } });
const column = (id, ref, x) => ({ id, type: 'group', label: 'Beat', x, y: 0, width: 300, height: 400, storyforge: { kind: 'column', ref } });
const nodes = [column('colA', 'b1', 0), column('colB', 'b2', 400), story('n1', 'sc1', 20, 60), story('n2', 'sc2', 420, 60), story('nc', 'c1', 900, 60), story('nr', 'r1', 900, 300)];
const refs = {
  colA: { state: 'ok', kind: 'beat', id: 'b1', structure: 's1' },
  colB: { state: 'ok', kind: 'beat', id: 'b2', structure: 's1' },
  n1: { state: 'ok', kind: 'scene', id: 'sc1', title: 'Ferry' },
  n2: { state: 'ok', kind: 'scene', id: 'sc2', title: 'Shore' },
  nc: { state: 'ok', kind: 'clue', id: 'c1', title: 'The key' },
  nr: { state: 'ok', kind: 'relationship', id: 'r1', title: 'A & B' },
};
const edges = [
  { id: 'e0', fromNode: 'n1', toNode: 'n2' },
  { id: 'e1', fromNode: 'n1', toNode: 'n2', storyforge: { link: 'main-link' } },
  { id: 'e2', fromNode: 'n1', toNode: 'n2', storyforge: { link: 'what-link' } },
  { id: 'e3', fromNode: 'n2', toNode: 'n1', storyforge: { link: 'gone' } },
];
const plan = {
  links: { links: [{ slug: 'main-link', relation: 'causes' }, { slug: 'what-link', relation: 'causes', branch: 'mutiny' }] },
  structures: { structures: [{ id: 's1', beats: [{ id: 'b1', name: 'Setup', scenes: ['sc1'] }, { id: 'b2', name: 'Turn', scenes: [{ id: 'sc2' }] }] }] },
  clues: { clues: [{ id: 'c1', fact: 'The key is under the mat', planted: [{ id: 'sc1' }], revealed: { id: 'sc2' } }] },
  arcs: { arcs: [{ id: 'a1', slug: 'maren', character: { name: 'Maren' }, milestones: [{ index: 0, scene: 'sc1' }] }] },
  relationships: { relationships: [{ id: 'r1', developments: [{ scene: 'sc2', change: 'x' }] }] },
};
const all = { links: true, beats: true, arcs: true, clues: true, relationships: true };
const run = (extra = {}) => planOverlay({ nodes, edges, refs, plan, layers: all, branch: null, findings: [], ...extra });

test('links: layer off hides every linked edge and only those', () => {
  assert.deepEqual([...run({ layers: { ...all, links: false } }).hiddenEdgeIds].sort(), ['e1', 'e2', 'e3']);
});

test('links: main hides branch edges; a named branch shows main plus that branch, dashed and labelled what-if', () => {
  const main = run();
  assert.deepEqual([...main.hiddenEdgeIds], ['e2']);
  assert.equal(main.dashedEdgeIds.size, 0);
  const what = run({ branch: 'mutiny' });
  assert.equal(what.hiddenEdgeIds.size, 0);
  assert.deepEqual([...what.dashedEdgeIds], ['e2']);
  assert.equal(what.edgeLabels.get('e2'), 'causes · what-if');
  assert.deepEqual([...run({ branch: 'other' }).hiddenEdgeIds], ['e2']);
});

test('beats: layer off hides the beat columns only; on, scene cards get a badge per beat', () => {
  const off = run({ layers: { ...all, beats: false } });
  assert.deepEqual([...off.hiddenNodeIds].sort(), ['colA', 'colB']);
  assert.ok(!off.badges.get('n1')?.some((b) => b.label === 'Setup'));
  const o = run();
  assert.equal(o.hiddenNodeIds.size, 0);
  assert.ok(o.badges.get('n1').some((b) => b.label === 'Setup'));
  assert.ok(o.badges.get('n2').some((b) => b.label === 'Turn'));
});

test('clues: plants and reveals edges and badges; layer off removes them', () => {
  const o = run();
  assert.deepEqual(
    o.extraEdges.filter((e) => e.kind !== 'develops').map((e) => [e.kind, e.from, e.to, e.warn]),
    [['plants', 'n1', 'nc', false], ['reveals', 'nc', 'n2', false]],
  );
  assert.ok(o.badges.get('n1').some((b) => b.label === 'Plants · The key is under the mat'));
  assert.ok(o.badges.get('n2').some((b) => b.label === 'Reveals · The key is under the mat'));
  const off = run({ layers: { ...all, clues: false } });
  assert.ok(off.extraEdges.every((e) => e.kind === 'develops'));
  assert.ok(![...off.badges.values()].flat().some((b) => /^(Plants|Reveals)/.test(b.label)));
});

test('clues: a PL6 finding on the clue makes the reveal edge warn', () => {
  const o = run({ findings: [{ rule: 'PL6', title: 'Revealed too early', subject: { kind: 'clue', id: 'c1' }, related: ['sc2', 'sc1'] }] });
  const reveal = o.extraEdges.find((e) => e.kind === 'reveals');
  assert.equal(reveal.warn, true);
  assert.equal(reveal.label, 'reveals · too early');
  assert.equal(o.extraEdges.find((e) => e.kind === 'plants').warn, false);
  assert.deepEqual(o.marks.get('nc'), ['Revealed too early']);
  assert.deepEqual(o.marks.get('n1'), ['Revealed too early']);
  assert.deepEqual(o.marks.get('n2'), ['Revealed too early']);
  assert.equal(o.marks.get('nr'), undefined);
  assert.equal(run({ findings: [{ rule: 'PL5', title: 'x', subject: { kind: 'clue', id: 'c1' }, related: [] }] }).extraEdges.find((e) => e.kind === 'reveals').warn, false);
});

test('arcs: a milestone gives the scene an Arc badge; layer off removes it', () => {
  assert.ok(run().badges.get('n1').some((b) => b.label === 'Arc · Maren'));
  assert.ok(!run({ layers: { ...all, arcs: false } }).badges.get('n1').some((b) => b.label.startsWith('Arc')));
});

test('relationships: develops edge to the scene card; layer off removes it', () => {
  assert.deepEqual(run().extraEdges.filter((e) => e.kind === 'develops').map((e) => [e.from, e.to, e.label]), [['nr', 'n2', 'develops']]);
  assert.equal(run({ layers: { ...all, relationships: false } }).extraEdges.filter((e) => e.kind === 'develops').length, 0);
});

test('marks: subject and related ids, one title each, even with every layer off', () => {
  const f = [
    { rule: 'PL3', title: 'Empty beat', subject: { kind: 'beat', id: 'b1' }, related: ['b1'] },
    { rule: 'PL1', title: 'Loose scene', subject: { kind: 'scene', id: 'sc2' }, related: [] },
  ];
  const o = run({ findings: f, layers: { links: false, beats: false, arcs: false, clues: false, relationships: false } });
  assert.deepEqual(o.marks.get('colA'), ['Empty beat']);
  assert.deepEqual(o.marks.get('n2'), ['Loose scene']);
  assert.equal(o.marks.size, 2);
});

test('badges: at most three per card', () => {
  const crowded = { ...plan, structures: { structures: [{ id: 's1', beats: ['A', 'B', 'C', 'D'].map((n) => ({ id: `x${n}`, name: n, scenes: ['sc1'] })) }] } };
  const o = run({ plan: crowded });
  assert.equal(MAX_BADGES, 3);
  assert.equal(o.badges.get('n1').length, 3);
  for (const list of o.badges.values()) assert.ok(list.length <= 3);
});

test('planOverlay changes neither nodes nor edges, returns neither, and works with no plan and no layers', () => {
  const before = JSON.stringify({ nodes, edges });
  const o = run({ layers: { ...all, links: false, beats: false } });
  assert.equal(JSON.stringify({ nodes, edges }), before);
  assert.ok(!('nodes' in o) && !('edges' in o));
  const bare = planOverlay({ nodes, edges, refs, plan: null });
  assert.equal(bare.extraEdges.length, 0);
  assert.equal(bare.hiddenEdgeIds.size, 0);
  assert.equal(bare.hiddenNodeIds.size, 0);
});

test('beatColumnNode is a column whose ref is the beat id, and the file format accepts it', () => {
  const n = beatColumnNode({ x: 100, y: 100 }, 'note_beat1');
  assert.equal(n.type, 'group');
  assert.deepEqual(n.storyforge, { kind: 'column', ref: 'note_beat1' });
  assert.ok(isBeatColumn(n, {}));
  const r = parseCanvas({ nodes: [n], edges: [] });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.canvas.nodes[0].storyforge.ref, 'note_beat1');
});

test('beatMoves: entering a beat column adds, leaving removes, moving between does both, staying lists nothing', () => {
  const inB = nodes.map((n) => (n.id === 'n1' ? { ...n, x: 420, y: 60 } : n));
  assert.deepEqual(beatMoves(nodes, inB, refs), [{ sceneId: 'sc1', add: 'b2', remove: 'b1' }]);
  const out = nodes.map((n) => (n.id === 'n1' ? { ...n, x: 700, y: 700 } : n));
  assert.deepEqual(beatMoves(nodes, out, refs), [{ sceneId: 'sc1', remove: 'b1' }]);
  const into = out.map((n) => (n.id === 'n1' ? { ...n, x: 20, y: 60 } : n));
  assert.deepEqual(beatMoves(out, into, refs), [{ sceneId: 'sc1', add: 'b1' }]);
  const clueIn = nodes.map((n) => (n.id === 'nc' ? { ...n, x: 20, y: 200 } : n)); // a clue card is not a scene
  assert.deepEqual(beatMoves(nodes, clueIn, refs), []);
  assert.deepEqual(beatMoves(nodes, nodes, refs), []);
  const nudged = nodes.map((n) => (n.id === 'n1' ? { ...n, y: 100 } : n));
  assert.deepEqual(beatMoves(nodes, nudged, refs), []);
  assert.deepEqual(beatMoves(nodes, layoutColumns({ nodes: inB }).nodes, refs), [{ sceneId: 'sc1', add: 'b2', remove: 'b1' }]);
});

test('beatsAfterMoves: adds and removes scene ids, normalises scenes to ids, null when nothing changes', () => {
  const beats = plan.structures.structures[0].beats;
  const next = beatsAfterMoves(beats, [{ sceneId: 'sc1', add: 'b2', remove: 'b1' }]);
  assert.deepEqual(next.map((b) => b.scenes), [[], ['sc2', 'sc1']]);
  assert.equal(beatsAfterMoves(beats, [{ sceneId: 'sc9', add: 'zz' }]), null);
  assert.equal(beatsAfterMoves(beats, [{ sceneId: 'sc1', add: 'b1' }]), null);
  assert.deepEqual(beats[0].scenes, ['sc1']);
});
