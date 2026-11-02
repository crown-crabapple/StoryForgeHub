// M05-J05 acceptance 5.4: the style command runs the (stand-in) checker and copies its report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  copyFixture, makeFramework, run, read, put, exists, pythonAvailable, snapshot,
} from './helpers.mjs';

// Reported as skipped (with this reason), never as passed, when Python is absent.
const skip = pythonAvailable() ? false : 'python is not available on PATH';
const WORK = '.work/salt-orchard';

const originals = (fw, nn) =>
  fs.readdirSync(path.join(fw, '.work')).filter((f) => new RegExp(`^chapter-${nn}-tech-report-[0-9a-f]{8}\\.md$`).test(f));

test('style --chapter 1 copies the checker report with its Verdict and leaves the original', { skip }, () => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  const r = run('style', { book, fw, chapter: 1 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /PASS/);
  const copy = read(fw, `${WORK}/reports/chapter-01-style-tech-report.md`);
  assert.match(copy, /^## Verdict/m);
  const orig = originals(fw, '01');
  assert.equal(orig.length, 1, 'the checker output must stay in .work/');
  assert.equal(fs.readFileSync(path.join(fw, '.work', orig[0]), 'utf8'), copy);
});

test('style writes the candidate under a name carrying the chapter number', { skip }, () => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  assert.equal(run('style', { book, fw, chapter: 1 }).status, 0);
  const cand = read(fw, `${WORK}/candidate/chapter-01-candidate.md`);
  assert.ok(cand.includes('The ferry nudged the jetty'));
  assert.ok(!cand.includes('<!--'));
});

test('the checker runs with cwd = its own folder and default word limits 1..100000', { skip }, () => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  assert.equal(run('style', { book, fw, chapter: 1 }).status, 0);
  const rep = read(fw, `${WORK}/reports/chapter-01-style-tech-report.md`);
  assert.match(rep, /min_words=1 max_words=100000/);
  const cwd = /- cwd: (.+)/.exec(rep)[1].trim();
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(path.join(fw, 'scripts', 'style')));
});

test('x-claude-book min/max words from book.md reach the checker and a FAIL verdict is reported', { skip }, () => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  const original = read(book, 'book.md');
  const edited = original.replace('language: en\n', 'language: en\nx-claude-book: { min_words: 3, max_words: 5 }\n');
  assert.notEqual(edited, original);
  put(book, 'book.md', edited);
  const r = run('style', { book, fw, chapter: 1 });
  assert.match(r.stdout, /FAIL/);
  const rep = read(fw, `${WORK}/reports/chapter-01-style-tech-report.md`);
  assert.match(rep, /min_words=3 max_words=5/);
  assert.match(rep, /^## Verdict\s+FAIL/m);
});

test('--python selects the interpreter', { skip }, () => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  const r = run('style', { book, fw, chapter: 1, extra: ['--python', 'python'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(exists(fw, `${WORK}/reports/chapter-01-style-tech-report.md`));
});

test('a stale report from before the run is not picked up', { skip }, () => {
  const book = copyFixture('salt-orchard');
  const fw = makeFramework();
  put(fw, '.work/chapter-01-tech-report-deadbeef.md', '# stale\n\n## Verdict\n\nFAIL-STALE\n');
  const before = snapshot(fw);
  const r = run('style', { book, fw, chapter: 1 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!read(fw, `${WORK}/reports/chapter-01-style-tech-report.md`).includes('FAIL-STALE'),
    'only a report created after the run started may be copied');
  assert.deepEqual(
    snapshot(fw).get('.work/chapter-01-tech-report-deadbeef.md'),
    before.get('.work/chapter-01-tech-report-deadbeef.md'),
  );
});
