// The Read view (the whole manuscript as one continuous page): its pure model, its address, and a static render of the page.
// Module: src/reading/model.js and src/reading/ReadView.jsx. No network: the scene texts arrive in the browser only.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { placeholderHeight, readingOrder, readingProgress, readingTime, withoutComments } from '../src/reading/model.js';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const sc = (id, title, word_count) => ({ id, title, word_count });
const BOOK = {
  id: 'book_1',
  title: 'The Salt Orchard',
  acts: [
    { act: 1, label: 'Act 1', title: 'Low Water', chapters: [
      { chapter: 0, label: 'Prologue', title: 'Before the Tide', scenes: [sc('P', 'Before the Tide', 500)] },
      { chapter: 1, label: 'Chapter 1', title: null, scenes: [sc('A', 'Arrival', 250), sc('K', '', 250)] },
      { chapter: 2, label: 'Chapter 2', title: null, scenes: [] },
    ] },
    { act: 2, label: 'Act 2', title: null, chapters: [{ chapter: 3, label: 'Chapter 3', title: 'Ferry', scenes: [sc('F', 'Ferry', 1000)] }] },
    { act: 3, label: 'Act 3', title: null, chapters: [] },
  ],
};

describe('reading model', () => {
  test('readingOrder: scenes in order with running words; empty chapters and acts are left out', () => {
    const o = readingOrder(BOOK);
    assert.deepEqual(o.scenes.map((s) => [s.id, s.before]), [['P', 0], ['A', 500], ['K', 750], ['F', 1000]]);
    assert.equal(o.words, 2000);
    assert.deepEqual(o.acts.map((a) => a.name), ['Act 1: Low Water', 'Act 2']);
    assert.deepEqual(o.acts[0].chapters.map((c) => c.name), ['Prologue: Before the Tide', 'Chapter 1']);
    assert.equal(o.scenes[2].title, 'Untitled scene');
  });

  test('readingOrder: a book with one act shows no act headings; an empty book has nothing', () => {
    const one = readingOrder({ acts: [BOOK.acts[0]] });
    assert.deepEqual(one.acts.map((a) => a.name), ['']);
    assert.deepEqual(readingOrder({ acts: [] }), { acts: [], scenes: [], words: 0 });
    assert.deepEqual(readingOrder(null).scenes, []);
  });

  test('readingProgress and readingTime', () => {
    const o = readingOrder(BOOK);
    assert.deepEqual(readingProgress(o, 'K'), { index: 3, total: 4, percent: 38, left: '5 min' });
    assert.deepEqual(readingProgress(o, 'P'), { index: 1, total: 4, percent: 0, left: '8 min' });
    assert.equal(readingProgress(o, 'nope'), null);
    assert.equal(readingTime(10), 'under a minute');
    assert.equal(readingTime(250 * 65), '1 h 5 min');
  });

  test('withoutComments drops notes to self and leaves the prose; placeholders keep a minimum height', () => {
    assert.equal(withoutComments('One.<!-- note: fix -->\nTwo <!-- x --> three.\n'), 'One.\nTwo  three.\n');
    assert.equal(withoutComments('First.\n\n<!-- note: a\nlong note -->\n\nSecond.\n'), 'First.\n\nSecond.\n');
    assert.equal(withoutComments('No notes.'), 'No notes.');
    assert.equal(placeholderHeight(0), 48);
    assert.equal(placeholderHeight(1000), 2400);
  });
});

describe('Read view render', () => {
  let vite;
  let ReadView;
  let model;
  before(async () => {
    vite = await createServer({ root: webDir, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
    ({ ReadView } = await vite.ssrLoadModule('/src/reading/ReadView.jsx'));
    model = await vite.ssrLoadModule('/src/planning/model.js');
  });
  after(() => vite?.close());

  test('?view=read is the Read view and keeps the scene; the switch lists it', () => {
    assert.equal(model.parseView('?view=read').view, 'read');
    assert.equal(model.viewHref('book_1', 'read'), '/books/book_1?view=read');
    assert.equal(model.viewHref('book_1', 'read', { scene: 'K' }), '/books/book_1?view=read&scene=K');
    assert.ok(model.VIEWS.some((v) => v.key === 'read' && v.label === 'Read'));
  });

  test('renders every chapter and scene in order, with breaks, Edit links and placeholders until the text arrives', () => {
    const html = renderToStaticMarkup(h(ReadView, { book: BOOK }));
    assert.match(html, /<h1>The Salt Orchard<\/h1>/);
    assert.match(html, /2,000 words · 4 scenes · about 8 min to read/);
    const order = [...html.matchAll(/data-read-scene="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['P', 'A', 'K', 'F']);
    assert.equal((html.match(/<hr class="read-break"\/>/g) ?? []).length, 1, 'a break only between scenes of one chapter');
    assert.match(html, /<h2 class="read-act-title">Act 1: Low Water<\/h2>/);
    assert.match(html, /<h3 class="read-chapter-title">Chapter 3: Ferry<\/h3>/);
    assert.match(html, /href="\/books\/book_1\?scene=K"/);
    assert.equal((html.match(/class="read-placeholder"/g) ?? []).length, 4);
    assert.match(html, /Scene 1 of 4/);
  });

  test('a book with no scenes says so', () => {
    const html = renderToStaticMarkup(h(ReadView, { book: { id: 'b', title: 'Empty', acts: [] } }));
    assert.match(html, /no scenes in its manuscript/);
  });
});
