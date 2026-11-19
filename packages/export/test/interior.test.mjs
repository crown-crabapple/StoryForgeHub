// M13-J05 section 3 and 8: the book interior document (html, css, report), pure and deterministic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assembleManuscript, renderInterior, parseUnicodeRanges, INTERIOR_FONT_FILES } from '../src/index.mjs';
import { renderEpub } from '../src/epub.mjs';
import { INTERIOR_DEFAULTS } from '@storyforge/format';
import { ORDER, PKG_ROOT, SCENES, cleanup, copyBook, decodeEntities, editScene, htmlText, normSpace, orderProblems, phrasesFor, readEpub, sha256 } from './helpers.mjs';

after(cleanup);

const FONTS_DIR = path.resolve(PKG_ROOT, '../../node_modules/@fontsource-variable');
const readCss = (family) => fs.readFileSync(path.join(FONTS_DIR, family, 'wght.css'), 'utf8');
const COVERAGE = { literata: parseUnicodeRanges(readCss('literata')), inter: parseUnicodeRanges(readCss('inter')) };

const stripTags = (html) => normSpace(decodeEntities(html.replace(/<[^>]+>/g, ' ')));
const sceneIdsIn = (html) => [...html.matchAll(/<div class="scene"(?: id="([^"]*)")?>/g)].map((m) => m[1]);
const cssBlock = (css, selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `css has ${selector}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unclosed ${selector}`);
};
const hasPageBlock = (css, selector) => css.includes(`${selector} {`);

/** A hand-built manuscript (the function is pure: no book folder needed). */
function manuscript(over = {}) {
  return {
    title: 'Tide & Salt',
    subtitle: 'A <novel>',
    author: 'A. Writer',
    parts: [{ label: 'Act 1', act: 1, title: '', chapters: [{ id: 'chap_X', label: 'Chapter One', title: 'Low', scenes: [{ id: 'scene_A', title: 'First', markdown: 'One *two* **three**.' }] }] }],
    excluded: [],
    slug: 'tide',
    bookId: 'book_X',
    language: 'en',
    modified: '2024-05-06T00:00:00Z',
    options: { excludeStatuses: [], sceneTitles: false, includeActs: false, titlePage: true, page: 'letter' },
    ...over,
  };
}

// ---------------------------------------------------------------- parseUnicodeRanges

test('parseUnicodeRanges: reads every unicode-range, merged and sorted', () => {
  const r = parseUnicodeRanges('@font-face { unicode-range: U+0041-005A, U+0061; }\n@font-face { unicode-range: U+005B-0060,U+0062,u+0064-0065,U+4??,U+1F600-1F64F; }\n/* unicode-range: U+9999; */');
  assert.deepEqual(r, [[0x41, 0x62], [0x64, 0x65], [0x400, 0x4ff], [0x1f600, 0x1f64f]]);
  assert.deepEqual(parseUnicodeRanges('body { color: red }'), []);
  assert.deepEqual(parseUnicodeRanges('unicode-range: U+ZZ, U+10-5, U+0030-0039;'), [[0x30, 0x39]]);
});

test('parseUnicodeRanges: the real fontsource CSS (all subsets, then only the served files)', () => {
  const covers = (ranges, cp) => ranges.some(([a, b]) => cp >= a && cp <= b);
  for (const family of ['literata', 'inter']) {
    const all = parseUnicodeRanges(readCss(family));
    assert.ok(all.length > 5);
    for (const [i, [a, b]] of all.entries()) {
      assert.ok(a <= b);
      if (i > 0) assert.ok(a > all[i - 1][1] + 1, 'sorted and merged');
    }
    assert.ok(covers(all, 0x41) && covers(all, 0x2019) && covers(all, 0xe9));
    assert.ok(!covers(all, 0x6f22), 'no CJK');
    assert.ok(!covers(all, 0x1f600), 'no emoji');
    const served = parseUnicodeRanges(readCss(family), { files: INTERIOR_FONT_FILES });
    assert.ok(served.length > 0 && covers(served, 0x41) && covers(served, 0x100));
    assert.ok(covers(all, 0x416) && !covers(served, 0x416), 'Cyrillic is declared by the package but not served');
  }
});

