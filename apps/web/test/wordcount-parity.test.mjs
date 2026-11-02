// M03-J02 acceptance 5: the web word count (apps/web/src/editor/wordcount.js, no package imports allowed in the app)
// must equal @storyforge/index countWords on every fixture body, the torture body and 1000 generated strings.
// The reference is imported by relative path: the lint rule only blocks the `@storyforge/*` specifier, and this is a test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countWords as indexCountWords } from '../../../packages/index/src/index.mjs';
import { countWords as webCountWords } from '../src/editor/wordcount.js';
import { allBodies, prng, toCRLF, toLF, variantsOf } from './editor-fixtures.mjs';

test('the web wordcount module exports countWords', () => {
  assert.equal(typeof webCountWords, 'function');
});

test('parity on every fixture body and the torture body, LF and CRLF, with and without a final newline', () => {
  const bodies = allBodies();
  assert.ok(bodies.length >= 17, 'all fixtures were found');
  for (const { name, body } of bodies) {
    for (const { label, text } of variantsOf(body)) {
      assert.equal(webCountWords(text), indexCountWords(text), `${name} (${label})`);
    }
  }
});

test('parity on hand-picked edges: empty, whitespace, comments, fences, Unicode', () => {
  const cases = [
    '',
    ' ',
    '\n\n\n',
    '\t \r\n ',
    'one',
    'one two  three\tfour\nfive\r\nsix',
    '<!-- only a comment -->',
    'a <!-- b --> c',
    'a<!-- b -->c',
    'a <!-- unclosed comment b c',
    '<!-- one --> <!-- two --> kept',
    '<!--\nmulti\nline\n--> after',
    '<!-- <!-- nested --> still --> end',
    '```\ninside fence\n```\noutside',
    '~~~\ninside tilde\n~~~\noutside',
    '```\nunclosed fence runs to the end\nmore words',
    '````\n```\nstill inside\n```\n````\nout',
    '```\nopen\n~~~\nstill inside\n```\nout',
    '   ```\nindented fence\n   ```\nout',
    '    ```\nfour spaces is not a fence\n    ```\nout',
    '```\r\ncrlf fence\r\n```\r\nout',
    'a ```inline``` b',
    '<!--\n```\n-->\nreal words\n```\ncode\n```',
    '```\n<!-- inside fence -->\n```\nafter',
    'café naïve Über',
    'こんにちは、世界。 物語',
    '🌊 🔑🌊',
    'nbsp joined and ideographic　space',
    '***',
    '* * * three',
    '[[pell|Label here]] and [@cite, p. 4]',
  ];
  for (const text of cases) {
    for (const t of [text, toLF(text), toCRLF(text)]) {
      assert.equal(webCountWords(t), indexCountWords(t), JSON.stringify(t));
    }
  }
});

test('known counts: the rule itself (so a drift in both implementations is also caught)', () => {
  assert.equal(webCountWords(''), 0);
  assert.equal(webCountWords('   \n\t'), 0);
  assert.equal(webCountWords('one two  three\nfour'), 4);
  assert.equal(webCountWords('a <!-- hidden words here --> b'), 2);
  assert.equal(webCountWords('before\n```\nfenced words\n```\nafter'), 2);
  assert.equal(webCountWords('before\n~~~\nfenced words\n~~~\nafter'), 2);
  assert.equal(webCountWords('well-known [[pell]] ***'), 3);
});

test('parity on 1000 generated strings (seeded)', () => {
  const rand = prng(20261101);
  const pieces = [
    'word', 'Word', 'café', 'こんにちは', '🌊', 'a-b', "it's", '12.5', '***', '[[x|y]]', '[@c]',
    ' ', ' ', ' ', '  ', '\t', '\n', '\n\n', '\r\n', ' ', '　',
    '<!--', '-->', '<!-- c -->', '<!-- note: n -->', '\n```\n', '\n~~~\n', '\n```js\n', '\n````\n', '\n   ```\n', '\n    ```\n', '```', '~~~',
  ];
  let nonZero = 0;
  for (let i = 0; i < 1000; i++) {
    const n = Math.floor(rand() * 40);
    let s = '';
    for (let k = 0; k < n; k++) s += pieces[Math.floor(rand() * pieces.length)];
    const a = webCountWords(s);
    const b = indexCountWords(s);
    assert.equal(a, b, `case ${i}: ${JSON.stringify(s)}`);
    if (b > 0) nonZero++;
  }
  assert.ok(nonZero > 300, 'the generator produces real words, not just empties');
});
