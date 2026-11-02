import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractLinks, validate } from '@storyforge/format';
import { buildGraph } from '../src/index.mjs';
import { copyFixture, openFor, plain, sortedJson } from './helpers.mjs';

const FIXTURES_WITH_GRAPH = ['valid/codex-graph', 'valid/salt-orchard', 'valid/spec-example'];

const ID = {
  landfall: 'scene_01CG0000000000000000000002',
  nightLines: 'scene_01CG0000000000000000000003',
  lastFerry: 'scene_01CG0000000000000000000004',
  maren: 'entry_01CG0000000000000000000005',
  tobin: 'entry_01CG0000000000000000000006',
  portAldine: 'entry_01CG0000000000000000000007',
  harbourBoard: 'entry_01CG0000000000000000000008',
  brassKey: 'entry_01CG0000000000000000000009',
  saltmarks: 'entry_01CG000000000000000000000A',
  gull: 'entry_01CG000000000000000000000B',
  tideCall: 'entry_01CG000000000000000000000C',
  thread: 'thread_01CG000000000000000000000E',
  event: 'event_01CG000000000000000000000F',
};

const graphSets = (g) => ({ nodes: sortedJson(g.nodes), edges: sortedJson(g.edges) });

async function fromFiles(root) {
  const result = await validate(root);
  return { result, graph: plain(buildGraph(result, undefined, '')) };
}
async function builtIndex(root) {
  const { idx } = await openFor(root);
  const built = await idx.rebuild();
  assert.equal(built.ok, true, JSON.stringify(built));
  return idx;
}

for (const fixture of FIXTURES_WITH_GRAPH) {
  test(`${fixture}: graph from files == from the index == after deleting .storyforge and rebuilding`, async () => {
    const root = await copyFixture(fixture);
    const { graph: files } = await fromFiles(root);
    assert.ok(files.nodes.length > 0 && files.edges.length > 0, 'fixture has a graph');

    const idx = await builtIndex(root);
    const first = plain(await idx.query.graph());
    assert.deepEqual(graphSets(first), graphSets(files), 'index graph equals files graph');

    await fs.rm(path.join(root, '.storyforge'), { recursive: true, force: true });
    const rebuilt = plain(await (await builtIndex(root)).query.graph());
    assert.deepEqual(graphSets(rebuilt), graphSets(files), 'rebuilt index graph equals files graph');
    assert.deepEqual(graphSets(rebuilt), graphSets(first));
  });

  test(`${fixture}: links table rows equal the format package link records`, async () => {
    const root = await copyFixture(fixture);
    const { result } = await fromFiles(root);
    const records = plain(extractLinks(result));
    assert.ok(records.length > 0);
    const idx = await builtIndex(root);
    const rows = plain(await idx.query.links());
    assert.equal(rows.length, records.length);
    assert.deepEqual(sortedJson(rows), sortedJson(records));
  });

  test(`${fixture}: every edge is explicit or inferred, never both for one scene/entry pair`, async () => {
    const { graph } = await fromFiles(await copyFixture(fixture));
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const pair = (e) => [e.from, e.to].sort().join('|');
    const explicitPairs = new Set(graph.edges.filter((e) => e.kind === 'explicit').map(pair));
    for (const e of graph.edges) {
      assert.ok(['explicit', 'inferred'].includes(e.kind), `kind ${e.kind}`);
      assert.ok(nodeIds.has(e.from) && nodeIds.has(e.to), 'edge endpoints are nodes');
      assert.equal(typeof e.source.path, 'string');
      if (e.kind === 'inferred') {
        assert.equal(e.rel, 'mention');
        assert.ok(Number.isInteger(e.count) && e.count >= 1, 'inferred edge carries a count');
        assert.ok(!explicitPairs.has(pair(e)), `inferred ${pair(e)} duplicates an explicit edge`);
      } else {
        assert.notEqual(e.rel, 'mention');
        assert.equal(e.count, undefined, 'explicit edges have no count');
      }
    }
  });
}

test('codex-graph: a scene that links an entry and also names it has one explicit edge and no inferred edge', async () => {
  const { graph } = await fromFiles(await copyFixture('valid/codex-graph'));
  const pair = graph.edges.filter((e) => e.from === ID.landfall && e.to === ID.tobin);
  assert.equal(pair.length, 1);
  assert.equal(pair[0].kind, 'explicit');
  assert.equal(pair[0].rel, 'link');
  assert.equal(pair[0].source.path, 'manuscript/act-01-one/ch-001-one/0010-landfall.md');
});

