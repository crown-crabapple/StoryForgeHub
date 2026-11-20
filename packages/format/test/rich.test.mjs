// The rich-document converter (docs/plans/phase2/design.md): lossless read for every string, and a write that never changes meaning.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RichSerializeError, docToMarkdown, markdownToDoc, normalizeDoc } from '../src/rich.mjs';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const roundTrip = (b) => docToMarkdown(markdownToDoc(b).doc);
const bodyOf = (text) => {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return m ? text.slice(m[0].length) : text;
};
function* markdownFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* markdownFiles(p);
    else if (e.name.endsWith('.md')) yield p;
  }
}

test('lossless read: every Markdown body in the fixtures writes back byte for byte', () => {
  let files = 0;
  let typed = 0;
  let raw = 0;
  for (const f of markdownFiles(FIXTURES)) {
    const body = bodyOf(fs.readFileSync(f, 'utf8'));
    const { doc, report } = markdownToDoc(body);
    assert.equal(docToMarkdown(doc), body, path.relative(FIXTURES, f));
    files++;
    raw += report.rawBlocks;
    typed += report.blocks - report.rawBlocks;
  }
  assert.ok(files > 100, `${files} files`);
  assert.ok(typed > raw * 10, `most blocks are typed (${typed} typed, ${raw} raw)`);
});

const CASES = [
  '',
  '\n',
  '\n\n\n',
  'One line.',
  'One line.\n',
  '\n\nLead and trail.\n\n\n',
  'Para one.\n\nPara two.\n',
  'Para one.\n\n\n\nPara two with a wide gap.',
  'Line one\nline two of the same paragraph.',
  'Trailing spaces  \nhard break.',
  '## Heading two\n\n### Three\n\n#### Four\n\n##### Five stays a paragraph',
  '# One stays a paragraph',
  '***',
  'Before.\n\n***\n\nAfter.',
  '> A quote\n> over two lines.',
  '- one\n- two\n- three',
  '* star\n* list',
  '1. first\n2. second',
  '3) third\n4) fourth',
  '1. not\n3. consecutive',
  'She said **bold** and *italic* and __under__ and _under_ and ~~gone~~ and `code`.',
  '*a **b** c*',
  '**a *b* c**',
  '***both***',
  'snake_case_words and 2 * 3 * 4 and a lone * star',
  'An unmatched **bold.',
  'Escapes: \\* \\_ \\[ \\] \\\\ \\` and a\\b backslash.',
  '[[maren-hollis]] met [[pell|Pell the cat]] at [[port-aldine]].',
  'Cite [@admiralty-tables] here, and a [link](https://example.org/x) there.',
  '[link with **bold** inside](https://example.org)',
  'Note <!-- note: check the tide tables --> inline.',
  '<!-- an opaque comment -->',
  '<!-- sf:anchor id=a1 -->Anchored text<!-- /sf:anchor -->',
  '<!-- a comment\nover two lines\n\nwith a blank one -->',
  'An image ![alt](cover.jpg) in text.',
  '```\ncode block\n\nwith a blank line\n```',
  'Footnote[^1].\n\n[^1]: The note.',
  '| a | b |\n|---|---|\n| 1 | 2 |',
  'Unicode: café — “quotes” 日本語 🌊',
  'Windows\r\nline endings\r\n\r\nhere.\r\n',
  'Mixed\r\nline\nendings',
  '   indented line',
  '\t\ttabs',
  'emoji at the end 🌊',
  '**bold <!-- note: inside --> still bold**',
  '[[a|b **c**]]',
  '`code with *stars*`',
  '<!-- note: -->',
  '- item with [[maren-hollis]] and *em*',
];

test('lossless read: hand-made bodies', () => {
  for (const b of CASES) assert.equal(roundTrip(b), b, JSON.stringify(b));
});

test('lossless read: random strings of Markdown-heavy characters', () => {
  const alphabet = ['a', 'b', ' ', '\n', '\n\n', '*', '**', '_', '__', '~~', '`', '[', ']', '(', ')', '[[', ']]', '|', '@', '#', '## ', '> ', '- ', '1. ', '\\', '<!--', '-->', ' note: ', '!', '***', '\r\n', 'é', '🌊'];
  let seed = 12345;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let i = 0; i < 4000; i++) {
    let s = '';
    const len = 1 + rnd(25);
    for (let k = 0; k < len; k++) s += alphabet[rnd(alphabet.length)];
    assert.equal(roundTrip(s), s, JSON.stringify(s));
  }
});

