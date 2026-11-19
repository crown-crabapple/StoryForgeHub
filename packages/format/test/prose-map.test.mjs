// M13-J01: prose projection and offset conversion. Every mapping test asserts body.slice(range.from, range.to) is the expected word.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectProse, toBodyRange, isWholeRange, codePointToUtf16, utf8ToUtf16, lineColumnToUtf16, lfOffsetToRaw, rawOffsetToLf,
} from '../src/index.mjs';

/** Find `word` in the projected text, map it back, and assert the body holds exactly `word` there. */
function mapWord(body, word, expectedText) {
  const proj = projectProse(body);
  const at = proj.text.indexOf(word);
  assert.notEqual(at, -1, `"${word}" is in the projected text ${JSON.stringify(proj.text)}`);
  const range = toBodyRange(proj, at, at + word.length);
  assert.ok(range, 'a range');
  assert.equal(body.slice(range.from, range.to), word);
  if (expectedText !== undefined) assert.equal(proj.text, expectedText);
  return { proj, range };
}

test('plain text projects to itself and map is the identity plus one', () => {
  const { proj } = mapWord('Hello brave world.', 'brave', 'Hello brave world.');
  assert.equal(proj.map.length, proj.text.length + 1);
  assert.equal(proj.map[proj.text.length], 18);
  assert.ok(proj.map instanceof Int32Array);
});

test('empty body projects to empty text with map [0]', () => {
  const p = projectProse('');
  assert.equal(p.text, '');
  assert.deepEqual([...p.map], [0]);
  assert.equal(toBodyRange(p, 0, 0), null);
});

test('emphasis, strong, underscore and strikethrough markers are dropped', () => {
  mapWord('A *quiet* day.', 'quiet', 'A quiet day.');
  mapWord('A **loud** day.', 'loud', 'A loud day.');
  mapWord('A __loud__ day.', 'loud', 'A loud day.');
  mapWord('A _soft_ day.', 'soft', 'A soft day.');
  mapWord('A ~~gone~~ day.', 'gone', 'A gone day.');
  mapWord('A ***both*** day.', 'both', 'A both day.');
});

test('markers with space on both sides and intraword underscores are kept', () => {
  assert.equal(projectProse('2 * 3 = 6').text, '2 * 3 = 6');
  assert.equal(projectProse('use snake_case_name here').text, 'use snake_case_name here');
});

test('a range over emphasised text maps to the inner body span', () => {
  mapWord('The *very quiet* room.', 'very quiet');
});

test('links keep the label and drop the destination', () => {
  const body = 'See [the label](https://x.test/a) now.';
  mapWord(body, 'the label', 'See the label now.');
  mapWord(body, 'now', 'See the label now.');
  mapWord('Go [a](https://x.test/a) b [c](https://x.test/b) end', 'end');
  mapWord('Go [wiki](https://x.test/a_(b)) end', 'end', 'Go wiki end');
  mapWord('[label](https://x.test/a)', 'label', 'label');
});

test('images become one placeholder, alt text dropped', () => {
  const body = 'Before ![alt text](a.png) after.';
  mapWord(body, 'after', 'Before X after.');
  assert.ok(!projectProse(body).text.includes('alt'));
  assert.equal(projectProse('![a](b.png)').text, 'X');
});

test('inline code becomes one placeholder, including double-backtick spans', () => {
  mapWord('Run `npm test` today.', 'today', 'Run X today.');
  mapWord('Run ``a ` b`` today.', 'today', 'Run X today.');
  assert.equal(projectProse('a ` b').text, 'a ` b', 'an unclosed backtick is kept');
});

test('fenced code blocks (``` and ~~~) are dropped whole', () => {
  const body = 'Before\n```js\nconst wrong = 1;\n```\nAfter word.';
  const { proj } = mapWord(body, 'After', 'Before\n\nAfter word.');
  assert.ok(!proj.text.includes('wrong'));
  mapWord('One\n~~~\ncode here\n~~~\nTwo', 'Two');
  assert.equal(projectProse('Intro\n```\nnever closed\nstill code').text, 'Intro\n');
});

test('HTML comments, including scene notes, are never prose', () => {
  const body = 'Seen <!-- note: hidden --> here.\n<!--\nmulti\nline\n--> Done.';
  const { proj } = mapWord(body, 'here', 'Seen  here.\n Done.');
  assert.ok(!proj.text.includes('hidden'));
  mapWord(body, 'Done');
  assert.equal(projectProse('a <!-- open').text, 'a <!-- open', 'an unclosed comment is kept');
});

test('autolinks become a placeholder, reference definitions are dropped', () => {
  mapWord('Visit <https://x.test/a> soon.', 'soon', 'Visit X soon.');
  const body = 'Text here.\n[ref]: https://x.test/ref\nMore text.';
  const { proj } = mapWord(body, 'More', 'Text here.\n\nMore text.');
  assert.ok(!proj.text.includes('https'));
});

