// M05-J06 acceptance 1 (adapter half) and 6: the adapter modes check, plan, co-write and suggest, and each command's write boundary.
// Method: tree snapshots (bytes, mtimes, file list) of the book and of the framework before and after each command.
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 1, 3 and 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validate } from '../../format/src/index.mjs';
import { abs, pythonAvailable, read } from './helpers.mjs';
import { ARRIVAL, ARRIVAL_EDITS, ARRIVAL_PATH, CF1, KEY, WORK, frontOf, netCalls, netEnv, replaceLines, scratch, setup, sha, suggestionsIn } from './author-helpers.mjs';

const HAVE_PYTHON = pythonAvailable();
const readReport = (fw, name) => JSON.parse(fs.readFileSync(path.join(fw, '.work/salt-orchard/reports', name), 'utf8'));
const inWork = (rel) => rel === '.work' || rel.startsWith('.work/');

// ---- check ----------------------------------------------------------------------------------------------------------------

test('check --chapter 1: reports the CF1 with file:line evidence in .md and .json; the book is untouched; nothing outside .work/<id>/ is written', () => {
  const { fw, go } = setup();
  const { status, bookD, fwD, r } = go('check', { chapter: 1, extra: ['--no-style'] });
  assert.equal(status, 0, r.stderr + r.stdout);
  assert.deepEqual(bookD, { added: [], removed: [], changed: [] }, 'the book tree is identical afterwards');
  assert.deepEqual(fwD.removed, []);
  assert.deepEqual(fwD.changed, []);
  assert.deepEqual(fwD.added.filter((p) => p !== WORK && !p.startsWith(`${WORK}/`)), [], 'only under .work/<work-id>/');

  const j = readReport(fw, 'chapter-01-check-report.json');
  const cf1 = j.findings.find((f) => f.fingerprint === CF1 || f.code === 'CF1');
  assert.ok(cf1, `CF1 in ${JSON.stringify(j.findings.map((f) => f.code))}`);
  assert.equal(cf1.file, ARRIVAL_PATH);
  assert.equal(cf1.line, 17);
  assert.ok(cf1.evidence.includes('green eyes ringed with salt'));
  assert.ok(cf1.range && cf1.range.to > cf1.range.from, 'range');
  assert.ok(cf1.message.length > 0);
  const md = read(fw, '.work/salt-orchard/reports/chapter-01-check-report.md');
  assert.match(md, /0010-arrival\.md:17/, 'file:line evidence in the Markdown report');
  assert.ok(md.includes('green eyes ringed with salt'));
  assert.ok(md.includes('CF1'));
});

test('check --no-style never runs the style checker (no tech report appears) and has no style findings', () => {
  const { fw, go } = setup();
  const { status, fwD } = go('check', { chapter: 1, extra: ['--no-style'] });
  assert.equal(status, 0);
  assert.deepEqual(fwD.added.filter((p) => /tech-report/.test(p)), []);
  assert.deepEqual(readReport(fw, 'chapter-01-check-report.json').findings.filter((f) => f.kind === 'style'), []);
});

test('check --scene <id>: reports that scene (CF1 for Arrival), leaves the book untouched', () => {
  const { fw, go } = setup();
  const { status, bookD, r } = go('check', { extra: ['--scene', ARRIVAL, '--no-style'] });
  assert.equal(status, 0, r.stderr + r.stdout);
  assert.deepEqual(bookD, { added: [], removed: [], changed: [] });
  const reports = fs.readdirSync(path.join(fw, '.work/salt-orchard/reports')).filter((f) => /check-report\.json$/.test(f));
  assert.ok(reports.length >= 1);
  const j = JSON.parse(fs.readFileSync(path.join(fw, '.work/salt-orchard/reports', reports[0]), 'utf8'));
  assert.ok(j.findings.some((f) => f.fingerprint === CF1 || f.code === 'CF1'));
});

test('check --scene on a scene without findings is clean (exit 0) and does not report Arrival CF1', () => {
  const { fw, go } = setup();
  const { status } = go('check', { extra: ['--scene', KEY, '--no-style'] });
  assert.equal(status, 0);
  const reports = fs.readdirSync(path.join(fw, '.work/salt-orchard/reports')).filter((f) => /check-report\.json$/.test(f));
  const j = JSON.parse(fs.readFileSync(path.join(fw, '.work/salt-orchard/reports', reports[0]), 'utf8'));
  assert.ok(!j.findings.some((f) => f.fingerprint === CF1));
});

