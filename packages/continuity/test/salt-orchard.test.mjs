// M05-J01 acceptance 1, 2, 3, 6 (and the fixture half of 4): the salt-orchard anchor, determinism, fingerprint stability,
// exception suppression, read-only behaviour. Contract: docs/contracts/M05-J01-continuity-rules.md sections 1.3, 2, 3.1, 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkContinuity, RULES, fingerprintOf } from '../src/index.mjs';
import { validate } from '../../format/src/index.mjs';
import { ARRIVAL_FILE, ARRIVAL_ID, MAREN_FILE, MAREN_ID, VALID, abs, copyFixture, id, put, read, statTree } from './helpers.mjs';

const FP_RE = /^[a-z0-9]{2,4}-[0-9a-f]{16}$/;
const lineNo = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
const cf1 = (r) => r.findings.filter((f) => f.rule === 'CF1');

const EXCEPTION = (fp, slug = 'maren-eyes', n = 1) => `---
schema: storyforge.continuity-exception/v1
id: ${id('note', 300 + n)}
slug: ${slug}
fingerprint: ${fp}
rule: CF1
title: Maren's eyes look green in the hut glass
created: "2026-11-02"
---
The hut glass is tinted; the author means it.
`;
const EX_FILE = 'planning/continuity/maren-eyes.md';

const SECOND_SCENE = `---
schema: storyforge.scene/v1
id: ${id('scene', 901)}
title: Second look
act: 1
chapter: 1
sequence: 30
status: drafting
pov: maren-hollis
characters: [maren-hollis]
---
Later she met her own gaze again and saw only blue eyes looking back.
`;
const SECOND_FILE = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0030-second-look.md';

test('API surface: RULES lists the documented rules; fingerprintOf is a function', () => {
  assert.ok(Array.isArray(RULES) || typeof RULES === 'object');
  const list = Array.isArray(RULES) ? RULES : Object.values(RULES);
  const ids = list.map((r) => r.id);
  for (const want of ['CF1', 'TL1', 'KN1', 'ST1', 'TH1']) {
    assert.ok(ids.some((i) => i.startsWith(want)), `RULES has ${want}`);
  }
  for (const r of list) {
    assert.ok(Number.isInteger(r.version) && r.version >= 1, `${r.id} has a version`);
    assert.ok(['error', 'warning', 'info'].includes(r.severity), `${r.id} severity`);
    assert.equal(typeof r.title, 'string');
    assert.equal(typeof r.description, 'string');
  }
  assert.equal(typeof fingerprintOf, 'function');
});

test('salt-orchard: result shape and exactly one CF1 with the two exact sources', async () => {
  const root = copyFixture();
  const r = await checkContinuity(root);
  assert.equal(r.engine_version, 1);
  assert.deepEqual(r.suppressed, []);
  assert.deepEqual(r.stale_exceptions, []);
  assert.deepEqual(r.skipped, []);
  const found = cf1(r);
  assert.equal(found.length, 1, 'exactly one CF1');
  const f = found[0];
  assert.match(f.fingerprint, FP_RE);
  assert.ok(f.fingerprint.startsWith('cf1-'));
  assert.equal(f.rule_version, 1);
  assert.equal(f.severity, 'warning');
  assert.equal(f.subject.kind, 'entry');
  assert.equal(f.subject.slug, 'maren-hollis');
  assert.equal(f.subject.id, MAREN_ID);
  assert.ok(f.title && !f.title.includes('\n'));
  assert.ok(/grey/i.test(f.message) && /green/i.test(f.message), 'message quotes both values');

  assert.equal(f.sources.length, 2);
  const [canon, text] = f.sources;
  const entryText = read(root, MAREN_FILE);
  assert.equal(canon.role, 'canon');
  assert.equal(canon.kind, 'entry');
  assert.equal(canon.id, MAREN_ID);
  assert.equal(canon.file, MAREN_FILE);
  assert.equal(canon.location, 'fields.Eyes');
  assert.equal(canon.line, lineNo(entryText, 'Eyes: Grey'));
  assert.match(canon.excerpt, /Grey/);

  const sceneText = read(root, ARRIVAL_FILE);
  const line17 = sceneText.split('\n')[16];
  assert.equal(text.role, 'text');
  assert.equal(text.kind, 'scene');
  assert.equal(text.id, ARRIVAL_ID);
  assert.equal(text.file, ARRIVAL_FILE);
  assert.equal(text.heading, 'Arrival');
  assert.equal(text.location, 'line 17');
  assert.equal(text.line, 17);
  const at = line17.indexOf('green eyes');
  assert.ok(at > 0);
  assert.ok(text.range, 'range present');
  assert.ok(text.range.from <= at && text.range.to >= at + 'green eyes'.length, `range ${JSON.stringify(text.range)} covers "green eyes" at ${at}`);
  assert.ok(text.range.to <= line17.length);
  assert.ok(text.excerpt.length <= 160);
  assert.match(text.excerpt, /green eyes/);
});

