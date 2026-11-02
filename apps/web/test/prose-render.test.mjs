import assert from 'node:assert/strict';
import { test } from 'node:test';
import { segmentProse, sceneNotes } from '../src/prose.js';

const join = (segs) => segs.map((s) => s.raw).join('');

const SAMPLES = [
  '',
  'plain text',
  'The key was colder.\n\n<!-- note: check the tide -->\n\n[[pell]] watched from the gate.\n',
  '[[tobin-reyes|the ferryman]] threw her bag ashore.',
  'a `[[not-a-link]]` and `<!-- not a comment -->` stay code',
  '```\n[[in-fence]]\n<!-- in fence -->\n```\nafter',
  '```js\nnever closed\n[[x]]',
  '~~~\ntilde\n~~~\n\n[[a|b]] <!-- c --> [[d]]',
  '<!-- unterminated comment',
  '[[ ]] [[|]] [[a|]] [[|b]]',
  'crlf\r\n<!-- x -->\r\n[[y]]\r\n',
  'unicode: [[é-slug|Émile]] 日本語 <!-- 注 -->',
  '<!-- note: first --> text <!-- NOTE:   second   --> <!-- other -->',
];

test('the segments always join back to the exact source', () => {
  for (const s of SAMPLES) assert.equal(join(segmentProse(s)), s, JSON.stringify(s));
});

test('segmenting leaves the source string as it was', () => {
  for (const s of SAMPLES) {
    const before = [...s].join('');
    segmentProse(s);
    sceneNotes(s);
    assert.equal(s, before);
  }
});

test('segmenting is deterministic', () => {
  for (const s of SAMPLES) assert.deepEqual(segmentProse(s), segmentProse(s));
});

test('wiki-links display as their label, or the slug when there is no label', () => {
  const [a, b] = segmentProse('[[pell]] and [[tobin-reyes|the ferryman]]').filter((s) => s.type === 'wikilink');
  assert.deepEqual([a.slug, a.text, a.raw], ['pell', 'pell', '[[pell]]']);
  assert.deepEqual([b.slug, b.text, b.raw], ['tobin-reyes', 'the ferryman', '[[tobin-reyes|the ferryman]]']);
});

test('comments are kept whole and visible; note comments expose their text', () => {
  const segs = segmentProse('a <!-- note: check the tide --> b <!-- opaque: keep -->');
  const comments = segs.filter((s) => s.type === 'comment');
  assert.equal(comments.length, 2);
  assert.equal(comments[0].text, '<!-- note: check the tide -->');
  assert.equal(comments[0].note, 'check the tide');
  assert.equal(comments[1].note, null);
  assert.deepEqual(sceneNotes('<!-- note: first --> x <!-- NOTE:   second   --> <!-- other -->'), ['first', 'second']);
});

test('code is not transformed: links and comments inside inline code or fences stay code', () => {
  const inline = segmentProse('see `[[x]]` and `<!-- y -->`');
  assert.equal(inline.filter((s) => s.type === 'wikilink' || s.type === 'comment').length, 0);
  assert.equal(inline.filter((s) => s.type === 'code').length, 2);
  const fenced = segmentProse('```\n[[x]]\n<!-- note: y -->\n```\n[[z]]');
  assert.deepEqual(
    fenced.map((s) => s.type),
    ['code', 'text', 'wikilink'],
  );
  assert.equal(fenced[0].block, true);
  assert.deepEqual(sceneNotes('```\n<!-- note: hidden -->\n```'), []);
});

test('an unterminated comment or link is plain text, not swallowed', () => {
  assert.deepEqual(
    segmentProse('<!-- never ends').map((s) => s.type),
    ['text'],
  );
  assert.deepEqual(
    segmentProse('[[no end').map((s) => s.type),
    ['text'],
  );
});
