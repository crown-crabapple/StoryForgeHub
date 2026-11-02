import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { VALID, walkFiles, readExpected, keysOf } from './helpers.mjs';

const ROOT = path.join(VALID, 'codex-graph');

/** Flat `key: value` front matter lines (top level only), enough to inventory the fixture. */
function top(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const fm = text.split('\n---\n')[0];
  const out = {};
  for (const line of fm.split('\n')) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return { fm: out, text };
}
const entries = () => walkFiles(ROOT).filter((f) => /^codex\/(?!_types\/).+\.md$/.test(f));

test('codex-graph: all five built-in types and both custom types are present', () => {
  const types = new Set(entries().map((f) => top(f).fm.type));
  assert.deepEqual([...types].sort(), ['character', 'faction', 'location', 'lore', 'object', 'ship', 'spell']);
});

test('codex-graph: ship has a _types file, spell does not', () => {
  const typeFiles = walkFiles(ROOT).filter((f) => f.startsWith('codex/_types/'));
  assert.deepEqual(typeFiles, ['codex/_types/ship.md']);
  assert.equal(top('codex/_types/ship.md').fm.type, 'ship');
  assert.ok(fs.existsSync(path.join(ROOT, 'codex/spells/tide-call.md')));
});

test('codex-graph: relations exist in both directions and none is a self-relation', () => {
  const rel = {};
  for (const f of entries()) {
    const { fm, text } = top(f);
    for (const m of text.matchAll(/^ {2}- to: (\S+)$/gm)) (rel[fm.slug] ??= []).push(m[1]);
  }
  assert.ok(rel['maren-hollis'].includes('tobin-reyes'));
  assert.ok(rel['tobin-reyes'].includes('maren-hollis'));
  assert.ok(rel['harbour-board'].includes('the-gull'), 'one-way relation');
  assert.ok(!(rel['the-gull'] ?? []).includes('harbour-board'), 'one-way relation stays one-way');
  for (const [slug, tos] of Object.entries(rel)) assert.ok(!tos.includes(slug), `${slug} relates to itself`);
});

test('codex-graph: scenes use front-matter references, [[links]] and plain-name mentions', () => {
  const landfall = top('manuscript/act-01-one/ch-001-one/0010-landfall.md');
  assert.match(landfall.text, /^pov: maren-hollis$/m);
  assert.match(landfall.text, /\[\[tobin-reyes\|the ferryman\]\]/);
  assert.match(landfall.text, /\bTobin did not speak/, 'link and plain mention of the same entry');
  const night = top('manuscript/act-01-one/ch-001-one/0020-night-lines.md');
  assert.doesNotMatch(night.text, /\[\[/, 'mention-only scene has no body links');
  assert.match(night.text, /Maren checked the lines twice\. Maren found/);
});

test('codex-graph: diagnostics are exactly the shared-alias W304 on both entries', async () => {
  const expected = readExpected(ROOT);
  assert.deepEqual(
    expected.diagnostics.map((d) => `${d.code} ${d.file} ${d.location}`),
    ['W304 codex/characters/maren-hollis.md aliases[1]', 'W304 codex/characters/tobin-reyes.md aliases[1]'],
  );
  const result = await validate(ROOT);
  assert.deepEqual(keysOf(result.diagnostics), keysOf(expected.diagnostics));
  assert.deepEqual(result.books[0].order.map((s) => s.id), expected.order);
});
