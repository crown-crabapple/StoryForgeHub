// M11: the plan tools (permission 'plan'), the plan read tools and codex_add_plan_cards, against a fake `call`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpServer, TOOLS } from '../src/index.mjs';

const SHA = 'a'.repeat(64);
const BOOK = '/api/v1/books/salt-orchard';

function setup(permissions, nodes = []) {
  const calls = [];
  const call = async (req) => {
    calls.push(req);
    if (req.method === 'GET' && req.path.includes('/canvases/')) {
      return { status: 200, body: { slug: 'board', sha256: SHA, canvas: { nodes, edges: [{ id: 'e', fromNode: 'n1', toNode: 'n1' }], storyforge: { schema: 'storyforge.canvas/v1' } } } };
    }
    if (req.method === 'GET') return { status: 200, body: { path: req.path } };
    return { status: 200, body: { ok: true, opId: 'op_1' } };
  };
  const server = createMcpServer({ call, permissions, serverInfo: { name: 'storyforge', version: '0.1.0' } });
  let n = 0;
  const rpc = (method, params) => server.handle({ jsonrpc: '2.0', id: ++n, method, ...(params === undefined ? {} : { params }) });
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: { book: 'salt-orchard', ...args } })).result;
  return { calls, rpc, tool };
}

const PLAN_WRITES = [
  ['codex_save_story_plan', { fields: { logline: 'A line' }, notes: 'n', base_sha256: SHA }, '/plan/story', { fields: { logline: 'A line' }, body: 'n', base_sha256: SHA }],
  ['codex_save_story_plan', { fields: { logline: null } }, '/plan/story', { fields: { logline: null }, base_sha256: null }],
  ['codex_save_scene_plan', { scene: 'scene_1', fields: { goal: 'Get out' }, characters: ['mara'] }, '/plan/scene-plans/scene_1', { fields: { goal: 'Get out' }, characters: ['mara'] }],
  ['codex_create_link', { from: 'scene_1', to: 'scene_2', relation: 'therefore', branch: 'alt' }, '/plan/links', { from: 'scene_1', to: 'scene_2', relation: 'therefore', branch: 'alt' }],
  ['codex_update_link', { slug: 'l1', relation: 'but', branch: null, base_sha256: SHA }, '/plan/links/l1', { relation: 'but', branch: null, base_sha256: SHA }],
  ['codex_archive_link', { slug: 'l1', base_sha256: SHA }, '/plan/links/l1/archive', { base_sha256: SHA }],
  ['codex_restore_link', { slug: 'l1' }, '/plan/links/l1/restore', {}],
  ['codex_create_structure', { template: 'three-act', name: ' Main ' }, '/plan/structures', { template: 'three-act', name: 'Main' }],
  ['codex_update_structure', { slug: 's1', name: 'New', notes: 'x', base_sha256: SHA }, '/plan/structures/s1', { name: 'New', body: 'x', base_sha256: SHA }],
  ['codex_set_beats', { slug: 's1', beats: [{ id: 'beat_1', name: 'Hook', scenes: ['scene_1'] }, { name: 'Turn' }], base_sha256: SHA }, '/plan/structures/s1/beats', { beats: [{ id: 'beat_1', name: 'Hook', state: 'open', scenes: ['scene_1'] }, { name: 'Turn', state: 'open', scenes: [] }], base_sha256: SHA }],
  ['codex_archive_structure', { slug: 's1' }, '/plan/structures/s1/archive', {}],
  ['codex_restore_structure', { slug: 's1' }, '/plan/structures/s1/restore', {}],
  ['codex_create_arc', { character: 'entry_9', arc_type: 'positive', fields: { want: 'w' } }, '/plan/arcs', { character: 'entry_9', arc_type: 'positive', fields: { want: 'w' } }],
  ['codex_update_arc', { slug: 'a1', arc_type: null, notes: 'x', base_sha256: SHA }, '/plan/arcs/a1', { arc_type: null, body: 'x', base_sha256: SHA }],
  ['codex_set_arc_milestones', { slug: 'a1', milestones: [{ scene: 'scene_1', choice: 'c' }], base_sha256: SHA }, '/plan/arcs/a1/milestones', { milestones: [{ scene: 'scene_1', choice: 'c' }], base_sha256: SHA }],
  ['codex_archive_arc', { slug: 'a1' }, '/plan/arcs/a1/archive', {}],
  ['codex_restore_arc', { slug: 'a1' }, '/plan/arcs/a1/restore', {}],
  ['codex_create_relationship', { a: 'entry_9', b: 'entry_8', fields: { baseline: 'b' } }, '/plan/relationships', { a: 'entry_9', b: 'entry_8', fields: { baseline: 'b' } }],
  ['codex_update_relationship', { slug: 'r1', fields: { end_state: 'e' }, base_sha256: SHA }, '/plan/relationships/r1', { fields: { end_state: 'e' }, base_sha256: SHA }],
  ['codex_set_relationship_developments', { slug: 'r1', developments: [{ scene: 'scene_1', change: 'c' }], base_sha256: SHA }, '/plan/relationships/r1/developments', { developments: [{ scene: 'scene_1', change: 'c' }], base_sha256: SHA }],
  ['codex_archive_relationship', { slug: 'r1' }, '/plan/relationships/r1/archive', {}],
  ['codex_restore_relationship', { slug: 'r1' }, '/plan/relationships/r1/restore', {}],
  ['codex_create_clue', { fact: ' The key ', kind: 'clue', planted: ['scene_1'], revealed: 'scene_2', red_herring: true }, '/plan/clues', { fact: 'The key', kind: 'clue', fields: { planted: ['scene_1'], revealed: 'scene_2', red_herring: true } }],
  ['codex_create_clue', { fact: 'Bare' }, '/plan/clues', { fact: 'Bare' }],
  ['codex_update_clue', { slug: 'c1', revealed: null, red_herring: false, notes: 'x', base_sha256: SHA }, '/plan/clues/c1', { fields: { revealed: null, red_herring: false }, body: 'x', base_sha256: SHA }],
  ['codex_set_clue_knowers', { slug: 'c1', knowers: [{ who: 'reader', scene: 'scene_2', reliable: false }], base_sha256: SHA }, '/plan/clues/c1/knowers', { knowers: [{ who: 'reader', scene: 'scene_2', reliable: false }], base_sha256: SHA }],
  ['codex_archive_clue', { slug: 'c1' }, '/plan/clues/c1/archive', {}],
  ['codex_restore_clue', { slug: 'c1' }, '/plan/clues/c1/restore', {}],
  ['codex_create_synopsis', { type: 'logline', name: 'N', target_words: 25, body: 'b' }, '/plan/synopses', { type: 'logline', name: 'N', target_words: 25, body: 'b' }],
  ['codex_update_synopsis', { slug: 'y1', target_words: null, body: 'b', base_sha256: SHA }, '/plan/synopses/y1', { target_words: null, body: 'b', base_sha256: SHA }],
  ['codex_archive_synopsis', { slug: 'y1' }, '/plan/synopses/y1/archive', {}],
  ['codex_restore_synopsis', { slug: 'y1' }, '/plan/synopses/y1/restore', {}],
];

