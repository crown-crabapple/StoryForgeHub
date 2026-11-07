// Story Planner M6 (ADR 0003): the planner rule family PL1-PL4 and the `intentional` flag on exceptions, on small synthetic books.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContinuity } from '../src/index.mjs';
import { buildBook, id, ofRule, put, read } from './helpers.mjs';

const FINGERPRINT_RE = /^[a-z0-9]{2,4}-[0-9a-f]{16}$/;
const sc = (n, extra = {}) => ({ n, title: `Scene ${n}`, body: 'Text.', ...extra });
const scene = (n) => id('scene', n);
const sceneFile = (n) => `manuscript/act-01-one/ch-001-c1/${String(n * 10).padStart(4, '0')}-s${n}.md`;

/** Add a planner link between two scene numbers. */
function link(root, k, from, to) {
  put(root, `planning/links/link-${k}.md`, `---
schema: storyforge.link/v1
id: ${id('note', 300 + k)}
slug: link-${k}
from: ${scene(from)}
to: ${scene(to)}
relation: therefore
created: 2026-11-06
---
Why.
`);
}

/** Add a structure; beats are [{ n, name, scenes? }]. */
function structure(root, beats, { archived = false, n = 1 } = {}) {
  const body = beats.map((b) => `  - id: ${id('note', 400 + b.n)}\n    name: ${b.name}\n${b.state ? `    state: ${b.state}\n` : ''}${b.scenes ? `    scenes: [${b.scenes.map(scene).join(', ')}]\n` : ''}`).join('');
  put(root, `${archived ? 'archive/' : ''}planning/structures/three-acts-${n}.md`, `---
schema: storyforge.structure/v1
id: ${id('note', 500 + n)}
slug: three-acts-${n}
name: Three acts
beats:
${body}---
Notes.
`);
}

const four = () => buildBook({ scenes: [sc(1), sc(2), sc(3), sc(4)] });
const pl = async (root, rule) => ofRule(await checkContinuity(root), rule);
const allPl = async (root) => (await checkContinuity(root)).findings.filter((f) => f.rule.startsWith('PL'));

test('PL1: no findings when the book has no links', async () => {
  assert.equal((await pl(four(), 'PL1')).length, 0);
  assert.equal((await pl(four(), 'PL2')).length, 0);
});

test('PL1: a scene with no links is reported when another link exists', async () => {
  const root = four();
  link(root, 1, 1, 2);
  link(root, 2, 2, 3);
  const f = await pl(root, 'PL1');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.equal(f[0].subject.id, scene(4));
  assert.equal(f[0].subject.kind, 'scene');
  assert.equal(f[0].sources[0].id, scene(4));
  assert.match(f[0].fingerprint, FINGERPRINT_RE);
});

test('PL2: adjacent linked scenes with no direct link are reported; a direct link in either direction clears it', async () => {
  const root = four();
  link(root, 1, 1, 2);
  link(root, 2, 3, 4);
  const f = await pl(root, 'PL2');
  assert.equal(f.length, 1);
  assert.equal(f[0].subject.id, scene(2));
  assert.deepEqual(f[0].sources.map((s) => s.id), [scene(2), scene(3)]);
  assert.match(f[0].message, /not documented in the planner/);
  assert.doesNotMatch(f[0].message, /missing/i);

  link(root, 3, 3, 2); // reverse direction counts
  assert.equal((await pl(root, 'PL2')).length, 0);
  const fwd = four();
  link(fwd, 1, 1, 2);
  link(fwd, 2, 2, 3);
  link(fwd, 3, 3, 4);
  assert.equal((await pl(fwd, 'PL2')).length, 0);
});

test('PL2: not reported when one of the pair has no links', async () => {
  const root = four();
  link(root, 1, 1, 2);
  link(root, 2, 2, 4);
  // scene 3 has no links: pairs (2,3) and (3,4) are skipped
  assert.equal((await pl(root, 'PL2')).length, 0);
  assert.equal((await pl(root, 'PL1')).length, 1);
});

