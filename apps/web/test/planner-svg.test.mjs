// "Download SVG" of the Flow graph (Story Planner M8): the pure flowSvg builder and the shared escapeXml and svgDocument.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));

let vite;
const m = {};
before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  m.svg = await vite.ssrLoadModule('/src/planner/svg-export.js');
  m.model = await vite.ssrLoadModule('/src/planner/model.js');
  m.flow = await vite.ssrLoadModule('/src/planner/FlowView.jsx');
});
after(async () => {
  await vite?.close();
});

const NODES = [
  { id: 'S1', kind: 'scene', title: 'Tom & "Jerry" <script>', act: 1, chapter: 1, sequence: 1 },
  { id: 'S2', kind: 'scene', title: "It's the Tide", act: 1, chapter: 1, sequence: 2 },
  { id: 'S3', kind: 'scene', title: 'Ferry', act: 2, chapter: 2, sequence: 1 },
  { id: 'B1', kind: 'beat', title: 'Midpoint', structure: { name: 'Mystery' } },
];
const edge = (slug, from, to, relation, branch = null, extra = {}) => ({ id: `note_${slug}`, slug, from, to, relation, branch, broken: false, ...extra });
const EDGES = [edge('a', 'S1', 'S3', 'therefore'), edge('b', 'S2', 'S3', 'but'), edge('c', 'S1', 'S2', 'enables', 'what-if'), edge('gone', 'S1', 'S_GONE', 'but', null, { broken: true }), edge('stray', 'S1', 'S_NOT_DRAWN', 'but')];
const build = (nodes = NODES, edges = EDGES) => m.svg.flowSvg({ nodes, edges, layout: m.model.layoutGraph(nodes) });

test('escapeXml: & < > " and \'', () => {
  assert.equal(m.svg.escapeXml(`a & b < c > "d" 'e'`), 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  assert.equal(m.svg.escapeXml('&amp;'), '&amp;amp;');
  assert.equal(m.svg.escapeXml(null), '');
  assert.equal(m.svg.escapeXml(42), '42');
});

test('svgDocument: xmlns, viewBox, a white background, the arrow marker and the body', () => {
  const doc = m.svg.svgDocument({ width: 300.2, height: 120, body: '<g id="x"/>' });
  assert.match(doc, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(doc, /viewBox="0 0 301 120"/);
  assert.match(doc, /<marker id="sf-arrow"/);
  assert.match(doc, /<rect x="0" y="0" width="301" height="120" fill="#ffffff"\/>/);
  assert.match(doc, /<g id="x"\/>\n<\/svg>\n$/);
  assert.match(m.svg.svgDocument({ width: 0, height: 0, body: '' }), /viewBox="0 0 1 1"/);
});

test('flowSvg: has a viewBox that holds the layout plus a margin, and a white background', () => {
  const layout = m.model.layoutGraph(NODES);
  const svg = build();
  const w = layout.width + 2 * m.svg.SVG_MARGIN;
  const hgt = layout.height + 2 * m.svg.SVG_MARGIN;
  assert.ok(svg.includes(`viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(hgt)}"`));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.match(svg, /fill="#ffffff"/);
});

test('flowSvg: titles are escaped, and no raw markup from a title gets through', () => {
  const svg = build();
  assert.ok(svg.includes('Tom &amp; &quot;Jerry&quot; &lt;script&gt;'));
  assert.ok(svg.includes('It&apos;s the Tide'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('Tom & "'));
  assert.ok(svg.includes('Act 1 · Ch 1'));
  assert.ok(svg.includes('Mystery: Midpoint'));
  assert.ok(svg.includes('>Beat<'));
  assert.equal((svg.match(/rx="8"/g) ?? []).length, NODES.length);
});

test('flowSvg: one path per drawn edge, with the relation dash, an arrow and a text label', () => {
  const svg = build();
  const paths = svg.match(/<path [^>]*>/g) ?? [];
  assert.equal(paths.length, 3);
  assert.ok(paths.every((p) => p.includes('marker-end="url(#sf-arrow)"')));
  assert.ok(paths[0].includes('d="M '));
  assert.ok(!paths[0].includes('stroke-dasharray'));
  assert.ok(paths[1].includes('stroke-dasharray="8 5"'));
  assert.ok(svg.includes('>therefore<'));
  assert.ok(svg.includes('>but<'));
});

test('flowSvg: a branch edge is dotted whatever its relation, and its label starts with [branch]', () => {
  const svg = build();
  const branchPath = (svg.match(/<path [^>]*>/g) ?? []).find((p) => p.includes('data-branch="what-if"'));
  assert.ok(branchPath.includes('stroke-dasharray="2 4"'));
  assert.ok(svg.includes('>[what-if] enables<'));
  const plain = build(NODES, [edge('c', 'S1', 'S2', 'but')]);
  assert.ok(plain.includes('stroke-dasharray="8 5"'));
  assert.ok(!plain.includes('2 4'));
});

test('flowSvg: an empty graph is still a valid, small document', () => {
  const svg = m.svg.flowSvg({ nodes: [], edges: [], layout: m.model.layoutGraph([]) });
  assert.match(svg, /<svg [^>]*viewBox="0 0 32 32"/);
  assert.equal((svg.match(/<path /g) ?? []).length, 0);
});

test('Flow view: a Download SVG button, disabled with no scenes', () => {
  const url = { view: 'flow', node: null, link: null, mode: 'graph', filter: null, branch: null };
  const full = renderToStaticMarkup(h(m.flow.FlowView, { bookId: 'b1', flow: { nodes: NODES, edges: EDGES }, links: { links: [], archived: [] }, url }));
  assert.match(full, /<button type="button" class="btn">Download SVG<\/button>/);
  const empty = renderToStaticMarkup(h(m.flow.FlowView, { bookId: 'b1', flow: { nodes: [], edges: [] }, links: { links: [], archived: [] }, url }));
  assert.match(empty, /<button type="button" class="btn" disabled="">Download SVG<\/button>/);
});
