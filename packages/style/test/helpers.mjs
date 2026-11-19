import assert from 'node:assert/strict';
import { findingProblems } from '@storyforge/format';
import { checkStyle } from '../src/index.mjs';

export const SCENE = 'scene_01HZX3K9M2N4P6Q8R0S1T2V3W4';
export const SCENE_B = 'scene_01HZX3K9M2N4P6Q8R0S1T2V3W5';
export const SHA = 'a'.repeat(64);

/** Settings with exactly one rule on (others off), merged with `map`. */
export const only = (id, map = {}) => ({
  rules: Object.fromEntries(['preferred-terms', 'repeated-words', 'punctuation', 'repeated-phrases', 'long-paragraphs', 'isolated-lines']
    .map((r) => [r, { enabled: r === id, ...(r === id ? map : {}) }])),
});

/** Run checkStyle and assert the contract on every finding: valid, and body.slice(range) is the original. */
export async function check(body, settings, sceneId = SCENE) {
  const findings = await checkStyle({ sceneId, body, settings, sha256: SHA });
  for (const f of findings) {
    assert.deepEqual(findingProblems(f), [], `finding ${f.id} is valid`);
    assert.equal(body.slice(f.range.from, f.range.to), f.original, 'body.slice(range) equals original');
    assert.equal(f.engine, 'textlint');
    assert.equal(f.engineVersion, '16.1.1');
  }
  return findings;
}

/** Apply every first replacement, last to first. */
export function applyAll(body, findings) {
  let out = body;
  for (const f of [...findings].sort((a, b) => b.range.from - a.range.from)) {
    if (f.replacements.length > 0) out = out.slice(0, f.range.from) + f.replacements[0] + out.slice(f.range.to);
  }
  return out;
}
