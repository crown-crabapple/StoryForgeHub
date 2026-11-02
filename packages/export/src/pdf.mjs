// PDF 1.4 output written by hand: standard Times faces (no embedding), WinAnsiEncoding, greedy word wrap using the AFM widths,
// 12 pt on 24 pt leading, 1-inch margins, page numbers in the footer, every chapter on a new page. No dates or ids: deterministic.
import { deflateSync } from 'node:zlib';
import { textWidth } from './afm.mjs';
import { chapterHeading, partHeading } from './markdown.mjs';
import { parseBlocks, toWinAnsiText, winAnsiByte } from './text.mjs';

const SIZES = { letter: [612, 792], a4: [595, 842] };
const MARGIN = 72;
const BODY = 12;
const LEADING = 24;
const INDENT = 24;
const FOOTER_SIZE = 10;
/** Face index: 0 roman (F1), 1 italic (F2), 2 bold (F3). */
const FONT_NAMES = ['Times-Roman', 'Times-Italic', 'Times-Bold'];

/** One output line: segments [face, text], x offset from the left margin, point size. @typedef {{ segs: [number, string][], x: number, size: number, y: number }} Line */

/**
 * Words of a paragraph's runs: each word keeps its face; spaces are separate tokens.
 * @param {import('./text.mjs').Run[]} runs @param {Set<string>} replaced collects characters PDF cannot show
 * @returns {{ face: number, text: string }[]}
 */
function tokens(runs, replaced) {
  /** @type {{ face: number, text: string }[]} */
  const out = [];
  for (const r of runs) {
    const { text, replaced: bad } = toWinAnsiText(r.text);
    for (const ch of bad) replaced.add(ch);
    const face = r.strong ? 2 : r.em ? 1 : 0;
    for (const piece of text.split(/( +)/)) if (piece !== '') out.push({ face, text: piece });
  }
  return out;
}

/**
 * Greedy wrap into lines no wider than `width` (the first line starts `indent` in). A word wider than a whole line is cut at the line end.
 * @param {{ face: number, text: string }[]} toks @param {number} width @param {number} indent @param {number} size
 * @returns {[number, string][][]}
 */
function wrap(toks, width, indent, size) {
  /** @type {[number, string][][]} */
  const lines = [];
  /** @type {[number, string][]} */
  let line = [];
  let w = 0;
  let avail = width - indent;
  const endLine = () => {
    // trailing spaces are not shown
    while (line.length && /^ +$/.test(line[line.length - 1][1])) line.pop();
    if (line.length) {
      const last = line[line.length - 1];
      last[1] = last[1].replace(/ +$/, '');
    }
    lines.push(line);
    line = [];
    w = 0;
    avail = width;
  };
  // group tokens into words: runs of non-space tokens with no space token between them
  /** @type {{ parts: { face: number, text: string }[], space: boolean }[]} */
  const words = [];
  for (const t of toks) {
    const space = /^ +$/.test(t.text);
    const last = words[words.length - 1];
    if (!space && last && !last.space) last.parts.push(t);
    else words.push({ parts: [t], space });
  }
  for (const word of words) {
    if (word.space) {
      if (line.length === 0) continue; // no leading spaces on a wrapped line
      const t = word.parts[0];
      const sw = textWidth(t.text, t.face, size);
      if (w + sw > avail) {
        endLine();
        continue;
      }
      line.push([t.face, t.text]);
      w += sw;
      continue;
    }
    let ww = word.parts.reduce((a, p) => a + textWidth(p.text, p.face, size), 0);
    if (w + ww > avail && line.length > 0) endLine();
    if (ww > avail) {
      // a single word wider than the line: cut it by character
      for (const p of word.parts) {
        for (const ch of p.text) {
          const cw = textWidth(ch, p.face, size);
          if (w + cw > avail && line.length > 0) endLine();
          if (line.length && line[line.length - 1][0] === p.face) line[line.length - 1][1] += ch;
          else line.push([p.face, ch]);
          w += cw;
        }
      }
      continue;
    }
    for (const p of word.parts) line.push([p.face, p.text]);
    w += ww;
  }
  if (line.length) endLine();
  return lines;
}

