// The real Harper LocalLinter in Node (M13-J02 §8). The WASM is read from node_modules and handed over as a data: URL, because the
// default file:// loader breaks on Windows drive letters. Allowed to take a few seconds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBinaryModuleFromUrl, Dialect, LocalLinter } from 'harper.js';
import { findingMatches, findingProblems } from '../src/findings/findings.js';
import { projectProse } from '../src/findings/prose-map.js';
import { toFindings } from '../src/grammar/harper-adapter.js';

const SCENE = 'scene_01HZX0000000000000000000AA';
const SHA = 'b'.repeat(64);
const KINDS = ['Replace', 'Remove', 'InsertAfter'];

let linter;

before(async () => {
  const wasm = fileURLToPath(new URL('../../../node_modules/harper.js/dist/harper_wasm_slim_bg.wasm', import.meta.url));
  const binary = createBinaryModuleFromUrl(`data:application/wasm;base64,${readFileSync(wasm).toString('base64')}`, 'slim');
  linter = new LocalLinter({ binary, dialect: Dialect.American });
  await linter.setup();
});

after(async () => {
  if (linter) await linter.dispose();
});

/** What the worker does: project, lint the projection as plaintext, extract plain data, free, convert. */
async function check(body) {
  const projection = projectProse(body);
  const organized = {};
  for (const [rule, lints] of Object.entries(await linter.organizedLints(projection.text, { language: 'plaintext' }))) {
    organized[rule] = lints.map((lint) => {
      const suggestions = lint.suggestions().map((s) => {
        const out = { kind: KINDS[s.kind()], text: s.get_replacement_text() };
        s.free();
        return out;
      });
      const span = lint.span();
      const out = { start: span.start, end: span.end, kind: lint.lint_kind(), message: lint.message(), problem: lint.get_problem_text(), suggestions };
      lint.free();
      return out;
    });
  }
  return toFindings({ sceneId: SCENE, body, projection, sha256: SHA, organized });
}

const apply = (body, f, i = 0) => body.slice(0, f.range.from) + f.replacements[i] + body.slice(f.range.to);

function assertFinding(body, f, word) {
  assert.deepEqual(findingProblems(f), []);
  assert.ok(findingMatches(f, body));
  assert.equal(body.slice(f.range.from, f.range.to), word);
}

test('"an test" is flagged at exactly "an" with replacement "a"', async () => {
  const body = 'She bought an test kit.';
  const found = await check(body);
  const f = found.find((x) => x.original === 'an');
  assert.ok(f, JSON.stringify(found.map((x) => [x.ruleId, x.original])));
  assertFinding(body, f, 'an');
  assert.equal(f.range.from, body.indexOf('an test'));
  assert.ok(f.replacements.includes('a'));
  assert.equal(f.engine, 'harper');
  assert.equal(apply(body, f, f.replacements.indexOf('a')), 'She bought a test kit.');
});

test('a misspelling after an emoji, smart quotes and an accented name is placed exactly', async () => {
  const body = '\u{1F600} “Zoë,” she said, “we recieve the letter tomorrow.”';
  const found = await check(body);
  const f = found.find((x) => x.original === 'recieve');
  assert.ok(f, JSON.stringify(found.map((x) => [x.ruleId, x.original])));
  assertFinding(body, f, 'recieve');
  assert.equal(f.category, 'spelling');
  assert.ok(f.replacements.includes('receive'));
  assert.equal(apply(body, f, f.replacements.indexOf('receive')), body.replace('recieve', 'receive'));
});

test('a misspelling in a CRLF-origin scene (LF view) after an emoji is placed exactly', async () => {
  const raw = 'First line \u{1F600}.\r\nSecond line has a mispelled word.\r\n';
  const body = raw.replace(/\r\n/g, '\n');
  const found = await check(body);
  const f = found.find((x) => x.original === 'mispelled');
  assert.ok(f);
  assertFinding(body, f, 'mispelled');
});

test('a misspelling inside emphasis and a link label is placed on the word', async () => {
  const body = 'She was *tereble* at it and [a lable](https://example.org/x) too.';
  const found = await check(body);
  for (const word of ['tereble', 'lable']) {
    const f = found.find((x) => x.original === word);
    assert.ok(f, word);
    assertFinding(body, f, word);
    assert.equal(f.range.from, body.indexOf(word));
  }
});

test('no finding ever covers left-out text, so applying one cannot delete code, a note or a link destination', async () => {
  const body = 'Then `x` was typed. She saw <!-- note: hi --> a  dog and [the](https://example.org) the end.';
  const found = await check(body);
  for (const f of found) {
    assertFinding(body, f, f.original);
    for (const hidden of ['`', '<!--', '-->', '](', 'https']) assert.ok(!f.original.includes(hidden), `${f.ruleId} covers "${f.original}"`);
  }
});

test('text next to a removed Codex link is never flagged: no finding touches the space before it or the link itself', async () => {
  const body = 'Past the dunes lay [[salt-orchard]], half under water.';
  const found = await check(body);
  const from = body.indexOf('[[');
  const to = body.indexOf(']]') + 2;
  for (const f of found) {
    assertFinding(body, f, f.original);
    assert.ok(f.original !== '' && f.original !== ' ', `${f.ruleId} covers "${f.original}"`);
    assert.ok(f.range.to <= from || f.range.from >= to, `${f.ruleId} overlaps the link`);
    assert.ok(f.range.to !== from, `${f.ruleId} ends at the link`);
  }
});

test('a misspelling inside an HTML note or a code block gives nothing', async () => {
  const body = [
    'The door opened.',
    '',
    '<!-- note: fix the speling here -->',
    '',
    '```',
    'a codeblok with mispeled words',
    '```',
    '',
    'Then (`inlinecodd`) was typed.',
    '',
  ].join('\n');
  const found = await check(body);
  assert.deepEqual(found.map((f) => f.original), []);
});

test('the book dictionary and rule switches take effect', async () => {
  const body = 'Zarnak walked home.';
  assert.ok((await check(body)).some((f) => f.original === 'Zarnak'));
  await linter.importWords(['Zarnak']);
  assert.ok(!(await check(body)).some((f) => f.original === 'Zarnak'));
  await linter.clearWords();
  assert.ok((await check(body)).some((f) => f.original === 'Zarnak'));
});

test('English detection answers for clearly English and clearly French text', async () => {
  assert.equal(await linter.isLikelyEnglish('The quick brown fox jumps over the lazy dog while the rain falls on the quiet town.'), true);
  assert.equal(await linter.isLikelyEnglish('Le renard brun rapide saute par-dessus le chien paresseux pendant que la pluie tombe sur la petite ville tranquille.'), false);
});