test('PL3: an empty beat is reported, a beat with scenes is not, an archived structure is ignored', async () => {
  const root = four();
  structure(root, [{ n: 1, name: 'Opening', scenes: [1] }, { n: 2, name: 'Midpoint' }, { n: 3, name: 'End', scenes: [] }]);
  structure(root, [{ n: 4, name: 'Old beat' }], { archived: true, n: 2 });
  const f = await pl(root, 'PL3');
  assert.deepEqual(f.map((x) => x.title).sort(), ['Beat "End" in "Three acts" has no scenes', 'Beat "Midpoint" in "Three acts" has no scenes']);
  assert.equal(f[0].subject.kind, 'structure');
  assert.equal(f[0].subject.id, id('note', 501));
  assert.equal(f[0].sources[0].kind, 'structure');
  assert.equal(f[0].severity, 'info');
});

test('PL3: a beat marked omitted is not reported', async () => {
  const root = four();
  structure(root, [{ n: 1, name: 'Skipped', state: 'omitted' }, { n: 2, name: 'Open' }]);
  assert.deepEqual((await pl(root, 'PL3')).map((x) => x.title), ['Beat "Open" in "Three acts" has no scenes']);
});

test('PL4: a payoff with no setup is a warning; with a setup it is not', async () => {
  const root = buildBook({
    scenes: [sc(1), sc(2)],
    threads: [{ n: 1, slug: 'key', status: 'paid', payoff: [2] }, { n: 2, slug: 'door', status: 'paid', setup: [1], payoff: [2] }, { n: 3, slug: 'bare', status: 'paid' }],
  });
  const f = await pl(root, 'PL4');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warning');
  assert.equal(f[0].subject.slug, 'key');
  assert.equal(f[0].sources[0].location, 'payoff');
});

test('fingerprints are stable across a title edit; PL2 changes when the scene order changes', async () => {
  const root = four();
  link(root, 1, 1, 2);
  link(root, 2, 3, 4);
  structure(root, [{ n: 1, name: 'Midpoint' }]);
  const before = (await allPl(root)).map((f) => f.fingerprint).sort();
  assert.ok(before.length >= 2);
  put(root, sceneFile(2), read(root, sceneFile(2)).replace('title: Scene 2', 'title: A new name'));
  const after = (await allPl(root)).map((f) => f.fingerprint).sort();
  assert.deepEqual(after, before);

  // move scene 2 after scene 3: the pair (2,3) is no longer adjacent in that order
  const pair = (await pl(root, 'PL2'))[0].fingerprint;
  put(root, sceneFile(2), read(root, sceneFile(2)).replace('sequence: 20', 'sequence: 35'));
  const moved = await pl(root, 'PL2');
  assert.ok(moved.length >= 1);
  assert.ok(!moved.some((f) => f.fingerprint === pair));
});

test('an exception with intentional: true suppresses the finding and the suppressed entry carries intentional', async () => {
  const root = buildBook({ scenes: [sc(1), sc(2)], threads: [{ n: 1, slug: 'key', status: 'paid', payoff: [2] }] });
  const [f] = await pl(root, 'PL4');
  const exc = (extra) => `---
schema: storyforge.continuity-exception/v1
id: ${id('note', 600)}
slug: a
fingerprint: ${f.fingerprint}
rule: PL4
title: On purpose
created: "2026-11-06"
${extra}---
It is on purpose.
`;
  put(root, 'planning/continuity/a.md', exc('intentional: true\n'));
  let r = await checkContinuity(root);
  assert.equal(ofRule(r, 'PL4').length, 0);
  assert.equal(r.suppressed.length, 1);
  assert.equal(r.suppressed[0].exception.intentional, true);
  assert.equal(r.suppressed[0].exception.slug, 'a');

  put(root, 'planning/continuity/a.md', exc(''));
  r = await checkContinuity(root);
  assert.equal(r.suppressed[0].exception.intentional, false);
});

