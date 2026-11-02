// M05-J05 acceptance 5.2 (no canonical change) and 5.3 (write boundary).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFixture, makeFramework, run, snapshot, diffSnapshots, pythonAvailable } from './helpers.mjs';

const HAVE_PYTHON = pythonAvailable();

function runAll(book, fw, workId) {
  const results = [
    ['context', run('context', { book, fw, chapter: 2, workId })],
    ['review-request', run('review-request', { book, fw, chapter: 2, workId })],
  ];
  if (HAVE_PYTHON) results.push(['style', run('style', { book, fw, chapter: 1, workId })]);
  return results;
}

const allowed = (workId) => (rel) =>
  rel === '.work' || rel === `.work/${workId}` || rel.startsWith(`.work/${workId}/`) ||
  /^\.work\/chapter-\d\d-tech-report-[0-9a-f]{8}\.md$/.test(rel);

for (const name of ['salt-orchard', 'continuity-cases']) {
  test(`${name}: context, style and review-request leave the book tree untouched`, (t) => {
    const book = copyFixture(name);
    const fw = makeFramework();
    const before = snapshot(book);
    for (const [cmd, r] of runAll(book, fw)) {
      assert.equal(r.status, 0, `${cmd}: ${r.stderr}${r.stdout}`);
    }
    if (!HAVE_PYTHON) t.diagnostic('python missing: style not run');
    const d = diffSnapshots(before, snapshot(book));
    assert.deepEqual(d, { added: [], removed: [], changed: [] });
  });
}

test('no .storyforge directory is created in a book that has none', () => {
  const book = copyFixture('continuity-cases');
  const fw = makeFramework();
  assert.ok(![...snapshot(book).keys()].some((k) => k.startsWith('.storyforge')));
  const r = run('context', { book, fw, chapter: 2 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(![...snapshot(book).keys()].some((k) => k.startsWith('.storyforge')));
});

test('write boundary: only .work/<work-id>/** and the checker report appear in the framework', (t) => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  const before = snapshot(fw);
  for (const [cmd, r] of runAll(book, fw)) assert.equal(r.status, 0, `${cmd}: ${r.stderr}${r.stdout}`);
  if (!HAVE_PYTHON) t.diagnostic('python missing: style not run');
  const d = diffSnapshots(before, snapshot(fw));
  const ok = allowed('salt-orchard');
  assert.deepEqual(d.removed, [], 'nothing may be deleted');
  assert.deepEqual(d.changed, [], 'no pre-existing framework file may change');
  assert.deepEqual(d.added.filter((p) => !ok(p)), [], 'files written outside the work dir');
  assert.ok(d.added.some((p) => p.startsWith('.work/salt-orchard/context/')));
});

test('--work-id redirects every write to .work/<work-id>/', (t) => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  const before = snapshot(fw);
  for (const [cmd, r] of runAll(book, fw, 'my-draft')) assert.equal(r.status, 0, `${cmd}: ${r.stderr}${r.stdout}`);
  if (!HAVE_PYTHON) t.diagnostic('python missing: style not run');
  const d = diffSnapshots(before, snapshot(fw));
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added.filter((p) => !allowed('my-draft')(p)), []);
  assert.ok(!d.added.some((p) => p.startsWith('.work/salt-orchard')), 'default work id must not be used');
  assert.ok(d.added.includes('.work/my-draft/adapter-manifest.json'));
});

test('the work dir is created when missing and a sibling work dir is left alone', () => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  const before = snapshot(fw);
  const r = run('context', { book, fw, chapter: 2 });
  assert.equal(r.status, 0, r.stderr);
  const after = snapshot(fw);
  assert.deepEqual(after.get('.work/other-book/keep.md'), before.get('.work/other-book/keep.md'));
  assert.ok(after.has('.work/salt-orchard/context'));
});