test('heading, list and blockquote markers are dropped at line start', () => {
  mapWord('# Heading', 'Heading', 'Heading');
  mapWord('### Third Level', 'Level', 'Third Level');
  mapWord('- list item', 'item', 'list item');
  mapWord('* star item\n+ plus item\n1. first\n2) second', 'second', 'star item\nplus item\nfirst\nsecond');
  mapWord('> quote text', 'text', 'quote text');
  mapWord('> > nested quote', 'quote', 'nested quote');
  mapWord('> - quoted item', 'item', 'quoted item');
  mapWord('Para one.\n\n# Title\n\nPara two.', 'Title', 'Para one.\n\nTitle\n\nPara two.');
});

test('markers mid-line are kept', () => {
  assert.equal(projectProse('a - b').text, 'a - b');
  assert.equal(projectProse('a > b').text, 'a > b');
  assert.equal(projectProse('#hashtag').text, '#hashtag');
});

test('backslash escapes drop the backslash and keep the character', () => {
  const body = '\\*escaped and \\_this\\_ and \\[x\\]';
  const { proj } = mapWord(body, 'escaped', '*escaped and _this_ and [x]');
  assert.equal(proj.text[0], '*');
  assert.equal(body.slice(proj.map[0], proj.map[0] + 1), '*');
  assert.equal(projectProse('a\\qb').text, 'a\\qb', 'a backslash before a letter stays');
});

test('surrogate pairs: a target word after an emoji maps exactly', () => {
  const body = '\u{1F600} Hello \u{1F600} *world* \u{1F600}';
  const { range } = mapWord(body, 'world');
  assert.equal(range.from, 13);
  const emoji = mapWord('say \u{1F600} now', '\u{1F600}');
  assert.equal(emoji.range.to - emoji.range.from, 2);
});

test('a range that splits a surrogate pair is widened at either end', () => {
  const body = 'a\u{1F600}b';
  const proj = projectProse(body);
  assert.deepEqual(toBodyRange(proj, 1, 2), { from: 1, to: 3 });
  assert.deepEqual(toBodyRange(proj, 2, 4), { from: 1, to: 4 });
  assert.equal(body.slice(1, 3), '\u{1F600}');
});

test('combining marks: a range ending between base and mark moves past the marks', () => {
  const body = 'We met Zoé at the café today.';
  const proj = projectProse(body);
  const at = proj.text.indexOf('Zoe');
  const range = toBodyRange(proj, at, at + 3);
  assert.equal(body.slice(range.from, range.to), 'Zoé');
  assert.equal(range.from, body.indexOf('Zoe'));
  const cafe = proj.text.indexOf('caf');
  const r2 = toBodyRange(proj, cafe, cafe + 4);
  assert.equal(body.slice(r2.from, r2.to), 'café');
  const r3 = toBodyRange(proj, cafe, cafe + 5);
  assert.equal(body.slice(r3.from, r3.to), 'café', 'a range already past the mark is unchanged');
});

test('combining marks with markup between base and mark still extend', () => {
  const body = '*Zoe*́ here';
  const proj = projectProse(body);
  const r = toBodyRange(proj, 0, 3);
  assert.equal(body.slice(r.from, r.to), 'Zoe*́');
});

test('precomposed accents and smart quotes map exactly', () => {
  const body = '“Café,” she said. ‘Zoë’ left.';
  mapWord(body, 'Café');
  mapWord(body, 'Zoë');
  mapWord(body, '“Café,”');
  mapWord(body, '‘Zoë’');
});

test('toBodyRange rejects empty and out of range input', () => {
  const p = projectProse('hello');
  assert.equal(toBodyRange(p, 2, 2), null);
  assert.equal(toBodyRange(p, 3, 2), null);
  assert.equal(toBodyRange(p, -1, 2), null);
  assert.equal(toBodyRange(p, 0, 6), null);
  assert.equal(toBodyRange(p, 0.5, 2), null);
  assert.deepEqual(toBodyRange(p, 0, 5), { from: 0, to: 5 });
});

test('a mixed scene maps each word back to itself', () => {
  const body = [
    '# Chapter *One*',
    '',
    '<!-- note: fix the ending -->',
    'The “detective” — **Zoé** — read the [letter](https://x.test/a) \u{1F600} twice.',
    '',
    '```',
    'not prose',
    '```',
    '',
    '> A quoted line with `code` inside.',
    '- last item with ![pic](p.png)tail',
  ].join('\n');
  for (const w of ['One', 'detective', 'letter', 'twice', 'quoted', 'inside', 'tail']) mapWord(body, w);
  const { proj } = mapWord(body, 'last item');
  assert.ok(!/not prose|fix the ending|https|code|pic/.test(proj.text));
});

