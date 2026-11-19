// EPUB 3 output. `mimetype` first and stored; fixed entry order and timestamps; dcterms:modified is the newest included scene's
// mtime (never "now"), so the same files give the same bytes.
import { chapterHeading, partHeading } from './markdown.mjs';
import { parseBlocks, runsHtml, xmlEscape, xmlSafe } from './text.mjs';
import { writeZip } from './zip.mjs';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';
const esc = (s) => xmlEscape(xmlSafe(s));

const CSS = `body { font-family: serif; line-height: 1.5; margin: 5%; }
h1, h2 { text-align: center; font-weight: bold; }
h1 { font-size: 1.6em; margin: 3em 0 1em; }
h2 { font-size: 1.2em; margin: 1.5em 0 0.75em; }
.part { font-size: 2em; margin-top: 4em; }
.titlepage { text-align: center; page-break-after: always; margin-top: 30%; }
.titlepage .title { font-size: 2.4em; font-weight: bold; }
.titlepage .subtitle { font-style: italic; font-size: 1.4em; }
.titlepage .author { margin-top: 2em; font-size: 1.2em; }
p { margin: 0; text-indent: 1.5em; text-align: left; }
p.scene-break { text-indent: 0; text-align: center; margin: 1em 0; }
`;

/**
 * The chapter files, in order: { file, heading, html, chapter, scenes }. `scenes` are the 1-based line ranges of each included scene inside `html`
 * (body lines; a scene with no lines of its own is left out).
 * @param {import('./manuscript.mjs').Manuscript} m
 */
export function epubChapters(m) {
  /** @type {{ file: string, heading: string, html: string, chapter: import('./manuscript.mjs').MChapter | null, scenes: { sceneId: string, first: number, last: number }[] }[]} */
  const out = [];
  let n = 0;
  const titlePage = () => {
    const bits = [];
    if (m.title !== '') bits.push(`<p class="title">${esc(m.title)}</p>`);
    if (m.subtitle !== '') bits.push(`<p class="subtitle">${esc(m.subtitle)}</p>`);
    if (m.author !== '') bits.push(`<p class="author">${esc(m.author)}</p>`);
    return bits.length ? `<section class="titlepage" epub:type="titlepage">${bits.join('')}</section>\n` : '';
  };
  let pendingTitle = m.options.titlePage ? titlePage() : '';
  for (const part of m.parts) {
    let partHtml = m.options.includeActs ? `<h1 class="part">${esc(partHeading(part))}</h1>\n` : '';
    for (const chapter of part.chapters) {
      n += 1;
      const heading = chapterHeading(chapter);
      /** @type {string[]} */
      const lines = [];
      let newlines = 0;
      const add = (text) => {
        lines.push(text);
        for (let k = text.indexOf('\n'); k !== -1; k = text.indexOf('\n', k + 1)) newlines += 1;
      };
      add(pendingTitle + partHtml);
      add(`<h2>${esc(heading)}</h2>\n`);
      pendingTitle = '';
      partHtml = '';
      /** @type {{ sceneId: string, first: number, last: number }[]} */
      const sceneLines = [];
      chapter.scenes.forEach((scene, i) => {
        let first = newlines + 1;
        if (m.options.sceneTitles) {
          if (scene.title !== '') add(`<h3>${esc(scene.title)}</h3>\n`);
        } else if (i > 0) {
          add('<p class="scene-break">* * *</p>\n');
          first = newlines + 1;
        }
        for (const b of parseBlocks(scene.markdown)) {
          if (b.type === 'break') add('<p class="scene-break">* * *</p>\n');
          else if (b.type === 'heading') add(`<h3>${runsHtml(b.runs)}</h3>\n`);
          else add(`<p>${runsHtml(b.runs)}</p>\n`);
        }
        if (newlines >= first && typeof scene.id === 'string' && scene.id !== '') sceneLines.push({ sceneId: scene.id, first, last: newlines });
      });
      out.push({ file: `chapter-${String(n).padStart(3, '0')}.xhtml`, heading, html: lines.join(''), chapter, scenes: sceneLines });
    }
  }
  if (out.length === 0 && pendingTitle !== '') out.push({ file: 'chapter-001.xhtml', heading: m.title, html: pendingTitle, chapter: null, scenes: [] });
  return out;
}

