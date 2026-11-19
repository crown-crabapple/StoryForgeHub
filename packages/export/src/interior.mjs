// M13-J05: the book interior document (a printed-novel layout for the Paged.js preview). Pure: no filesystem, no clock.
// The text comes from the same assembled manuscript, parseBlocks and parseInline as the EPUB; every character is escaped and no raw HTML
// from the manuscript reaches the output.
import { INTERIOR_DEFAULTS, preferenceProblems } from '@storyforge/format';
import { chapterHeading, partHeading } from './markdown.mjs';
import { ExportError, parseBlocks, runsHtml, runsText, xmlEscape, xmlSafe } from './text.mjs';

const esc = (s) => xmlEscape(xmlSafe(s));

/** Served font files (the server allow-lists these under /interior-assets/): Literata and Inter, latin and latin-ext, `wght`, normal and italic. */
export const INTERIOR_FONT_FILES = Object.freeze([
  'literata-latin-wght-normal.woff2',
  'literata-latin-wght-italic.woff2',
  'literata-latin-ext-wght-normal.woff2',
  'literata-latin-ext-wght-italic.woff2',
  'inter-latin-wght-normal.woff2',
  'inter-latin-wght-italic.woff2',
  'inter-latin-ext-wght-normal.woff2',
  'inter-latin-ext-wght-italic.woff2',
]);

// The declared unicode-range of the fontsource latin and latin-ext subsets (the same for both families and both styles).
const RANGE_LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const RANGE_LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

const FONTS = {
  literata: { family: 'Literata Variable', weights: '200 900', stack: "'Literata Variable', Georgia, 'Times New Roman', serif" },
  inter: { family: 'Inter Variable', weights: '100 900', stack: "'Inter Variable', 'Helvetica Neue', Arial, sans-serif" },
};
const TRIM_SIZE = { '6x9': '6in 9in', '5.5x8.5': '5.5in 8.5in' };

// ----------------------------------------------------------------------------------------------- font coverage

/**
 * Code point ranges declared by `unicode-range:` in a fontsource CSS file, merged and sorted: `[[from, to], ...]`. Wildcards (`U+4??`) are
 * expanded; malformed tokens are ignored.
 * @param {string} cssText
 * @param {{ files?: readonly string[] }} [options] `files`: only the @font-face blocks whose `src` is one of these file names (for example
 *   INTERIOR_FONT_FILES, so subsets that are not served do not count as coverage); default: every `unicode-range:` in the text
 * @returns {Array<[number, number]>}
 */
export function parseUnicodeRanges(cssText, options = {}) {
  const css = String(cssText).replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {string[]} */
  const declarations = [];
  const collect = (text) => {
    for (const m of text.matchAll(/unicode-range\s*:\s*([^;}]*)/gi)) declarations.push(m[1]);
  };
  if (options.files) {
    for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      const src = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/i.exec(block[1]);
      const name = src ? src[1].split('/').pop() : '';
      if (name && options.files.includes(name)) collect(block[1]);
    }
  } else collect(css);
  /** @type {Array<[number, number]>} */
  const found = [];
  for (const decl of declarations) {
    for (const raw of decl.split(',')) {
      const t = raw.trim();
      const m = /^u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(t);
      if (!m) continue;
      let from;
      let to;
      if (m[1].includes('?')) {
        if (m[2] !== undefined || !/^[0-9a-f]*\?+$/i.test(m[1])) continue;
        from = parseInt(m[1].replace(/\?/g, '0'), 16);
        to = parseInt(m[1].replace(/\?/g, 'f'), 16);
      } else {
        from = parseInt(m[1], 16);
        to = m[2] !== undefined ? parseInt(m[2], 16) : from;
      }
      if (to < from || to > 0x10ffff) continue;
      found.push([from, to]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {Array<[number, number]>} */
  const merged = [];
  for (const [from, to] of found) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

// ----------------------------------------------------------------------------------------------- unsupported Markdown

const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/; // as parseBlocks reads a scene break
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const UNSUPPORTED_KINDS = ['image', 'table', 'footnote', 'list', 'blockquote', 'code'];

/**
 * What the prototype flattens or drops in one scene's Markdown, counted: images, tables, footnote markers, list items, block quotes (runs of
 * quoted lines), code (fenced blocks and inline spans).
 * @param {string} markdown @returns {Record<string, number>}
 */
function scanUnsupported(markdown) {
  const n = { image: 0, table: 0, footnote: 0, list: 0, blockquote: 0, code: 0 };
  let fence = null;
  let prev = '';
  let prevQuote = false;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      prev = '';
      prevQuote = false;
      continue;
    }
    if (f) {
      n.code += 1;
      fence = f[1];
      prev = '';
      prevQuote = false;
      continue;
    }
    if (line === '' || HR_RE.test(raw)) {
      prev = '';
      prevQuote = false;
      continue;
    }
    n.image += (line.match(/!\[[^\]\n]*\](?:\([^)\n]*\)|\[[^\]\n]*\])/g) ?? []).length;
    n.footnote += (line.match(/\[\^[^\]\s]+\]/g) ?? []).length;
    n.code += (line.match(/`+[^`]*?`+/g) ?? []).length;
    if (line.includes('|') && TABLE_SEP.test(line) && prev.includes('|')) n.table += 1;
    const quoted = line.startsWith('>');
    if (quoted && !prevQuote) n.blockquote += 1;
    if (/^(?:[-+*]|\d+[.)])\s+\S/.test(line.replace(/^(?:>\s?)+/, ''))) n.list += 1;
    prevQuote = quoted;
    prev = line;
  }
  return n;
}

// ----------------------------------------------------------------------------------------------- the document

/** A CSS string literal that can sit inside a <style> element. @param {string} s */
const cssString = (s) => `"${xmlSafe(s).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3c ').replace(/>/g, '\\3e ')}"`;

/** @param {string} text paragraphs split at blank lines, single line breaks kept */
function textParagraphs(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p>${p.split('\n').map((l) => esc(l.trim())).join('<br>')}</p>\n`)
    .join('');
}

