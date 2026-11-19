// M13-J03 section 6: mergeFindings. A grammar finding and a style finding on the same range and concern keep only the owner's; everything else is kept.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNERS, mergeFindings } from '../src/findings/merge.js';

const f = (engine, ruleId, from, to, extra = {}) => ({ id: `${engine}-${ruleId}-${from}-${to}`, engine, ruleId, range: { from, to }, original: 'x'.repeat(to - from), replacements: [], ...extra });

test('OWNERS names the Harper rules of the four concerns and the textlint rule that owns each', () => {
  assert.deepEqual(OWNERS, {
    RepeatedWords: 'repeated-words',
    Dashes: 'punctuation',
    WrongApostrophe: 'punctuation',
    UseEllipsisCharacter: 'punctuation',
    EllipsisLength: 'punctuation',
  });
  assert.ok(Object.isFrozen(OWNERS));
});

test('the same range and concern keeps the owner (textlint) finding only', () => {
  const g = [f('harper', 'RepeatedWords', 4, 11), f('harper', 'Dashes', 20, 22), f('harper', 'UseEllipsisCharacter', 30, 33), f('harper', 'WrongApostrophe', 40, 41)];
  const s = [f('textlint', 'repeated-words', 4, 11), f('textlint', 'punctuation', 20, 22), f('textlint', 'punctuation', 30, 33), f('textlint', 'punctuation', 40, 41)];
  const out = mergeFindings(g, s);
  assert.deepEqual(out, s);
});

test('a different range, or a textlint rule of another concern, keeps both', () => {
  const g = [f('harper', 'RepeatedWords', 4, 11), f('harper', 'Dashes', 20, 22)];
  const s = [f('textlint', 'repeated-words', 5, 11), f('textlint', 'preferred-terms', 20, 22)];
  const out = mergeFindings(g, s);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((x) => x.id), [...g, ...s].map((x) => x.id));
});

test('a Harper rule that has no owner is never suppressed, even on the same range', () => {
  const g = [f('harper', 'SpellCheck', 4, 11), f('harper', 'LongSentences', 0, 50)];
  const s = [f('textlint', 'repeated-words', 4, 11), f('textlint', 'punctuation', 0, 50)];
  assert.equal(mergeFindings(g, s).length, 4);
});

test('textlint findings are never dropped; grammar comes first, each in its own order; inputs are not changed', () => {
  const g = [f('harper', 'SpellCheck', 9, 12), f('harper', 'AnA', 1, 3)];
  const s = [f('textlint', 'long-paragraphs', 0, 5), f('textlint', 'repeated-words', 9, 12)];
  const gCopy = [...g];
  const out = mergeFindings(g, s);
  assert.deepEqual(out.map((x) => x.id), [g[0].id, g[1].id, s[0].id, s[1].id]);
  assert.deepEqual(g, gCopy);
});

test('empty and missing lists', () => {
  assert.deepEqual(mergeFindings([], []), []);
  assert.deepEqual(mergeFindings(undefined, undefined), []);
  const s = [f('textlint', 'punctuation', 1, 2)];
  assert.deepEqual(mergeFindings([], s), s);
  const g = [f('harper', 'Dashes', 1, 2)];
  assert.deepEqual(mergeFindings(g, []), g, 'with no style finding the Harper dash finding stays');
});