// ---- M8: branch links are not main plan

/** Add a link on a what-if branch. */
function branchLink(root, k, from, to, branch) {
  put(root, `planning/links/link-${k}.md`, `---
schema: storyforge.link/v1
id: ${id('note', 300 + k)}
slug: link-${k}
from: ${scene(from)}
to: ${scene(to)}
relation: therefore
branch: ${branch}
created: 2026-11-06
---
Why.
`);
}

test('PL1 and PL2 ignore branch links: a book with only branch links runs neither rule', async () => {
  const root = four();
  branchLink(root, 1, 1, 2, 'ferry-sinks');
  branchLink(root, 2, 3, 4, 'ferry-sinks');
  assert.equal((await pl(root, 'PL1')).length, 0);
  assert.equal((await pl(root, 'PL2')).length, 0);
});

test('PL1 and PL2 read main links only: branch links neither clear a finding nor add one', async () => {
  const main = four();
  link(main, 1, 1, 2);
  link(main, 2, 3, 4);
  const base = {
    PL1: (await pl(main, 'PL1')).map((f) => f.fingerprint).sort(),
    PL2: (await pl(main, 'PL2')).map((f) => f.fingerprint).sort(),
  };
  assert.deepEqual(base.PL1, [], 'every scene has a main link');
  assert.equal(base.PL2.length, 1, 'scenes 2 and 3 have no direct main link');
  // a branch link that would join 2 and 3, and one that would touch only scene 4
  branchLink(main, 3, 2, 3, 'ferry-sinks');
  assert.deepEqual((await pl(main, 'PL2')).map((f) => f.fingerprint).sort(), base.PL2, 'a branch link does not document the transition');

  const solo = four();
  link(solo, 1, 1, 2);
  link(solo, 2, 2, 3);
  branchLink(solo, 3, 3, 4, 'ferry-sinks');
  const f = await pl(solo, 'PL1');
  assert.deepEqual(f.map((x) => x.subject.id), [scene(4)], 'a scene linked only on a branch is still not in the main flow');
});

// ---- M8: clues

/** Add a clue; scene numbers become scene ids. */
function clue(root, n, { fact = `Fact ${n}`, kind, planted, revealed, redHerring, archived = false, slug = `clue-${n}` } = {}) {
  const lines = ['---', 'schema: storyforge.clue/v1', `id: ${id('note', 600 + n)}`, `slug: ${slug}`, `fact: ${fact}`];
  if (kind) lines.push(`kind: ${kind}`);
  if (planted) lines.push(`planted: [${planted.map(scene).join(', ')}]`);
  if (revealed) lines.push(`revealed: ${scene(revealed)}`);
  if (redHerring !== undefined) lines.push(`red_herring: ${redHerring}`);
  lines.push('created: 2026-11-06', '---', 'Notes.', '');
  put(root, `${archived ? 'archive/' : ''}planning/clues/${slug}.md`, lines.join('\n'));
}

test('PL5: a planted clue with no revealed scene is an info finding about the clue', async () => {
  const root = four();
  clue(root, 1, { fact: 'The key opens the gate', planted: [1, 2] });
  const f = await pl(root, 'PL5');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'info');
  assert.equal(f[0].rule_version, 1);
  assert.deepEqual(f[0].subject, { kind: 'clue', id: id('note', 601), slug: 'clue-1', name: 'The key opens the gate' });
  assert.equal(f[0].sources.length, 1);
  assert.equal(f[0].sources[0].role, 'plan');
  assert.equal(f[0].sources[0].kind, 'clue');
  assert.equal(f[0].sources[0].location, 'planted');
  assert.equal(f[0].sources[0].file, 'planning/clues/clue-1.md');
  assert.match(f[0].fingerprint, FINGERPRINT_RE);
  assert.match(f[0].title, /never revealed/);
});