test('INTERIOR_FONT_FILES: the eight latin and latin-ext wght files, all present in node_modules', () => {
  assert.equal(INTERIOR_FONT_FILES.length, 8);
  assert.ok(Object.isFrozen(INTERIOR_FONT_FILES));
  for (const f of INTERIOR_FONT_FILES) {
    assert.match(f, /^(literata|inter)-(latin|latin-ext)-wght-(normal|italic)\.woff2$/);
    assert.ok(fs.existsSync(path.join(FONTS_DIR, f.startsWith('literata') ? 'literata' : 'inter', 'files', f)), f);
  }
});

// ---------------------------------------------------------------- html: scenes, order, text

test('every included scene id appears exactly once, in EPUB order; excluded scenes are absent', async () => {
  for (const options of [{}, { excludeStatuses: ['outline'] }, { excludeStatuses: ['revised', 'drafting'] }]) {
    const m = await assembleManuscript(copyBook(), options);
    const { html, report } = renderInterior(m, {});
    const expected = m.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes.map((s) => s.id)));
    assert.deepEqual(sceneIdsIn(html), expected, JSON.stringify(options));
    assert.equal(report.scenes, expected.length);
    for (const id of expected) assert.equal(html.split(`id="${id}"`).length - 1, 1, id);
    for (const e of m.excluded) if (e.id) assert.ok(!html.includes(e.id), `excluded ${e.id}`);
    // the EPUB reads the same scenes in the same order (phrases of the sample scenes)
    const epub = readEpub(renderEpub(m));
    const epubText = epub.spine.map((p) => htmlText(epub.byName.get(p).data.toString('utf8'))).join('\n');
    const phrases = phrasesFor(expected.filter((id) => SCENES[id]));
    assert.deepEqual(orderProblems(epubText, phrases), [], 'EPUB order');
    assert.deepEqual(orderProblems(stripTags(html), phrases), [], 'interior order');
  }
  assert.equal(ORDER.length, 7);
});

test('the concatenated text of the interior equals the EPUB text (whitespace-normalised), per option set', async () => {
  const root = copyBook();
  for (const options of [{}, { sceneTitles: true }, { titlePage: false }, { includeActs: false }, { excludeStatuses: ['drafting'] }]) {
    const m = await assembleManuscript(root, options);
    const html = renderInterior(m, {}).html.replace(/<section class="front (?:copyright-page|dedication)">[\s\S]*?<\/section>\n/g, '').replace(/<section class="back about-author">[\s\S]*?<\/section>\n/g, '');
    const epub = readEpub(renderEpub(m));
    const epubText = normSpace(epub.spine.map((p) => htmlText(epub.byName.get(p).data.toString('utf8'))).join('\n'));
    assert.equal(stripTags(html), epubText, JSON.stringify(options));
  }
});

test('emphasis, headings, scene breaks and scene titles match the EPUB markup', () => {
  const m = manuscript({
    parts: [{ label: 'Act 1', chapters: [{ label: 'Chapter One', title: 'Low', scenes: [{ id: 'scene_A', title: 'First', markdown: 'One *two* **three** ***four***.\n\n## A heading\n\nAfter.\n\n***\n\nPast the break.' }, { id: 'scene_B', title: 'Second', markdown: 'Next.' }] }] }],
  });
  const { html } = renderInterior(m, {});
  assert.ok(html.includes('<p>One <em>two</em> <strong>three</strong> <strong><em>four</em></strong>.</p>') || html.includes('<p>One <em>two</em> <strong>three</strong> <em><strong>four</strong></em>.</p>'));
  assert.ok(html.includes('<h3>A heading</h3>'));
  assert.equal((html.match(/<p class="scene-break">\* \* \*<\/p>/g) ?? []).length, 2, 'one in the scene, one between scenes');
  assert.ok(!html.includes('<h3>First</h3>'));
  const titled = renderInterior(manuscript({ ...m, options: { ...m.options, sceneTitles: true } }), {}).html;
  assert.ok(titled.includes('<h3>First</h3>') && titled.includes('<h3>Second</h3>'));
  assert.equal((titled.match(/class="scene-break"/g) ?? []).length, 1, 'only the Markdown break');
});

