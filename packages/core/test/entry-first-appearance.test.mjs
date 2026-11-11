// setEntryFields `firstAppearance`: set (line absent), replace, clear, a live-scene check (unknown and archived scenes refused), a stale base_sha256 is a CONFLICT.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const LIVE = 'scene_01S50000000000000000000001';
const LIVE2 = 'scene_01S50000000000000000000004';
const ARCHIVED = 'scene_01S50000000000000000000007';
const MAREN = 'codex/characters/maren-hollis.md'; // has first_appearance
const PELL = 'codex/characters/pell.md'; // has none

const repos = [];
after(async () => {
  for (const r of repos) await r.close();
});
async function setup() {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root, { watch: false, pollMs: 0 });
  repos.push(repo);
  return { root, repo };
}
const text = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
const errors = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

test('firstAppearance: inserts the line when the entry has none, touching only that file and adding nothing else', async () => {
  const { root, repo } = await setup();
  const before = await text(root, PELL);
  const r = await repo.setEntryFields(BOOK, 'pell', { firstAppearance: LIVE });
  assert.equal(r.ok, true, JSON.stringify(r));
  const after1 = await text(root, PELL);
  assert.match(after1, new RegExp(`^first_appearance: ${LIVE}$`, 'm'));
  assert.equal(after1.replace(new RegExp(`first_appearance: ${LIVE}\r?\n`), ''), before, 'only the one line was added');
  assert.deepEqual(await errors(root), []);
});

test('firstAppearance: replaces an existing line; a dry run writes nothing', async () => {
  const { root, repo } = await setup();
  const before = await snapshot(root, { skipStoryforge: true });
  const dry = await repo.setEntryFields(BOOK, 'maren-hollis', { firstAppearance: LIVE2, dryRun: true });
  assert.equal(dry.ok, true);
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
  const r = await repo.setEntryFields(BOOK, 'maren-hollis', { firstAppearance: LIVE2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = await text(root, MAREN);
  assert.equal(t.match(/^first_appearance:.*$/gm).length, 1);
  assert.match(t, new RegExp(`^first_appearance: ${LIVE2}$`, 'm'));
  assert.match(t, /^role: Protagonist$/m);
  assert.deepEqual(await errors(root), []);
});

test('firstAppearance: null or an empty string removes the line (and nothing else); clearing an absent line changes nothing', async () => {
  const { root, repo } = await setup();
  const before = await text(root, MAREN);
  const r = await repo.setEntryFields(BOOK, 'maren-hollis', { firstAppearance: null });
  assert.equal(r.ok, true, JSON.stringify(r));
  const t = await text(root, MAREN);
  assert.doesNotMatch(t, /first_appearance/);
  assert.equal(t, before.replace(/first_appearance: [^\r\n]*\r?\n/, ''), 'only that line is gone, no blank line left');
  assert.deepEqual(await errors(root), []);
  const snap = await snapshot(root, { skipStoryforge: true });
  assert.equal((await repo.setEntryFields(BOOK, 'maren-hollis', { firstAppearance: '' })).ok, true);
  assert.equal((await repo.setEntryFields(BOOK, 'pell', { firstAppearance: null })).ok, true);
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), snap);
});

test('firstAppearance: an unknown scene, an archived scene and a malformed id are refused and nothing is written', async () => {
  const { root, repo } = await setup();
  const before = await snapshot(root, { skipStoryforge: true });
  for (const [value, code] of [[ARCHIVED, 'REFUSED_UNKNOWN_SCENE'], ['scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', 'REFUSED_UNKNOWN_SCENE'], ['scene_nope', 'REFUSED_BAD_ARGS'], [42, 'REFUSED_BAD_ARGS']]) {
    const r = await repo.setEntryFields(BOOK, 'pell', { firstAppearance: value });
    assert.equal(r.ok, false, String(value));
    assert.equal(r.code, code, String(value));
  }
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

test('firstAppearance: a stale base_sha256 is a CONFLICT; the right one succeeds', async () => {
  const { root, repo } = await setup();
  const before = await snapshot(root, { skipStoryforge: true });
  const stale = await repo.setEntryFields(BOOK, 'pell', { firstAppearance: LIVE, baseSha256: '0'.repeat(64) });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'CONFLICT');
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
  const ok = await repo.setEntryFields(BOOK, 'pell', { firstAppearance: LIVE, baseSha256: sha(await fs.readFile(path.join(root, ...PELL.split('/')))) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});
