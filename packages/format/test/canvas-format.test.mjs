// M09-J01 section 1.1: parseCanvas() rules and serializeCanvas() shape. Pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_LIMITS, emptyCanvas, isCanvasFilePath, parseCanvas, serializeCanvas, canvasTitle } from '../src/index.mjs';

const node = (extra = {}) => ({ id: 'a', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10, ...extra });
const refused = (doc, re) => {
  const r = parseCanvas(doc);
  assert.equal(r.ok, false, JSON.stringify(doc).slice(0, 120));
  if (re) assert.match(/** @type {any} */ (r).message, re);
};

test('a valid canvas is normalised: integers, unknown keys kept, missing lists are empty', () => {
  const r = parseCanvas({ nodes: [node({ x: 1.6, y: -2.4, width: 99.5, extra: { a: 1 } })], other: true });
  assert.equal(r.ok, true);
  const c = /** @type {any} */ (r).canvas;
  assert.deepEqual([c.nodes[0].x, c.nodes[0].y, c.nodes[0].width], [2, -2, 100]);
  assert.deepEqual(c.nodes[0].extra, { a: 1 });
  assert.deepEqual(c.edges, []);
  assert.equal(c.other, true);
  assert.equal(parseCanvas('{"nodes":[],"edges":[]}').ok, true);
  assert.equal(parseCanvas('﻿{}').ok, true, 'a byte-order mark and missing lists are fine');
});

test('every node type and the StoryForge kinds', () => {
  const doc = {
    nodes: [
      node({ id: 't' }),
      node({ id: 'f', type: 'file', file: 'assets/canvas/a.png', text: undefined }),
      node({ id: 'l', type: 'link', url: 'https://example.com', text: undefined }),
      node({ id: 'm', type: 'link', url: 'mailto:a@example.com', text: undefined }),
      node({ id: 'g', type: 'group', label: 'Wall', text: undefined, storyforge: { kind: 'column' } }),
      node({ id: 's', color: '#E8DDD4', storyforge: { kind: 'swatch', name: 'Pearl', hex: '#E8DDD4' } }),
      node({ id: 'r', type: 'file', file: 'codex/characters/x.md', text: undefined, storyforge: { ref: 'entry_1' } }),
      node({ id: 'c', color: '3' }),
    ],
    edges: [{ id: 'e', fromNode: 't', toNode: 'g', fromSide: 'right', toSide: 'left', toEnd: 'arrow', label: 'leads to', color: '#fff' }],
  };
  assert.equal(parseCanvas(doc).ok, true);
});

test('each rule is refused with a message that names the node or edge', () => {
  refused([], /JSON object/);
  refused('{', /not JSON/);
  refused({ nodes: {} }, /nodes/);
  refused({ nodes: [node(), node()] }, /used twice/);
  refused({ nodes: [node({ id: '' })] }, /id/);
  refused({ nodes: [node({ type: 'shape' })] }, /type must be/);
  refused({ nodes: [node({ x: Infinity })] }, /x must be a number/);
  refused({ nodes: [node({ width: 0 })] }, /at least 1/);
  refused({ nodes: [node({ color: 'red' })] }, /color/);
  refused({ nodes: [node({ text: 5 })] }, /text/);
  refused({ nodes: [node({ text: 'x'.repeat(CANVAS_LIMITS.text + 1) })] }, /text/);
  refused({ nodes: [node({ type: 'link', url: 'javascript:alert(1)' })] }, /url/);
  refused({ nodes: [node({ type: 'link', url: 'file:///etc/passwd' })] }, /url/);
  for (const file of ['../x.md', '/abs.md', 'a\\b.md', 'a//b.md', './a.md', '']) refused({ nodes: [node({ type: 'file', file })] }, /file/);
  refused({ nodes: [node({ storyforge: 'x' })] }, /storyforge/);
  refused({ nodes: [node({ storyforge: { hex: 'E8DDD4' } })] }, /hex/);
  refused({ nodes: [node({ storyforge: { ref: '' } })] }, /ref/);
  refused({ nodes: [node()], edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }] }, /toNode/);
  refused({ nodes: [node()], edges: [{ id: 'a', fromNode: 'a', toNode: 'a' }] }, /used twice/);
  refused({ nodes: [node()], edges: [{ id: 'e', fromNode: 'a', toNode: 'a', fromSide: 'middle' }] }, /fromSide/);
  refused({ nodes: [node()], edges: [{ id: 'e', fromNode: 'a', toNode: 'a', toEnd: 'diamond' }] }, /toEnd/);
  refused({ nodes: Array.from({ length: CANVAS_LIMITS.nodes + 1 }, (_, i) => node({ id: `n${i}` })) }, /at most/);
  refused({ storyforge: { title: 3 } }, /title/);
});

test('an edge may carry storyforge.link, a link slug', () => {
  const edge = (storyforge) => ({ id: 'e', fromNode: 'a', toNode: 'a', storyforge });
  for (const storyforge of [{ link: 'a-therefore-b' }, { link: 'x' }, {}]) assert.equal(parseCanvas({ nodes: [node()], edges: [edge(storyforge)] }).ok, true);
  const kept = /** @type {any} */ (parseCanvas({ nodes: [node()], edges: [edge({ link: 'a-but-b' })] })).canvas;
  assert.deepEqual(kept.edges[0].storyforge, { link: 'a-but-b' });
  for (const storyforge of ['x', [], null, { link: 5 }, { link: '' }, { link: 'Not A Slug' }, { link: 'a_b' }, { link: '-a' }, { link: 'a'.repeat(121) }]) {
    refused({ nodes: [node()], edges: [edge(storyforge)] }, /storyforge/);
  }
});

test('serializeCanvas: nodes, edges, then the rest; two-space JSON with a final newline; titles', () => {
  const text = serializeCanvas({ storyforge: { title: 'T' }, edges: [], nodes: [] });
  assert.equal(text, '{\n  "nodes": [],\n  "edges": [],\n  "storyforge": {\n    "title": "T"\n  }\n}\n');
  assert.equal(canvasTitle(emptyCanvas('Mood'), 'mood'), 'Mood');
  assert.equal(canvasTitle({ nodes: [] }, 'slug'), 'slug');
  assert.equal(isCanvasFilePath('assets/canvas/a.png'), true);
});