test('check exits 1 when the scene has an error diagnostic, still writes the report, and still leaves the book alone', () => {
  const { book, fw, go } = setup();
  const file = abs(book, ARRIVAL_PATH);
  fs.appendFileSync(file, '\nHe met [[ghost-person]] there.\n');
  const { status, bookD } = go('check', { chapter: 1, extra: ['--no-style'] });
  assert.equal(status, 1);
  assert.deepEqual(bookD, { added: [], removed: [], changed: [] });
  const j = readReport(fw, 'chapter-01-check-report.json');
  const d = j.findings.find((f) => f.kind === 'diagnostic' && f.code === 'E301');
  assert.ok(d, 'E301 diagnostic');
  assert.equal(d.severity, 'error');
  assert.equal(d.file, ARRIVAL_PATH);
  assert.equal(d.line, 21);
  assert.ok(d.evidence.includes('ghost-person'));
});

test('check makes no network call and calls no model (network recorder preloaded into the adapter process)', () => {
  const { log, env } = netEnv();
  const { go } = setup();
  const { status, r } = go('check', { chapter: 1, extra: ['--no-style'], env });
  assert.equal(status, 0, r.stderr + r.stdout);
  assert.deepEqual(netCalls(log), []);
});

test('check with the style checker: runs it (when python exists), keeps writes under .work/, exit 0 on a passing chapter', { skip: !HAVE_PYTHON && 'python missing' }, () => {
  const { go } = setup();
  const { status, bookD, fwD, r } = go('check', { chapter: 1 });
  assert.equal(status, 0, r.stderr + r.stdout);
  assert.deepEqual(bookD, { added: [], removed: [], changed: [] });
  assert.deepEqual(fwD.changed, []);
  assert.deepEqual(fwD.added.filter((p) => !inWork(p)), []);
});

// ---- plan -----------------------------------------------------------------------------------------------------------------

test('plan --chapter 2: context pack plus a plan request naming the planner agent file; writes only under .work/<id>/; book untouched', () => {
  const { fw, go } = setup();
  const { status, bookD, fwD, r } = go('plan', { chapter: 2 });
  assert.equal(status, 0, r.stderr + r.stdout);
  assert.deepEqual(bookD, { added: [], removed: [], changed: [] });
  assert.deepEqual(fwD.removed, []);
  assert.deepEqual(fwD.changed, []);
  assert.deepEqual(fwD.added.filter((p) => p !== WORK && !p.startsWith(`${WORK}/`)), []);
  assert.ok(fwD.added.some((p) => p.startsWith(`${WORK}/context/`)), 'context pack written');
  const t = read(fw, '.work/salt-orchard/reports/chapter-02-plan-request.md');
  assert.ok(t.includes('chapter-planner'));
  assert.ok(/analysis[\\/]\.claude[\\/]agents[\\/]chapter-planner\.md/.test(t), 'planner agent file path');
  assert.match(t, /context[\\/]/);
});

// ---- co-write -------------------------------------------------------------------------------------------------------------

test('co-write copies the draft to drafts/chapter-NN-draft.md with a proposal header; writes only under .work/<id>/', () => {
  const draft = 'Maren stepped off the ferry.\n\nShe did not look back.\n';
  const from = scratch('draft.md', draft);
  const { fw, go } = setup();
  const { status, bookD, fwD, r } = go('co-write', { chapter: 1, extra: ['--from', from] });
  assert.equal(status, 0, r.stderr + r.stdout);
  assert.deepEqual(bookD, { added: [], removed: [], changed: [] });
  assert.deepEqual(fwD.changed, []);
  assert.deepEqual(fwD.removed, []);
  assert.deepEqual(fwD.added.filter((p) => p !== WORK && !p.startsWith(`${WORK}/`)), []);
  const t = read(fw, '.work/salt-orchard/drafts/chapter-01-draft.md');
  assert.ok(t.includes(draft), 'the draft text is kept whole');
  assert.match(t.slice(0, t.indexOf(draft)), /proposal/i, 'a header marks it as a proposal');
  assert.equal(fs.readFileSync(from, 'utf8'), draft, 'the source file is untouched');
});

test('co-write without --from, or with a missing file, is a usage error (exit 2) and writes nothing', () => {
  const { go } = setup();
  for (const extra of [[], ['--from', path.join(path.dirname(scratch('x.md', 'x')), 'missing.md')]]) {
    const { status, bookD, fwD } = go('co-write', { chapter: 1, extra });
    assert.equal(status, 2);
    assert.deepEqual(bookD, { added: [], removed: [], changed: [] });
    assert.deepEqual(fwD.added.filter((p) => /drafts/.test(p)), []);
  }
});

// ---- suggest --------------------------------------------------------------------------------------------------------------

const alternativeBody = (book) => {
  const original = fs.readFileSync(abs(book, ARRIVAL_PATH), 'utf8');
  const edited = replaceLines(original, ARRIVAL_EDITS);
  return { original, edited, body: edited.slice(frontOf(edited).length) };
};