test('M11: plan tools are listed only with the plan permission, as non-destructive writes', async () => {
  const withPlan = (await setup(['read', 'plan']).rpc('tools/list')).result.tools;
  const without = (await setup(['read', 'propose', 'canvas']).rpc('tools/list')).result.tools;
  const planNames = TOOLS.filter((t) => t.need === 'plan').map((t) => t.name);
  assert.equal(planNames.length, 30);
  assert.deepEqual([...new Set(PLAN_WRITES.map((w) => w[0]))].sort(), [...planNames].sort(), 'every plan write tool is exercised below');
  for (const n of [...planNames, 'codex_get_scene_plan', 'codex_get_plan_check', 'codex_list_structure_templates']) assert.ok(withPlan.some((t) => t.name === n), `${n} listed with plan`);
  for (const n of planNames) assert.equal(without.some((t) => t.name === n), false, `${n} hidden without plan`);
  for (const n of planNames) {
    const t = withPlan.find((x) => x.name === n);
    assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, n);
    assert.match(t.description, /the author can Undo it in StoryForge/, n);
  }
  assert.equal(withPlan.length, 34 + 30, 'read + plan');
  // the plan read tools need only read
  const ro = (await setup(['read']).rpc('tools/list')).result.tools.map((t) => t.name);
  for (const n of ['codex_get_scene_plan', 'codex_get_plan_check', 'codex_list_structure_templates']) assert.ok(ro.includes(n), n);
  const refused = await setup(['read', 'propose', 'canvas']).tool('codex_create_link', { from: 'a', to: 'b', relation: 'but' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /plan/);
});

