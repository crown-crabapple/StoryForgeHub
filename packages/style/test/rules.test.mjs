// M13-J03 §2: each rule with positive, negative and edge fixtures, through checkStyle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkStyle, STYLE_RULE_IDS } from '../src/index.mjs';
import { applyAll, check, only, SCENE, SHA } from './helpers.mjs';

const TERMS = { terms: [{ use: 'grey', avoid: ['gray', 'grayish'] }] };

test('preferred-terms: whole word, case copied, accented words, not inside other words', async () => {
  const body = 'Gray skies, gray sea, grayish haze, a stingray, 😀 gray. Gray’s coat. GRAY.';
  const f = await check(body, only('preferred-terms', TERMS));
  assert.deepEqual(f.map((x) => x.original), ['Gray', 'gray', 'grayish', 'gray', 'Gray', 'GRAY']);
  assert.deepEqual(f.map((x) => x.replacements[0]), ['Grey', 'grey', 'grey', 'grey', 'Grey', 'Grey']);
  assert.ok(f.every((x) => x.category === 'terminology' && x.severity === 'warning' && x.advisory === false && x.ruleId === 'preferred-terms'));
});

test('preferred-terms: accented and non-ASCII letters count as word characters', async () => {
  const settings = only('preferred-terms', { terms: [{ use: 'café', avoid: ['cafe'] }] });
  assert.deepEqual((await check('A cafe. Cafeteria, cafés, Café.', settings)).map((x) => x.original), ['cafe']);
  const accent = only('preferred-terms', { terms: [{ use: 'Zoe', avoid: ['Zoë'] }] });
  const f = await check('Zoë and Zoëy.', accent);
  assert.deepEqual(f.map((x) => [x.original, x.replacements[0]]), [['Zoë', 'Zoe']]);
});

test('preferred-terms: caseSensitive on a term, no terms, regex characters in terms are literal', async () => {
  const cs = only('preferred-terms', { terms: [{ use: 'Mum', avoid: ['mom'], caseSensitive: true }] });
  assert.deepEqual((await check('mom and Mom', cs)).map((x) => x.original), ['mom']);
  assert.deepEqual(await check('gray gray', only('preferred-terms', {})), []);
  const lit = only('preferred-terms', { terms: [{ use: 'ok', avoid: ['a.c', 'o(k'] }] });
  assert.deepEqual(await check('abc a.c o(k', lit).then((r) => r.map((x) => x.original)), ['a.c', 'o(k']);
});

test('repeated-words: same word twice, one line break allowed, punctuation not', async () => {
  const f = await check('She said that that was the the end.\nThe\nthe door. Very, very good. Had HAD it.', only('repeated-words'));
  assert.deepEqual(f.map((x) => x.original), ['that that', 'the the', 'The\nthe', 'Had HAD']);
  assert.deepEqual(f.map((x) => x.replacements), [['that'], ['the'], ['The'], ['Had']]);
  assert.ok(f.every((x) => x.category === 'repetition' && x.severity === 'warning' && !x.advisory));
  assert.deepEqual(await check('Very, very good. Wait... wait. The\n\nthe end.', only('repeated-words')), []);
});

test('repeated-words: not a part of a longer word, emoji before, accents, CRLF-origin text', async () => {
  assert.deepEqual(await check('Theater the other. A banana nana.', only('repeated-words')), []);
  const emoji = await check('😀 Zoë said that that was fine.', only('repeated-words'));
  assert.deepEqual(emoji.map((x) => x.original), ['that that']);
  assert.equal(emoji[0].range.from, '😀 Zoë said '.length);
  const accent = await check('Très très bien.', only('repeated-words'));
  assert.deepEqual(accent.map((x) => x.replacements[0]), ['Très']);
  const lf = 'one\r\ntwo two\r\nthree'.replace(/\r\n/g, '\n');
  assert.deepEqual((await check(lf, only('repeated-words'))).map((x) => x.original), ['two two']);
});

test('repeated-words: emphasis, links and notes around the word', async () => {
  // a marker between the words leaves hidden text inside the range: no replacement can be offered, so no finding
  assert.deepEqual(await check('It was *very* very good.', only('repeated-words')), []);
  assert.deepEqual(await check('It was the [the](http://x.test) end.', only('repeated-words')), []);
  // emphasis outside the pair is fine
  assert.deepEqual((await check('It was *the the* end.', only('repeated-words'))).map((x) => x.original), ['the the']);
  // inside a note or code: nothing
  assert.deepEqual(await check('Before <!-- the the --> after `the the` done.\n\n```\nthe the\n```\n', only('repeated-words')), []);
});

