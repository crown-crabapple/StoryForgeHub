// The Codex details pane draws each entry section as Markdown (MarkdownView): lists, emphasis, headings, tables, quotes and code become HTML elements,
// [[links]] open the entry, web links open in a new tab, and nothing in the text is ever drawn as raw HTML or fetched.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const webDir = fileURLToPath(new URL('..', import.meta.url));
let vite;
let md;
let inspector;

before(async () => {
  vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  md = await vite.ssrLoadModule('/src/MarkdownView.jsx');
  inspector = await vite.ssrLoadModule('/src/codex/EntryInspector.jsx');
});
after(async () => {
  await vite?.close();
});

const ENTRIES = { maren: { id: 'ent_maren', name: 'Maren Hollis' }, 'port-aldine': { id: 'ent_port', name: 'Port Aldine' } };
const resolve = (ref) => ENTRIES[ref] ?? null;
const entryHref = (id) => `/books/b1/codex?entry=${id}`;
const render = (source, props = {}) => renderToStaticMarkup(h(md.MarkdownView, { source, resolve, entryHref, ...props }));

describe('MarkdownView', () => {
  test('bullet lists, nested lists and emphasis become elements; no Markdown marks are left', () => {
    const html = render('- **Role:** the *heir* of ~~nothing~~\n- Lives in town\n  - nested item\n\nAfter the list.');
    assert.match(html, /^<div class="md"><ul><li><p><strong>Role:<\/strong> the <em>heir<\/em> of <del>nothing<\/del><\/p><\/li><li><p>Lives in town<\/p><ul><li><p>nested item<\/p><\/li><\/ul><\/li><\/ul><p>After the list.<\/p><\/div>$/);
    assert.ok(!/\*\*|~~|^- /m.test(html));
  });

  test('numbered lists keep their start; a soft line break joins the paragraph', () => {
    const html = render('3. three\n4. four\n\nline one\nline two');
    assert.match(html, /<ol start="3"><li><p>three<\/p><\/li><li><p>four<\/p><\/li><\/ol>/);
    assert.match(html, /<p>line one\nline two<\/p>/);
  });

  test('headings start one level below the section heading, with inline marks and spaces kept', () => {
    const html = render('### History of **the** town ###\n\n#### Detail');
    assert.match(html, /<h4 class="md-heading">History of <strong>the<\/strong> town<\/h4>/);
    assert.match(html, /<h5 class="md-heading">Detail<\/h5>/);
  });

  test('[[links]] open the entry with its label or name; unknown ones stay plain', () => {
    const html = render('Met [[maren]] at [[port-aldine|the port]] and [[nobody]].');
    assert.match(html, /<a href="\/books\/b1\/codex\?entry=ent_maren" class="codex-link" title="maren">Maren Hollis<\/a>/);
    assert.match(html, /<a href="\/books\/b1\/codex\?entry=ent_port"[^>]*>the port<\/a>/);
    assert.ok(html.includes('<span class="prose-link" title="nobody">nobody</span>'), html);
    assert.ok(!html.includes('[['));
  });

  test('a cross-book link uses linkOf', () => {
    const html = render('See [[other:ilse]].', { linkOf: (ref) => (ref === 'other:ilse' ? { href: '/books/b2/codex?entry=x', name: 'Ilse' } : null) });
    assert.match(html, /<a href="\/books\/b2\/codex\?entry=x"[^>]*>Ilse<\/a>/);
  });

  test('web links open in a new tab; other targets and images are text only', () => {
    const html = render('[map](https://example.org/map) [file](file:///etc/passwd) [js](javascript:alert(1)) ![portrait](assets/a.png) <https://example.org/x>');
    assert.ok(html.includes('<a class="md-link" href="https://example.org/map" target="_blank" rel="noopener noreferrer">map</a>'), html);
    assert.ok(html.includes('<a class="md-link" href="https://example.org/x" target="_blank" rel="noopener noreferrer">https://example.org/x</a>'), html);
    assert.equal((html.match(/<a /g) ?? []).length, 2, 'only the two web links are links');
    assert.ok(!html.includes('<img'), 'images are never loaded');
    assert.ok(html.includes('portrait'));
    assert.ok(!/href="(file|javascript):/.test(html));
  });

  test('raw HTML is shown as text, never as markup', () => {
    const html = render('<script>alert(1)</script>\n\nA <b onclick="x()">tag</b>.');
    assert.ok(!html.includes('<script>') && !html.includes('<b '), html);
    assert.ok(html.includes('&lt;script&gt;'), html);
  });

  test('tables, task lists, quotes, rules, code and comments', () => {
    const html = render('| Year | Event |\n|---|---|\n| 812 | **Flood** |\n\n- [x] done\n- [ ] open\n\n> quoted\n\n---\n\n`code` and\n\n```\nblock\n```\n\n<!-- note: later -->');
    assert.match(html, /<table class="md-table"><thead><tr><th>Year<\/th><th>Event<\/th><\/tr><\/thead><tbody><tr><td>812<\/td><td><strong>Flood<\/strong><\/td><\/tr><\/tbody><\/table>/);
    assert.match(html, /<li><p class="md-task"><input type="checkbox"[^>]*aria-label="Done" checked=""\/> done<\/p><\/li><li><p class="md-task"><input type="checkbox"[^>]*aria-label="Not done"\/> open<\/p>/);
    assert.match(html, /<input type="checkbox" disabled=""/);
    assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
    assert.ok(html.includes('<hr/>'));
    assert.ok(html.includes('<code class="prose-code-inline">code</code>'));
    assert.match(html, /<pre class="prose-code"><code>block<\/code><\/pre>/);
    assert.ok(html.includes('<p class="prose-comment">&lt;!-- note: later --&gt;</p>'));
  });

  test('empty and missing text render an empty container', () => {
    assert.equal(render(''), '<div class="md"></div>');
    assert.equal(render(undefined), '<div class="md"></div>');
  });
});

describe('EntryInspector draws sections as Markdown', () => {
  test('a section with a list and bold shows elements, and its [[link]] opens the entry', () => {
    const entry = { id: 'ent_1', name: 'Tobin', type: 'character', status: 'draft', sections: [{ heading: 'Overview', markdown: '- **Role:** friend of [[maren]]\n- *Quiet*' }] };
    const html = renderToStaticMarkup(h(inspector.EntryInspector, { bookId: 'b1', entry, resolve: (ref) => (ref === 'maren' ? { id: 'ent_maren', name: 'Maren Hollis' } : null) }));
    assert.match(html, /<h3>Overview<\/h3><div class="codex-section-text"><div class="md"><ul><li><p><strong>Role:<\/strong> friend of <a [^>]*href="\/books\/b1\/codex\?entry=ent_maren"[^>]*>Maren Hollis<\/a><\/p><\/li><li><p><em>Quiet<\/em><\/p><\/li><\/ul><\/div><\/div>/);
  });
});