/** @param {string} s text restricted to WinAnsi characters: a PDF literal string with high bytes as octal escapes */
function literal(s) {
  let out = '';
  for (const ch of s) {
    const b = winAnsiByte(ch);
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `(${out})`;
}

/** A UTF-16BE hex string for metadata. @param {string} s */
const hexString = (s) => `<FEFF${Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase()}>`;

/**
 * @param {import('./manuscript.mjs').Manuscript} m
 * @returns {{ bytes: Buffer, warnings: string[] }}
 */
export function renderPdf(m) {
  const [pw, ph] = SIZES[m.options.page];
  const width = pw - 2 * MARGIN;
  const firstBaseline = ph - MARGIN - 18;
  const linesPerPage = Math.floor((ph - 2 * MARGIN) / LEADING);
  /** @type {Set<string>} */
  const replaced = new Set();

  /** @type {Line[][]} */
  const pages = [];
  /** @type {Line[]} */
  let page = [];
  let row = 0;
  const newPage = () => {
    if (page.length || row > 0) pages.push(page);
    page = [];
    row = 0;
  };
  const baseline = (r) => firstBaseline - r * LEADING;
  /** A centred heading line at the current row. @param {string} text @param {number} face @param {number} size */
  const centred = (text, face, size, r = row) => {
    const t = toWinAnsiText(text);
    for (const ch of t.replaced) replaced.add(ch);
    for (const seg of wrap([{ face, text: t.text }], width, 0, size)) {
      const w = seg.reduce((a, [f, s]) => a + textWidth(s, f, size), 0);
      page.push({ segs: seg, x: (width - w) / 2, size, y: baseline(r) });
      r += 1;
    }
    return r;
  };
  const addLine = (segs, x) => {
    if (row >= linesPerPage) newPage();
    page.push({ segs, x, size: BODY, y: baseline(row) });
    row += 1;
  };

  if (m.options.titlePage && (m.title || m.subtitle || m.author)) {
    let r = 8;
    if (m.title) r = centred(m.title, 2, 28, r) + 1;
    if (m.subtitle) r = centred(m.subtitle, 1, 16, r) + 1;
    if (m.author) centred(m.author, 0, 14, r + 1);
    row = linesPerPage; // the title page stands alone
  }

  for (const part of m.parts) {
    let partTitle = m.options.includeActs ? partHeading(part) : '';
    for (const chapter of part.chapters) {
      newPage();
      if (partTitle) {
        centred(partTitle, 2, 20, 2);
        row = 4;
        partTitle = '';
      } else {
        row = 0;
      }
      row = centred(chapterHeading(chapter), 2, 18, row + (row === 0 ? 2 : 0)) + 1;
      chapter.scenes.forEach((scene, i) => {
        const items = [];
        if (m.options.sceneTitles) {
          if (scene.title !== '') items.push({ kind: 'title', text: scene.title });
        } else if (i > 0) {
          items.push({ kind: 'break' });
        }
        for (const b of parseBlocks(scene.markdown)) items.push(b.type === 'break' ? { kind: 'break' } : { kind: b.type === 'heading' ? 'bold' : 'p', runs: b.runs });
        for (const it of items) {
          if (it.kind === 'break') {
            addLine([[0, '* * *']], (width - textWidth('* * *', 0, BODY)) / 2);
          } else if (it.kind === 'title') {
            const t = toWinAnsiText(it.text);
            for (const ch of t.replaced) replaced.add(ch);
            for (const segs of wrap([{ face: 2, text: t.text }], width, 0, BODY)) addLine(segs, 0);
          } else {
            const toks = tokens(it.kind === 'bold' ? it.runs.map((r) => ({ ...r, strong: true })) : it.runs, replaced);
            wrap(toks, width, it.kind === 'p' ? INDENT : 0, BODY).forEach((segs, k) => addLine(segs, it.kind === 'p' && k === 0 ? INDENT : 0));
          }
        }
      });
    }
  }
  if (page.length || row > 0 || pages.length === 0) pages.push(page);

  // ------------------------------------------------------------------ objects
  const FIRST_PAGE_OBJ = 7;
  /** @type {Buffer[]} */
  const objects = []; // index = object number - 1
  const put = (num, body) => {
    objects[num - 1] = Buffer.from(body, 'latin1');
  };
  const kids = pages.map((_p, i) => `${FIRST_PAGE_OBJ + 2 * i} 0 R`);
  put(1, '<< /Type /Catalog /Pages 2 0 R >>');
  put(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
  FONT_NAMES.forEach((name, i) => put(3 + i, `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
  put(6, `<< /Title ${hexString(m.title)} /Author ${hexString(m.author)} /Producer ${hexString('StoryForge')} >>`);
  const fmt = (n) => (Math.round(n * 100) / 100).toString();
  pages.forEach((lines, i) => {
    const out = [];
    for (const ln of lines) {
      let s = `BT\n${fmt(MARGIN + ln.x)} ${fmt(ln.y)} Td\n`;
      let current = -1;
      for (const [face, text] of ln.segs) {
        if (face !== current) {
          s += `/F${face + 1} ${ln.size} Tf\n`;
          current = face;
        }
        s += `${literal(text)} Tj\n`;
      }
      out.push(`${s}ET\n`);
    }
    const label = String(i + 1);
    const fw = textWidth(label, 0, FOOTER_SIZE);
    out.push(`BT\n/F1 ${FOOTER_SIZE} Tf\n${fmt((pw - fw) / 2)} ${MARGIN / 2} Td\n${literal(label)} Tj\nET\n`);
    const stream = deflateSync(Buffer.from(out.join(''), 'latin1'), { level: 9 });
    const pageNum = FIRST_PAGE_OBJ + 2 * i;
    put(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${pageNum + 1} 0 R >>`);
    objects[pageNum] = Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream', 'latin1')]);
  });

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const piece = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(piece);
    offset += piece.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  const warnings = replaced.size
    ? [`PDF cannot show ${replaced.size} character${replaced.size === 1 ? '' : 's'} (shown as "?"): ${[...replaced].join(' ')}`]
    : [];
  return { bytes: Buffer.concat(chunks), warnings };
}