/** The layout with every default filled in; a layout the format would refuse is refused here too. @param {any} layout */
function normaliseLayout(layout) {
  const given = layout ?? {};
  const problems = preferenceProblems('interior', given);
  if (problems.length > 0) throw new ExportError('BAD_LAYOUT', `interior layout: ${problems.map((p) => `${p.location}: ${p.message}`).join('; ')}`);
  return {
    ...INTERIOR_DEFAULTS,
    ...given,
    margins: { ...INTERIOR_DEFAULTS.margins, ...(given.margins ?? {}) },
    frontMatter: { ...INTERIOR_DEFAULTS.frontMatter, ...(given.frontMatter ?? {}) },
    backMatter: { ...INTERIOR_DEFAULTS.backMatter, ...(given.backMatter ?? {}) },
  };
}

/** @param {any} L the normalised layout @param {import('./manuscript.mjs').Manuscript} m */
function interiorCss(L, m) {
  const font = FONTS[L.font];
  const lang = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(m.language) ? m.language : 'en';
  const inch = (v) => `${v}in`;
  const { inside, outside, top, bottom } = L.margins;
  const startBreak = L.chapterStart === 'right' ? 'right' : 'page';
  const head = L.runningHeads;
  const num = L.pageNumbers;
  const css = [];
  css.push(`/* StoryForge book interior: ${L.template} template (preview). */`);
  for (const style of ['normal', 'italic']) {
    for (const [subset, range] of [['latin', RANGE_LATIN], ['latin-ext', RANGE_LATIN_EXT]]) {
      const file = `${L.font}-${subset}-wght-${style}.woff2`;
      css.push(`@font-face {\n  font-family: '${font.family}';\n  font-style: ${style};\n  font-weight: ${font.weights};\n  src: url(/interior-assets/${file}) format('woff2');\n  unicode-range: ${range};\n}`);
    }
  }
  css.push(`@page {\n  size: ${TRIM_SIZE[L.trim]};\n  margin-top: ${inch(top)};\n  margin-bottom: ${inch(bottom)};\n}`);
  const side = (name, left, right, headContent) => {
    const lines = [`  margin-left: ${inch(left)};`, `  margin-right: ${inch(right)};`];
    if (head) lines.push(`  @top-center {\n    content: ${headContent};\n    font-size: 9pt;\n    font-style: italic;\n  }`);
    return `@page :${name} {\n${lines.join('\n')}\n}`;
  };
  // inside margin on the spine side: the right margin of a left page, the left margin of a right page
  css.push(side('left', outside, inside, cssString(m.title)));
  css.push(side('right', inside, outside, 'string(chaptertitle)'));
  if (num) css.push(`@page {\n  @bottom-center {\n    content: counter(page);\n    font-size: 9pt;\n  }\n}`);
  const none = (boxes) => boxes.map((b) => `  @${b} {\n    content: none;\n  }`).join('\n');
  const headBoxes = head ? ['top-center'] : [];
  const bothBoxes = [...headBoxes, ...(num ? ['bottom-center'] : [])];
  css.push(`@page :blank {\n${none(bothBoxes) || '  /* nothing printed on a blank page */'}\n}`);
  css.push(`@page front {\n${none(bothBoxes) || '  /* no running head and no page number on front matter */'}\n}`);
  css.push(`@page back {\n${none(headBoxes) || '  /* no running head on back matter */'}\n}`);
  css.push(`@page chapter-start:first {\n${none(headBoxes) || '  /* no running head on the page a chapter opens */'}\n}`);
  css.push(`body {\n  margin: 0;\n  font-family: ${font.stack};\n  font-size: ${L.fontSize}pt;\n  line-height: ${L.lineHeight};\n  text-align: justify;\n  widows: 2;\n  orphans: 2;\n}`);
  css.push(`body:lang(${lang}) {\n  hyphens: auto;\n}`);
  css.push('h1, h2, h3 {\n  break-after: avoid;\n  break-inside: avoid;\n  hyphens: none;\n}');
  css.push('p {\n  margin: 0;\n  text-indent: 1.5em;\n}');
  css.push('.chapter-title + .scene > p:first-child,\n.scene-break + p,\nh3 + p {\n  text-indent: 0;\n}');
  if (head) css.push(`.chapter-title {\n  string-set: chaptertitle content(text);\n}`);
  css.push('section.front {\n  page: front;\n}');
  css.push('section.title-page {\n  text-align: center;\n}\n.book-title {\n  font-size: 2.4em;\n  margin: 2.2in 0 0.3em;\n}\n.book-subtitle {\n  font-style: italic;\n  font-size: 1.3em;\n  text-indent: 0;\n}\n.book-author {\n  margin-top: 2em;\n  font-size: 1.1em;\n  text-indent: 0;\n}');
  css.push('section.copyright-page {\n  break-before: page;\n  font-size: 0.8em;\n  text-align: left;\n  padding-top: 3.5in;\n}\n.title-page + .copyright-page {\n  break-before: left;\n}\n.copyright-page p {\n  text-indent: 0;\n  margin-bottom: 0.6em;\n}');
  css.push('section.dedication {\n  break-before: right;\n  text-align: center;\n  font-style: italic;\n  padding-top: 2in;\n}\n.dedication p {\n  text-indent: 0;\n}');
  css.push(`section.part {\n  page: front;\n  break-before: ${startBreak};\n}\n.part-title {\n  text-align: center;\n  font-size: 2em;\n  margin: 2.5in 0 0;\n}`);
  css.push(`section.chapter {\n  page: chapter-start;\n  break-before: ${startBreak};\n}`);
  css.push('.chapter-title {\n  text-align: center;\n  font-size: 1.6em;\n  font-weight: bold;\n  margin: 1.2in 0 0.8in;\n  text-indent: 0;\n}');
  css.push('h3 {\n  font-size: 1.05em;\n  margin: 1.2em 0 0.5em;\n  text-align: left;\n}');
  css.push('.scene-break {\n  text-align: center;\n  text-indent: 0;\n  margin: 1em 0;\n}\n.scene-break-ornament::before {\n  content: "\\2766";\n}\n.scene-break-blank {\n  height: 1.5em;\n  margin: 0;\n}');
  css.push('section.back {\n  page: back;\n  break-before: page;\n}\n.back-title {\n  text-align: center;\n  font-size: 1.4em;\n  margin: 1in 0 0.6in;\n  text-indent: 0;\n}');
  return `${css.join('\n')}\n`;
}