/** @param {string} lang @param {string} title @param {string} bodyHtml */
const xhtml = (lang, title, bodyHtml) =>
  `${XML_DECL}<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${esc(lang)}" xml:lang="${esc(lang)}">\n<head>\n<meta charset="utf-8"/>\n<title>${esc(title)}</title>\n<link rel="stylesheet" type="text/css" href="styles.css"/>\n</head>\n<body>\n${bodyHtml}</body>\n</html>\n`;

/** @param {import('./manuscript.mjs').Manuscript} m @returns {Buffer} */
export function renderEpub(m) {
  const chapters = epubChapters(m);
  const identifier = m.bookId || m.slug;
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="styles.css" media-type="text/css"/>',
    ...chapters.map((c, i) => `<item id="c${i + 1}" href="${c.file}" media-type="application/xhtml+xml"/>`),
  ];
  const opf = `${XML_DECL}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(m.language)}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${esc(identifier)}</dc:identifier>
<dc:title>${esc(m.title)}</dc:title>
${m.author !== '' ? `<dc:creator>${esc(m.author)}</dc:creator>\n` : ''}<dc:language>${esc(m.language)}</dc:language>
<meta property="dcterms:modified">${m.modified}</meta>
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine>
${chapters.map((_c, i) => `<itemref idref="c${i + 1}"/>`).join('\n')}
</spine>
</package>
`;
  const nav = xhtml(
    m.language,
    m.title,
    `<nav epub:type="toc" id="toc">\n<h1>${esc(m.title || 'Contents')}</h1>\n<ol>\n${chapters.map((c) => `<li><a href="${c.file}">${esc(c.heading)}</a></li>`).join('\n')}\n</ol>\n</nav>\n`,
  );
  const container = `${XML_DECL}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles>\n<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n</rootfiles>\n</container>\n`;
  const entries = [
    { name: 'mimetype', data: Buffer.from('application/epub+zip', 'ascii'), store: true },
    { name: 'META-INF/container.xml', data: Buffer.from(container, 'utf8') },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf, 'utf8') },
    { name: 'OEBPS/nav.xhtml', data: Buffer.from(nav, 'utf8') },
    { name: 'OEBPS/styles.css', data: Buffer.from(CSS, 'utf8') },
    ...chapters.map((c) => ({ name: `OEBPS/${c.file}`, data: Buffer.from(xhtml(m.language, c.heading, c.html), 'utf8') })),
  ];
  return writeZip(entries);
}

/**
 * Where each scene sits in the EPUB's chapter files, from the same data renderEpub writes (the bytes do not change).
 * `{ '<path inside the EPUB>': { chapterId, chapterLabel, scenes: [{ sceneId, firstLine, lastLine }] } }`; lines are 1-based lines of
 * that XHTML file as written. `chapterId` is null when the chapter has none.
 * @param {import('./manuscript.mjs').Manuscript} m
 * @returns {Record<string, { chapterId: string | null, chapterLabel: string, scenes: { sceneId: string, firstLine: number, lastLine: number }[] }>}
 */
export function epubSourceMap(m) {
  /** @type {ReturnType<typeof epubSourceMap>} */
  const map = {};
  for (const c of epubChapters(m)) {
    const shell = xhtml(m.language, c.heading, '');
    const bodyStart = shell.slice(0, shell.indexOf('</body>')).split('\n').length;
    map[`OEBPS/${c.file}`] = {
      chapterId: typeof c.chapter?.id === 'string' && c.chapter.id !== '' ? c.chapter.id : null,
      chapterLabel: c.chapter?.label ?? c.heading,
      scenes: c.scenes.map((s) => ({ sceneId: s.sceneId, firstLine: bodyStart - 1 + s.first, lastLine: bodyStart - 1 + s.last })),
    };
  }
  return map;
}