test('salt-orchard: findings equal expected-continuity.json; every extra finding is a failure', async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(VALID, 'salt-orchard', 'expected-continuity.json'), 'utf8'));
  const r = await checkContinuity(copyFixture());
  assert.deepEqual(r.findings, expected.findings);
  assert.deepEqual(expected.suppressed ?? [], []);
});

test('the three fixtures validate with no diagnostics (state / exceptions add no warnings)', async () => {
  for (const name of ['salt-orchard', 'continuity-cases', 'continuity-exception']) {
    const r = await validate(path.join(VALID, name));
    assert.deepEqual(r.diagnostics, [], name);
  }
});

test('continuity-cases and continuity-exception match their expected-continuity.json', async () => {
  for (const name of ['continuity-cases', 'continuity-exception']) {
    const expected = JSON.parse(fs.readFileSync(path.join(VALID, name, 'expected-continuity.json'), 'utf8'));
    const r = await checkContinuity(copyFixture(name));
    assert.deepEqual(r.findings, expected.findings, `${name} findings`);
    for (const k of ['suppressed', 'stale_exceptions']) {
      if (k in expected) assert.deepEqual(r[k], expected[k], `${name} ${k}`);
    }
  }
});

test('continuity-exception fixture: CF1 suppressed, made-up exception is stale', async () => {
  const r = await checkContinuity(copyFixture('continuity-exception'));
  assert.equal(cf1(r).length, 0);
  assert.equal(r.suppressed.length, 1);
  assert.equal(r.suppressed[0].finding.rule, 'CF1');
  assert.equal(r.suppressed[0].exception.file, 'planning/continuity/maren-eyes.md');
  assert.equal(r.stale_exceptions.length, 1);
});

// ---------------------------------------------------------------- determinism

test('two runs and a copy in another directory give byte-identical JSON', async () => {
  const a = copyFixture();
  const b = copyFixture();
  const one = JSON.stringify(await checkContinuity(a));
  assert.equal(JSON.stringify(await checkContinuity(a)), one);
  assert.equal(JSON.stringify(await checkContinuity(b)), one);
  // a relative / differently spelled path to the same book gives the same output too
  assert.equal(JSON.stringify(await checkContinuity(path.join(a, '.', ''))), one);
});

// ---------------------------------------------------------------- fingerprint stability

async function baseline(root) {
  const r = await checkContinuity(root);
  assert.equal(cf1(r).length, 1, 'baseline has the CF1');
  return cf1(r)[0];
}

test('fingerprint ignores lines inserted above the evidence in both files; line numbers move', async () => {
  const root = copyFixture();
  const before = await baseline(root);
  put(root, ARRIVAL_FILE, read(root, ARRIVAL_FILE).replace('---\nThe ferry nudged', '---\nA new opening paragraph.\n\nAnother new one.\n\nThe ferry nudged'));
  put(root, MAREN_FILE, read(root, MAREN_FILE).replace('fields:\n', 'fields:\n  Height: tall\n  Build: lean\n'));
  const after = (await checkContinuity(root)).findings.find((f) => f.rule === 'CF1');
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(after.sources[1].line, before.sources[1].line + 4);
  assert.equal(after.sources[0].line, before.sources[0].line + 2);
});

test('fingerprint survives renaming the scene file', async () => {
  const root = copyFixture();
  const before = await baseline(root);
  const to = ARRIVAL_FILE.replace('0010-arrival.md', '0010-arrival-by-ferry.md');
  fs.renameSync(abs(root, ARRIVAL_FILE), abs(root, to));
  const after = (await checkContinuity(root)).findings.find((f) => f.rule === 'CF1');
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(after.sources[1].file, to);
});

test('fingerprint survives moving the entry to another folder', async () => {
  const root = copyFixture();
  const before = await baseline(root);
  const to = 'codex/people/maren-hollis.md';
  put(root, to, read(root, MAREN_FILE));
  fs.rmSync(abs(root, MAREN_FILE));
  const after = (await checkContinuity(root)).findings.find((f) => f.rule === 'CF1');
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(after.sources[0].file, to);
});

test('changing the field value Grey to Blue gives a different fingerprint', async () => {
  const root = copyFixture();
  const before = await baseline(root);
  put(root, MAREN_FILE, read(root, MAREN_FILE).replace('Eyes: Grey', 'Eyes: Blue'));
  const after = (await checkContinuity(root)).findings.find((f) => f.rule === 'CF1');
  assert.ok(after, 'still a conflict: blue vs green');
  assert.notEqual(after.fingerprint, before.fingerprint);
});

test('changing the field to the text value removes the finding (Green = green)', async () => {
  const root = copyFixture();
  put(root, MAREN_FILE, read(root, MAREN_FILE).replace('Eyes: Grey', 'Eyes: Green'));
  assert.equal(cf1(await checkContinuity(root)).length, 0);
});

// ---------------------------------------------------------------- exceptions

