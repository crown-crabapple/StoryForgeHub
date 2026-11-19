// M13-J02: the Grammar checks settings in book.md (preferences.checks.grammar), written through POST /api/books/:b/checks/grammar.
// withGrammarChecks (pure bytes), setGrammarChecks (repository) and the route: 200 with the resulting map, unchanged, 400 per bad field, 404, and a fresh repository.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { withGrammarChecks } from '../../../packages/core/src/fs-writes.mjs';
import { BOOK } from './move-helpers.mjs';
import { bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const URL_ = `/api/books/${BOOK}/checks/grammar`;
const post = (t, body) => t.member('POST', URL_, body);
const readBook = (t) => fs.readFile(path.join(t.root, 'book.md'));
const body = '\nBody text.\n\nSecond paragraph.\n';

function patchText(text, patch) {
  const r = withGrammarChecks(Buffer.from(text), patch);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

test('withGrammarChecks creates the maps, keeps comments and other keys, and copies the body bytes unchanged', () => {
  const plain = `---\nid: book_1\n# keep me\ntitle: "A: B"\n---${body}`;
  const on = patchText(plain, { enabled: true });
  assert.equal(on.changed, true);
  assert.equal(on.buf.toString('utf8'), `---\nid: book_1\n# keep me\ntitle: "A: B"\npreferences:\n  checks:\n    grammar:\n      enabled: true\n---${body}`);
  assert.deepEqual(on.grammar, { enabled: true });

  const existing = `---\nid: book_1\npreferences:\n  theme: dark # mine\n  checks:\n    version: 1 # v\n    grammar:\n      enabled: true # on\n      language: en\n    style:\n      enabled: false\n---${body}`;
  const r = patchText(existing, { dialect: 'british', addWords: ['Mara'], disableRules: ['SpellCheck'] });
  assert.equal(
    r.buf.toString('utf8'),
    `---\nid: book_1\npreferences:\n  theme: dark # mine\n  checks:\n    version: 1 # v\n    grammar:\n      enabled: true # on\n      language: en\n      dialect: british\n      words:\n        - Mara\n      rules:\n        SpellCheck: false\n    style:\n      enabled: false\n---${body}`,
  );
  assert.deepEqual(r.grammar, { enabled: true, language: 'en', dialect: 'british', words: ['Mara'], rules: { SpellCheck: false } });

  // the body (and any bytes after the front matter) are byte-identical, including a non-UTF-8 sequence and a final line without a break
  const tail = Buffer.from([0x0a, 0xff, 0xfe, 0x0d, 0x0a, 0x41]);
  const bytes = Buffer.concat([Buffer.from('---\nid: x\n---'), tail]);
  const out = withGrammarChecks(bytes, { enabled: false });
  assert.equal(out.ok, true);
  assert.equal(Buffer.compare(out.buf.subarray(out.buf.length - tail.length), tail), 0);

  // an empty `preferences:` value and an empty front matter are filled in
  assert.equal(patchText(`---\nid: x\npreferences:\n---${body}`, { enabled: true }).buf.toString('utf8'), `---\nid: x\npreferences:\n  checks:\n    grammar:\n      enabled: true\n---${body}`);
});

test('withGrammarChecks keeps CRLF in the head and the body bytes untouched', () => {
  const crlfBody = '\r\nBody\r\nlines\r\n';
  const r = patchText(`---\r\nid: x\r\n# note\r\ntitle: T\r\n---${crlfBody}`, { enabled: true, addWords: ['Mara'] });
  assert.equal(r.buf.toString('utf8'), `---\r\nid: x\r\n# note\r\ntitle: T\r\npreferences:\r\n  checks:\r\n    grammar:\r\n      enabled: true\r\n      words:\r\n        - Mara\r\n---${crlfBody}`);
  assert.doesNotMatch(r.buf.toString('utf8').replace(/\r\n/g, ''), /[\r\n]/, 'every line break in the file is CRLF');
});

test('withGrammarChecks: words are added in order after the existing ones with no duplicates, and removed by exact match', () => {
  const start = `---\nid: x\n---${body}`;
  const a = patchText(start, { addWords: ['Mara', 'Kestrel', 'Mara'] });
  assert.deepEqual(a.grammar.words, ['Mara', 'Kestrel']);
  const b = patchText(a.buf.toString('utf8'), { addWords: ['Kestrel', 'Zoe', 'Ada'] });
  assert.deepEqual(b.grammar.words, ['Mara', 'Kestrel', 'Zoe', 'Ada']);
  const c = patchText(b.buf.toString('utf8'), { removeWords: ['kestrel', 'Kestrel', 'Nobody'] });
  assert.deepEqual(c.grammar.words, ['Mara', 'Zoe', 'Ada'], 'case-sensitive, unknown words ignored');
  // add and remove in one change: remove first, then add
  const d = patchText(c.buf.toString('utf8'), { removeWords: ['Mara'], addWords: ['Mara', 'Lin'] });
  assert.deepEqual(d.grammar.words, ['Zoe', 'Ada', 'Mara', 'Lin']);
  // removing the last words removes the list, and the empty maps with it
  const e = patchText(a.buf.toString('utf8'), { removeWords: ['Mara', 'Kestrel'] });
  assert.equal(e.buf.toString('utf8'), start);
  assert.deepEqual(e.grammar, {});
});

test('withGrammarChecks: rules are turned off with false and back on by deleting the entry', () => {
  const start = `---\nid: x\n---${body}`;
  const a = patchText(start, { disableRules: ['SpellCheck', 'LongSentences', 'SpellCheck'] });
  assert.deepEqual(a.grammar.rules, { SpellCheck: false, LongSentences: false });
  assert.match(a.buf.toString('utf8'), /rules:\n {8}SpellCheck: false\n {8}LongSentences: false\n/);
  const b = patchText(a.buf.toString('utf8'), { enableRules: ['SpellCheck', 'NeverOff'] });
  assert.deepEqual(b.grammar.rules, { LongSentences: false });
  const c = patchText(b.buf.toString('utf8'), { enableRules: ['LongSentences'] });
  assert.equal(c.buf.toString('utf8'), start);
});

test('withGrammarChecks: a change that changes nothing is reported unchanged and returns the same bytes', () => {
  const text = `---\nid: x\npreferences:\n  checks:\n    grammar:\n      enabled: true\n      dialect: british\n      words: [Mara]\n      rules: { SpellCheck: false }\n---${body}`;
  const bytes = Buffer.from(text);
  for (const patch of [{}, { enabled: true }, { dialect: 'british' }, { addWords: ['Mara'] }, { removeWords: ['Zed'] }, { disableRules: ['SpellCheck'] }, { enableRules: ['Other'] }]) {
    const r = withGrammarChecks(bytes, patch);
    assert.equal(r.ok, true);
    assert.equal(r.changed, false, JSON.stringify(patch));
    assert.equal(r.buf, bytes);
  }
  // nothing to remove from a file with no grammar settings writes nothing and creates nothing
  const bare = Buffer.from(`---\nid: x\n---${body}`);
  const r = withGrammarChecks(bare, { removeWords: ['A'], enableRules: ['B'] });
  assert.equal(r.changed, false);
  assert.deepEqual(r.grammar, {});
});

test('withGrammarChecks refuses a preferences, checks or grammar that is not a mapping, and a bad change', () => {
  for (const front of ['preferences: nope', 'preferences:\n  checks: 5', 'preferences:\n  checks:\n    grammar: [a]', 'preferences:\n  checks:\n    grammar:\n      words: nope', 'preferences:\n  checks:\n    grammar:\n      rules: [a]']) {
    const r = withGrammarChecks(Buffer.from(`---\nid: x\n${front}\n---${body}`), { enabled: true });
    assert.equal(r.ok, false, front);
    assert.equal(r.code, 'BAD_ARGS', front);
  }
  assert.equal(withGrammarChecks(Buffer.from('no front matter'), { enabled: true }).ok, false);
  const ok = Buffer.from(`---\nid: x\n---${body}`);
  for (const patch of [{ enabled: 'yes' }, { dialect: 'klingon' }, { addWords: 'Mara' }, { addWords: [' Mara'] }, { removeWords: [''] }, { disableRules: ['bad rule'] }, { enableRules: [1] }, { nope: 1 }, null, []]) {
    const r = withGrammarChecks(ok, /** @type {any} */ (patch));
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.equal(r.code, 'BAD_ARGS', JSON.stringify(patch));
  }
});

test('the route: 200 with the resulting grammar map, written to book.md, unchanged when nothing changes; GET /api/preferences shows it effective', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const before = (await readBook(t)).toString('utf8');
  const frontEnd = before.indexOf('\n---', 4) + 4;
  const defaults = await t.member('GET', `/api/preferences?book=${BOOK}`);
  assert.deepEqual(defaults.json.effective.checks.grammar, { enabled: false, language: 'en', dialect: 'american', words: [], rules: {} });

  const first = await post(t, { enabled: true, dialect: 'british', addWords: ['Mara', 'Kestrel'], disableRules: ['SpellCheck'] });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json, { ok: true, grammar: { enabled: true, dialect: 'british', words: ['Mara', 'Kestrel'], rules: { SpellCheck: false } } });
  const after1 = (await readBook(t)).toString('utf8');
  assert.equal(after1.slice(after1.indexOf('\n---', 4) + 4), before.slice(frontEnd), 'the body is untouched');
  assert.match(after1, /grammar:\n {6}enabled: true\n {6}dialect: british\n {6}words:\n {8}- Mara\n {8}- Kestrel\n {6}rules:\n {8}SpellCheck: false\n/);

  const prefs = await t.member('GET', `/api/preferences?book=${BOOK}`);
  assert.deepEqual(prefs.json.effective.checks.grammar, { enabled: true, language: 'en', dialect: 'british', words: ['Mara', 'Kestrel'], rules: { SpellCheck: false } });
  assert.equal(prefs.json.sources['checks.grammar.enabled'], 'book');

  const second = await post(t, { removeWords: ['Kestrel'], addWords: ['Zoe'], enableRules: ['SpellCheck'] });
  assert.equal(second.status, 200, second.text);
  assert.deepEqual(second.json.grammar, { enabled: true, dialect: 'british', words: ['Mara', 'Zoe'] });
  assert.equal(second.json.unchanged, undefined);

  const bytes = await readBook(t);
  const same = await post(t, { enabled: true, addWords: ['Mara'] });
  assert.equal(same.status, 200, same.text);
  assert.deepEqual(same.json, { ok: true, grammar: { enabled: true, dialect: 'british', words: ['Mara', 'Zoe'] }, unchanged: true });
  assert.equal(Buffer.compare(await readBook(t), bytes), 0, 'an unchanged request writes nothing');

  // a fresh repository over the same folder still sees the words
  const repository = createFsRepository(t.root, { watch: false, pollMs: 0 });
  try {
    const p = await repository.getPreferences({ bookId: BOOK });
    assert.deepEqual(p.book.checks.grammar, { enabled: true, dialect: 'british', words: ['Mara', 'Zoe'] });
  } finally {
    await repository.close?.();
  }
});

