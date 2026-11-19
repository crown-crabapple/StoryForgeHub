// M13-J03: the core half of Style checks: withStyleChecks / setStyleChecks, style dismissals (create, list, archive, undo, verify rollback),
// applyFindingEdit (a finding applied to a scene that is not open) and getSceneBodies / listLiveScenes (what a scan reads).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mock, test } from 'node:test';
import YAML from 'yaml';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { withStyleChecks } from '../src/fs-writes.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const S1 = 'scene_01S50000000000000000000001';
const S2 = 'scene_01S50000000000000000000002';
const S3 = 'scene_01S50000000000000000000003';
const VARIANT = 'scene_01S50000000000000000000004';
const ARCHIVED = 'scene_01S50000000000000000000007';
const GHOST = 'scene_01S5000000000000000000ZZ99';
const FP = 'sty-0123456789abcdef';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const body = '\nBody text.\n\nSecond paragraph.\n';

function patchText(text, patch) {
  const r = withStyleChecks(Buffer.from(text), patch);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

async function withRepo(fn) {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  try {
    await fn(repo, root);
  } finally {
    await repo.close();
  }
}

// ---------------------------------------------------------------- withStyleChecks / setStyleChecks

test('withStyleChecks creates the maps, keeps comments and other keys, and copies the body bytes unchanged', () => {
  const plain = `---\nid: book_1\n# keep me\ntitle: "A: B"\n---${body}`;
  const on = patchText(plain, { enabled: true });
  assert.equal(on.changed, true);
  assert.equal(on.buf.toString('utf8'), `---\nid: book_1\n# keep me\ntitle: "A: B"\npreferences:\n  checks:\n    style:\n      enabled: true\n---${body}`);
  assert.deepEqual(on.style, { enabled: true });

  const existing = `---\nid: book_1\npreferences:\n  theme: dark # mine\n  checks:\n    version: 1 # v\n    grammar:\n      enabled: true\n    style:\n      enabled: false # off\n      rules:\n        repeated-words: { enabled: true } # keep\n---${body}`;
  const r = patchText(existing, { enabled: true, rules: { punctuation: { enabled: true, quotes: 'curly', dashes: null, ellipsis: 'character' }, 'preferred-terms': { enabled: true, terms: [{ use: 'grey', avoid: ['gray'] }] } } });
  const text = r.buf.toString('utf8');
  assert.match(text, /theme: dark # mine/);
  assert.match(text, /version: 1 # v/);
  assert.match(text, /repeated-words: \{ enabled: true \} # keep/);
  assert.match(text, /quotes: curly/);
  assert.match(text, /dashes: null/);
  assert.match(text, /- use: grey/);
  assert.equal(text.slice(text.indexOf('\n---\n') + 4 > 0 ? text.lastIndexOf('---') : 0), `---${body}`);
  assert.equal(r.style.enabled, true);
  assert.deepEqual(r.style.rules.punctuation, { enabled: true, quotes: 'curly', dashes: null, ellipsis: 'character' });
  assert.deepEqual(r.style.rules['repeated-words'], { enabled: true });

  // the body (and any bytes after the front matter) are byte-identical, including a non-UTF-8 sequence and a final line without a break
  const tail = Buffer.from([0x0a, 0xff, 0xfe, 0x0d, 0x0a, 0x41]);
  const out = withStyleChecks(Buffer.concat([Buffer.from('---\nid: x\n---'), tail]), { enabled: false });
  assert.equal(out.ok, true);
  assert.equal(Buffer.compare(out.buf.subarray(out.buf.length - tail.length), tail), 0);
});

test('withStyleChecks keeps CRLF in the head and the body bytes untouched', () => {
  const crlfBody = '\r\nBody\r\nlines\r\n';
  const r = patchText(`---\r\nid: x\r\n# note\r\ntitle: T\r\n---${crlfBody}`, { enabled: true, rules: { 'long-paragraphs': { enabled: true, maxWords: 100 } } });
  assert.equal(r.buf.toString('utf8'), `---\r\nid: x\r\n# note\r\ntitle: T\r\npreferences:\r\n  checks:\r\n    style:\r\n      enabled: true\r\n      rules:\r\n        long-paragraphs:\r\n          enabled: true\r\n          maxWords: 100\r\n---${crlfBody}`);
  assert.doesNotMatch(r.buf.toString('utf8').replace(/\r\n/g, ''), /[\r\n]/, 'every line break in the file is CRLF');
});

test('withStyleChecks: a given rule map replaces that rule\'s map; other rules stay; the same patch twice is unchanged', () => {
  const start = `---\nid: x\npreferences:\n  checks:\n    style:\n      rules:\n        punctuation: { enabled: true, quotes: curly }\n        isolated-lines: { enabled: true, minRun: 8 }\n---${body}`;
  const a = patchText(start, { rules: { punctuation: { enabled: false } } });
  assert.deepEqual(a.style.rules, { punctuation: { enabled: false }, 'isolated-lines': { enabled: true, minRun: 8 } });
  assert.equal(a.changed, true);
  const again = withStyleChecks(a.buf, { rules: { punctuation: { enabled: false } } });
  assert.equal(again.ok && again.changed, false);
  assert.equal(again.ok && Buffer.compare(again.buf, a.buf), 0);
  const same = withStyleChecks(Buffer.from(`---\nid: x\n---${body}`), {});
  assert.equal(same.ok && same.changed, false);
});

test('withStyleChecks refuses every bad change with BAD_ARGS and writes nothing', () => {
  const bytes = Buffer.from(`---\nid: x\n---${body}`);
  const bad = (patch, re) => {
    const r = withStyleChecks(bytes, patch);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.code, 'BAD_ARGS', JSON.stringify(patch));
    if (re) assert.match(r.message, re);
  };
  bad(null, /object/);
  bad([], /object/);
  bad({ colour: 1 }, /unknown style setting colour/);
  bad({ enabled: 'yes' }, /true or false/);
  bad({ rules: [] }, /mapping/);
  bad({ rules: { 'textlint-rule-anything': { enabled: true } } }, /unknown style rule/);
  bad({ rules: { punctuation: true } }, /must be a mapping/);
  bad({ rules: { punctuation: { quotes: 'fancy' } } }, /quotes/);
  bad({ rules: { punctuation: { nope: 1 } } }, /nope/);
  bad({ rules: { 'repeated-phrases': { minWords: 2 } } }, /minWords/);
  bad({ rules: { 'preferred-terms': { terms: [{ use: 'grey', avoid: ['grey'] }] } } }, /avoid/);
  // a file whose style map is not a mapping is refused, not overwritten
  bad2(`---\nid: x\npreferences:\n  checks:\n    style: 5\n---${body}`);
  bad2(`---\nid: x\npreferences: 5\n---${body}`);
  function bad2(text) {
    const r = withStyleChecks(Buffer.from(text), { enabled: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BAD_ARGS');
  }
  assert.equal(withStyleChecks(Buffer.from('no front matter'), { enabled: true }).code, 'NOT_A_DOCUMENT');
});

test('setStyleChecks writes book.md through the store: result map, unchanged, refusals, and the library stays valid', async () => {
  await withRepo(async (repo, root) => {
    const before = await fs.readFile(path.join(root, 'book.md'));
    assert.equal((await repo.setStyleChecks('book_nope', { enabled: true })).code, 'NOT_FOUND');
    assert.equal((await repo.setStyleChecks(BOOK, { enabled: 'yes' })).code, 'BAD_ARGS');
    assert.deepEqual(await fs.readFile(path.join(root, 'book.md')), before);

    const r = await repo.setStyleChecks(BOOK, { enabled: true, rules: { 'repeated-phrases': { enabled: true, minWords: 5, window: 400 } } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.style, { enabled: true, rules: { 'repeated-phrases': { enabled: true, minWords: 5, window: 400 } } });
    assert.equal(r.unchanged, undefined);
    const text = await fs.readFile(path.join(root, 'book.md'), 'utf8');
    assert.match(text, /preferences:\n {2}checks:\n {4}style:\n {6}enabled: true/);
    assert.ok(text.endsWith(before.toString('utf8').slice(before.toString('utf8').lastIndexOf('---') + 3)), 'body bytes unchanged');
    const errors = (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
    assert.deepEqual(errors, []);

    const again = await repo.setStyleChecks(BOOK, { enabled: true });
    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true);
    assert.equal(Buffer.compare(await fs.readFile(path.join(root, 'book.md'), 'utf8').then((t) => Buffer.from(t)), Buffer.from(text)), 0);
  });
});

// ---------------------------------------------------------------- dismissals

test('createStyleDismissal writes planning/style/<slug>.md that the validator accepts; list shows it; the text is quoted safely', async () => {
  await withRepo(async (repo, root) => {
    const base = (await validate(root)).diagnostics.length;
    const text = 'had had: "so" --- #1\nnext line';
    const r = await repo.createStyleDismissal(BOOK, { fingerprint: FP, rule: 'repeated-words', sceneId: S1, text, note: 'Intentional: the narrator\'s voice.' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.slug, /^repeated-words-had-had/);
    assert.equal(r.file, `planning/style/${r.slug}.md`);
    assert.match(r.id, /^note_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.equal(r.undo.op, r.opId);
    const file = await fs.readFile(path.join(root, ...r.file.split('/')), 'utf8');
    assert.ok(file.startsWith('---\nschema: storyforge.style-dismissal/v1\n'));
    assert.ok(file.endsWith('---\nIntentional: the narrator\'s voice.\n'));
    const fm = YAML.parse(file.slice(4, file.indexOf('\n---\n') + 1), { version: '1.2', schema: 'core' });
    assert.equal(fm.text, text);
    assert.equal(fm.fingerprint, FP);
    assert.equal(fm.scene, S1);
    assert.equal(fm.rule, 'repeated-words');
    assert.match(fm.created, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await validate(root)).diagnostics.length, base, 'no new diagnostics');

    assert.deepEqual(await repo.listStyleDismissals(BOOK), [
      { slug: r.slug, fingerprint: FP, rule: 'repeated-words', sceneId: S1, text, note: 'Intentional: the narrator\'s voice.', created: fm.created },
    ]);
    assert.deepEqual(await repo.listStyleDismissals('book_nope'), []);

    // a second dismissal of the same passage is refused and writes nothing; a different fingerprint gets its own file (and a fresh slug)
    const dup = await repo.createStyleDismissal(BOOK, { fingerprint: FP, rule: 'repeated-words', sceneId: S1, text });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, 'ALREADY_DISMISSED');
    const other = await repo.createStyleDismissal(BOOK, { fingerprint: 'sty-fedcba9876543210', rule: 'repeated-words', sceneId: S2, text });
    assert.equal(other.ok, true, JSON.stringify(other));
    assert.notEqual(other.slug, r.slug);
    assert.equal((await repo.listStyleDismissals(BOOK)).length, 2);
    // no note: the file has no body
    assert.ok((await fs.readFile(path.join(root, ...other.file.split('/')), 'utf8')).endsWith('\n---\n'));
  });
});

test('createStyleDismissal refusals: BAD_ARGS for each bad field, NOT_FOUND for an unknown book; nothing is written', async () => {
  await withRepo(async (repo, root) => {
    const good = { fingerprint: FP, rule: 'punctuation', sceneId: S1, text: '"' };
    const codes = async (over) => (await repo.createStyleDismissal(BOOK, { ...good, ...over })).code;
    assert.equal(await codes({ fingerprint: 'cf1-0123456789abcdef' }), 'BAD_ARGS');
    assert.equal(await codes({ fingerprint: 'sty-xyz' }), 'BAD_ARGS');
    assert.equal(await codes({ fingerprint: undefined }), 'BAD_ARGS');
    assert.equal(await codes({ rule: 'textlint-rule-anything' }), 'BAD_ARGS');
    assert.equal(await codes({ rule: undefined }), 'BAD_ARGS');
    assert.equal(await codes({ sceneId: 'scene_nope' }), 'BAD_ARGS');
    assert.equal(await codes({ sceneId: 'entry_01S50000000000000000000001' }), 'BAD_ARGS');
    assert.equal(await codes({ text: '' }), 'BAD_ARGS');
    assert.equal(await codes({ text: '   ' }), 'BAD_ARGS');
    assert.equal(await codes({ text: 5 }), 'BAD_ARGS');
    assert.equal(await codes({ text: 'x'.repeat(501) }), 'BAD_ARGS');
    assert.equal(await codes({ note: 5 }), 'BAD_ARGS');
    assert.equal(await codes({ note: 'n'.repeat(2001) }), 'BAD_ARGS');
    assert.equal((await repo.createStyleDismissal(BOOK, null)).code, 'BAD_ARGS');
    assert.equal((await repo.createStyleDismissal('book_nope', good)).code, 'NOT_FOUND');
    await assert.rejects(fs.stat(path.join(root, 'planning', 'style')), { code: 'ENOENT' });
  });
});

test('undo of a dismissal (restoreOp) removes the file; archive restores the finding; undo of the archive brings it back', async () => {
  await withRepo(async (repo, root) => {
    const made = await repo.createStyleDismissal(BOOK, { fingerprint: FP, rule: 'repeated-words', sceneId: S1, text: 'the the' });
    assert.equal(made.ok, true, JSON.stringify(made));
    const live = path.join(root, ...made.file.split('/'));
    const undone = await repo.restoreOp(BOOK, made.undo.op);
    assert.equal(undone.ok, true, JSON.stringify(undone));
    await assert.rejects(fs.stat(live), { code: 'ENOENT' });
    assert.deepEqual(await repo.listStyleDismissals(BOOK), []);

    // dismiss again (same fingerprint is allowed again after the undo), then archive it
    const again = await repo.createStyleDismissal(BOOK, { fingerprint: FP, rule: 'repeated-words', sceneId: S1, text: 'the the' });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal((await repo.archiveStyleDismissal(BOOK, 'no-such-slug')).code, 'NOT_FOUND');
    assert.equal((await repo.archiveStyleDismissal('book_nope', again.slug)).code, 'NOT_FOUND');
    const arch = await repo.archiveStyleDismissal(BOOK, again.slug);
    assert.equal(arch.ok, true, JSON.stringify(arch));
    assert.equal(arch.slug, again.slug);
    assert.equal(arch.archived, `archive/planning/style/${again.slug}.md`);
    assert.equal(arch.undo.op, arch.opId);
    await fs.stat(path.join(root, ...arch.archived.split('/')));
    await assert.rejects(fs.stat(path.join(root, ...again.file.split('/'))), { code: 'ENOENT' });
    assert.deepEqual(await repo.listStyleDismissals(BOOK), []);
    assert.equal((await repo.archiveStyleDismissal(BOOK, again.slug)).code, 'NOT_FOUND', 'an archived dismissal cannot be archived again');
    // the finding can be dismissed again once archived, with a new file name
    const third = await repo.createStyleDismissal(BOOK, { fingerprint: FP, rule: 'repeated-words', sceneId: S1, text: 'the the' });
    assert.equal(third.ok, true, JSON.stringify(third));
    assert.notEqual(third.slug, again.slug);
    const third_ = await repo.restoreOp(BOOK, third.opId);
    assert.equal(third_.ok, true, JSON.stringify(third_));

    const back = await repo.restoreOp(BOOK, arch.undo.op);
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.deepEqual((await repo.listStyleDismissals(BOOK)).map((d) => d.slug), [again.slug]);
  });
});

test('the verify hook rolls a dismissal back when the library would gain an error', async () => {
  await withRepo(async (repo, root) => {
    const real = YAML.stringify;
    const m = mock.method(YAML, 'stringify', (v, o) => real({ ...v, fingerprint: 'not-a-fingerprint' }, o));
    try {
      const r = await repo.createStyleDismissal(BOOK, { fingerprint: FP, rule: 'repeated-words', sceneId: S1, text: 'the the' });
      assert.equal(r.ok, false);
      assert.equal(r.code, 'ROLLED_BACK');
      assert.ok(r.diagnostics.some((d) => d.code === 'E102'), JSON.stringify(r.diagnostics));
      assert.equal(m.mock.callCount(), 1);
    } finally {
      m.mock.restore();
    }
    await assert.rejects(fs.stat(path.join(root, 'planning', 'style', 'repeated-words-the-the.md')), { code: 'ENOENT' });
    assert.deepEqual(await repo.listStyleDismissals(BOOK), []);
    assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.severity === 'error'), []);
  });
});

// ---------------------------------------------------------------- applyFindingEdit

/** Make scene 1 a CRLF file whose body starts with an emoji and holds "the the"; returns the repository's view of it. */
async function crlfScene(root, repo) {
  const file = path.join(root, 'manuscript', 'act-01-low-water', 'ch-000-prologue', '0010-before-the-tide.md');
  const text = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
  const head = text.slice(0, text.indexOf('\n---\n') + 5);
  const next = `${head}\u{1F600} She said the the word again.\n\nSecond line, no change.\n`.replace(/\n/g, '\r\n');
  await fs.writeFile(file, next);
  await repo.rescan();
  const got = await repo.getSceneBodies(BOOK, [S1]);
  assert.equal(got.ok, true, JSON.stringify(got));
  const scene = got.scenes[0];
  const from = scene.body.indexOf('the the');
  assert.ok(from > 2, 'the emoji (two UTF-16 units) is before the range');
  return { file, scene, from, to: from + 'the the'.length };
}

test('applyFindingEdit applies exactly the range in a CRLF scene with an emoji before it, writes an author/check receipt, and restoreOp undoes it', async () => {
  await withRepo(async (repo, root) => {
    const { file, scene, from, to } = await crlfScene(root, repo);
    assert.equal(scene.body.includes('\r'), false, 'body has LF line breaks');
    const before = await fs.readFile(file);
    assert.equal(scene.sha256, sha(before));
    const r = await repo.applyFindingEdit(BOOK, S1, { baseSha256: scene.sha256, from, to, original: 'the the', replacement: 'the', ruleId: 'repeated-words', engine: 'textlint' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.path, scene.path);
    assert.match(r.opId, /\S/);
    const after = await fs.readFile(file);
    assert.equal(r.sha256, sha(after));
    assert.equal(after.toString('utf8'), before.toString('utf8').replace('the the word', 'the word'));
    assert.equal(after.toString('utf8').includes('\n') && !/[^\r]\n/.test(after.toString('utf8')), true, 'still CRLF everywhere');

    // the receipt: author.edit, actor author, workflow check, with the summary
    const { receipts } = await repo.getReceipts(BOOK, S1);
    const mine = receipts.filter((x) => x.workflow === 'check');
    assert.equal(mine.length, 1, JSON.stringify(receipts.map((x) => [x.operation, x.workflow])));
    assert.equal(mine[0].operation, 'author.edit');
    assert.equal(mine[0].actor, 'author');
    const rcpt = await fs.readFile(path.join(root, ...mine[0].path.split('/')), 'utf8');
    assert.match(rcpt, /Style check: “the the” -> “the” \(repeated-words\)/);
    assert.deepEqual((await repo.verifyReceipts(BOOK)).problems.filter((p) => p.severity !== 'info'), []);

    const undone = await repo.restoreOp(BOOK, r.opId);
    assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.equal(Buffer.compare(await fs.readFile(file), before), 0, 'the scene is back byte for byte');
  });
});

test('applyFindingEdit refuses a changed scene (sha or range text) with SCENE_CHANGED and writes nothing', async () => {
  await withRepo(async (repo, root) => {
    const { file, scene, from, to } = await crlfScene(root, repo);
    const before = await fs.readFile(file);
    const args = { baseSha256: scene.sha256, from, to, original: 'the the', replacement: 'the', ruleId: 'repeated-words', engine: 'textlint' };
    const unchanged = async () => assert.equal(Buffer.compare(await fs.readFile(file), before), 0);
    // the range text differs
    assert.equal((await repo.applyFindingEdit(BOOK, S1, { ...args, original: 'a a' })).code, 'SCENE_CHANGED');
    assert.equal((await repo.applyFindingEdit(BOOK, S1, { ...args, from: from + 1, to: to + 1 })).code, 'SCENE_CHANGED');
    assert.equal((await repo.applyFindingEdit(BOOK, S1, { ...args, from: 5000, to: 5007 })).code, 'SCENE_CHANGED');
    // the file differs from what the scan saw
    assert.equal((await repo.applyFindingEdit(BOOK, S1, { ...args, baseSha256: sha('other') })).code, 'SCENE_CHANGED');
    await unchanged();
    await fs.appendFile(file, 'Added later.\r\n');
    await repo.rescan();
    const changed = await repo.applyFindingEdit(BOOK, S1, args);
    assert.equal(changed.ok, false);
    assert.equal(changed.code, 'SCENE_CHANGED');
    assert.equal((await fs.readFile(file, 'utf8')).includes('the the word'), true);
  });
});

test('applyFindingEdit: BAD_ARGS for bad input, NOT_FOUND for an unknown scene or one that is not live; replacement is at most 2,000 characters', async () => {
  await withRepo(async (repo, root) => {
    const { scene, from, to } = await crlfScene(root, repo);
    const good = { baseSha256: scene.sha256, from, to, original: 'the the', replacement: 'the', ruleId: 'repeated-words', engine: 'textlint' };
    const code = async (over, id = S1) => (await repo.applyFindingEdit(BOOK, id, { ...good, ...over })).code;
    assert.equal(await code({ baseSha256: 'abc' }), 'BAD_ARGS');
    assert.equal(await code({ baseSha256: undefined }), 'BAD_ARGS');
    assert.equal(await code({ original: '' }), 'BAD_ARGS');
    assert.equal(await code({ original: 5 }), 'BAD_ARGS');
    assert.equal(await code({ replacement: 5 }), 'BAD_ARGS');
    assert.equal(await code({ replacement: 'x'.repeat(2001) }), 'BAD_ARGS');
    assert.equal(await code({ ruleId: '../x' }), 'BAD_ARGS');
    assert.equal(await code({ ruleId: undefined }), 'BAD_ARGS');
    assert.equal(await code({ engine: 'Text Lint' }), 'BAD_ARGS');
    assert.equal(await code({ from: 1.5 }), 'BAD_ARGS');
    assert.equal(await code({ from: -1 }), 'BAD_ARGS');
    assert.equal(await code({ to: from }), 'BAD_ARGS');
    assert.equal(await code({ to: '9' }), 'BAD_ARGS');
    assert.equal((await repo.applyFindingEdit(BOOK, S1, undefined)).code, 'BAD_ARGS');
    assert.equal(await code({}, GHOST), 'NOT_FOUND');
    assert.equal(await code({}, ARCHIVED), 'NOT_FOUND');
    assert.equal((await repo.applyFindingEdit('book_nope', S1, good)).code, 'NOT_FOUND');
    // a 2,000 character replacement is accepted
    const long = await repo.applyFindingEdit(BOOK, S1, { ...good, replacement: 'x'.repeat(2000) });
    assert.equal(long.ok, true, JSON.stringify(long));
  });
});

test('applyFindingEdit summarises long text at 60 characters', async () => {
  await withRepo(async (repo, root) => {
    const { scene, from, to } = await crlfScene(root, repo);
    const r = await repo.applyFindingEdit(BOOK, S1, { baseSha256: scene.sha256, from, to, original: 'the the', replacement: 'y'.repeat(200), ruleId: 'preferred-terms', engine: 'textlint' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const { receipts } = await repo.getReceipts(BOOK, S1);
    const rcpt = await fs.readFile(path.join(root, ...receipts.find((x) => x.workflow === 'check').path.split('/')), 'utf8');
    assert.match(rcpt, /Style check: “the the” -> “y{59}…” \(preferred-terms\)\n/);
  });
});

// ---------------------------------------------------------------- getSceneBodies / listLiveScenes

test('getSceneBodies answers in the requested order, lists unknown, archived and variant ids as missing, and matches getScene', async () => {
  await withRepo(async (repo, root) => {
    const { scene: crlf } = await crlfScene(root, repo);
    const r = await repo.getSceneBodies(BOOK, [S3, GHOST, S1, ARCHIVED, S2, S3, VARIANT]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.scenes.map((s) => s.id), [S3, S1, S2]);
    assert.deepEqual(r.missing, [GHOST, ARCHIVED, VARIANT]);
    for (const s of r.scenes) {
      const one = await repo.getScene(BOOK, s.id);
      assert.equal(s.sha256, one.sha256, 'the whole-file hash getScene gives');
      assert.equal(s.body, one.body.replace(/\r\n/g, '\n'));
      assert.equal(s.title, one.title);
      assert.equal(s.act, one.act);
      assert.equal(s.chapter, one.chapter);
      assert.equal(s.path, one.path);
      assert.equal(typeof s.chapterLabel, 'string');
      assert.equal(s.body.includes('\r'), false);
    }
    assert.equal(r.scenes[1].body, crlf.body);
    assert.equal(r.scenes[1].body.includes('\n\n'), true);

    assert.deepEqual((await repo.getSceneBodies(BOOK, [])), { ok: true, code: 'OK', scenes: [], missing: [] });
    assert.equal((await repo.getSceneBodies('book_nope', [S1])).code, 'NOT_FOUND');
    assert.equal((await repo.getSceneBodies(BOOK, 'scene_x')).code, 'BAD_ARGS');
    assert.equal((await repo.getSceneBodies(BOOK, [S1, 5])).code, 'BAD_ARGS');
  });
});

test('listLiveScenes lists the live scenes in book order without variants or archived scenes', async () => {
  await withRepo(async (repo) => {
    const r = await repo.listLiveScenes(BOOK);
    assert.equal(r.ok, true);
    const ids = r.scenes.map((s) => s.id);
    assert.deepEqual(ids.slice(0, 3), [S1, S2, S3]);
    assert.equal(ids.includes(VARIANT), false);
    assert.equal(ids.includes(ARCHIVED), false);
    const book = await repo.getBook(BOOK);
    assert.deepEqual(ids, book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes.map((s) => s.id))));
    assert.deepEqual(Object.keys(r.scenes[0]).sort(), ['act', 'chapter', 'chapterLabel', 'id', 'path', 'title']);
    assert.equal((await repo.listLiveScenes('book_nope')).code, 'NOT_FOUND');
  });
});