test('exception suppresses only its fingerprint; a second conflict still reports; deleting restores', async () => {
  const root = copyFixture();
  const original = await checkContinuity(root);
  const fp = cf1(original)[0].fingerprint;

  put(root, EX_FILE, EXCEPTION(fp));
  const withEx = await checkContinuity(root);
  assert.equal(cf1(withEx).length, 0);
  assert.deepEqual(withEx.findings, original.findings.filter((f) => f.fingerprint !== fp), 'every other finding unchanged');
  assert.equal(withEx.suppressed.length, 1);
  assert.equal(withEx.suppressed[0].finding.fingerprint, fp);
  assert.deepEqual(withEx.suppressed[0].finding, cf1(original)[0], 'suppressed finding is the full original finding');
  assert.deepEqual(withEx.suppressed[0].exception, { file: EX_FILE, slug: 'maren-eyes', intentional: false });
  assert.deepEqual(withEx.stale_exceptions, []);

  // a second conflict in another scene is a different finding and is NOT hidden
  put(root, SECOND_FILE, SECOND_SCENE);
  const two = await checkContinuity(root);
  const reported = cf1(two);
  assert.equal(reported.length, 1);
  assert.notEqual(reported[0].fingerprint, fp);
  assert.equal(reported[0].sources[1].file, SECOND_FILE);
  assert.match(reported[0].sources[1].excerpt, /blue eyes/);
  assert.equal(two.suppressed.length, 1);
  assert.equal(two.suppressed[0].finding.fingerprint, fp);

  // delete the exception: both findings come back
  fs.rmSync(abs(root, EX_FILE));
  fs.rmSync(abs(root, SECOND_FILE));
  const restored = await checkContinuity(root);
  assert.deepEqual(restored, original);
});

test('exception does not suppress a second conflict of the same kind and value in another scene', async () => {
  const root = copyFixture();
  const fp = cf1(await checkContinuity(root))[0].fingerprint;
  put(root, EX_FILE, EXCEPTION(fp));
  put(root, SECOND_FILE, SECOND_SCENE.replace('blue eyes', 'green eyes'));
  const r = await checkContinuity(root);
  assert.equal(cf1(r).length, 1, 'the new scene is a new finding (one finding per entry/label/value/scene)');
  assert.equal(cf1(r)[0].sources[1].file, SECOND_FILE);
});

test('stale exception (matches no current finding) is listed, suppresses nothing', async () => {
  const root = copyFixture();
  const original = await checkContinuity(root);
  put(root, 'planning/continuity/old-news.md', EXCEPTION('cf1-0123456789abcdef', 'old-news', 2));
  const r = await checkContinuity(root);
  assert.deepEqual(r.findings, original.findings);
  assert.deepEqual(r.suppressed, []);
  assert.deepEqual(r.stale_exceptions, [{ file: 'planning/continuity/old-news.md', slug: 'old-news', fingerprint: 'cf1-0123456789abcdef' }]);
});

test('an exception whose fingerprint is one hex digit off does not suppress', async () => {
  const root = copyFixture();
  const fp = cf1(await checkContinuity(root))[0].fingerprint;
  put(root, EX_FILE, EXCEPTION(fp.slice(0, -1) + (fp.endsWith('0') ? '1' : '0')));
  const r = await checkContinuity(root);
  assert.equal(cf1(r).length, 1, 'one hex digit off: no suppression');
  assert.equal(r.stale_exceptions.length, 1);
});

// ---------------------------------------------------------------- read-only

test('the engine writes nothing: bytes and mtimes unchanged, no .storyforge created', async () => {
  const root = copyFixture();
  fs.rmSync(abs(root, '.storyforge'), { recursive: true, force: true });
  const before = statTree(root);
  await checkContinuity(root);
  await checkContinuity(root);
  assert.deepEqual(statTree(root), before);
  assert.equal(fs.existsSync(abs(root, '.storyforge')), false, 'did not create .storyforge');
});

test('works with .storyforge deleted, and never reads it (garbage inside changes nothing)', async () => {
  const withIdx = copyFixture();
  const without = copyFixture();
  fs.rmSync(abs(without, '.storyforge'), { recursive: true, force: true });
  put(withIdx, '.storyforge/garbage.md', '---\nschema: storyforge.scene/v1\nid: scene_01T6999999999999999999999A\n---\nher green eyes\n');
  put(withIdx, '.storyforge/index.sqlite', 'not a database');
  assert.deepEqual(await checkContinuity(withIdx), await checkContinuity(without));
});

test('a file that fails to parse is skipped and listed; the rest is still checked', async () => {
  const root = copyFixture();
  const bad = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0040-broken.md';
  put(root, bad, '---\nschema: storyforge.scene/v1\nid: [unclosed\n---\nher blue eyes\n');
  const r = await checkContinuity(root);
  assert.ok(r.skipped.includes(bad), `skipped lists ${bad}: ${JSON.stringify(r.skipped)}`);
  assert.equal(cf1(r).length, 1, 'the real CF1 is still found');
});
