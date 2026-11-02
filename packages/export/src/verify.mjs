// verifyExport: read the produced bytes back and check that every included scene is there, in canonical order, and that no
// excluded scene is. The check looks for the first 40 normalised characters of each scene (see text.mjs sceneKey).
import { inflateSync } from 'node:zlib';
import { excludedText, sceneList } from './manuscript.mjs';
import { ExportError, norm, sceneKey, winAnsiChar, xmlUnescape } from './text.mjs';
import { unzip } from './zip.mjs';

/**
 * @param {string} haystack normalised text of the whole export
 * @param {{ id: string, key: string }[]} scenes in canonical order
 * @param {string} where e.g. "chapter-002.xhtml"; used in messages
 * @param {string[]} problems
 * @param {number} [from]
 * @returns {number} where the search ended
 */
function checkOrder(haystack, scenes, where, problems, from = 0) {
  let pos = from;
  for (const s of scenes) {
    if (s.key === '') continue;
    const at = haystack.indexOf(s.key, pos);
    if (at < 0) {
      const anywhere = haystack.indexOf(s.key);
      problems.push(anywhere < 0 ? `scene ${s.id} is missing from ${where}` : `scene ${s.id} is out of order in ${where}`);
    } else {
      pos = at + s.key.length;
    }
  }
  return pos;
}

/** Excluded scenes must not appear (unless their opening is also part of an included scene's text). */
function checkExcluded(haystack, manuscript, format, included, problems) {
  const includedText = included.map((s) => s.key);
  for (const e of excludedText(manuscript)) {
    const key = sceneKey(e.markdown, format);
    if (key.length < 20) continue;
    if (includedText.some((k) => k.includes(key) || key.includes(k))) continue;
    if (haystack.includes(key)) problems.push(`excluded scene ${e.id} appears in the export`);
  }
}

/** @param {string} xml */
const stripTags = (xml) => xmlUnescape(xml.replace(/<\/(?:w:p|p|h\d|li)>/g, ' ').replace(/<w:br\s*\/?>/g, ' ').replace(/<[^>]*>/g, ''));

/** Text of a PDF's body lines (12 pt), page by page, and each page's footer. @param {Buffer} bytes */
function readPdf(bytes) {
  const text = bytes.toString('latin1');
  if (!text.startsWith('%PDF-1.4')) throw new ExportError('BAD_PDF', 'not a PDF 1.4 file');
  /** @type {Map<number, { dict: string, stream: Buffer | null }>} */
  const objs = new Map();
  const re = /(?:^|\n)(\d+) 0 obj\n/g;
  let m;
  while ((m = re.exec(text))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    // dictionary: balanced << >>
    let depth = 0;
    let i = start;
    for (; i < text.length; i++) {
      if (text.startsWith('<<', i)) {
        depth++;
        i++;
      } else if (text.startsWith('>>', i)) {
        depth--;
        i++;
        if (depth === 0) break;
      }
    }
    const dict = text.slice(start, i + 1);
    let stream = null;
    if (text.startsWith('\nstream\n', i + 1)) {
      const len = Number(/\/Length (\d+)/.exec(dict)?.[1]);
      const from = i + 1 + '\nstream\n'.length;
      stream = bytes.subarray(from, from + len);
      re.lastIndex = from + len;
    }
    objs.set(num, { dict, stream });
  }
  const root = objs.get(Number(/\/Root (\d+) 0 R/.exec(text.slice(text.lastIndexOf('trailer')))?.[1]));
  const pagesNum = Number(/\/Pages (\d+) 0 R/.exec(root?.dict ?? '')?.[1]);
  const kids = [...(/\/Kids \[([^\]]*)\]/.exec(objs.get(pagesNum)?.dict ?? '')?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((k) => Number(k[1]));
  return kids.map((k) => {
    const contentNum = Number(/\/Contents (\d+) 0 R/.exec(objs.get(k)?.dict ?? '')?.[1]);
    const c = objs.get(contentNum);
    if (!c?.stream) throw new ExportError('BAD_PDF', `page object ${k} has no content stream`);
    const content = (/\/FlateDecode/.test(c.dict) ? inflateSync(c.stream) : c.stream).toString('latin1');
    /** @type {{ size: number, text: string }[]} */
    const blocks = [];
    for (const b of content.matchAll(/BT([\s\S]*?)ET/g)) {
      let size = 0;
      let line = '';
      for (const t of b[1].matchAll(/\/F\d+ ([\d.]+) Tf|\(((?:\\[\s\S]|[^\\)])*)\)\s*Tj|\[((?:\((?:\\[\s\S]|[^\\)])*\)|[^\]])*)\]\s*TJ/g)) {
        if (t[1] !== undefined) size = Number(t[1]);
        else {
          const strings = t[2] !== undefined ? [t[2]] : [...t[3].matchAll(/\(((?:\\[\s\S]|[^\\)])*)\)/g)].map((x) => x[1]);
          for (const s of strings) line += decodeLiteral(s);
        }
      }
      blocks.push({ size, text: line });
    }
    return blocks;
  });
}

