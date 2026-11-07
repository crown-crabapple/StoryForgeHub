// Build a canvas from the plan and tidy cards to it (M10 C8): columns per beat, first-beat placement, links, and that nothing is added or removed by tidy. No DOM, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCanvas } from '../../../packages/format/src/canvas.mjs';
import { columnMembers, nodeKind } from '../src/canvas/model.js';
import { buildPlanCanvas, tidyToPlan } from '../src/canvas/plan/build.js';

/** A repeatable stream of numbers in [0, 1). */
const seeded = () => {
  let n = 7;
  return () => {
    n = (n * 16807) % 2147483647;
    return (n - 1) / 2147483646;
  };
};

const plan = {
  storyPlan: { id: 'note_plan' },
  synopses: { synopses: [{ id: 'note_syn' }] },
  scenes: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }],
  structures: {
    structures: [
      {
        id: 'st1',
        primary: true,
        beats: [
          { id: 'b1', name: 'Setup', scenes: ['s1', 's2'] },
          { id: 'b2', name: 'Turn', scenes: [{ id: 's2' }, 's3'] },
        ],
      },
    ],
  },
  clues: { clues: [{ id: 'c1' }, { id: 'c2' }] },
  arcs: { arcs: [{ id: 'a1' }] },
  relationships: { relationships: [{ id: 'r1' }] },
  links: {
    links: [
      { slug: 'l-main', from: 's1', to: 's3', relation: 'causes' },
      { slug: 'l-branch', from: 's1', to: 's2', relation: 'causes', branch: 'what-if' },
      { slug: 'l-missing', from: 's1', to: 's4x', relation: 'causes' },
    ],
  },
};
const build = () => buildPlanCanvas({ plan, structureId: null, targets: [], title: 'My plan', rand: seeded() });
const refOf = (n) => n.storyforge?.ref;
const column = (doc, ref) => doc.nodes.find((n) => nodeKind(n) === 'column' && refOf(n) === ref);
const card = (doc, ref) => doc.nodes.find((n) => nodeKind(n) === 'story' && refOf(n) === ref);

test('buildPlanCanvas makes a column per beat and a Not in a beat column', () => {
  const doc = build();
  const columns = doc.nodes.filter((n) => nodeKind(n) === 'column');
  assert.deepEqual(columns.map((c) => c.label), ['Setup', 'Turn', 'Not in a beat']);
  assert.deepEqual(columns.map(refOf), ['b1', 'b2', undefined]);
  assert.ok(columns[0].x < columns[1].x && columns[1].x < columns[2].x);
  assert.equal(columns[1].x - columns[0].x, 300 + 24);
});

test('a scene sits in its first beat only; scenes in no beat are in the last column in book order', () => {
  const doc = build();
  const members = (col) => columnMembers(doc.nodes, col).map(refOf);
  assert.deepEqual(members(column(doc, 'b1')), ['s1', 's2']);
  assert.deepEqual(members(column(doc, 'b2')), ['s3']);
  assert.deepEqual(members(doc.nodes.find((n) => n.label === 'Not in a beat')), ['s4']);
  assert.equal(doc.nodes.filter((n) => refOf(n) === 's2').length, 1);
});

test('story plan, synopsis, clue, arc and relationship cards are placed in rows', () => {
  const doc = build();
  assert.deepEqual([card(doc, 'note_plan').y, card(doc, 'note_syn').y], [0, 0]);
  assert.ok(card(doc, 'note_plan').x < card(doc, 'note_syn').x);
  const bottom = Math.max(...doc.nodes.filter((n) => nodeKind(n) === 'column').map((c) => c.y + c.height));
  assert.ok(card(doc, 'c1').y > bottom && card(doc, 'c1').y === card(doc, 'c2').y);
  assert.ok(card(doc, 'a1').y > card(doc, 'c1').y && card(doc, 'a1').y === card(doc, 'r1').y);
});

test('only main-plan links between two scenes with cards become edges, tied to the link', () => {
  const doc = build();
  assert.equal(doc.edges.length, 1);
  const [e] = doc.edges;
  assert.equal(e.storyforge.link, 'l-main');
  assert.equal(e.label, 'causes');
  assert.equal(e.fromNode, card(doc, 's1').id);
  assert.equal(e.toNode, card(doc, 's3').id);
});

test('buildPlanCanvas is deterministic and its document passes parseCanvas', () => {
  assert.deepEqual(build(), build());
  const doc = build();
  assert.equal(doc.storyforge.title, 'My plan');
  const r = parseCanvas(doc);
  assert.ok(r.ok, r.message);
  assert.equal(new Set(doc.nodes.map((n) => n.id)).size, doc.nodes.length);
});

test('an empty plan builds an empty canvas that parses', () => {
  const doc = buildPlanCanvas({ plan: null, rand: seeded() });
  assert.deepEqual([doc.nodes, doc.edges], [[], []]);
  assert.ok(parseCanvas(doc).ok);
});

// ---------------------------------------------------------------- tidy

const refsOf = (doc) => Object.fromEntries(doc.nodes.filter((n) => nodeKind(n) === 'story').map((n) => [n.id, { state: 'ok', kind: refOf(n).startsWith('s') ? 'scene' : 'clue', id: refOf(n) }]));

test('tidyToPlan moves a scene card back into the column of its first beat', () => {
  const doc = build();
  const s1 = card(doc, 's1');
  const turn = column(doc, 'b2');
  const messy = { ...doc, nodes: doc.nodes.map((n) => (n.id === s1.id ? { ...n, x: turn.x + 20, y: turn.y + 60 } : n)) };
  assert.ok(columnMembers(messy.nodes, turn).some((m) => refOf(m) === 's1'));
  const tidy = tidyToPlan(messy, refsOf(messy), plan, null);
  assert.ok(columnMembers(tidy.nodes, column(tidy, 'b1')).some((m) => refOf(m) === 's1'));
  assert.ok(!columnMembers(tidy.nodes, column(tidy, 'b2')).some((m) => refOf(m) === 's1'));
});

test('tidyToPlan moves a card dropped outside every column, and never adds or removes nodes or edges', () => {
  const doc = build();
  const s3 = card(doc, 's3');
  const messy = { ...doc, nodes: doc.nodes.map((n) => (n.id === s3.id ? { ...n, x: -900, y: -900 } : n)) };
  const tidy = tidyToPlan(messy, refsOf(messy), plan, null);
  assert.deepEqual(tidy.nodes.map((n) => n.id).sort(), messy.nodes.map((n) => n.id).sort());
  assert.deepEqual(tidy.edges, messy.edges);
  assert.ok(columnMembers(tidy.nodes, column(tidy, 'b2')).some((m) => refOf(m) === 's3'));
});

test('tidyToPlan leaves a card alone when its first beat has no column on the canvas, and a tidy canvas as it is', () => {
  const doc = build();
  assert.equal(tidyToPlan(doc, refsOf(doc), plan, null), doc);
  const s1 = card(doc, 's1');
  const noCol = { ...doc, nodes: doc.nodes.filter((n) => refOf(n) !== 'b1').map((n) => (n.id === s1.id ? { ...n, x: -900, y: -900 } : n)) };
  const out = tidyToPlan(noCol, refsOf(noCol), plan, null);
  assert.equal(out.nodes.length, noCol.nodes.length);
  assert.equal(card(out, 's1').x, -900);
});