test('M11: each plan write tool posts to the right v1 path with the right body', async () => {
  const { calls, tool } = setup(['read', 'plan']);
  for (const [name, args, path, body] of PLAN_WRITES) {
    calls.length = 0;
    const r = await tool(name, args);
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r)}`);
    assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', `${BOOK}${path}`, body]], name);
    assert.equal(r.structuredContent.opId, 'op_1');
    assert.match(r.structuredContent.note, /Undo/);
  }
});

test('M11: plan tools reject bad input before any request', async () => {
  const { calls, tool } = setup(['read', 'plan']);
  assert.equal((await tool('codex_create_link', { from: 'a', to: 'b', relation: 'nope' })).isError, true, 'relation enum');
  assert.equal((await tool('codex_set_beats', { slug: 's', beats: [{ name: 'x', bogus: 1 }], base_sha256: SHA })).isError, true, 'unknown beat key');
  assert.equal((await tool('codex_update_link', { slug: 'l1', relation: 'but' })).isError, true, 'base_sha256 required');
  assert.equal((await tool('codex_create_clue', { fact: 'x', kind: 'rumour' })).isError, true, 'clue kind enum');
  assert.equal(calls.length, 0);
});

test('M11: plan read tools call the v1 plan routes', async () => {
  const { calls, tool } = setup(['read']);
  for (const [name, args, path] of [['codex_get_scene_plan', { scene: 'scene_1' }, '/plan/scene-plans/scene_1'], ['codex_get_plan_check', {}, '/plan/check'], ['codex_list_structure_templates', {}, '/plan/templates']]) {
    calls.length = 0;
    assert.ok(!(await tool(name, args)).isError, name);
    assert.deepEqual(calls.map((c) => [c.method, c.path]), [['GET', `${BOOK}${path}`]], name);
  }
});

test('M11: codex_add_plan_cards skips refs already on the canvas, places a grid below the nodes and sends the sha', async () => {
  const nodes = [
    { id: 'n1', type: 'file', file: 'unknown.md', x: 0, y: 0, width: 260, height: 150, storyforge: { ref: 'scene_1' } },
    { id: 'n2', type: 'text', text: 'x', x: 300, y: 100, width: 100, height: 100 },
  ];
  const { calls, tool } = setup(['read', 'canvas'], nodes);
  const r = await tool('codex_add_plan_cards', { canvas: 'board', refs: ['scene_1', 'clue_1', 'beat_1', 'clue_1', 'arc_1', 'arc_2', 'arc_3'] });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.equal(r.structuredContent.added, 5);
  assert.equal(r.structuredContent.skipped, 2);
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PUT']);
  assert.equal(calls[1].path, `${BOOK}/canvases/board`);
  assert.equal(calls[1].body.base_sha256, SHA);
  const out = calls[1].body.canvas;
  assert.deepEqual(out.nodes.slice(0, 2), nodes);
  assert.equal(out.edges.length, 1);
  assert.equal(out.storyforge.schema, 'storyforge.canvas/v1');
  const added = out.nodes.slice(2);
  assert.deepEqual(added.map((n) => n.storyforge.ref), ['clue_1', 'beat_1', 'arc_1', 'arc_2', 'arc_3']);
  assert.ok(added.every((n) => n.type === 'file' && n.id.length === 16));
  assert.equal(new Set(out.nodes.map((n) => n.id)).size, out.nodes.length);
  assert.deepEqual(added.slice(0, 4).map((n) => n.y), [240, 240, 240, 240], 'one row below the lowest node (200) plus a gap');
  assert.equal(added[4].y, 430, 'the fifth card starts the second row');
  assert.equal(added[4].x, 0);
  // every ref already there: nothing is written
  calls.length = 0;
  const none = await tool('codex_add_plan_cards', { canvas: 'board', refs: ['scene_1'] });
  assert.equal(none.structuredContent.added, 0);
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
});
