// M07-J02 acceptance 1 on the M06-J03 large synthetic book (3 acts, 60 chapters, 320 scenes, ~130 000 words, 220 entries) plus the tidewater fixture:
// GET /insights is byte-identical when every .storyforge/ is deleted and the index rebuilt, and identical when computed without an index.
// Heavy run: `npm run test:large`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copyFixture } from './helpers.mjs';
import { copyLarge, largeBook } from './large-helpers.mjs';
import { insightsParity } from './insights-helpers.mjs';

const CLOCK = () => new Date(2026, 10, 4, 12, 0).getTime();

test('1. large synthetic book: insights are identical without an index, from a fresh index, after deleting .storyforge/ and rebuilding, and over HTTP', async () => {
  const stats = largeBook().stats;
  const root = await copyLarge();
  // give the numbers real work: a writing log, goals, sessions
  const w = async (rel, text) => {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  };
  const rows = Array.from({ length: 40 }, (_, i) => `| 2026-${i < 30 ? '10' : '11'}-${String(i < 30 ? i + 1 : i - 29).padStart(2, '0')} | ${300 + i * 7} | ${i} | ${30 + i} | 1 |`).join('\n');
  await w('activity/writing-log.md', `---\nschema: storyforge.doc/v1\nid: note_01J00000000000000000000002\ntitle: Writing log\n---\n\n| Date | Words added | Words removed | Minutes | Sessions |\n|---|---|---|---|---|\n${rows}\n`);
  await w('activity/goals.md', '---\nschema: storyforge.goals/v1\nid: note_01J00000000000000000000001\ngoals:\n  - { id: g1, kind: words, target: 500, period: day }\n  - { id: g2, kind: words, target: 200000, period: total, due: 2027-03-01 }\n---\n');
  const out = await insightsParity(root, CLOCK);
  assert.equal(out.size, 1);
  const i = JSON.parse([...out.values()][0]);
  assert.equal(i.book.scenes, stats.scenes);
  assert.ok(i.book.words > 100_000);
  assert.equal(i.manuscript.chapters.length, stats.chapters);
  assert.equal(i.story.threads.rows.length, stats.threads);
  assert.equal(i.story.events.total, stats.events);
  assert.ok(i.story.characters.rows.length > 0, 'the heat map has characters');
});

test('1. tidewater (with the large book running in the same process): same check', async () => {
  const root = await copyFixture('valid/tidewater');
  assert.equal((await insightsParity(root, CLOCK)).size, 3);
});