/** @param {string} s inside of a PDF literal string */
function decodeLiteral(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') {
      out += winAnsiChar(s.charCodeAt(i));
      continue;
    }
    const n = s[++i];
    const oct = /^[0-7]{1,3}/.exec(s.slice(i));
    if (oct) {
      out += winAnsiChar(parseInt(oct[0], 8));
      i += oct[0].length - 1;
    } else if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else out += n;
  }
  return out;
}

/**
 * @param {Buffer} bytes
 * @param {'markdown' | 'docx' | 'epub' | 'pdf'} format
 * @param {import('./manuscript.mjs').Manuscript} manuscript
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyExport(bytes, format, manuscript) {
  /** @type {string[]} */
  const problems = [];
  try {
    const scenes = sceneList(manuscript, format);
    if (format === 'markdown') {
      const text = norm(bytes.toString('utf8'));
      checkOrder(text, scenes, 'the Markdown file', problems);
      checkExcluded(text, manuscript, format, scenes, problems);
    } else if (format === 'docx') {
      const files = unzip(bytes);
      for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
        if (!files.has(part)) problems.push(`DOCX part ${part} is missing`);
      }
      const doc = files.get('word/document.xml');
      if (doc) {
        const text = norm(stripTags(doc.toString('utf8')));
        checkOrder(text, scenes, 'word/document.xml', problems);
        checkExcluded(text, manuscript, format, scenes, problems);
      }
    } else if (format === 'epub') {
      verifyEpub(bytes, manuscript, scenes, problems);
    } else if (format === 'pdf') {
      const pages = readPdf(bytes);
      if (pages.length === 0) problems.push('the PDF has no pages');
      pages.forEach((blocks, i) => {
        const footer = blocks.filter((b) => b.size === 10).map((b) => b.text).join('');
        if (footer !== String(i + 1)) problems.push(`page ${i + 1} has footer "${footer}"`);
      });
      const text = norm(pages.flatMap((blocks) => blocks.filter((b) => b.size === 12).map((b) => b.text)).join(' '));
      checkOrder(text, scenes, 'the PDF', problems);
      checkExcluded(text, manuscript, format, scenes, problems);
    } else {
      throw new ExportError('BAD_FORMAT', `unknown format: ${format}`);
    }
  } catch (e) {
    if (e instanceof ExportError && e.code === 'BAD_FORMAT') throw e;
    problems.push(`the ${format} output cannot be read back: ${e instanceof Error ? e.message : e}`);
  }
  return { ok: problems.length === 0, problems };
}

/** @param {Buffer} bytes @param {import('./manuscript.mjs').Manuscript} manuscript @param {{ id: string, key: string }[]} scenes @param {string[]} problems */
function verifyEpub(bytes, manuscript, scenes, problems) {
  const files = unzip(bytes);
  const opf = files.get('OEBPS/content.opf')?.toString('utf8');
  if (!opf) {
    problems.push('OEBPS/content.opf is missing');
    return;
  }
  const hrefOf = new Map([...opf.matchAll(/<item id="([^"]+)" href="([^"]+)"/g)].map((x) => [x[1], x[2]]));
  const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((x) => hrefOf.get(x[1]));
  // chapter files in canonical order: chapters of the manuscript, in order
  const expected = [];
  manuscript.parts.forEach((p) => p.chapters.forEach((c) => expected.push(c)));
  const chapterFiles = spine.filter((h) => h && h !== 'nav.xhtml');
  if (spine.some((h) => !h)) problems.push('the spine names an item that is not in the manifest');
  if (expected.length > 0 && chapterFiles.length !== expected.length) {
    problems.push(`the spine has ${chapterFiles.length} chapter files but the manuscript has ${expected.length} chapters`);
  }
  let all = '';
  expected.forEach((chapter, i) => {
    const file = chapterFiles[i];
    const xml = file ? files.get(`OEBPS/${file}`)?.toString('utf8') : undefined;
    if (xml === undefined) {
      problems.push(`chapter file ${file ?? i + 1} is missing`);
      return;
    }
    const text = norm(stripTags(xml.replace(/^[\s\S]*?<body>/, '')));
    const keys = scenes.filter((s) => chapter.scenes.some((cs) => cs.id === s.id));
    checkOrder(text, keys, file, problems);
    all += ` ${text}`;
  });
  checkExcluded(norm(all), manuscript, 'epub', scenes, problems);
}
