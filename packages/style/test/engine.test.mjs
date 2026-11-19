// M13-J03 §2, §3, §5, §11: crossSceneRepeats, styleFingerprint, the dialogue fixture, defaults, and the no-dynamic-loading guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN, FINGERPRINT_RE, findingProblems } from '@storyforge/format';
import { checkStyle, crossSceneRepeats, STYLE_DEFAULTS, STYLE_RULE_IDS, styleFingerprint, TEXTLINT_VERSION } from '../src/index.mjs';
import { RULES } from '../src/rules/index.mjs';
import { check, only, SCENE, SCENE_B, SHA } from './helpers.mjs';

const PHRASE_A = 'Elsewhere the old lighthouse keeper walked down the long road home.';
const PHRASE_B = 'Later the old lighthouse keeper walked down the long road again.';
const ON = only('repeated-phrases');

test('exports and the frozen RULES table', () => {
  assert.equal(TEXTLINT_VERSION, '16.1.1');
  assert.deepEqual(STYLE_RULE_IDS, Object.keys(RULES));
  assert.ok(Object.isFrozen(RULES));
  assert.ok(Object.isFrozen(STYLE_DEFAULTS) && Object.isFrozen(STYLE_DEFAULTS['preferred-terms'].terms));
  assert.deepEqual(STYLE_DEFAULTS, {
    'preferred-terms': { enabled: true, terms: [] },
    'repeated-words': { enabled: true },
    punctuation: { enabled: true, quotes: null, dashes: null, ellipsis: null },
    'repeated-phrases': { enabled: false, minWords: 4, window: 300 },
    'long-paragraphs': { enabled: false, maxWords: 220 },
    'isolated-lines': { enabled: false, minRun: 6 },
  });
  const meta = Object.fromEntries(STYLE_RULE_IDS.map((id) => [id, [RULES[id].category, RULES[id].severity, RULES[id].advisory]]));
  assert.deepEqual(meta, {
    'preferred-terms': ['terminology', 'warning', false],
    'repeated-words': ['repetition', 'warning', false],
    punctuation: ['punctuation', 'warning', false],
    'repeated-phrases': ['repetition', 'info', true],
    'long-paragraphs': ['rhythm', 'info', true],
    'isolated-lines': ['rhythm', 'info', true],
  });
});

test('STYLE_DEFAULTS equals BUILTIN.checks.style.rules from @storyforge/format', () => {
  assert.ok(BUILTIN.checks.style, 'BUILTIN.checks.style exists');
  assert.deepEqual(STYLE_DEFAULTS, BUILTIN.checks.style.rules);
  assert.equal(BUILTIN.checks.style.enabled, false);
});

test('crossSceneRepeats: phrases that recur in different scenes, with related; silent unless repeated-phrases is on', () => {
  const scenes = [
    { sceneId: SCENE, body: `${PHRASE_A}\nOther words follow.`, sha256: SHA },
    { sceneId: SCENE_B, body: PHRASE_B, sha256: SHA },
  ];
  assert.deepEqual(crossSceneRepeats(scenes, undefined), []);
  assert.deepEqual(crossSceneRepeats(scenes, only('repeated-words')), []);
  const f = crossSceneRepeats(scenes, ON);
  assert.equal(f.length, 2);
  assert.deepEqual(f.map((x) => x.sceneId), [SCENE, SCENE_B]);
  for (const x of f) {
    assert.deepEqual(findingProblems(x), []);
    assert.equal(x.ruleId, 'repeated-phrases');
    assert.equal(x.advisory, true);
    assert.equal(x.engine, 'textlint');
    assert.deepEqual(x.replacements, []);
    assert.equal(x.original, 'the old lighthouse keeper walked down the long');
  }
  const bodyOf = { [SCENE]: scenes[0].body, [SCENE_B]: scenes[1].body };
  for (const x of f) {
    assert.equal(x.related.length, 1);
    const r = x.related[0];
    assert.notEqual(r.sceneId, x.sceneId);
    assert.equal(bodyOf[r.sceneId].slice(r.from, r.to), r.text);
  }
});

test('crossSceneRepeats: one scene, a repeat inside one scene, common words and minWords', () => {
  const same = [{ sceneId: SCENE, body: `${PHRASE_A} ${PHRASE_B}`, sha256: SHA }];
  assert.deepEqual(crossSceneRepeats(same, ON), []);
  const two = [{ sceneId: SCENE, body: `${PHRASE_A} ${PHRASE_B}`, sha256: SHA }, { sceneId: SCENE_B, body: 'Nothing like it here at all.', sha256: SHA }];
  assert.deepEqual(crossSceneRepeats(two, ON), [], 'inside one scene only');
  const common = [
    { sceneId: SCENE, body: 'It was all of it and I was in it.', sha256: SHA },
    { sceneId: SCENE_B, body: 'It was all of it and I was in it.', sha256: SHA },
  ];
  assert.deepEqual(crossSceneRepeats(common, ON), []);
  const shortRepeat = [
    { sceneId: SCENE, body: 'Crimson tide rolls.', sha256: SHA },
    { sceneId: SCENE_B, body: 'Crimson tide rolls.', sha256: SHA },
  ];
  assert.deepEqual(crossSceneRepeats(shortRepeat, ON), []);
  assert.equal(crossSceneRepeats(shortRepeat, only('repeated-phrases', { minWords: 3 })).length, 2);
});