/**
 * The interior of a manuscript as body HTML, a stylesheet and a report.
 * @param {import('./manuscript.mjs').Manuscript} m
 * @param {any} [layout] a `preferences.interior` map (missing keys take the defaults)
 * @param {{ coverage?: { literata?: Array<[number, number]>, inter?: Array<[number, number]> } }} [options] `coverage`: code point ranges each font declares
 *   (parseUnicodeRanges of its fontsource CSS); without it no glyph is reported missing
 * @returns {{ html: string, css: string, report: { words: number, scenes: number, chapters: number,
 *   unsupported: { kind: 'image' | 'table' | 'footnote' | 'list' | 'blockquote' | 'code', sceneId: string, count: number }[],
 *   missingGlyphs: { char: string, codePoint: number, count: number, sceneIds: string[] }[] } }}
 * @throws {ExportError} BAD_LAYOUT when the layout would not validate
 */
export function renderInterior(m, layout, options = {}) {
  const L = normaliseLayout(layout);
  const body = [];
  let words = 0;
  let sceneCount = 0;
  let chapterCount = 0;
  /** @type {{ kind: string, sceneId: string, count: number }[]} */
  const unsupported = [];

  const glyphs = new Map(); // char -> { char, codePoint, count, sceneIds }
  const ranges = L.font === 'literata' ? options.coverage?.literata : options.coverage?.inter;
  const covered = new Map();
  const isCovered = (cp) => {
    let hit = covered.get(cp);
    if (hit === undefined) {
      hit = (ranges ?? []).some(([from, to]) => cp >= from && cp <= to);
      covered.set(cp, hit);
    }
    return hit;
  };
  const scanGlyphs = (text, sceneId) => {
    if (!ranges) return;
    for (const ch of text) {
      const cp = /** @type {number} */ (ch.codePointAt(0));
      if (/\s/u.test(ch) || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || cp === 0xfeff || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
      if (isCovered(cp)) continue;
      let g = glyphs.get(ch);
      if (!g) {
        g = { char: ch, codePoint: cp, count: 0, sceneIds: [] };
        glyphs.set(ch, g);
      }
      g.count += 1;
      if (sceneId !== '' && !g.sceneIds.includes(sceneId)) g.sceneIds.push(sceneId);
    }
  };

  // title page, copyright, dedication
  if (m.options.titlePage) {
    const bits = [];
    if (m.title !== '') bits.push(`<h1 class="book-title">${esc(m.title)}</h1>\n`);
    if (m.subtitle !== '') bits.push(`<p class="book-subtitle">${esc(m.subtitle)}</p>\n`);
    if (m.author !== '') bits.push(`<p class="book-author">${esc(m.author)}</p>\n`);
    if (bits.length) body.push(`<section class="front title-page">\n${bits.join('')}</section>\n`);
  }
  for (const t of [m.title, m.subtitle, m.author]) scanGlyphs(t, '');
  const year = /^\d{4}/.exec(m.modified)?.[0] ?? '';
  const defaultCopyright = `Copyright \u00a9 ${[year, m.author].filter((x) => x !== '').join(' ')}. All rights reserved.`;
  const copyright = L.frontMatter.copyright.trim() !== '' ? L.frontMatter.copyright : defaultCopyright;
  body.push(`<section class="front copyright-page">\n${textParagraphs(copyright)}</section>\n`);
  scanGlyphs(copyright, '');
  if (L.frontMatter.dedication.trim() !== '') {
    body.push(`<section class="front dedication">\n${textParagraphs(L.frontMatter.dedication)}</section>\n`);
    scanGlyphs(L.frontMatter.dedication, '');
  }

  const sceneBreak = () => {
    if (L.sceneBreak === 'ornament') return '<p class="scene-break scene-break-ornament"></p>\n';
    if (L.sceneBreak === 'blank') return '<p class="scene-break scene-break-blank"></p>\n';
    return '<p class="scene-break">* * *</p>\n';
  };

  for (const part of m.parts) {
    const withPart = m.options.includeActs;
    if (withPart) {
      // the part title is its own page section (not a wrapper around its chapters): a wrapper with no named page of its own
      // left an empty numbered page before the part title in Paged.js
      body.push(`<section class="part">\n<h1 class="part-title">${esc(partHeading(part))}</h1>\n</section>\n`);
      scanGlyphs(partHeading(part), '');
    }
    for (const chapter of part.chapters) {
      chapterCount += 1;
      const heading = chapterHeading(chapter);
      scanGlyphs(heading, '');
      const chapterId = typeof chapter.id === 'string' ? chapter.id : '';
      body.push(`<section class="chapter" id="ch-${chapterCount}" data-chapter="${esc(chapterId)}">\n<h2 class="chapter-title">${esc(heading)}</h2>\n`);
      chapter.scenes.forEach((scene, i) => {
        sceneCount += 1;
        const idAttr = typeof scene.id === 'string' && scene.id !== '' ? ` id="${esc(scene.id)}"` : '';
        const sceneId = typeof scene.id === 'string' ? scene.id : '';
        const inner = [];
        if (m.options.sceneTitles) {
          if (scene.title !== '') {
            inner.push(`<h3>${esc(scene.title)}</h3>\n`);
            scanGlyphs(scene.title, sceneId);
          }
        } else if (i > 0) inner.push(sceneBreak());
        for (const b of parseBlocks(scene.markdown)) {
          if (b.type === 'break') inner.push(sceneBreak());
          else {
            const text = runsText(b.runs);
            words += (text.match(/\S+/g) ?? []).length;
            scanGlyphs(text, sceneId);
            inner.push(b.type === 'heading' ? `<h3>${runsHtml(b.runs)}</h3>\n` : `<p>${runsHtml(b.runs)}</p>\n`);
          }
        }
        body.push(`<div class="scene"${idAttr}>\n${inner.join('')}</div>\n`);
        const counts = scanUnsupported(scene.markdown);
        for (const kind of UNSUPPORTED_KINDS) if (counts[kind] > 0) unsupported.push({ kind, sceneId, count: counts[kind] });
      });
      body.push('</section>\n');
    }
  }

  if (L.backMatter.aboutAuthor.trim() !== '') {
    body.push(`<section class="back about-author">\n<h2 class="back-title">About the Author</h2>\n${textParagraphs(L.backMatter.aboutAuthor)}</section>\n`);
    scanGlyphs(L.backMatter.aboutAuthor, '');
  }

  return {
    html: body.join(''),
    css: interiorCss(L, m),
    report: { words, scenes: sceneCount, chapters: chapterCount, unsupported: /** @type {any} */ (unsupported), missingGlyphs: [...glyphs.values()] },
  };
}