test('typed blocks: the common constructs are not kept raw', () => {
  const { doc, report } = markdownToDoc('## Title\n\nShe said **bold**, *it*, [[maren-hollis]], [@cite] <!-- note: n -->.\n\n***\n\n> quote\n\n- a\n- b\n');
  assert.deepEqual(doc.content.map((b) => b.type), ['heading', 'paragraph', 'horizontalRule', 'blockquote', 'bulletList']);
  assert.equal(report.rawBlocks, 0);
  assert.equal(report.rawInlines, 0);
  assert.equal(report.authorNotes, 1);
  assert.equal(report.cites, 1);
  assert.equal(report.mentions, 1);
  const p = doc.content[1].content;
  assert.deepEqual(p.find((n) => n.text === 'bold').marks, [{ type: 'bold', attrs: { delim: '**' } }]);
  assert.deepEqual(p.find((n) => n.text === 'maren-hollis').marks, [{ type: 'entityMention', attrs: { slug: 'maren-hollis', form: 'bare', state: 'confirmed' } }]);
});

test('mixed line endings: one raw block, read-only', () => {
  const { doc, report } = markdownToDoc('a\r\nb\nc');
  assert.equal(report.mixedEol, true);
  assert.equal(doc.attrs.readOnly, true);
  assert.equal(docToMarkdown(doc), 'a\r\nb\nc');
});

// ------------------------------------------------------------------------------------------- stable write: documents the editor made

const p = (...content) => ({ type: 'paragraph', content });
const t = (text, ...marks) => (marks.length ? { type: 'text', text, marks } : { type: 'text', text });
const doc = (...content) => ({ type: 'doc', attrs: { lead: '', trail: '\n', eol: 'lf' }, content });

test('stable write: typed asterisks, hashes and brackets are escaped, and read back as typed', () => {
  for (const text of ['2 **not bold** 3', '# not a heading', '- not a list', '1. not a list', '[not a link](x)', '[[not-a-mention]]', '<!-- not a comment -->', '***', '> not a quote', 'back\\slash *']) {
    const d = doc(p(t(text)));
    const md = docToMarkdown(d);
    assert.deepEqual(normalizeDoc(markdownToDoc(md).doc), normalizeDoc(d), `${JSON.stringify(text)} -> ${JSON.stringify(md)}`);
  }
});

test('stable write: new marks from the editor (no delim attrs) get the default delimiters', () => {
  const md = docToMarkdown(doc(p(t('a '), t('b', { type: 'bold' }), t(' '), t('c', { type: 'italic' }), t(' '), t('d', { type: 'bold' }, { type: 'italic' }))));
  assert.equal(md, 'a **b** *c* ***d***\n');
});

test('stable write: new paragraphs get a blank line, empty paragraphs vanish', () => {
  assert.equal(docToMarkdown(doc(p(t('one')), p(), p(t('two')))), 'one\n\ntwo\n');
});

test('stable write: a soft line break inside a paragraph', () => {
  assert.equal(docToMarkdown(doc(p(t('one'), { type: 'hardBreak' }, t('two')))), 'one\ntwo\n');
});

test('stable write: what cannot be written refuses instead of changing the text', () => {
  const bad = [
    doc({ type: 'heading', attrs: { level: 2 }, content: [t('a'), { type: 'hardBreak' }, t('b')] }),
    doc(p(t('x', { type: 'code' }), t('`'), t('y', { type: 'code' }))).content[0].content[0].text === 'x' ? doc(p(t('a`b', { type: 'code' }))) : null,
    doc(p({ type: 'authorNote', attrs: { text: 'a --> b' } })),
    doc(p(t('x', { type: 'link', attrs: { href: 'has space' } }))),
    doc({ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('a')), p(t('b'))] }] }),
    doc(p(t('one'), { type: 'hardBreak' }, t('   '), { type: 'hardBreak' }, t('two'))),
  ];
  for (const d of bad) assert.throws(() => docToMarkdown(d), RichSerializeError, JSON.stringify(d.content));
});

test('editing a read document: change one word, only that word changes', () => {
  const body = 'Para one stays.\n\nShe said **bold** and [[maren-hollis]].\n\n***\n\nLast.\n';
  const { doc: d } = markdownToDoc(body);
  const edited = structuredClone(d);
  edited.content[1].content[0].text = 'He said ';
  assert.equal(docToMarkdown(edited), body.replace('She said', 'He said'));
});
