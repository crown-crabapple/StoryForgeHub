// The Read view's rich renderer: a schema v1 document -> React elements (src/rich/render.js). No DOM: static markup.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { markdownToDoc } from '@storyforge/format/rich';
import { renderRich } from '../src/rich/render.js';

const html = (doc, opts) => renderToStaticMarkup(h('div', null, ...renderRich(doc, opts)));
const md = (body, opts) => html(markdownToDoc(body).doc, opts);
const text = (s) => s.replace(/<[^>]*>/g, '');

describe('blocks', () => {
  test('paragraph, headings 2-4, quote, hr', () => {
    const out = md('Plain.\n\n## Two\n\n### Three\n\n#### Four\n\n> said\n\n***');
    assert.match(out, /<p>Plain\.<\/p>/);
    assert.match(out, /<h2>Two<\/h2>/);
    assert.match(out, /<h3>Three<\/h3>/);
    assert.match(out, /<h4>Four<\/h4>/);
    assert.match(out, /<blockquote><p>said<\/p><\/blockquote>/);
    assert.match(out, /<hr class="read-break"\/>/);
  });
  test('bullet list and ordered list honouring start', () => {
    assert.match(md('- a\n- b'), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
    assert.match(md('1. a\n2. b'), /<ol><li>a<\/li><li>b<\/li><\/ol>/);
    assert.match(md('3. a\n4. b'), /<ol start="3"><li>a<\/li><li>b<\/li><\/ol>/);
  });
  test('rawBlock text is shown verbatim', () => {
    const out = md('```\ncode **here**\n```');
    assert.match(out, /<pre class="rich-raw">```\ncode \*\*here\*\*\n```<\/pre>/);
  });
});

describe('inline', () => {
  test('bold, italic, strike, code', () => {
    const out = md('**b** *i* ~~s~~ `c`');
    assert.equal(out, '<div><p><strong>b</strong> <em>i</em> <s>s</s> <code>c</code></p></div>');
  });
  test('links: web opens a new tab, relative does not, unsafe is plain text', () => {
    assert.match(md('[x](https://e.com)'), /<a href="https:\/\/e.com" target="_blank" rel="noopener noreferrer">x<\/a>/);
    const rel = md('[x](/a)');
    assert.match(rel, /<a href="\/a" rel="noopener noreferrer">x<\/a>/);
    assert.doesNotMatch(rel, /target/);
    assert.equal(text(md('[x](javascript:alert)')), 'x');
    assert.doesNotMatch(md('[x](javascript:alert)'), /<a /);
  });
  test('mentions show their text only', () => {
    const out = md('See [[ana-ruiz|Ana]] and [[bo]].');
    assert.match(out, /<span class="mention" title="ana-ruiz">Ana<\/span>/);
    assert.match(out, /<span class="mention" title="bo">bo<\/span>/);
    assert.equal(text(out), 'See Ana and bo.');
  });
  test('cite shows [key]', () => {
    assert.match(md('Fact [@smith2020].'), /<span class="rich-cite">\[smith2020\]<\/span>/);
  });
  test('rawInline is shown as written', () => {
    assert.match(md('a ![alt](x.png) b'), /<span class="rich-raw">!\[alt\]\(x\.png\)<\/span>/);
  });
  test('soft break is a space, hard break is br', () => {
    assert.equal(md('one\ntwo'), '<div><p>one two</p></div>');
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak', attrs: { soft: false } }, { type: 'text', text: 'b' }] }] };
    assert.equal(html(doc), '<div><p>a<br/>b</p></div>');
  });
});

describe('author notes', () => {
  const src = 'Before <!-- note: fix this --> after.';
  test('hidden by default', () => {
    assert.equal(text(md(src)), 'Before  after.');
    assert.doesNotMatch(md(src), /fix this/);
  });
  test('shown when showNotes', () => {
    assert.match(md(src, { showNotes: true }), /<span class="rich-note">fix this<\/span>/);
  });
  test('a paragraph holding only a hidden note is dropped', () => {
    assert.equal(md('<!-- note: only -->\n\nText'), '<div><p>Text</p></div>');
  });
});

describe('no Markdown syntax in typed constructs', () => {
  test('rendered text has none of it', () => {
    const out = text(md('## Title\n\n**bold** and *it* with [[slug|Label]] and [[bare]]\n\n> quote\n\n- item\n\n***\n\nEnd <!-- note: n -->'));
    for (const s of ['**', '[[', '<!--', '#', '> ', '- ', '***']) assert.ok(!out.includes(s), `found ${s} in ${out}`);
  });
});

test('HTML comments (sf:anchor, opaque, multi-line) show only with the notes, never as prose', () => {
  const body = 'A <!-- sf:anchor id=a1 -->marked<!-- /sf:anchor --> word.\n\n<!-- an opaque\n\ncomment -->\n\nAfter.';
  const off = md(body, { showNotes: false });
  assert.doesNotMatch(off, /&lt;!--|sf:anchor|opaque/);
  assert.match(text(off), /A marked word\./);
  const on = md(body, { showNotes: true });
  assert.match(on, /sf:anchor/);
  assert.match(on, /opaque/);
});