test('scene break styles: asterisks, ornament, blank', () => {
  const m = manuscript({ parts: [{ label: 'A', chapters: [{ label: 'C', title: '', scenes: [{ id: 's1', title: '', markdown: 'a' }, { id: 's2', title: '', markdown: 'b' }] }] }] });
  assert.ok(renderInterior(m, { sceneBreak: 'asterisks' }).html.includes('<p class="scene-break">* * *</p>'));
  const orn = renderInterior(m, { sceneBreak: 'ornament' });
  assert.ok(orn.html.includes('<p class="scene-break scene-break-ornament"></p>') && !orn.html.includes('* * *'));
  assert.ok(orn.css.includes('.scene-break-ornament::before'));
  const blank = renderInterior(m, { sceneBreak: 'blank' });
  assert.ok(blank.html.includes('<p class="scene-break scene-break-blank"></p>') && !blank.html.includes('* * *'));
});

test('structure: part sections, chapter ids, data-chapter, headings (labels as the other exports give them)', async () => {
  const m = await assembleManuscript(copyBook(), {});
  const { html, report } = renderInterior(m, {});
  assert.equal(report.chapters, 4);
  assert.deepEqual([...html.matchAll(/<section class="chapter" id="(ch-\d+)" data-chapter="([^"]*)">/g)].map((x) => x[1]), ['ch-1', 'ch-2', 'ch-3', 'ch-4']);
  assert.match(html, /data-chapter="chap_[0-9A-Z]{26}"/);
  assert.ok(html.includes('<h2 class="chapter-title">Chapter One: The Drowned Rows</h2>'));
  assert.equal((html.match(/<section class="part">/g) ?? []).length, 2);
  assert.ok(html.includes('<h1 class="part-title">Act 1: Low Water</h1>'));
  assert.ok(html.startsWith('<section class="front title-page">\n<h1 class="book-title">The Salt Orchard</h1>'));
  const noActs = renderInterior(await assembleManuscript(copyBook(), { includeActs: false }), {}).html;
  assert.ok(!noActs.includes('class="part"'));
  const noChapterId = renderInterior(manuscript({ parts: [{ label: 'A', chapters: [{ label: 'C', title: '', scenes: [] }] }] }), {}).html;
  assert.ok(noChapterId.includes('data-chapter=""'));
});

test('escaping: <script> and & render as text, nothing from the manuscript is HTML', () => {
  const m = manuscript({
    title: '<script>alert(1)</script> & Co',
    author: '"Quote" <b>',
    parts: [{ label: '<i>Act</i>', chapters: [{ id: 'chap"><x', label: 'Chapter <1>', title: 'T&C', scenes: [{ id: 'scene_A', title: '', markdown: 'Fish & chips <script>alert("x")</script> <img src=x onerror=y>\n\n<div class="scene">raw</div> [link](javascript:alert(1)) ![pic](x.png)' }] }] }],
    options: { excludeStatuses: [], sceneTitles: false, includeActs: true, titlePage: true, page: 'letter' },
  });
  const { html, css } = renderInterior(m, { frontMatter: { copyright: '© <script>x</script> & me', dedication: 'For <b>you</b>' }, backMatter: { aboutAuthor: 'Bio <i>text</i> & more' } });
  assert.ok(!/<script/i.test(html), 'no script element');
  assert.ok(!/<img|<b>|<i>|<x/i.test(html));
  assert.ok(html.includes('Fish &amp; chips &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &lt;img src=x onerror=y&gt;'));
  assert.ok(html.includes('&lt;div class=&quot;scene&quot;&gt;raw&lt;/div&gt;'));
  assert.ok(html.includes('data-chapter="chap&quot;&gt;&lt;x"'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co'));
  assert.ok(html.includes('For &lt;b&gt;you&lt;/b&gt;') && html.includes('Bio &lt;i&gt;text&lt;/i&gt; &amp; more'));
  assert.equal(sceneIdsIn(html).length, 1);
  assert.ok(!css.includes('<script') && !css.includes('</style'));
  assert.ok(css.includes('content: "\\3c script\\3e alert(1)\\3c /script\\3e  & Co"'), 'book title in the stylesheet cannot close the style element');
  assert.ok(!css.includes('booktitle'));
  assert.ok(!/https?:\/\//.test(css + html), 'no external URL');
});

// ---------------------------------------------------------------- front and back matter

test('front and back matter: copyright always (default text), dedication and about the author only when set', () => {
  const m = manuscript();
  const base = renderInterior(m, {}).html;
  assert.ok(base.includes('<section class="front copyright-page">\n<p>Copyright © 2024 A. Writer. All rights reserved.</p>'));
  assert.ok(!base.includes('dedication') && !base.includes('about-author'));
  assert.ok(base.indexOf('title-page') < base.indexOf('copyright-page') && base.indexOf('copyright-page') < base.indexOf('class="chapter"'));
  const full = renderInterior(m, { frontMatter: { copyright: 'Line one\nLine two\n\nSecond paragraph', dedication: 'For Ilse.' }, backMatter: { aboutAuthor: 'First.\n\nSecond.' } }).html;
  assert.ok(full.includes('<p>Line one<br>Line two</p>\n<p>Second paragraph</p>'));
  assert.ok(!full.includes('All rights reserved'));
  assert.ok(full.includes('<section class="front dedication">\n<p>For Ilse.</p>'));
  assert.ok(full.indexOf('copyright-page') < full.indexOf('class="front dedication"') && full.indexOf('class="front dedication"') < full.indexOf('class="chapter"'));
  assert.ok(full.endsWith('<section class="back about-author">\n<h2 class="back-title">About the Author</h2>\n<p>First.</p>\n<p>Second.</p>\n</section>\n'));
  assert.ok(renderInterior(m, { frontMatter: { dedication: '   ' }, backMatter: { aboutAuthor: '\n' } }).html === base, 'blank text counts as not set');
  const noTitle = renderInterior(manuscript({ options: { ...m.options, titlePage: false } }), {}).html;
  assert.ok(!noTitle.includes('title-page'));
  assert.ok(renderInterior(manuscript({ author: '' }), {}).html.includes('Copyright © 2024. All rights reserved.'));
});

// ---------------------------------------------------------------- css

test('css: trim, mirrored margins with the inside on the spine side, font size and line height', () => {
  const m = manuscript();
  const a = renderInterior(m, {}).css;
  assert.ok(cssBlock(a, '@page').includes('size: 6in 9in'));
  assert.ok(cssBlock(a, '@page').includes('margin-top: 0.6in') && cssBlock(a, '@page').includes('margin-bottom: 0.6in'));
  const left = cssBlock(a, '@page :left');
  const right = cssBlock(a, '@page :right');
  assert.ok(left.includes('margin-left: 0.5in') && left.includes('margin-right: 0.75in'), 'left page: inside is the right margin');
  assert.ok(right.includes('margin-left: 0.75in') && right.includes('margin-right: 0.5in'), 'right page: inside is the left margin');
  assert.ok(a.includes('font-size: 11pt') && a.includes('line-height: 1.35'));
  const b = renderInterior(m, { trim: '5.5x8.5', fontSize: 9.5, lineHeight: 1.5, margins: { inside: 1, outside: 0.3, top: 0.9, bottom: 1.1 } }).css;
  assert.ok(cssBlock(b, '@page').includes('size: 5.5in 8.5in') && cssBlock(b, '@page').includes('margin-top: 0.9in') && cssBlock(b, '@page').includes('margin-bottom: 1.1in'));
  assert.ok(cssBlock(b, '@page :left').includes('margin-left: 0.3in') && cssBlock(b, '@page :left').includes('margin-right: 1in'));
  assert.ok(cssBlock(b, '@page :right').includes('margin-left: 1in') && cssBlock(b, '@page :right').includes('margin-right: 0.3in'));
  assert.ok(b.includes('font-size: 9.5pt') && b.includes('line-height: 1.5'));
  assert.ok(!b.includes('6in 9in'));
});

test('css: running heads (book title left, chapter title right) and page numbers bottom-centre; none on front, chapter-start first pages or :blank', () => {
  const css = renderInterior(manuscript(), {}).css;
  assert.ok(cssBlock(css, '@page :left').includes('@top-center') && cssBlock(css, '@page :left').includes('content: "Tide & Salt";'));
  assert.ok(cssBlock(css, '@page :right').includes('content: string(chaptertitle)'));
  assert.ok(css.includes('string-set: chaptertitle content(text);') && !css.includes('booktitle'));
  assert.ok(css.includes('@bottom-center {\n    content: counter(page);'));
  for (const sel of ['@page front', '@page :blank']) {
    const block = cssBlock(css, sel);
    assert.ok(/@top-center \{\s*content: none;/.test(block) && /@bottom-center \{\s*content: none;/.test(block), `${sel}: no head, no number`);
  }
  const ch = cssBlock(css, '@page chapter-start:first');
  assert.ok(/@top-center \{\s*content: none;/.test(ch) && !ch.includes('bottom-center'), 'chapter opening: no running head, page number kept');
  assert.ok(css.includes('section.chapter {\n  page: chapter-start;') && css.includes('section.front {\n  page: front;'));
});

test('css: the left head is the literal book title, escaped, and absent where the head is suppressed', () => {
  const css = renderInterior(manuscript({ title: 'A "Q" \\ <b>' }), {}).css;
  const left = cssBlock(css, '@page :left');
  assert.ok(left.includes('content: "A \\"Q\\" \\\\ \\3c b\\3e ";'), left);
  assert.ok(!css.includes('</style') && !css.includes('string(booktitle)'));
  for (const sel of ['@page front', '@page :blank', '@page chapter-start:first']) assert.ok(!cssBlock(css, sel).includes('Tide') && /@top-center \{\s*content: none;/.test(cssBlock(css, sel)), sel);
  assert.ok(!cssBlock(css, '@page back').includes('content: "') || /@top-center \{\s*content: none;/.test(cssBlock(css, '@page back')));
  const off = renderInterior(manuscript(), { runningHeads: false }).css;
  assert.ok(!off.includes('content: "Tide'), 'no literal head when running heads are off');
});

test('css: rules are absent when running heads or page numbers are off', () => {
  const m = manuscript();
  const noHead = renderInterior(m, { runningHeads: false }).css;
  assert.ok(!noHead.includes('string(') && !noHead.includes('string-set') && !noHead.includes('@top-center'));
  assert.ok(noHead.includes('counter(page)'));
  assert.ok(/@page :blank \{\s*@bottom-center \{\s*content: none;/.test(noHead));
  const noNum = renderInterior(m, { pageNumbers: false }).css;
  assert.ok(!noNum.includes('counter(page)') && !noNum.includes('@bottom-center'));
  assert.ok(noNum.includes('content: "Tide & Salt";') && noNum.includes('string-set'));
  const neither = renderInterior(m, { runningHeads: false, pageNumbers: false }).css;
  for (const bad of ['string(', 'string-set', 'counter(page)', '@top-center', '@bottom-center', 'content: none']) assert.ok(!neither.includes(bad), bad);
  assert.ok(hasPageBlock(neither, '@page front') && hasPageBlock(neither, '@page :blank') && hasPageBlock(neither, '@page chapter-start:first'));
});

test('css: chapterStart right vs any, heading and indentation rules, hyphens with lang, fonts', () => {
  const m = manuscript();
  const right = renderInterior(m, { chapterStart: 'right' }).css;
  assert.ok(cssBlock(right, 'section.chapter').includes('break-before: right'));
  const any = renderInterior(m, { chapterStart: 'any' }).css;
  assert.ok(cssBlock(any, 'section.chapter').includes('break-before: page') && !cssBlock(any, 'section.chapter').includes('right'));
  assert.ok(cssBlock(right, 'h1, h2, h3').includes('break-after: avoid') && cssBlock(right, 'h1, h2, h3').includes('break-inside: avoid'));
  assert.ok(cssBlock(right, 'p').includes('text-indent: 1.5em'));
  assert.ok(cssBlock(right, '.chapter-title + .scene > p:first-child,\n.scene-break + p,\nh3 + p').includes('text-indent: 0'));
  assert.ok(cssBlock(right, 'body:lang(en)').includes('hyphens: auto'));
  assert.ok(renderInterior(manuscript({ language: 'fr-CA' }), {}).css.includes('body:lang(fr-CA) {\n  hyphens: auto;'));
  assert.ok(renderInterior(manuscript({ language: '"}</style>' }), {}).css.includes('body:lang(en) {'), 'a strange language falls back to en');
  // fonts: only the chosen family, files under /interior-assets/, fallback stack ending in the generic family
  assert.deepEqual([...right.matchAll(/url\(\/interior-assets\/([^)]+)\)/g)].map((x) => x[1]), INTERIOR_FONT_FILES.filter((f) => f.startsWith('literata')).sort((a, b) => (a.includes('italic') ? 1 : 0) - (b.includes('italic') ? 1 : 0) || a.length - b.length));
  assert.match(right, /font-family: 'Literata Variable', Georgia, 'Times New Roman', serif;/);
  const inter = renderInterior(m, { font: 'inter' }).css;
  assert.deepEqual(new Set([...inter.matchAll(/url\(\/interior-assets\/([^)]+)\)/g)].map((x) => x[1])), new Set(INTERIOR_FONT_FILES.filter((f) => f.startsWith('inter'))));
  assert.match(inter, /font-family: 'Inter Variable', 'Helvetica Neue', Arial, sans-serif;/);
  assert.ok(!/https?:\/\/|@import/.test(right + inter));
});

test('the layout is validated like the format does, and missing keys take the defaults', () => {
  const m = manuscript();
  assert.equal(renderInterior(m, undefined).css, renderInterior(m, INTERIOR_DEFAULTS).css);
  assert.equal(renderInterior(m, {}).html, renderInterior(m, INTERIOR_DEFAULTS).html);
  assert.throws(() => renderInterior(m, { trim: 'a4' }), (e) => e.code === 'BAD_LAYOUT' && /interior\.trim/.test(e.message));
  assert.throws(() => renderInterior(m, { margins: { inside: 9 } }), { code: 'BAD_LAYOUT' });
  assert.throws(() => renderInterior(m, { version: 2 }), { code: 'BAD_LAYOUT' });
});

// ---------------------------------------------------------------- report

async function fixtureBook() {
  const root = copyBook();
  const rel = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
  editScene(root, rel, (t) => `${t.trimEnd()}\n\nSee ![a map](map.png) here and ![ref image][r1].\n\n| Name | Tide |\n|------|------|\n| Ilse | low |\n\nA note.[^1] Another.[^2]\n\n[^1]: The note.\n\nA CJK word 漢 and an emoji 😀, again 漢.\n\n- first\n- second\n1. third\n\n> quoted line one\n> quoted line two\n\nUse \`inline\` code.\n\n\`\`\`\nfenced code\n\`\`\`\n`);
  const m = await assembleManuscript(root, {});
  const scene = m.parts.flatMap((p) => p.chapters.flatMap((c) => c.scenes)).find((s) => s.markdown.includes('漢'));
  assert.ok(scene);
  return { m, id: scene.id };
}

test('report: unsupported Markdown is found per scene (image, table, footnote, list, blockquote, code)', async () => {
  const { m, id } = await fixtureBook();
  const { report, html } = renderInterior(m, {});
  assert.deepEqual(report.unsupported, [
    { kind: 'image', sceneId: id, count: 2 },
    { kind: 'table', sceneId: id, count: 1 },
    { kind: 'footnote', sceneId: id, count: 3 },
    { kind: 'list', sceneId: id, count: 3 },
    { kind: 'blockquote', sceneId: id, count: 1 },
    { kind: 'code', sceneId: id, count: 2 },
  ]);
  assert.ok(!html.includes('<img') && !html.includes('<table') && !html.includes('<blockquote') && !html.includes('<ul') && !html.includes('<pre'));
  assert.ok(html.includes('a map') && html.includes('fenced code'), 'flattened to text, not dropped silently');
  // a plain book reports nothing
  const plain = renderInterior(await assembleManuscript(copyBook(), {}), {});
  assert.deepEqual(plain.report.unsupported, []);
});

test('report: scene breaks, bold dashes and horizontal rules are not lists', () => {
  const m = manuscript({ parts: [{ label: 'A', chapters: [{ label: 'C', title: '', scenes: [{ id: 's1', title: '', markdown: 'Text.\n\n* * *\n\n- - -\n\n***\n\n---\n\n**Bold** start\n\n*emphasis* start\n\n| not a table\n\nplain | pipe' }] }] }] });
  assert.deepEqual(renderInterior(m, {}).report.unsupported, []);
});

test('report: missingGlyphs against the font coverage (CJK and emoji with Literata and Inter)', async () => {
  const { m, id } = await fixtureBook();
  for (const font of ['literata', 'inter']) {
    const { report } = renderInterior(m, { font }, { coverage: COVERAGE });
    const mine = report.missingGlyphs.filter((g) => g.sceneIds.includes(id));
    const han = mine.find((g) => g.char === '漢');
    const emoji = mine.find((g) => g.char === '😀');
    assert.deepEqual(han, { char: '漢', codePoint: 0x6f22, count: 2, sceneIds: [id] }, font);
    assert.deepEqual(emoji, { char: '😀', codePoint: 0x1f600, count: 1, sceneIds: [id] }, font);
    for (const g of report.missingGlyphs) {
      assert.equal(g.char, String.fromCodePoint(g.codePoint));
      assert.ok(g.count >= g.sceneIds.length);
      assert.ok(!/\s/.test(g.char));
    }
    assert.ok(!report.missingGlyphs.some((g) => 'e’“”— .,'.includes(g.char)), 'Latin text and curly quotes are covered');
  }
  // coverage per font: Inter coverage does not apply to Literata
  const onlyInter = renderInterior(m, { font: 'literata' }, { coverage: { inter: [[0, 0x10ffff]] } });
  assert.deepEqual(onlyInter.report.missingGlyphs, []);
  // no coverage given: nothing can be judged
  assert.deepEqual(renderInterior(m, {}).report.missingGlyphs, []);
  // characters in titles are counted but name no scene
  const t = renderInterior(manuscript({ title: '漢' }), {}, { coverage: COVERAGE }).report.missingGlyphs;
  assert.deepEqual(t, [{ char: '漢', codePoint: 0x6f22, count: 1, sceneIds: [] }]);
});

test('report: words, scenes and chapters', () => {
  const m = manuscript({ parts: [{ label: 'A', chapters: [{ label: 'C1', title: '', scenes: [{ id: 's1', title: '', markdown: 'One two three.\n\n## Four five\n\n***\n\nSix *seven*.' }, { id: 's2', title: '', markdown: '' }] }, { label: 'C2', title: '', scenes: [{ id: 's3', title: '', markdown: 'Eight' }] }] }] });
  const { report } = renderInterior(m, {});
  assert.deepEqual([report.words, report.scenes, report.chapters], [8, 3, 2]);
});

// ---------------------------------------------------------------- determinism and the EPUB

test('determinism: the same manuscript and layout give byte-identical html, css and report', async () => {
  const root = copyBook();
  const layout = { font: 'inter', chapterStart: 'any', sceneBreak: 'ornament', frontMatter: { dedication: 'For you' }, margins: { inside: 0.9 } };
  const a = renderInterior(await assembleManuscript(root, {}), layout, { coverage: COVERAGE });
  const b = renderInterior(await assembleManuscript(copyBook(), {}), layout, { coverage: COVERAGE });
  assert.equal(a.html, b.html);
  assert.equal(a.css, b.css);
  assert.deepEqual(a.report, b.report);
  assert.notEqual(a.css, renderInterior(await assembleManuscript(root, {}), { ...layout, trim: '5.5x8.5' }).css);
  const m = await assembleManuscript(root, {});
  const before = JSON.stringify(m);
  renderInterior(m, layout);
  assert.equal(JSON.stringify(m), before, 'the manuscript is not modified');
});

test('renderEpub bytes are unchanged by the shared runsHtml (pinned hashes of the J04 test)', async () => {
  const pinned = new Map([
    ['{}', '95dcf07451e82f8354fb44606275def224b09b9b400311e450313c45a5d2e596'],
    ['{"sceneTitles":true}', '41ff1728fc6044dfc99c8145249706e698b9a55f1f8a3fd5cdb3e0793681b180'],
    ['{"titlePage":false,"includeActs":true}', '2a988f29c04eb66ac4e43d4d2ea8d0a0cd30c3e81b65720b77c0ddc168cdb466'],
  ]);
  const root = copyBook();
  for (const [key, hash] of pinned) {
    const m = await assembleManuscript(root, JSON.parse(key));
    renderInterior(m, {});
    assert.equal(sha256(renderEpub(m)), hash, key);
  }
});