for (const form of ['whole scene file', 'body only']) {
  test(`suggest (${form}): creates exactly one suggestion file, three one-line hunks at 15/17/19, scene unchanged, path printed`, async () => {
    const { book, go } = setup();
    const { original, edited, body } = alternativeBody(book);
    const from = scratch('alt.md', form === 'body only' ? body : edited);
    const { status, bookD, fwD, r } = go('suggest', { extra: ['--scene', ARRIVAL, '--from', from] });
    assert.equal(status, 0, r.stderr + r.stdout);
    assert.equal(fs.readFileSync(abs(book, ARRIVAL_PATH), 'utf8'), original, 'the scene is never written by suggest');
    const files = bookD.added.filter((p) => p.endsWith('.md'));
    assert.equal(files.length, 1, `one new file: ${bookD.added}`);
    assert.match(files[0], /^suggestions\/\d{4}\/\d{8}-\d{6}-[a-z0-9-]+\.md$/);
    assert.deepEqual(bookD.added.filter((p) => !p.endsWith('.md')).filter((p) => !/^suggestions(\/\d{4})?$/.test(p)), [], 'only suggestions/ directories besides the file');
    assert.deepEqual(bookD.changed, []);
    assert.deepEqual(bookD.removed, []);
    assert.deepEqual(fwD.changed, []);
    assert.deepEqual(fwD.removed, []);
    assert.ok(r.stdout.includes(files[0].split('/').pop()), `prints its path: ${r.stdout}`);

    const [s] = await suggestionsIn(book);
    assert.equal(s.fm.schema, 'storyforge.suggestion/v1');
    assert.equal(s.fm.source, 'claude-book');
    assert.equal(s.fm.mode, 'suggest');
    assert.equal(s.fm.target, ARRIVAL);
    assert.equal(s.fm.target_path, ARRIVAL_PATH);
    assert.equal(s.fm.base_sha256, sha(original));
    assert.equal(s.fm.status, 'pending');
    assert.deepEqual(s.fm.hunks.map((h) => [h.line, h.lines, h.status]), [[15, 1, 'pending'], [17, 1, 'pending'], [19, 1, 'pending']]);
    assert.match(s.text, /^@@ -17,1 \+17,1 @@ h2$/m);
    assert.ok(s.text.includes(`+${ARRIVAL_EDITS[17]}`), 'proposed line in the diff block');
    assert.ok(s.text.includes('-In the glass of the ticket hut she caught her own face, green eyes'), 'original line in the diff block');
    assert.deepEqual((await validate(book)).diagnostics.filter((d) => d.severity === 'error'), [], 'the suggestion document is valid');
  });
}

test('suggest: text identical to the scene is refused (NO_CHANGE), exit 1, nothing written', () => {
  const { book, go } = setup();
  const from = scratch('same.md', fs.readFileSync(abs(book, ARRIVAL_PATH), 'utf8'));
  const { status, bookD, r } = go('suggest', { extra: ['--scene', ARRIVAL, '--from', from] });
  assert.equal(status, 1, r.stderr + r.stdout);
  assert.match(r.stderr + r.stdout, /NO_CHANGE|no change|identical/i);
  assert.deepEqual(bookD, { added: [], removed: [], changed: [] });
});

test('suggest: unknown scene or missing --from fails and writes nothing', () => {
  const { book, go } = setup();
  const from = scratch('alt.md', alternativeBody(book).edited);
  for (const extra of [['--scene', 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ', '--from', from], ['--scene', ARRIVAL]]) {
    const { status, bookD, fwD } = go('suggest', { extra });
    assert.ok(status === 1 || status === 2, `exit ${status}`);
    assert.deepEqual(bookD, { added: [], removed: [], changed: [] });
    assert.deepEqual(fwD.changed, []);
  }
});

test('suggest twice with the same text never overwrites: the first file stays byte-identical', async () => {
  const { book, go } = setup();
  const from = scratch('alt.md', alternativeBody(book).edited);
  assert.equal(go('suggest', { extra: ['--scene', ARRIVAL, '--from', from] }).status, 0);
  const first = (await suggestionsIn(book)).map((s) => [s.rel, s.text]);
  const second = go('suggest', { extra: ['--scene', ARRIVAL, '--from', from] });
  const after = await suggestionsIn(book);
  // a same-second second run either makes a distinct second file (exit 0) or refuses and writes nothing; it never replaces the first
  assert.equal(after.length, second.status === 0 ? 2 : 1);
  for (const [rel, text] of first) assert.equal(after.find((s) => s.rel === rel)?.text, text, `${rel} unchanged`);
  assert.deepEqual(second.bookD.changed, []);
});