test('codePointToUtf16', () => {
  assert.equal(codePointToUtf16('abc', 0), 0);
  assert.equal(codePointToUtf16('abc', 2), 2);
  assert.equal(codePointToUtf16('a\u{1F600}b', 1), 1);
  assert.equal(codePointToUtf16('a\u{1F600}b', 2), 3);
  assert.equal(codePointToUtf16('a\u{1F600}b', 3), 4);
  assert.equal(codePointToUtf16('a\u{1F600}b', 99), 4);
  assert.equal(codePointToUtf16('', 0), 0);
  const t = 'x\u{1F600}y';
  assert.equal(t.slice(codePointToUtf16(t, 2), codePointToUtf16(t, 3)), 'y');
});

test('utf8ToUtf16', () => {
  const t = 'aé€\u{1F600}b'; // 1 + 2 + 3 + 4 + 1 bytes; 1 + 1 + 1 + 2 + 1 units
  assert.equal(utf8ToUtf16(t, 0), 0);
  assert.equal(utf8ToUtf16(t, 1), 1);
  assert.equal(utf8ToUtf16(t, 2), 1, 'inside the e-acute rounds down');
  assert.equal(utf8ToUtf16(t, 3), 2);
  assert.equal(utf8ToUtf16(t, 5), 2, 'inside the euro sign rounds down');
  assert.equal(utf8ToUtf16(t, 6), 3);
  assert.equal(utf8ToUtf16(t, 8), 3, 'inside the emoji rounds down');
  assert.equal(utf8ToUtf16(t, 10), 5);
  assert.equal(utf8ToUtf16(t, 11), 6);
  assert.equal(utf8ToUtf16(t, 999), 6);
  assert.equal(utf8ToUtf16(t, -4), 0);
  assert.equal(t.slice(utf8ToUtf16(t, 10)), 'b');
});

test('lineColumnToUtf16', () => {
  const t = 'ab\ncd\n\n\u{1F600}x';
  assert.equal(lineColumnToUtf16(t, 1, 0), 0);
  assert.equal(lineColumnToUtf16(t, 1, 2), 2, 'end of line 1');
  assert.equal(lineColumnToUtf16(t, 1, 3), null);
  assert.equal(lineColumnToUtf16(t, 2, 1), 4);
  assert.equal(lineColumnToUtf16(t, 3, 0), 6, 'an empty line');
  assert.equal(lineColumnToUtf16(t, 4, 2), 9, 'columns count UTF-16 units');
  assert.equal(lineColumnToUtf16(t, 4, 3), 10);
  assert.equal(lineColumnToUtf16(t, 4, 4), null);
  assert.equal(lineColumnToUtf16(t, 5, 0), null);
  assert.equal(lineColumnToUtf16(t, 0, 0), null);
  assert.equal(lineColumnToUtf16(t, 1, -1), null);
  assert.equal(lineColumnToUtf16('x\n', 2, 0), 2, 'the empty line after a final break');
  assert.equal(lineColumnToUtf16('', 1, 0), 0);
});

test('lfOffsetToRaw and rawOffsetToLf against hand-computed values (CRLF)', () => {
  const raw = 'ab\r\ncd\r\n\r\nef'; // LF view: ab\ncd\n\nef
  assert.equal(raw.replace(/\r\n/g, '\n').length, 9);
  const table = [[0, 0], [1, 1], [2, 2], [3, 4], [4, 5], [5, 6], [6, 8], [7, 10], [8, 11], [9, 12]];
  for (const [lf, rw] of table) {
    assert.equal(lfOffsetToRaw(raw, lf), rw, `lf ${lf}`);
    assert.equal(rawOffsetToLf(raw, rw), lf, `raw ${rw}`);
  }
  assert.equal(rawOffsetToLf(raw, 3), 2, 'between CR and LF rounds down to before the break');
  assert.equal(rawOffsetToLf(raw, 999), 9);
  assert.equal(lfOffsetToRaw(raw, 999), raw.length);
});

test('lfOffsetToRaw and rawOffsetToLf on an LF body and with a lone CR', () => {
  assert.equal(lfOffsetToRaw('a\nb', 2), 2);
  assert.equal(rawOffsetToLf('a\nb', 2), 2);
  assert.equal(lfOffsetToRaw('a\rb\r\nc', 4), 5);
  assert.equal(rawOffsetToLf('a\rb\r\nc', 5), 4);
});