test('setGrammarChecks (repository): writes, reports unchanged, refuses a bad change and an unknown book', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const repository = createFsRepository(t.root, { watch: false, pollMs: 0 });
  try {
    const r = await repository.setGrammarChecks(BOOK, { addWords: ['Mara'] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.grammar, { words: ['Mara'] });
    assert.equal(r.unchanged, undefined);
    assert.equal((await repository.setGrammarChecks(BOOK, { addWords: ['Mara'] })).unchanged, true);
    assert.equal((await repository.setGrammarChecks(BOOK, { dialect: 'klingon' })).code, 'BAD_ARGS');
    assert.equal((await repository.setGrammarChecks('book_01S5ZZZZZZZZZZZZZZZZZZZZZZ', { enabled: true })).code, 'NOT_FOUND');
  } finally {
    await repository.close?.();
  }
});

test('the route refuses each bad field with 400 and writes nothing; an unknown book is 404', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const before = await readBook(t);
  const bad = [
    [{}, 'empty body'],
    [{ nope: true }, 'unknown key'],
    [{ enabled: true, extra: 1 }, 'unknown key beside a good one'],
    [{ enabled: 'yes' }, 'enabled type'],
    [{ dialect: 'klingon' }, 'dialect'],
    [{ dialect: 5 }, 'dialect type'],
    [{ addWords: 'Mara' }, 'words not a list'],
    [{ addWords: [''] }, 'empty word'],
    [{ addWords: [' Mara'] }, 'word with a space at the start'],
    [{ addWords: ['Ma\nra'] }, 'word with a line break'],
    [{ addWords: ['a'.repeat(65)] }, 'word too long'],
    [{ addWords: [7] }, 'word not a string'],
    [{ addWords: ['Mara', 'Mara'] }, 'duplicate word in the request'],
    [{ removeWords: ['ok', ''] }, 'bad removed word'],
    [{ disableRules: 'SpellCheck' }, 'rules not a list'],
    [{ disableRules: ['Spell Check'] }, 'rule name with a space'],
    [{ disableRules: ['1Spell'] }, 'rule name starting with a digit'],
    [{ enableRules: [3] }, 'rule name not a string'],
  ];
  for (const [b, why] of bad) {
    const r = await post(t, b);
    assert.equal(r.status, 400, `${why}: ${r.text}`);
    assert.equal(r.json.error, 'bad_request', why);
    assert.equal(typeof r.json.message, 'string', why);
  }
  assert.match((await post(t, { dialect: 'klingon' })).json.message, /dialect/);
  assert.match((await post(t, { addWords: [''] })).json.message, /addWords/);
  assert.match((await post(t, { enableRules: ['no way'] })).json.message, /enableRules/);
  assert.match((await post(t, { nope: 1 })).json.message, /nope/);
  assert.equal(Buffer.compare(await readBook(t), before), 0);
  assert.equal((await t.member('POST', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/checks/grammar', { enabled: true })).status, 404);
  assert.equal(Buffer.compare(await readBook(t), before), 0);
});

test('the route answers 400 when book.md holds a grammar value that is not a mapping, and writes nothing', async () => {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const file = path.join(t.root, 'book.md');
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace(/\n---\n/, '\npreferences:\n  checks:\n    grammar: nope\n---\n'));
  const before = await readBook(t);
  const r = await post(t, { enabled: true });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.code, 'BAD_ARGS');
  assert.equal(Buffer.compare(await readBook(t), before), 0);
});