test('punctuation: nothing is checked until a style is chosen', async () => {
  assert.deepEqual(await check('"Hi" -- he said... \'ok\'', only('punctuation')), []);
  assert.deepEqual(await check('"Hi" -- he said... \'ok\'', only('punctuation', { quotes: null, dashes: null, ellipsis: null })), []);
});

test('punctuation: curly quotes (opening, closing, apostrophe, after brackets and dashes)', async () => {
  const body = '"Don\'t," she said. (\'Hi\') — "Yes" he\'d said—"no."\n\'Tis "odd".';
  const f = await check(body, only('punctuation', { quotes: 'curly' }));
  assert.equal(applyAll(body, f), '“Don’t,” she said. (‘Hi’) — “Yes” he’d said—“no.”\n‘Tis “odd”.');
  assert.deepEqual(await check('“Already” ‘curly’ ’s', only('punctuation', { quotes: 'curly' })), []);
});

test('punctuation: straight quotes', async () => {
  const body = '“Don’t,” she said. ‘Hi’';
  const f = await check(body, only('punctuation', { quotes: 'straight' }));
  assert.equal(applyAll(body, f), '"Don\'t," she said. \'Hi\'');
  assert.deepEqual(await check('"plain" \'plain\'', only('punctuation', { quotes: 'straight' })), []);
});

test('punctuation: dashes in each style', async () => {
  const body = 'He ran--fast. She - slow. They – late. Wait—what. Pages 10–20. Rest --- done.';
  const em = await check(body, only('punctuation', { dashes: 'em' }));
  assert.equal(applyAll(body, em), 'He ran—fast. She—slow. They—late. Wait—what. Pages 10–20. Rest—done.');
  const spaced = await check(body, only('punctuation', { dashes: 'em-spaced' }));
  assert.equal(applyAll(body, spaced), 'He ran — fast. She — slow. They — late. Wait — what. Pages 10–20. Rest — done.');
  const en = await check(body, only('punctuation', { dashes: 'en-spaced' }));
  assert.equal(applyAll(body, en), 'He ran – fast. She – slow. They – late. Wait – what. Pages 10–20. Rest – done.');
  assert.deepEqual(await check('A — B', only('punctuation', { dashes: 'em-spaced' })), []);
  assert.deepEqual(await check('A – B', only('punctuation', { dashes: 'en-spaced' })), []);
  assert.deepEqual(await check('A—B', only('punctuation', { dashes: 'em' })), []);
});

test('punctuation: hyphens, rules and line-edge dashes are not dashes', async () => {
  assert.deepEqual(await check('A well-known fact.\n\n---\n\n- item\n\n----', only('punctuation', { dashes: 'em' })), []);
});

test('punctuation: ellipsis in each style', async () => {
  const chars = await check('Wait... what.... Hmm…', only('punctuation', { ellipsis: 'character' }));
  assert.deepEqual(chars.map((x) => [x.original, x.replacements[0]]), [['...', '…']]);
  const dots = await check('Wait... what.... Hmm…', only('punctuation', { ellipsis: 'dots' }));
  assert.deepEqual(dots.map((x) => [x.original, x.replacements[0]]), [['…', '...']]);
});

test('punctuation: a quote next to emoji and inside code or notes', async () => {
  const body = '😀"Hi" and `"code"` <!-- "note" -->';
  const f = await check(body, only('punctuation', { quotes: 'curly' }));
  assert.deepEqual(f.map((x) => x.range.from), [2, 5]);
  assert.deepEqual(f.map((x) => x.replacements[0]), ['”', '”']);
});

test('punctuation: a replacement is never offered over a placeholder', async () => {
  // the quote opens right after inline code: the finding itself is on a plain quote and stays whole
  const f = await check('`x`"hi"', only('punctuation', { quotes: 'curly' }));
  assert.deepEqual(f.map((x) => x.original), ['"', '"']);
});

test('repeated-phrases: off by default, on finds a repeat within the window, never in common words, never across paragraphs', async () => {
  const body = 'The old lighthouse keeper walked down the long road. Then the old lighthouse keeper walked down the long road again.';
  assert.deepEqual(await check(body, undefined), []);
  const f = await check(body, only('repeated-phrases'));
  assert.equal(f.length, 1);
  assert.equal(f[0].original, 'the old lighthouse keeper walked down the long');
  assert.equal(f[0].advisory, true);
  assert.equal(f[0].severity, 'info');
  assert.equal(f[0].category, 'repetition');
  assert.deepEqual(f[0].replacements, []);
  assert.deepEqual(f[0].related, [{ sceneId: SCENE, from: 0, to: 46, text: 'The old lighthouse keeper walked down the long' }]);

  assert.deepEqual(await check('It was all of it and I was in it. Then it was in the end of it.', only('repeated-phrases')), [], 'common words only');
  assert.deepEqual(await check('Blue bird sings songs.\n\nBlue bird sings songs.', only('repeated-phrases')).then((r) => r.length), 1, 'paragraphs are not a break between two occurrences');
  assert.deepEqual(await check('Blue bird sings\n\nsongs. Blue bird sings songs.', only('repeated-phrases')), [], 'a phrase never runs across a paragraph break');
});

