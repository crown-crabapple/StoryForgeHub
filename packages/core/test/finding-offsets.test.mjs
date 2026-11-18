// M13-J01: a finding range computed on the LF body (projectProse + toBodyRange) is what selectRange takes, even when the file body is CRLF
// and an emoji comes before the word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectProse, toBodyRange, findingMatches } from '@storyforge/format';
import { selectRange } from '../src/ai-rewrite.mjs';

const FRONT = '---\nschema: storyforge.scene/v1\nid: scene_01HZX3K9M2N4P6Q8R0S1T2V3W4\n---\n';

function sceneFile(lfBody) {
  const bytes = Buffer.from(FRONT + lfBody.replace(/\n/g, '\r\n'), 'utf8');
  return { bytes, bodyStart: Buffer.byteLength(FRONT, 'utf8') };
}

function findWord(lfBody, word) {
  const proj = projectProse(lfBody);
  const at = proj.text.indexOf(word);
  assert.notEqual(at, -1);
  const range = toBodyRange(proj, at, at + word.length);
  assert.equal(lfBody.slice(range.from, range.to), word);
  return range;
}

test('selectRange returns the finding original for a CRLF body with an emoji before the word', () => {
  const lfBody = 'First line \u{1F600} here.\n\nShe said the *teh* word \u{1F600} aloud.\nLast line.\n';
  const { bytes, bodyStart } = sceneFile(lfBody);
  const range = findWord(lfBody, 'teh');
  const sel = selectRange(bytes, bodyStart, range.from, range.to);
  assert.equal(sel.ok, true);
  assert.equal(sel.text, 'teh');
  assert.equal(bytes.subarray(sel.byteFrom, sel.byteTo).toString('utf8'), 'teh');
  assert.ok(sel.body.includes('\r\n'));
});

test('a word on a later line, a multi-line-aware word after markup, and a combining-mark name all come back exact', () => {
  const lfBody = '# Title\n\n> \u{1F600}\u{1F600} quoted\n\nMet Zoé at the [café](https://x.test/a).\n';
  const { bytes, bodyStart } = sceneFile(lfBody);
  for (const word of ['quoted', 'café']) {
    const r = findWord(lfBody, word);
    const sel = selectRange(bytes, bodyStart, r.from, r.to);
    assert.equal(sel.ok, true);
    assert.equal(sel.text, word);
  }
  const proj = projectProse(lfBody);
  const at = proj.text.indexOf('Zoe');
  const r = toBodyRange(proj, at, at + 3); // ends between base and combining accent: moved past it
  const sel = selectRange(bytes, bodyStart, r.from, r.to);
  assert.equal(sel.text, 'Zoé');
});

test('findingMatches agrees with the bytes selectRange reads', () => {
  const lfBody = 'A \u{1F600} line.\nThe teh word.\n';
  const { bytes, bodyStart } = sceneFile(lfBody);
  const range = findWord(lfBody, 'teh');
  const finding = { source: { length: lfBody.length }, range, original: 'teh' };
  const sel = selectRange(bytes, bodyStart, range.from, range.to);
  assert.equal(findingMatches(finding, sel.body.replace(/\r\n/g, '\n')), true);
  assert.equal(sel.text, finding.original);
});