test('crossSceneRepeats: related is capped at 20', () => {
  const scenes = Array.from({ length: 25 }, (_, i) => ({
    sceneId: `scene_01HZX3K9M2N4P6Q8R0S1T2V3${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[i]}0`,
    body: 'Crimson tide rolls in slowly.',
    sha256: SHA,
  }));
  const f = crossSceneRepeats(scenes, ON);
  assert.equal(f.length, 25);
  assert.ok(f.every((x) => x.related.length === 20 && findingProblems(x).length === 0));
});

test('styleFingerprint: stable, matches FINGERPRINT_RE, changes when the passage changes', async () => {
  const body = 'He said that he had had enough of it all, every day of the long year.';
  const [f] = await check(body, only('repeated-words'));
  assert.equal(f.original, 'had had');
  const fp = styleFingerprint(f, body);
  assert.match(fp, /^sty-[0-9a-f]{16}$/);
  assert.match(fp, FINGERPRINT_RE);
  assert.equal(styleFingerprint(f, body), fp);
  const edited = 'He said that he had had quite enough of it all.';
  const [g] = await check(edited, only('repeated-words'));
  assert.notEqual(styleFingerprint(g, edited), fp, 'text after the range changed');
  const moved = `Then. ${body}`;
  const [h] = await check(moved, only('repeated-words'));
  assert.notEqual(styleFingerprint(h, moved), fp, 'text before the range changed');
  const far = body.replace('long year', 'short year');
  const [i] = await check(far, only('repeated-words'));
  assert.equal(styleFingerprint(i, far), fp, 'text beyond 24 characters does not matter');
  assert.notEqual(styleFingerprint({ ...f, sceneId: SCENE_B }, body), fp, 'scene is part of it');
  assert.notEqual(styleFingerprint({ ...f, ruleId: 'punctuation' }, body), fp, 'rule is part of it');
});

test('dialogue: “No, no, no,” is not flagged; had had is, and its dismissal goes stale when the sentence is edited', async () => {
  const body = '“No, no, no,” she said. “I had had enough,” he said.';
  const settings = only('repeated-words');
  const first = await check(body, settings);
  assert.deepEqual(first.map((x) => x.original), ['had had']);
  const dismissed = new Set(first.map((x) => styleFingerprint(x, body)));
  const rescan = (await check(body, settings)).filter((x) => !dismissed.has(styleFingerprint(x, body)));
  assert.deepEqual(rescan, [], 'stays dismissed on the next scan');
  const edited = '“No, no, no,” she said. “I had had quite enough,” he said.';
  const after = await check(edited, settings);
  assert.equal(after.length, 1);
  assert.ok(!dismissed.has(styleFingerprint(after[0], edited)), 'the edit changes the fingerprint: the old dismissal hides nothing');
  const seenNow = new Set(after.map((x) => styleFingerprint(x, edited)));
  assert.ok([...dismissed].every((fp) => !seenNow.has(fp)), 'the dismissal is stale (not seen in the last scan)');
});

test('findings are deterministic and carry the source', async () => {
  const body = 'The the end.';
  const a = await check(body, undefined);
  const b = await check(body, undefined);
  assert.deepEqual(a, b);
  assert.deepEqual(a[0].source, { sha256: SHA, length: body.length });
});

test('no dynamic loading anywhere in packages/style/src', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else files.push(path.join(dir, e.name));
    }
  };
  walk(root);
  assert.ok(files.length >= 9);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const re of [/\bimport\s*\(/, /\brequire\s*\(/, /\bcreateRequire\b/, /\beval\b/, /\bnew\s+Function\b/, /node:(fs|child_process)\b|from\s+'(fs|child_process)/]) {
      assert.ok(!re.test(text), `${path.relative(root, file)} must not match ${re}`);
    }
  }
});

test('checkStyle only runs rules of the fixed table (a settings object cannot add one)', async () => {
  const settings = { rules: { 'repeated-words': { enabled: true, module: './x.mjs', path: '/tmp/x' } } };
  assert.equal((await checkStyle({ sceneId: SCENE, body: 'a a', settings, sha256: SHA })).length, 1);
});