test('PL5: not reported with a revealed scene, for a red herring, for other kinds, with nothing planted, or when archived', async () => {
  const root = four();
  clue(root, 1, { planted: [1], revealed: 3 });
  clue(root, 2, { planted: [1], redHerring: true });
  clue(root, 3, { planted: [1], kind: 'secret' });
  clue(root, 4, { planted: [1], kind: 'reveal' });
  clue(root, 5, {});
  clue(root, 6, { planted: [1], archived: true });
  assert.equal((await pl(root, 'PL5')).length, 0);
  clue(root, 7, { planted: [2], redHerring: false, kind: 'clue' });
  assert.deepEqual((await pl(root, 'PL5')).map((f) => f.subject.slug), ['clue-7']);
});

test('PL6: a clue revealed before its first planted scene is a warning with the clue and both scenes as sources', async () => {
  const root = four();
  clue(root, 1, { fact: 'The key opens the gate', planted: [3, 4], revealed: 2 });
  const f = await pl(root, 'PL6');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'warning');
  assert.equal(f[0].rule_version, 1);
  assert.deepEqual(f[0].subject, { kind: 'clue', id: id('note', 601), slug: 'clue-1', name: 'The key opens the gate' });
  assert.deepEqual(f[0].sources.map((s) => [s.kind, s.location]), [['clue', 'revealed'], ['clue', 'planted'], ['scene', 'title'], ['scene', 'title']]);
  assert.deepEqual(f[0].sources.slice(2).map((s) => s.id), [scene(2), scene(3)]);
  assert.match(f[0].fingerprint, FINGERPRINT_RE);
  assert.match(f[0].message, /scene 2/);
  assert.match(f[0].message, /scene 3/);
  assert.equal((await pl(root, 'PL5')).length, 0);
});

test('PL6: not reported when revealed is after or in the first planted scene, when something is planted earlier, or for an unknown scene', async () => {
  const root = four();
  clue(root, 1, { planted: [1, 3], revealed: 4 });
  clue(root, 2, { planted: [2], revealed: 2 });
  clue(root, 3, { planted: [3, 1], revealed: 2 }); // the first planted scene (by reading order) is scene 1
  clue(root, 4, { planted: [4], revealed: 3, archived: true });
  assert.equal((await pl(root, 'PL6')).length, 0);
  put(root, 'planning/clues/clue-9.md', `---\nschema: storyforge.clue/v1\nid: ${id('note', 609)}\nslug: clue-9\nfact: Ghost\nplanted: [${scene(3)}]\nrevealed: ${scene(40)}\n---\n`);
  assert.equal((await pl(root, 'PL6')).length, 0);
});

test('clue fingerprints do not change when the clue text or scene titles change; PL6 changes with the scenes', async () => {
  const root = four();
  clue(root, 1, { planted: [3], revealed: 2 });
  clue(root, 2, { planted: [1] });
  const before = (await allPl(root)).map((f) => f.fingerprint).sort();
  assert.equal(before.filter((fp) => fp.startsWith('pl5-') || fp.startsWith('pl6-')).length, 2);
  put(root, 'planning/clues/clue-1.md', read(root, 'planning/clues/clue-1.md').replace('fact: Fact 1', 'fact: Reworded'));
  put(root, sceneFile(2), read(root, sceneFile(2)).replace('title: Scene 2', 'title: A new name'));
  assert.deepEqual((await allPl(root)).map((f) => f.fingerprint).sort(), before);
  const pl6 = (await pl(root, 'PL6'))[0].fingerprint;
  put(root, 'planning/clues/clue-1.md', read(root, 'planning/clues/clue-1.md').replace(`planted: [${scene(3)}]`, `planted: [${scene(4)}]`));
  const moved = await pl(root, 'PL6');
  assert.equal(moved.length, 1);
  assert.notEqual(moved[0].fingerprint, pl6, 'another planted scene is another finding');
});
