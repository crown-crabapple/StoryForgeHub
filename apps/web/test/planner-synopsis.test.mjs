// The Synopsis view of the Plan tab (Story Planner M7): the pure helpers, the hunk review and the request builders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SYNOPSIS_TYPES,
  applyHunks,
  archiveSynopsisRequest,
  createSynopsisRequest,
  defaultInstruction,
  extractUrl,
  isSynopsisConflict,
  proposalHunks,
  restoreSynopsisRequest,
  skippedText,
  synopsesUrl,
  synopsisUrl,
  targetText,
  targetValue,
  typeLabel,
  updateSynopsisBody,
  wordCount,
} from '../src/planner/synopsis.js';
import { parsePlanSearch, planUrl } from '../src/planner/model.js';
import { planHref } from '../src/planner/requests.js';

const all = (segments) => new Set(segments.filter((s) => s.kind === 'hunk').map((s) => s.id));

test('types: eight, in order, with labels', () => {
  assert.deepEqual(SYNOPSIS_TYPES.map((t) => t.type), ['premise', 'logline', 'elevator-pitch', 'short', 'one-page', 'long', 'chapter-treatment', 'custom']);
  assert.equal(typeLabel('one-page'), 'One-page synopsis');
  assert.equal(typeLabel('elevator-pitch'), 'Elevator pitch');
  assert.equal(typeLabel('weird'), 'weird');
});

test('wordCount and targetText', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('  one two\nthree  '), 3);
  assert.equal(targetText(412, 500), '412 of 500 words');
  assert.equal(targetText(412, null), '412 words');
  assert.equal(targetText(1, null), '1 word');
  assert.equal(targetText(0, undefined), '0 words');
  assert.equal(targetValue(' 500 '), 500);
  assert.equal(targetValue('0'), null);
  assert.equal(targetValue('1.5'), null);
  assert.equal(targetValue(''), null);
  assert.equal(skippedText(0), null);
  assert.equal(skippedText(1), '1 scene has no summary');
  assert.equal(skippedText(3), '3 scenes have no summary');
});

test('hunks: changed runs group into hunks, equal lines stay as context', () => {
  const { segments } = proposalHunks('a\nb\nc\nd\ne\n', 'a\nB\nC\nd\ne\nf\n');
  assert.deepEqual(segments, [
    { kind: 'same', lines: ['a'] },
    { kind: 'hunk', id: 'h1', before: ['b', 'c'], after: ['B', 'C'] },
    { kind: 'same', lines: ['d', 'e'] },
    { kind: 'hunk', id: 'h2', before: [], after: ['f'] },
  ]);
});

test('applyHunks: accept all is the proposal, accept none is the current text', () => {
  const pairs = [
    ['a\nb\nc\nd\ne\n', 'a\nB\nC\nd\ne\nf\n'],
    ['a\nb\nc', 'a\nx\nc\ny'],
    ['one\ntwo\n', ''],
    ['', 'new\ntext\n'],
    ['same\n', 'same\n'],
  ];
  for (const [cur, prop] of pairs) {
    const { segments } = proposalHunks(cur, prop);
    assert.equal(applyHunks(segments, new Set()), cur, `none: ${JSON.stringify(cur)}`);
    if (cur !== prop) assert.equal(applyHunks(segments, all(segments)), prop, `all: ${JSON.stringify(prop)}`);
  }
});

test('applyHunks: a partial mix takes the accepted hunks only', () => {
  const { segments } = proposalHunks('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\nE\n');
  assert.equal(applyHunks(segments, new Set(['h1'])), 'a\nB\nc\nd\ne\n');
  assert.equal(applyHunks(segments, new Set(['h2'])), 'a\nb\nc\nd\nE\n');
  assert.equal(applyHunks(segments, new Set(['h1', 'h2'])), 'a\nB\nc\nd\nE\n');
  assert.equal(applyHunks(segments, new Set(['nope'])), 'a\nb\nc\nd\ne\n');
});

test('applyHunks: the final newline follows the current text, or the proposal when all is accepted', () => {
  const noNl = proposalHunks('a\nb', 'a\nB\n').segments;
  assert.equal(applyHunks(noNl, new Set()), 'a\nb');
  assert.equal(applyHunks(noNl, new Set(['h1'])), 'a\nB\n');
  const nl = proposalHunks('a\nb\n', 'a\nB').segments;
  assert.equal(applyHunks(nl, new Set()), 'a\nb\n');
  assert.equal(applyHunks(nl, new Set(['h1'])), 'a\nB');
});

test('request builders', () => {
  assert.equal(synopsesUrl('b 1'), '/api/books/b%201/synopses');
  assert.equal(synopsisUrl('b', 'my-short'), '/api/books/b/synopses/my-short');
  assert.equal(synopsisUrl('b', 'x', '/archive'), '/api/books/b/synopses/x/archive');
  assert.equal(extractUrl('b', 'x'), '/api/books/b/synopses/x/extract');
  assert.deepEqual(createSynopsisRequest('b', { type: 'short' }), { url: '/api/books/b/synopses', body: { type: 'short' } });
  assert.deepEqual(createSynopsisRequest('b', { type: 'long', name: ' My long ', target_words: 800, dryRun: true }).body, { type: 'long', name: 'My long', target_words: 800, dryRun: true });
  assert.deepEqual(updateSynopsisBody({ sha256: 'abc' }, { body: 'x' }), { body: 'x', base_sha256: 'abc' });
  assert.deepEqual(updateSynopsisBody({ sha256: 'abc' }, { basis: 'h' }), { basis: 'h', base_sha256: 'abc' });
  assert.deepEqual(updateSynopsisBody({ sha256: 'abc' }, { name: ' N ', target_words: null, basis: null, dryRun: true }), { name: 'N', target_words: null, basis: null, base_sha256: 'abc', dryRun: true });
  assert.deepEqual(archiveSynopsisRequest('b', 'x'), { url: '/api/books/b/synopses/x/archive', body: {} });
  assert.deepEqual(restoreSynopsisRequest('b', 'x', { dryRun: true }), { url: '/api/books/b/synopses/x/restore', body: { dryRun: true } });
  assert.equal(isSynopsisConflict(409, { error: 'conflict', code: 'CONFLICT' }), true);
  assert.equal(isSynopsisConflict(400, { code: 'CONFLICT' }), false);
  assert.match(defaultInstruction('one-page', 500), /^Rewrite this one-page synopsis so it reads well\. Keep every plot fact\. Aim for about 500 words\.$/);
  assert.doesNotMatch(defaultInstruction('premise', null), /Aim for/);
});

test('plan URL: the synopsis view and slug round-trip', () => {
  assert.equal(parsePlanSearch('?view=synopsis').view, 'synopsis');
  assert.equal(planHref('b', { view: 'synopsis', synopsis: 'my-short' }), '/books/b/plan?view=synopsis&synopsis=my-short');
  const href = planUrl('b', parsePlanSearch(''), { view: 'synopsis' });
  assert.equal(href, '/books/b/plan?view=synopsis');
});
