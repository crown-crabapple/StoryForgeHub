// The relationship graph of the Lanes view (Story Planner M8): pure layout and standalone SVG.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relationshipLayout, relationshipSvg } from '../src/planner/relgraph.js';

const end = (id, name) => ({ id, slug: id, name, type: 'character' });
const rel = (slug, a, b, extra = {}) => ({ id: `id-${slug}`, slug, name: `${slug} name`, a, b, baseline: null, end_state: null, developments: [], ...extra });

test('nodes are the distinct entries by id, edges one per relationship', () => {
  const ava = end('c1', 'Ava');
  const ben = end('c2', 'Ben');
  const cy = end('c3', 'Cy');
  const layout = relationshipLayout([rel('r1', ava, ben), rel('r2', ben, cy), rel('r3', ava, cy)], { width: 600, height: 400 });
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.edges.length, 3);
  assert.deepEqual(layout.nodes.map((n) => n.name), ['Ava', 'Ben', 'Cy']);
  assert.equal(relationshipLayout([rel('r1', ava, ben), rel('r2', ben, ava)]).nodes.length, 2);
  assert.deepEqual(relationshipLayout([]).nodes, []);
});

test('nodes sit on a circle inside the bounds; one node is centred', () => {
  const rels = ['a', 'b', 'c', 'd', 'e'].map((k, i, all) => rel(`r${k}`, end(k, k.toUpperCase()), end(all[(i + 1) % all.length], all[(i + 1) % all.length].toUpperCase())));
  const { nodes, width, height } = relationshipLayout(rels, { width: 500, height: 300 });
  assert.equal(nodes.length, 5);
  const radii = nodes.map((n) => Math.hypot(n.x - width / 2, n.y - height / 2));
  for (const r of radii) assert.ok(Math.abs(r - radii[0]) < 0.1);
  for (const n of nodes) {
    assert.ok(n.x - n.r >= 0 && n.x + n.r <= width);
    assert.ok(n.y - n.r >= 0 && n.y + n.r <= height);
  }
  const one = relationshipLayout([rel('self', end('x', 'X'), end('x', 'X'))], { width: 400, height: 200 });
  assert.deepEqual([one.nodes[0].x, one.nodes[0].y], [200, 100]);
});

test('labels fall back from end state to baseline to name; unnamed ends are Unknown entry', () => {
  const a = end('c1', 'Ava');
  const layout = relationshipLayout([
    rel('r1', a, end('c2', 'Ben'), { end_state: 'Allies', baseline: 'Rivals' }),
    rel('r2', a, end('c3', 'Cy'), { baseline: 'Strangers' }),
    rel('r3', a, { id: 'c4', slug: null, name: null, type: null }),
  ]);
  assert.deepEqual(layout.edges.map((e) => e.label), ['Allies', 'Strangers', 'r3 name']);
  assert.ok(layout.nodes.some((n) => n.name === 'Unknown entry'));
});

test('the SVG is a standalone document with escaped text', () => {
  const layout = relationshipLayout([rel('r1', end('c1', 'A <b> & "C"'), end('c2', "Ben's"), { end_state: '</text><script>x</script>' })]);
  const svg = relationshipSvg(layout);
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('A &lt;b&gt; &amp; &quot;C&quot;'));
  assert.ok(svg.includes('Ben&apos;s'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;/text&gt;&lt;script&gt;'));
  assert.equal((svg.match(/<circle /g) ?? []).length, 2);
  assert.equal((svg.match(/<line /g) ?? []).length, 1);
});