test('CRLF: project the LF view, map, then convert to raw offsets and slice the raw body', () => {
  const raw = '\u{1F600} one\r\n\r\nThe *target* word.\r\n';
  const lf = raw.replace(/\r\n/g, '\n');
  const proj = projectProse(lf);
  const at = proj.text.indexOf('target');
  const r = toBodyRange(proj, at, at + 6);
  assert.equal(lf.slice(r.from, r.to), 'target');
  assert.equal(raw.slice(lfOffsetToRaw(raw, r.from), lfOffsetToRaw(raw, r.to)), 'target');
});

test('M13-J02: [[target]] Codex links become a placeholder and [[target|label]] keeps only the label', () => {
  mapWord('Then [[Mara]] left.', 'left', 'Then X left.');
  const { proj } = mapWord('Then [[Mara|she]] left.', 'she', 'Then she left.');
  assert.equal(proj.text, 'Then she left.');
  mapWord('Then [[Mara|she]] left.', 'left');
  mapWord('[[Mara|the captain|x]] spoke', 'the captain|x', 'the captain|x spoke');
  mapWord('[[a]][[b|c]]d', 'd', 'Xcd');
  // an unclosed [[ and a [[ across a line break are kept as text
  assert.equal(projectProse('Open [[Mara never closes').text, 'Open [[Mara never closes');
  assert.equal(projectProse('x [[Ma\nra]] y').text, 'x [[Ma\nra]] y');
});

test('M13-J02: [@key] citations are dropped whole, offsets stay exact', () => {
  mapWord('As said [@smith2020] before.', 'before', 'As said X before.');
  mapWord('A [@a:b-1] B [@c2]', 'B', 'A X B X');
  // not a citation: whitespace in the key, or a link destination follows
  assert.equal(projectProse('x [@ no] y').text, 'x [@ no] y');
  assert.equal(projectProse('x [@k](u) y').text, 'x @k y');
});

test('placeholders: removed inline content the reader sees projects as one X mapped to its start', () => {
  const body = 'Past the dunes lay [[salt-orchard]], half under water.';
  const { proj } = mapWord(body, 'half', 'Past the dunes lay X, half under water.');
  assert.equal(proj.placeholders.length, proj.text.length);
  const x = proj.text.indexOf('X');
  assert.equal(proj.placeholders[x], 1);
  assert.equal(proj.map[x], body.indexOf('[['));
  assert.equal(proj.placeholders.reduce((a, b) => a + b, 0), 1);
  mapWord('Then `x` was typed.', 'was', 'Then X was typed.');
  assert.equal(projectProse('a [@key] b').text, 'a X b');
  assert.equal(projectProse('a <https://x.test/p> b').text, 'a X b');
  assert.equal(projectProse('a ![alt](s.png) b').text, 'a X b');
  const she = projectProse('Then [[a|she]] left.');
  assert.equal(she.text, 'Then she left.');
  assert.equal(she.placeholders.reduce((a, b) => a + b, 0), 0);
  assert.equal(projectProse('a <!-- note: hi --> b').text, 'a  b');
  assert.equal(projectProse('a <!-- note: hi --> b').placeholders.reduce((a, b) => a + b, 0), 0);
  assert.equal(projectProse('A *b* c [d](u) e').placeholders.reduce((a, b) => a + b, 0), 0);
});

test('isWholeRange is false over any placeholder and true over its neighbours', () => {
  const p = projectProse('Past the dunes lay [[salt-orchard]], half under water.');
  const x = p.text.indexOf('X');
  assert.equal(isWholeRange(p, x, x + 1), false);
  assert.equal(isWholeRange(p, x - 1, x), true, 'the space before');
  assert.equal(isWholeRange(p, x + 1, x + 2), true, 'the comma after');
  assert.equal(isWholeRange(p, x - 1, x + 1), false);
  assert.equal(isWholeRange(p, x, x + 2), false);
  assert.equal(isWholeRange(p, x - 4, x - 1), true, 'the word before');
  const { text, map } = p;
  assert.equal(isWholeRange({ text, map }, x, x + 1), true, 'a projection without placeholders is judged by contiguity only');
});

test('isWholeRange: true over unbroken body text, false across anything left out', () => {
  const body = 'Then `x` was *very* typed [here](https://a.test) now.';
  const p = projectProse(body);
  const at = (s) => p.text.indexOf(s);
  assert.equal(isWholeRange(p, at('was'), at('was') + 3), true);
  assert.equal(isWholeRange(p, at('very'), at('very') + 4), true);
  assert.equal(isWholeRange(p, at('Then'), at('Then') + 6), false, 'across the dropped code span');
  assert.equal(isWholeRange(p, at('very'), at('very') + 6), false, 'across the dropped emphasis marker');
  assert.equal(isWholeRange(p, at('here'), at('here') + 6), false, 'across the dropped link destination');
  assert.equal(isWholeRange(p, 3, 3), false);
  assert.equal(isWholeRange(p, -1, 2), false);
});