test('repeated-phrases: minWords and window', async () => {
  const filler = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
  const body = `Crimson tide rolls in. ${filler} Crimson tide rolls in.`;
  assert.equal((await check(body, only('repeated-phrases', { minWords: 4, window: 300 }))).length, 1);
  assert.equal((await check(body, only('repeated-phrases', { minWords: 4, window: 50 }))).length, 0);
  assert.equal((await check(body, only('repeated-phrases', { minWords: 5, window: 300 }))).length, 0);
  assert.equal((await check('Crimson tide rolls. x Crimson tide rolls.', only('repeated-phrases', { minWords: 3 }))).length, 1);
});

test('long-paragraphs: off by default; over maxWords only', async () => {
  const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
  const body = `${long}\n\nShort one.`;
  assert.deepEqual(await check(body, undefined), []);
  const f = await check(body, only('long-paragraphs', { maxWords: 50 }));
  assert.equal(f.length, 1);
  assert.equal(f[0].original, long);
  assert.equal(f[0].category, 'rhythm');
  assert.equal(f[0].advisory, true);
  assert.deepEqual(await check(body, only('long-paragraphs', { maxWords: 60 })), []);
});

test('isolated-lines: runs of short one-line paragraphs only', async () => {
  const lines = Array.from({ length: 6 }, (_, i) => `Line ${i} here.`);
  const body = `${lines.join('\n\n')}\n\nA long enough paragraph follows here. It has two lines\nof words.`;
  assert.deepEqual(await check(body, undefined), []);
  const f = await check(body, only('isolated-lines'));
  assert.equal(f.length, 1);
  assert.equal(f[0].original, lines.join('\n\n'));
  assert.equal(f[0].category, 'rhythm');
  assert.deepEqual(await check(lines.slice(0, 5).join('\n\n'), only('isolated-lines')), []);
  assert.equal((await check(lines.slice(0, 3).join('\n\n'), only('isolated-lines', { minRun: 3 }))).length, 1);
  const wordy = Array.from({ length: 6 }, () => 'one two three four five six seven eight nine ten eleven twelve').join('\n\n');
  assert.deepEqual(await check(wordy, only('isolated-lines')), [], 'twelve words is not short');
});

test('defaults: only preferred-terms, repeated-words and punctuation are on; the others are silent until enabled', async () => {
  const long = Array.from({ length: 300 }, () => 'word').join(' ');
  const body = `${long}\n\nThe old lighthouse keeper walked down the long road. The old lighthouse keeper walked down the long road.\n\n${Array.from({ length: 8 }, () => 'Hi.').join('\n\n')}`;
  const f = await check(body, undefined);
  assert.deepEqual([...new Set(f.map((x) => x.ruleId))], ['repeated-words']);
  for (const id of ['repeated-phrases', 'long-paragraphs', 'isolated-lines']) assert.ok(!f.some((x) => x.ruleId === id), `${id} is silent`);
  assert.ok(f.length > 0, 'repeated-words fires on "word word" in the default run');
  for (const id of ['repeated-phrases', 'long-paragraphs', 'isolated-lines']) {
    const on = await check(body, only(id));
    assert.ok(on.length > 0 && on.every((x) => x.ruleId === id), `${id} fires once enabled`);
  }
});

test('unknown rule ids in settings are ignored, never loaded', async () => {
  const settings = { rules: { 'textlint-rule-anything': { enabled: true }, '../../evil': { enabled: true }, 'repeated-words': { enabled: true } } };
  const f = await check('The the end.', settings);
  assert.deepEqual(f.map((x) => x.ruleId), ['repeated-words']);
  assert.deepEqual(STYLE_RULE_IDS, ['preferred-terms', 'repeated-words', 'punctuation', 'repeated-phrases', 'long-paragraphs', 'isolated-lines']);
});

test('an empty body or one with no prose gives no findings; sorted by range', async () => {
  assert.deepEqual(await checkStyle({ sceneId: SCENE, body: '', settings: undefined, sha256: SHA }), []);
  assert.deepEqual(await check('<!-- the the -->', undefined), []);
  const f = await check('b b a a', undefined);
  assert.deepEqual(f.map((x) => x.range.from), [0, 4]);
});
