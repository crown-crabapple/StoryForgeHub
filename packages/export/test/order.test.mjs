// M05-J03 acceptance 1: every format renders the included scenes in canonical order; variants, archived and trash
// scenes, <!-- note --> text and front matter never reach the reader; links are rendered as names.
// Oracles: helpers.mjs (own zip / XML / PDF readers) and the fixture's expected.json for the order.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { assembleManuscript, exportBook, verifyExport } from '../src/index.mjs';
import { EXT, FORBIDDEN, FORMATS, MIME, ORDER, REQUIRED, SLUG, cleanup, copyBook, editScene, expectedJson, occurrences, orderProblems, phrasesFor, textOf } from './helpers.mjs';

after(cleanup);

test('oracle sanity: the phrase table follows the fixture expected.json order', () => {
  assert.deepEqual(ORDER, expectedJson().order);
});

test('assembleManuscript: scenes in canonical order, grouped acts -> chapters, with the book title page data', async () => {
  const root = copyBook();
  const m = await assembleManuscript(root, {});
  assert.equal(m.title, 'The Salt Orchard');
  assert.ok(!m.subtitle, 'the fixture has an empty subtitle');
  const ids = m.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
  assert.deepEqual(ids, expectedJson().order);
  assert.equal(m.parts.length, 2, 'two acts');
  assert.deepEqual(m.parts.map((p) => p.chapters.length), [3, 1]);
  const labels = m.parts.flatMap((p) => p.chapters.map((c) => c.label));
  assert.deepEqual(labels.slice(0, 3), ['Prologue', 'Chapter One', 'Chapter Two']);
  assert.deepEqual(m.parts.flatMap((p) => p.chapters.map((c) => c.title)).slice(0, 3), ['Before the Tide', 'The Drowned Rows', 'The Grafting']);
  const scene = m.parts[0].chapters[1].scenes[1];
  assert.equal(scene.title, 'The Key');
});

test('assembleManuscript: excluded lists the variant and the archived scene with the fixture reasons', async () => {
  const m = await assembleManuscript(copyBook(), {});
  const want = expectedJson().excluded.map((e) => ({ id: e.id, reason: e.reason }));
  assert.deepEqual([...m.excluded].map((e) => ({ id: e.id, reason: e.reason })).sort((a, b) => (a.id < b.id ? -1 : 1)), want);
});

test('assembleManuscript: scene markdown has no front matter, no HTML comments and no wiki links', async () => {
  const m = await assembleManuscript(copyBook(), {});
  const scenes = m.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes));
  assert.equal(scenes.length, 7);
  for (const s of scenes) {
    assert.doesNotMatch(s.markdown, /^---\s*$/m, `${s.id} front matter fence`);
    assert.doesNotMatch(s.markdown, /<!--|-->/, `${s.id} comments`);
    assert.doesNotMatch(s.markdown, /\[\[|\]\]/, `${s.id} wiki links`);
    assert.doesNotMatch(s.markdown, /schema:|storyforge\./, `${s.id} front matter keys`);
  }
  const arrival = scenes.find((s) => s.id === ORDER[1]).markdown;
  assert.match(arrival, /the ferryman threw her bag ashore/);
  assert.match(arrival, /lay The Salt Orchard, half under water/, '[[slug]] becomes the entry name');
  const wall = scenes.find((s) => s.id === ORDER[6]).markdown;
  assert.match(wall, /used the key, and the old sluice gate/, '[[scene_id|label]] becomes the label');
  const key = scenes.find((s) => s.id === ORDER[2]).markdown;
  assert.match(key, /Pell watched from the gate/, '[[pell]] becomes the display name');
  assert.doesNotMatch(key, /check the tide times|left by the first draft/);
});

test('assembleManuscript: an unresolved [[slug]] is rendered as the slug text', async () => {
  const root = copyBook();
  editScene(root, 'manuscript/act-02-high-water/ch-003-the-wall/0020-the-wall.md', (t) => t.replace('The wall came down', 'See [[no-such-thing]] and [[no-such-two|a label]]. The wall came down'));
  const m = await assembleManuscript(root, {});
  const wall = m.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes)).find((s) => s.id === ORDER[6]).markdown;
  assert.match(wall, /See no-such-thing and a label\./);
});

for (const format of FORMATS) {
  test(`${format}: included scenes appear once each in canonical order, nothing hidden leaks, links are names`, async () => {
    const root = copyBook();
    const out = await exportBook(root, format, {});
    assert.ok(Buffer.isBuffer(out.bytes), 'bytes is a Buffer');
    assert.equal(out.filename, `${SLUG}.${EXT[format]}`);
    assert.ok(out.mime.startsWith(MIME[format]), out.mime);
    assert.ok(Array.isArray(out.warnings));

    const text = textOf(format, out.bytes);
    assert.deepEqual(orderProblems(text, phrasesFor(ORDER)), [], 'canonical order');
    for (const id of ORDER) assert.equal(occurrences(text, phrasesFor([id])[0]), 1, `${id} appears exactly once`);
    for (const bad of FORBIDDEN) assert.ok(!text.includes(bad), `${format} must not contain ${JSON.stringify(bad)}`);
    for (const good of REQUIRED) assert.ok(text.replace(/\s+/g, ' ').includes(good), `${format} should contain ${JSON.stringify(good)}`);
  });

  test(`${format}: verifyExport accepts the export of the same manuscript`, async () => {
    const root = copyBook();
    const manuscript = await assembleManuscript(root, {});
    const out = await exportBook(root, format, {});
    const v = await verifyExport(out.bytes, format, manuscript);
    assert.deepEqual(v.problems, []);
    assert.equal(v.ok, true);
  });
}

test('pdf: characters outside WinAnsi (kana, emoji) become "?" with exactly one warning that lists them', async () => {
  const out = await exportBook(copyBook(), 'pdf', {});
  assert.equal(out.warnings.length, 1, JSON.stringify(out.warnings));
  assert.match(out.warnings[0], /潮|U\+6F6E|6f6e/i, 'names a kana/kanji character');
  assert.match(out.warnings[0], /\u{1F30A}|U\+1F30A|1f30a/iu, 'names the emoji');
  assert.ok(!out.warnings[0].includes('ë'), 'WinAnsi characters (e with diaeresis) are not listed');
});

test('markdown: Unicode survives as UTF-8 (curly quotes, em dash, kana, accents, emoji)', async () => {
  const out = await exportBook(copyBook(), 'markdown', {});
  const t = out.bytes.toString('utf8');
  for (const s of ['“Not tonight,”', 'forty, then forty-one — and', '潮が引く、そして戻る。', 'Zoë', 'café', '\u{1F30A}']) assert.ok(t.includes(s), s);
});
