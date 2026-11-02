import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANTED, SALT_ARRIVAL, SALT_ARRIVAL_ID, SALT_LOWTIDE_ID, copyFixture, openFor, plain, plantSearchWords,
} from './helpers.mjs';

let idx;
const search = async (q, opts) => plain(await idx.query.search(q, opts));
const ids = (rows) => rows.map((r) => r.id);

before(async () => {
  const root = await copyFixture('valid/salt-orchard');
  await plantSearchWords(root);
  ({ idx } = await openFor(root));
  const r = await idx.rebuild();
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('"isle" finds the scene containing the accented word', async () => {
  for (const q of ['isle', 'ISLE', PLANTED.accented]) {
    const rows = await search(q);
    assert.ok(ids(rows).includes(SALT_ARRIVAL_ID), `query ${q} finds the arrival scene`);
    const hit = rows.find((r) => r.id === SALT_ARRIVAL_ID);
    assert.equal(hit.kind, 'scene');
    assert.equal(hit.path, SALT_ARRIVAL);
    assert.equal(typeof hit.title, 'string');
    assert.equal(typeof hit.snippet, 'string');
  }
});

test('diacritics fold both ways: "cafe" and "café" find the same scene', async () => {
  assert.ok(ids(await search('cafe')).includes(SALT_LOWTIDE_ID));
  assert.ok(ids(await search('café')).includes(SALT_LOWTIDE_ID));
});

test('prefix matching finds a longer word', async () => {
  assert.ok((await search('graft')).length > 0);
});

test('a word that appears only inside an HTML comment is not found', async () => {
  assert.deepEqual(await search(PLANTED.commentOnly), []);
  assert.deepEqual(await search('opaque'), [], 'fixture comment text is not indexed either');
});

test('a word that appears only inside a fenced code block is not found', async () => {
  assert.deepEqual(await search(PLANTED.codeOnly), []);
});

test('a Japanese phrase is found', async () => {
  const rows = await search(PLANTED.japanese);
  assert.ok(ids(rows).includes(SALT_ARRIVAL_ID));
});

test('a query with no match returns an empty array', async () => {
  assert.deepEqual(await search('zzzzunmatchable'), []);
});

test('FTS syntax in user text never throws and is treated as plain text', async () => {
  const nasty = [
    '"a" OR b*',
    'NEAR(',
    'NEAR(a b, 2)',
    'title:isle',
    'body: key',
    ':',
    '"',
    '""',
    "'",
    'a AND',
    '(((',
    '*',
    'a*b',
    '-isle',
    'isle ^',
    '{title}: key',
    '\\',
    '; DROP TABLE fts; --',
  ];
  for (const q of nasty) {
    const rows = await search(q);
    assert.ok(Array.isArray(rows), `query ${JSON.stringify(q)} returns an array`);
    for (const r of rows) assert.equal(typeof r.id, 'string');
  }
  // An operator must not be interpreted: this would find the isle scene if OR were live.
  assert.deepEqual(await search('isle OR zzzzunmatchable'), []);
  assert.deepEqual(await search('"isle" OR zzzzunmatchable*'), []);
  // The index still works afterwards.
  assert.ok(ids(await search('isle')).includes(SALT_ARRIVAL_ID));
});

test('empty and whitespace queries do not throw', async () => {
  for (const q of ['', '   ', '\n\t']) {
    const rows = await search(q);
    assert.ok(Array.isArray(rows));
  }
});

test('kinds and limit options narrow the results', async () => {
  const all = await search('grafting');
  assert.ok(all.length >= 2, 'fixture has several matches for grafting');
  const entries = await search('grafting', { kinds: ['entry'] });
  assert.ok(entries.every((r) => r.kind === 'entry'));
  const scenes = await search('grafting', { kinds: ['scene'] });
  assert.ok(scenes.length > 0 && scenes.every((r) => r.kind === 'scene'));
  const one = await search('grafting', { limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].id, all[0].id, 'limit keeps the best-ranked result');
});
