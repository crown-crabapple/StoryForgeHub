// Canvas relations: a connection between two scene cards can carry a Flow link. The pure helpers, the request bodies and which connections qualify. No DOM, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relationStroke } from '../src/planner/model.js';
import { RELATIONS, createLinkRequest, reverseLinkBody, updateLinkBody } from '../src/planner/requests.js';
import {
  duplicateLinkSlug,
  edgeLink,
  edgeView,
  explainCanvasLinkFailure,
  indexLinks,
  relationFromLabel,
  reverseEdge,
  sceneEnds,
  withLink,
  withoutLink,
} from '../src/canvas/model.js';

const BOOK = 'book_1';
const story = (id, ref) => ({ id, type: 'file', file: 'x.md', x: 0, y: 0, width: 10, height: 10, storyforge: { ref } });
const note = (id) => ({ id, type: 'text', text: 'n', x: 0, y: 0, width: 10, height: 10 });
const nodes = [story('a', 's1'), story('b', 's2'), story('c', 's3'), story('d', 'e1'), story('e', 's5'), story('f', 's6'), note('n')];
const refs = {
  a: { state: 'ok', kind: 'scene', id: 's1' },
  b: { state: 'ok', kind: 'scene', id: 's2' },
  c: { state: 'archived', kind: 'scene', id: 's3' },
  d: { state: 'ok', kind: 'entry', id: 'e1' },
  e: { state: 'broken', kind: null, id: 's5' },
};
const edge = (extra = {}) => ({ id: 'x', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', toEnd: 'arrow', ...extra });

test('sceneEnds: both ends must be story cards of live scenes', () => {
  assert.deepEqual(sceneEnds(edge(), nodes, refs), { from: 's1', to: 's2' });
  assert.deepEqual(sceneEnds(edge({ fromNode: 'b', toNode: 'a' }), nodes, refs), { from: 's2', to: 's1' });
  assert.equal(sceneEnds(edge({ toNode: 'c' }), nodes, refs), null, 'archived scene');
  assert.equal(sceneEnds(edge({ toNode: 'e' }), nodes, refs), null, 'broken ref');
  assert.equal(sceneEnds(edge({ toNode: 'f' }), nodes, refs), null, 'no refs entry');
  assert.equal(sceneEnds(edge({ toNode: 'd' }), nodes, refs), null, 'a Codex card');
  assert.equal(sceneEnds(edge({ toNode: 'n' }), nodes, { ...refs, n: { state: 'ok', kind: 'scene', id: 's9' } }), null, 'a note is not a story card');
  assert.equal(sceneEnds(edge({ toNode: 'missing' }), nodes, refs), null);
  assert.equal(sceneEnds(edge(), nodes, undefined), null);
});

test('edgeLink, withLink and withoutLink', () => {
  assert.equal(edgeLink(edge()), null);
  assert.equal(edgeLink(edge({ storyforge: {} })), null);
  assert.equal(edgeLink(edge({ storyforge: { link: '' } })), null);
  const linked = withLink(edge({ label: 'old' }), 'one-pays-off-two', 'pays_off');
  assert.equal(linked.label, 'pays off');
  assert.deepEqual(linked.storyforge, { link: 'one-pays-off-two' });
  assert.equal(edgeLink(linked), 'one-pays-off-two');
  assert.equal(linked.fromNode, 'a');
  assert.equal(linked.toEnd, 'arrow');
  assert.deepEqual(withoutLink(linked), edge(), 'label and the empty storyforge are gone');
  const kept = withoutLink(withLink(edge({ storyforge: { other: 1 } }), 's', 'but'));
  assert.deepEqual(kept, edge({ storyforge: { other: 1 } }));
  assert.equal('label' in kept, false);
  assert.deepEqual(withoutLink(edge()), edge());
});

test('reverseEdge swaps the cards and their sides, not the arrow ends', () => {
  const r = reverseEdge(edge({ storyforge: { link: 'l' }, label: 'but' }));
  assert.deepEqual([r.fromNode, r.fromSide, r.toNode, r.toSide, r.toEnd, r.label, r.id], ['b', 'left', 'a', 'right', 'arrow', 'but', 'x']);
  assert.deepEqual(r.storyforge, { link: 'l' });
  const bare = reverseEdge({ id: 'y', fromNode: 'a', toNode: 'b' });
  assert.deepEqual(bare, { id: 'y', fromNode: 'b', toNode: 'a' });
});

test('relationFromLabel reads a relation back from its words', () => {
  for (const { value } of RELATIONS) assert.equal(relationFromLabel(value.replace(/_/g, ' ')), value);
  assert.equal(relationFromLabel(' Pays Off '), 'pays_off');
  assert.equal(relationFromLabel('leads to'), null);
  assert.equal(relationFromLabel(undefined), null);
});

test('edgeView: the live link is the truth; a missing one is unlinked; no link is plain', () => {
  const links = indexLinks({ links: [{ slug: 'one-but-two', from: 's1', to: 's2', relation: 'but', sha256: 'h' }, { slug: 'p-parallel-q', relation: 'parallel' }, { nope: true }], archived: [{ slug: 'gone', relation: 'but' }] });
  assert.deepEqual([...links.keys()], ['one-but-two', 'p-parallel-q']);

  const plain = edgeView(edge({ label: 'hi' }), links);
  assert.deepEqual([plain.state, plain.label, plain.dasharray], ['plain', 'hi', null]);

  const live = edgeView(withLink(edge(), 'one-but-two', 'therefore'), links);
  assert.equal(live.state, 'live');
  assert.equal(live.label, 'but', 'the link, not the stored label');
  assert.equal(live.dasharray, relationStroke('but').dasharray);
  assert.equal(live.link.sha256, 'h');
  assert.equal(edgeView(withLink(edge(), 'p-parallel-q', 'parallel'), links).dasharray, relationStroke('parallel').dasharray);
  assert.equal(edgeView(withLink(edge(), 'one-but-two', 'but'), new Map([['one-but-two', { relation: 'therefore' }]])).dasharray, null, 'a solid relation has no dashes');

  const gone = edgeView(withLink(edge(), 'gone', 'but'), links);
  assert.deepEqual([gone.state, gone.label, gone.dasharray, gone.link], ['unlinked', 'but', null, null]);
  assert.equal(edgeView(withLink(edge(), 'gone', 'but'), null).state, 'pending');
});

test('the requests are the Flow ones: create, change relation, reverse', () => {
  assert.deepEqual(createLinkRequest(BOOK, { from: 's1', to: 's2', relation: 'therefore' }), { url: '/api/books/book_1/links', body: { from: 's1', to: 's2', relation: 'therefore' } });
  const link = { slug: 'one-but-two', from: 's1', to: 's2', relation: 'but', sha256: 'abc' };
  assert.deepEqual(updateLinkBody(link, { relation: 'enables' }), { relation: 'enables', base_sha256: 'abc' });
  assert.deepEqual(reverseLinkBody(link), { from: 's2', to: 's1', base_sha256: 'abc' });
});

test('duplicateLinkSlug and the failure sentences', () => {
  const dup = { error: 'conflict', code: 'REFUSED_DUPLICATE_LINK', existing: { slug: 'one-but-two' } };
  assert.equal(duplicateLinkSlug(409, dup), 'one-but-two');
  assert.equal(duplicateLinkSlug(409, { ...dup, existing: 'plain-slug' }), 'plain-slug');
  assert.equal(duplicateLinkSlug(409, { ...dup, existing: {} }), null);
  assert.equal(duplicateLinkSlug(409, { error: 'conflict' }), null, 'a stale write is not a duplicate');
  assert.equal(duplicateLinkSlug(400, dup), null);
  assert.match(explainCanvasLinkFailure(403, { code: 'MODULE_OFF' }), /planner module is off/);
  assert.match(explainCanvasLinkFailure(400, { code: 'REFUSED_SELF_LINK' }), /itself/);
  assert.match(explainCanvasLinkFailure(0, null), /could not be reached/);
});