test('codex-graph: front-matter references are explicit and suppress the mention of the same entry', async () => {
  const { graph } = await fromFiles(await copyFixture('valid/codex-graph'));
  const landfall = graph.edges.filter((e) => e.from === ID.landfall).map((e) => `${e.kind}:${e.rel}:${e.to}`);
  for (const want of [
    `explicit:pov:${ID.maren}`, `explicit:character:${ID.maren}`, `explicit:location:${ID.portAldine}`,
    `explicit:thread:${ID.thread}`, `explicit:event:${ID.event}`, `explicit:link:${ID.tobin}`,
  ]) assert.ok(landfall.includes(want), `missing ${want}`);
  // "Maren" is written in the prose too, but the pair already has explicit edges
  assert.ok(!landfall.some((s) => s.startsWith('inferred') && s.endsWith(ID.maren)));
});

test('codex-graph: a scene that only names entries yields one inferred edge per entry, with the count', async () => {
  const { graph } = await fromFiles(await copyFixture('valid/codex-graph'));
  const inferred = graph.edges.filter((e) => e.from === ID.nightLines && e.kind === 'inferred');
  const byTo = Object.fromEntries(inferred.map((e) => [e.to, e]));
  assert.equal(inferred.length, 5, 'one edge per entry, no duplicates');
  assert.equal(byTo[ID.maren].count, 2, 'Maren appears twice');
  for (const id of [ID.saltmarks, ID.gull, ID.tideCall, ID.harbourBoard]) assert.equal(byTo[id].count, 1);
  assert.equal(byTo[ID.maren].rel, 'mention');
  // tobin is this scene's pov: explicit only
  assert.ok(graph.edges.some((e) => e.from === ID.nightLines && e.to === ID.tobin && e.kind === 'explicit' && e.rel === 'pov'));
  assert.ok(!byTo[ID.tobin]);

  const last = graph.edges.filter((e) => e.from === ID.lastFerry);
  assert.ok(last.some((e) => e.to === ID.portAldine && e.kind === 'inferred' && e.count === 1));
  assert.ok(last.some((e) => e.to === ID.tobin && e.kind === 'explicit' && e.rel === 'pov'));
  assert.ok(!last.some((e) => e.to === ID.tobin && e.kind === 'inferred'));
});

test('codex-graph: entry relations are explicit, labelled and directional (both ways for one pair)', async () => {
  const { graph } = await fromFiles(await copyFixture('valid/codex-graph'));
  const related = graph.edges.filter((e) => e.rel === 'related');
  const key = (e) => `${e.from}>${e.to}:${e.label}`;
  assert.deepEqual(
    related.map(key).sort(),
    [
      `${ID.maren}>${ID.tobin}:childhood friend`,
      `${ID.maren}>${ID.portAldine}:home port`,
      `${ID.tobin}>${ID.maren}:ferry passenger`,
      `${ID.harbourBoard}>${ID.gull}:operates`,
      `${ID.brassKey}>${ID.maren}:carried by`,
      `${ID.gull}>${ID.portAldine}:home port`,
    ].sort(),
  );
  for (const e of related) {
    assert.equal(e.kind, 'explicit');
    assert.match(e.source.path, /^codex\//);
  }
});

test('codex-graph: nodes cover every scene, entry (all seven types), thread and event once', async () => {
  const { graph } = await fromFiles(await copyFixture('valid/codex-graph'));
  assert.equal(new Set(graph.nodes.map((n) => n.id)).size, graph.nodes.length);
  const entries = graph.nodes.filter((n) => n.kind === 'entry');
  assert.deepEqual([...new Set(entries.map((n) => n.type))].sort(), ['character', 'faction', 'location', 'lore', 'object', 'ship', 'spell']);
  assert.equal(graph.nodes.filter((n) => n.kind === 'scene').length, 3);
  assert.deepEqual(graph.nodes.find((n) => n.id === ID.gull), { id: ID.gull, kind: 'entry', type: 'ship', name: 'The Gull' });
});

test('buildGraph is a pure function of (result, mentions): empty mentions gives no inferred edges', async () => {
  const { result } = await fromFiles(await copyFixture('valid/codex-graph'));
  const g = buildGraph(result, [], '');
  assert.ok(g.edges.length > 0);
  assert.ok(g.edges.every((e) => e.kind === 'explicit'));
  const one = buildGraph(result, [{ entry_id: ID.saltmarks, scene_id: ID.lastFerry, count: 7 }], '');
  const inf = one.edges.filter((e) => e.kind === 'inferred');
  assert.equal(inf.length, 1);
  assert.equal(inf[0].count, 7);
});

test('codex-graph: the index stores the same inferred counts as its mentions rows', async () => {
  const root = await copyFixture('valid/codex-graph');
  const idx = await builtIndex(root);
  const g = plain(await idx.query.graph());
  const mentions = plain(await idx.query.mentions());
  for (const e of g.edges.filter((x) => x.kind === 'inferred')) {
    const m = mentions.find((r) => r.scene_id === e.from && r.entry_id === e.to);
    assert.equal(e.count, m.count);
  }
});
