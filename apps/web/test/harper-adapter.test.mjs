// Harper adapter (M13-J02 §4, §8): pure conversion of extracted lint data to findings. No Harper import.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { findingMatches, findingProblems } from '../src/findings/findings.js';
import { projectProse } from '../src/findings/prose-map.js';
import { HARPER_VERSION, KIND_CATEGORY, toFindings } from '../src/grammar/harper-adapter.js';

const SCENE = 'scene_01HZX0000000000000000000AA';
const SHA = 'a'.repeat(64);

/** One lint over the first occurrence of `word` in the projected text. */
function lintOf(projection, word, extra = {}) {
  const start = projection.text.indexOf(word);
  assert.ok(start >= 0, `${word} is in the projection`);
  return { start, end: start + word.length, kind: 'Miscellaneous', message: 'msg', problem: word, suggestions: [], ...extra };
}

function run(body, word, extra) {
  const projection = projectProse(body);
  const organized = { SomeRule: [lintOf(projection, word, extra)] };
  return toFindings({ sceneId: SCENE, body, projection, sha256: SHA, organized });
}

function assertValid(body, f, word) {
  assert.deepEqual(findingProblems(f), []);
  assert.ok(findingMatches(f, body));
  assert.equal(body.slice(f.range.from, f.range.to), word);
  assert.equal(f.original, word);
}

test('HARPER_VERSION equals the harper.js dependency in apps/web/package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['harper.js'], HARPER_VERSION);
  assert.equal(HARPER_VERSION, '3.2.0');
});

test('kinds map to categories, severity and advisory', () => {
  const cases = {
    Spelling: 'spelling', Typo: 'spelling',
    Punctuation: 'punctuation', Formatting: 'punctuation', Capitalization: 'punctuation',
    Style: 'style', Readability: 'style', Redundancy: 'style', Enhancement: 'style', WordChoice: 'style', Repetition: 'style', Regionalism: 'style',
    Miscellaneous: 'grammar', Agreement: 'grammar', Usage: 'grammar', Eggcorn: 'grammar', Unheard: 'grammar',
  };
  for (const [kind, category] of Object.entries(cases)) {
    const [f] = run('She saw the thing.', 'thing', { kind });
    assert.equal(f.category, category, kind);
    assert.equal(f.advisory, category === 'style', kind);
    assert.equal(f.severity, category === 'style' ? 'info' : 'warning', kind);
    assert.equal(f.engine, 'harper');
    assert.equal(f.engineVersion, HARPER_VERSION);
    assert.equal(f.ruleId, 'SomeRule');
    assert.deepEqual(findingProblems(f), []);
  }
  assert.equal(Object.keys(KIND_CATEGORY).length, 12);
});

test('replacement kinds: Replace, Remove, InsertAfter', () => {
  const body = 'It is an test.';
  const [f] = run(body, 'an', {
    suggestions: [
      { kind: 'Replace', text: 'a' },
      { kind: 'Remove', text: '' },
      { kind: 'InsertAfter', text: ',' },
    ],
  });
  assert.deepEqual(f.replacements, ['a', '', 'an,']);
  assertValid(body, f, 'an');
});

test('replacements are de-duplicated and capped at 8', () => {
  const dup = run('One word here.', 'word', {
    suggestions: [{ kind: 'Replace', text: 'x' }, { kind: 'Replace', text: 'x' }, { kind: 'InsertAfter', text: '' }, { kind: 'Replace', text: 'word' }],
  });
  assert.deepEqual(dup[0].replacements, ['x', 'word']);
  const many = run('One word here.', 'word', {
    suggestions: Array.from({ length: 12 }, (_, i) => ({ kind: 'Replace', text: `w${i}` })),
  });
  assert.deepEqual(many[0].replacements, ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7']);
  assert.deepEqual(findingProblems(many[0]), []);
});

test('ranges are exact after an emoji, smart quotes and an accented name', () => {
  const body = '\u{1F600} “Zoë” said teh thing.';
  const [f] = run(body, 'teh');
  assertValid(body, f, 'teh');
  assert.equal(f.source.length, body.length);
  assert.match(f.id, /^fnd_[0-9a-f]{16}$/);
});

test('ranges are exact for text that came from CRLF (the editor holds LF)', () => {
  const body = 'First line.\nSecond line has teh typo.\nThird.'; // what loadBuffer gives for a CRLF scene
  const [f] = run(body, 'teh');
  assertValid(body, f, 'teh');
});

test('ranges are exact inside emphasis, strong and link labels', () => {
  const emph = 'She said *teh* word and **teh** again.';
  const p1 = projectProse(emph);
  const second = p1.text.indexOf('teh', p1.text.indexOf('teh') + 1);
  const out = toFindings({
    sceneId: SCENE, body: emph, projection: p1, sha256: SHA,
    organized: { R: [{ start: second, end: second + 3, kind: 'Spelling', message: 'm', problem: 'teh', suggestions: [] }] },
  });
  assertValid(emph, out[0], 'teh');
  assert.equal(out[0].range.from, emph.lastIndexOf('teh'));

  const [first] = run(emph, 'teh');
  assertValid(emph, first, 'teh');
  assert.equal(first.range.from, emph.indexOf('teh'));

  const link = 'See [teh label](https://example.org/teh) now.';
  const [l] = run(link, 'teh');
  assertValid(link, l, 'teh');
  assert.equal(l.range.from, link.indexOf('teh'));
});

test('a lint across a removed marker maps to the body span that includes it', () => {
  const body = 'a *bad* word';
  const projection = projectProse(body); // 'a bad word'
  const [f] = toFindings({
    sceneId: SCENE, body, projection, sha256: SHA,
    organized: { R: [{ start: 2, end: 5, kind: 'Spelling', message: 'm', problem: 'bad', suggestions: [] }] },
  });
  assert.equal(f.original, 'bad');
  assert.deepEqual(findingProblems(f), []);
});

test('empty and out-of-range lints are dropped', () => {
  const body = 'Some prose here.';
  const projection = projectProse(body);
  const organized = {
    R: [
      { start: 3, end: 3, kind: 'Spelling', message: 'empty', suggestions: [] },
      { start: 5, end: 999, kind: 'Spelling', message: 'past the end', suggestions: [] },
      { start: -1, end: 2, kind: 'Spelling', message: 'negative', suggestions: [] },
      { start: 0, end: 4, kind: 'Spelling', message: 'kept', suggestions: [] },
    ],
  };
  const out = toFindings({ sceneId: SCENE, body, projection, sha256: SHA, organized });
  assert.equal(out.length, 1);
  assert.equal(out[0].original, 'Some');
});

test('findings are sorted by range and every one passes findingProblems', () => {
  const body = 'Teh cat sat on teh mat.';
  const projection = projectProse(body);
  const organized = {
    B: [{ start: 15, end: 18, kind: 'Spelling', message: 'b', suggestions: [{ kind: 'Replace', text: 'the' }] }],
    A: [{ start: 0, end: 3, kind: 'Spelling', message: 'a', suggestions: [{ kind: 'Replace', text: 'The' }] }],
  };
  const out = toFindings({ sceneId: SCENE, body, projection, sha256: SHA, organized });
  assert.deepEqual(out.map((f) => f.range.from), [0, 15]);
  assert.notEqual(out[0].id, out[1].id);
  for (const f of out) assert.deepEqual(findingProblems(f), []);
});

test('an over-long message is cut to 1000 characters and still valid', () => {
  const [f] = run('Some word.', 'word', { message: 'x'.repeat(1500) });
  assert.equal(f.message.length, 1000);
  assert.deepEqual(findingProblems(f), []);
});
