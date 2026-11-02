// M03-J04 section 1: `daily_word_goal` on book.md and the activity/writing-log.md document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../src/index.mjs';
import { VALID } from './helpers.mjs';

function copySaltOrchard() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-fmt-j04-'));
  const dest = path.join(base, 'salt-orchard');
  fs.cpSync(path.join(VALID, 'salt-orchard'), dest, { recursive: true });
  return dest;
}

function setGoal(root, line) {
  const file = path.join(root, 'book.md');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace('language: en\n', `language: en\n${line}\n`));
}

const keys = (r) => r.diagnostics.map((d) => `${d.code} | ${d.file} | ${d.location}`).sort();

test('baseline: the salt-orchard copy has no diagnostics added by these tests', async () => {
  const root = copySaltOrchard();
  const base = keys(await validate(root));
  setGoal(root, 'daily_word_goal: 500');
  assert.deepEqual(keys(await validate(root)), base);
});

for (const good of [1, 500, 100000]) {
  test(`daily_word_goal: ${good} is accepted`, async () => {
    const root = copySaltOrchard();
    const base = keys(await validate(root));
    setGoal(root, `daily_word_goal: ${good}`);
    assert.deepEqual(keys(await validate(root)), base);
  });
}

for (const bad of ['0', '-5', '1.5', '"500"', 'many', 'true', '[500]', '""']) {
  test(`daily_word_goal: ${bad} is E102 on book.md daily_word_goal`, async () => {
    const root = copySaltOrchard();
    setGoal(root, `daily_word_goal: ${bad}`);
    const r = await validate(root);
    const hits = r.diagnostics.filter((d) => d.code === 'E102' && d.file === 'book.md' && d.location === 'daily_word_goal');
    assert.equal(hits.length, 1, JSON.stringify(r.diagnostics));
    assert.equal(hits[0].severity, 'error');
  });
}

const LOG = `---
schema: storyforge.doc/v1
id: note_01S50000000000000000000ZZ1
title: Writing log
---
| Date | Words added | Words removed | Minutes | Sessions |
|---|---|---|---|---|
| 2026-10-30 | 400 | 20 | 45 | 2 |
| 2026-11-01 | 642 | 87 | 95 | 3 |
`;

test('activity/writing-log.md validates with no new diagnostics (not flagged by folder rules)', async () => {
  const root = copySaltOrchard();
  const base = keys(await validate(root));
  fs.mkdirSync(path.join(root, 'activity'));
  fs.writeFileSync(path.join(root, 'activity', 'writing-log.md'), LOG);
  assert.deepEqual(keys(await validate(root)), base);
});

test('writing log with a hand-edited unparseable row still validates clean', async () => {
  const root = copySaltOrchard();
  const base = keys(await validate(root));
  fs.mkdirSync(path.join(root, 'activity'));
  fs.writeFileSync(path.join(root, 'activity', 'writing-log.md'), LOG + '| yesterday-ish | lots | few | ? | ? |\n');
  assert.deepEqual(keys(await validate(root)), base);
});
