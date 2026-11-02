import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countWords } from '../src/index.mjs';

test('empty and whitespace-only bodies count zero', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('  \n\t \r\n '), 0);
});

test('counts whitespace-separated runs', () => {
  assert.equal(countWords('one'), 1);
  assert.equal(countWords('one two  three\tfour\nfive'), 5);
});

test('CRLF line endings', () => {
  assert.equal(countWords('a b\r\nc\r\n\r\nd'), 4);
});

test('HTML comments are excluded, including multi-line ones', () => {
  assert.equal(countWords('a <!-- hidden words here --> b'), 2);
  assert.equal(countWords('a\n<!--\nmany\nhidden\nwords\n-->\nb'), 2);
});

test('fenced code blocks are excluded', () => {
  assert.equal(countWords('a\n```\ncode words here\n```\nb'), 2);
  assert.equal(countWords('a\n```js\nconst x = 1;\n```\nb c'), 3);
});

test('Unicode words', () => {
  assert.equal(countWords('naïve café'), 2);
  assert.equal(countWords('潮が引く、そして戻る'), 1); // no whitespace: one \S+ run
  assert.equal(countWords('“Not tonight,” she said — softly'), 6);
});

test('punctuation-attached tokens count as one run each', () => {
  assert.equal(countWords('well-known, "quoted" end.'), 3);
});
