// Shared helpers for the M05-J03 acceptance tests (not a test file; `node --test "test/*.test.mjs"` skips it).
// Everything here is an INDEPENDENT oracle written from the contract and the container formats only: a zip reader and
// writer, an XML tag-balance checker, text extractors for DOCX / EPUB / PDF and a PDF xref parser. Nothing is imported
// from the export package, so a bug there cannot hide a bug here.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(HERE, '..');
export const FIXTURES = path.resolve(HERE, '../../format/fixtures');

export const BOOK_ID = 'book_01S5000000000000000000000A';
export const SLUG = 'salt-orchard';
export const FORMATS = ['markdown', 'docx', 'epub', 'pdf'];
export const EXT = { markdown: 'md', docx: 'docx', epub: 'epub', pdf: 'pdf' };
export const MIME = {
  markdown: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  pdf: 'application/pdf',
};

/** Fixed mtime for every file of a test copy (no clock): 2020-01-01T00:00:00Z. */
export const BASE_MTIME = new Date('2020-01-01T00:00:00Z');

const sid = (n) => `scene_01S500000000000000000000${String(n).padStart(2, '0')}`;
/**
 * Scenes of salt-orchard: a phrase that occurs once in the scene's text after processing (links rendered as names,
 * comments gone), and the status in its front matter.
 */
export const SCENES = {
  [sid(1)]: { phrase: 'Ilse counted the rows by lantern light', status: 'revised' },
  [sid(2)]: { phrase: 'The ferry nudged the jetty', status: 'drafting' },
  [sid(3)]: { phrase: 'The key was colder than the morning', status: 'drafting' },
  [sid(5)]: { phrase: 'Tobin ran the ferry twice a day', status: 'drafting' },
  [sid(6)]: { phrase: 'Pell handed over the Grafting Knife handle first', status: 'drafting' },
  [sid(8)]: { phrase: 'The tables promised the lowest water in a decade', status: 'drafting' },
  [sid(9)]: { phrase: 'At the breach she finally used the key', status: 'outline' },
};
/** Reading order of the included scenes (cross-checked against the fixture's expected.json in the tests). */
export const ORDER = Object.keys(SCENES);
export const phrasesFor = (ids) => ids.map((id) => SCENES[id].phrase);

/** Text of excluded scenes, comments, front matter, trash: none of it may reach a reader. */
export const FORBIDDEN = [
  'In this take the key is already', // variant
  'A scene that did not survive', // archived
  'Prior version from an atomic save', // .storyforge/trash
  'check the tide times', // <!-- note: ... -->
  'left by the first draft', // <!-- opaque: ... -->
  'sf:anchor',
  'a_01S500',
  'Maren steps off the ferry into the flooded rows', // summary: front matter
  'storyforge.scene/v1',
  'x-mood',
  '[[',
  ']]',
  '<!--',
];
/** Text that must survive processing. */
export const REQUIRED = [
  'the ferryman threw her bag ashore', // [[tobin-reyes|the ferryman]]
  'Past the dunes lay The Salt Orchard, half under water', // [[salt-orchard]] -> entry name
  'Pell watched from the gate', // [[pell]]
  'The Harbour Board allowed it less each year', // [[harbour-board]]
  'He rang the Ferry Bell once for Maren', // [[ferry-bell]]
  'Cut clean, he said, and never cut twice', // text between sf:anchor comments is kept
  'Every cut left its Saltmarks on the bark by morning', // [[saltmarks]]
  'and the old sluice gate turned', // [[scene_...|the key]]
];

// ---------------------------------------------------------------- temp dirs and copies

const temps = [];
export function tmpDir(prefix = 'sf-exp-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}
export function cleanup() {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
}

export function walkFiles(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(dir, r, out);
    else out.push(r);
  }
  return out;
}

function setTimes(dir, when) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) setTimes(full, when);
    else fs.utimesSync(full, when, when);
  }
}

/**
 * Copy a fixture (relative to packages/format/fixtures) into a fresh temp dir whose files all carry BASE_MTIME, so two
 * copies are indistinguishable to a reader that looks at mtimes. Returns the path of the copied book folder.
 */
export function copyBook(rel = 'valid/salt-orchard', { under } = {}) {
  const base = under ?? tmpDir();
  const dest = path.join(base, path.basename(rel));
  fs.cpSync(path.join(FIXTURES, ...rel.split('/')), dest, { recursive: true });
  setTimes(dest, BASE_MTIME);
  return dest;
}

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export const expectedJson = () => readJson(path.join(FIXTURES, 'valid', 'salt-orchard', 'expected.json'));

/** Replace text inside one scene file (by file name suffix) of a copied book. */
export function editScene(root, relPath, fn) {
  const p = path.join(root, ...relPath.split('/'));
  fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8')));
  fs.utimesSync(p, BASE_MTIME, BASE_MTIME);
}

/** Add the kinds of file a backup must carry (or leave out) on top of the fixture. Returns relative paths added. */
export function addExtras(root) {
  const files = {
    'provenance/receipts/r-0001.json': Buffer.from('{"receipt":1}\n'),
    'assets/cover-test.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 254, 255]),
    'assets/empty.txt': Buffer.alloc(0),
    'notes/café ☕.md': Buffer.from('# loose note\r\nwith CRLF and no front matter\r\n'),
    '.storyforge/index.sqlite': Buffer.from('not really sqlite'),
  };
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    fs.utimesSync(p, BASE_MTIME, BASE_MTIME);
  }
  return Object.keys(files);
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** rel path (and rel/ for directories) -> { sha, size, mtimeMs } for everything under root. */
export function snapshotTree(root) {
  const out = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const st = fs.statSync(full);
      if (e.isDirectory()) {
        out.set(rel + '/', { sha: 'dir', size: 0, mtimeMs: st.mtimeMs });
        walk(full);
      } else {
        out.set(rel, { sha: sha256(fs.readFileSync(full)), size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  })(root);
  return out;
}

/** Every file under root except .storyforge/: rel path -> Buffer. */
export function readAll(root, { skip = ['.storyforge'] } = {}) {
  const out = new Map();
  for (const rel of walkFiles(root)) {
    if (skip.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
    out.set(rel, fs.readFileSync(path.join(root, ...rel.split('/'))));
  }
  return out;
}

export function assertSameFiles(assert, a, b, label = '') {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${label} same set of files`);
  for (const [p, buf] of a) assert.ok(b.get(p).equals(buf), `${label} ${p} byte-identical`);
}

export const exists = (p) => fs.existsSync(p);

// ---------------------------------------------------------------- crc32 and zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Read a zip from its central directory. Checks every entry's CRC-32 and size (an independent check of the writer).
 * Returns { entries: [{ name, method, flags, dosTime, dosDate, crc, csize, usize, localOffset, extAttr, versionMadeBy,
 * dataOffset, data }], comment, commentRaw } with entries in central-directory order.
 */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const clen = buf.readUInt16LE(eocd + 20);
  const commentRaw = buf.subarray(eocd + 22, eocd + 22 + clen);
  const entries = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central directory signature at entry ${i}`);
    const e = {
      versionMadeBy: buf.readUInt16LE(p + 4),
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      dosTime: buf.readUInt16LE(p + 12),
      dosDate: buf.readUInt16LE(p + 14),
      crc: buf.readUInt32LE(p + 16),
      csize: buf.readUInt32LE(p + 20),
      usize: buf.readUInt32LE(p + 24),
      extAttr: buf.readUInt32LE(p + 38),
      localOffset: buf.readUInt32LE(p + 42),
    };
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const cmlen = buf.readUInt16LE(p + 32);
    e.name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + elen + cmlen;
    const lo = e.localOffset;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error(`bad local header for ${e.name}`);
    e.dataOffset = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(e.dataOffset, e.dataOffset + e.csize);
    e.data = e.method === 0 ? Buffer.from(raw) : e.method === 8 ? zlib.inflateRawSync(raw) : Buffer.alloc(0);
    if (e.method === 0 || e.method === 8) {
      if (e.data.length !== e.usize) throw new Error(`${e.name}: size ${e.data.length} != ${e.usize}`);
      if (crc32(e.data) !== e.crc) throw new Error(`${e.name}: crc mismatch`);
    }
    entries.push(e);
  }
  return { entries, comment: commentRaw.toString('utf8'), commentRaw };
}

/**
 * Write a zip. entry: { name: string|Buffer, data: Buffer, method?: 0|8|n, extAttr?, versionMadeBy?, flags?,
 * fake?: { usize?, csize?, crc? } } (fake lies in the headers). Fixed timestamp 1980-01-01.
 */
export function writeZip(entries, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const method = e.method ?? 8;
    const data = e.data ?? Buffer.alloc(0);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = e.fake?.crc ?? crc32(data);
    const usize = e.fake?.usize ?? data.length;
    const csize = e.fake?.csize ?? body.length;
    const flags = e.flags ?? 0x0800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.versionMadeBy ?? 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(csize, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((e.extAttr ?? 0) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const cm = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(cm.length, 20);
  return Buffer.concat([...locals, cd, end, cm]);
}

/** Re-pack a real backup with `mutate(entries, comment)` returning { entries, comment }. */
export function rewriteZip(buf, mutate) {
  const z = readZip(buf);
  const entries = z.entries.map((e) => ({ name: e.name, data: e.data, method: e.method, extAttr: e.extAttr, versionMadeBy: e.versionMadeBy }));
  const r = mutate(entries, z.comment) ?? { entries, comment: z.comment };
  return writeZip(r.entries ?? entries, { comment: r.comment ?? z.comment });
}

// ---------------------------------------------------------------- XML

const ENTITY_OK = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/y;
function badAmp(text) {
  for (let i = text.indexOf('&'); i !== -1; i = text.indexOf('&', i + 1)) {
    ENTITY_OK.lastIndex = i;
    if (!ENTITY_OK.test(text)) return true;
  }
  return false;
}
const ATTRS = String.raw`(?:\s+[^\s=/>"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*`;
const TOKEN = new RegExp(
  String.raw`<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?"']+)(${ATTRS})\s*(\/?)>`,
  'g',
);

/** Strict tag-balance check: returns a list of problems ([] = well formed with one root element). */
export function checkXml(xml) {
  const problems = [];
  const stack = [];
  let roots = 0;
  let last = 0;
  const text = (s) => {
    if (/[<]/.test(s)) problems.push(`stray "<" in text near ${JSON.stringify(s.slice(0, 40))}`);
    if (badAmp(s)) problems.push(`bad entity near ${JSON.stringify(s.slice(0, 40))}`);
    if (stack.length === 0 && s.trim() !== '') problems.push('text outside the root element');
  };
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(xml); m; m = TOKEN.exec(xml)) {
    text(xml.slice(last, m.index));
    last = TOKEN.lastIndex;
    if (m[1] !== undefined) {
      const open = stack.pop();
      if (open !== m[1]) problems.push(`</${m[1]}> closes <${open}>`);
    } else if (m[2] !== undefined) {
      if (badAmp(m[3] ?? '')) problems.push(`bad entity in attributes of <${m[2]}>`);
      if (stack.length === 0) roots++;
      if (m[4] !== '/') stack.push(m[2]);
    }
  }
  text(xml.slice(last));
  if (stack.length) problems.push(`unclosed: ${stack.join(' > ')}`);
  if (roots !== 1) problems.push(`${roots} root elements`);
  return problems;
}

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
export const normSpace = (s) => s.replace(/\s+/g, ' ').trim();

/** Paragraphs of a WordprocessingML document: [{ text, xml }]. */
export function docxParagraphs(xml) {
  const out = [];
  for (const m of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    const inner = m[1] ?? '';
    const text = [...inner.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => decodeEntities(t[1])).join('');
    out.push({ text, xml: m[0] });
  }
  return out;
}

/** Plain text of an XHTML document: block ends become newlines. */
export function htmlText(xhtml) {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/.exec(xhtml)?.[1] ?? xhtml;
  return decodeEntities(
    body
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '')
      .replace(/<\/(p|h[1-6]|div|li|section|blockquote)>|<br\s*\/?>|<hr\s*\/?>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

// ---------------------------------------------------------------- EPUB

/** { opfPath, opf, manifest: Map(id -> {href, type, properties, path}), spine: [path], zip } */
export function readEpub(bytes) {
  const zip = readZip(bytes);
  const byName = new Map(zip.entries.map((e) => [e.name, e]));
  const container = byName.get('META-INF/container.xml')?.data.toString('utf8');
  const opfPath = /full-path="([^"]+)"/.exec(container ?? '')?.[1];
  const opf = byName.get(opfPath)?.data.toString('utf8') ?? '';
  const dir = path.posix.dirname(opfPath ?? '');
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b([^>]*?)\/?>/g)) {
    const a = (n) => new RegExp(`\\b${n}="([^"]*)"`).exec(m[1])?.[1];
    manifest.set(a('id'), { href: a('href'), type: a('media-type'), properties: a('properties') ?? '', path: path.posix.normalize(path.posix.join(dir, decodeEntities(a('href') ?? ''))) });
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/g)].map((m) => manifest.get(m[1])?.path);
  return { zip, byName, container, opfPath, opf, manifest, spine, dir };
}

// ---------------------------------------------------------------- PDF

function pdfString(raw) {
  // literal string body (without the outer parentheses) -> latin1 text
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8));
    } else if (n === '\n') {
      /* line continuation */
    } else out += n;
  }
  return out;
}

/** The shown strings of one content stream, one entry per Tj / TJ operation. */
export function pdfStrings(content) {
  const lines = [];
  let inArray = false;
  let arr = '';
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < content.length && depth > 0) {
        const d = content[j];
        if (d === '\\') {
          raw += d + content[j + 1];
          j += 2;
          continue;
        }
        if (d === '(') depth++;
        if (d === ')') depth--;
        if (depth > 0) raw += d;
        j++;
      }
      if (inArray) arr += pdfString(raw);
      else lines.push(pdfString(raw));
      i = j - 1;
    } else if (c === '<' && content[i + 1] !== '<') {
      const j = content.indexOf('>', i);
      const hex = content.slice(i + 1, j).replace(/\s+/g, '');
      let s = '';
      for (let k = 0; k < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      if (inArray) arr += s;
      else lines.push(s);
      i = j;
    } else if (c === '[') {
      inArray = true;
      arr = '';
    } else if (c === ']' && inArray) {
      inArray = false;
      lines.push(arr);
    }
  }
  return lines;
}

/**
 * Text blocks (BT ... ET) of one content stream: { x, y, font, size, text } with the strings of the block concatenated.
 * A stream without BT/ET falls back to one block per shown string.
 */
export function pdfBlocks(content) {
  const blocks = [];
  for (const m of content.matchAll(/BT\b([\s\S]*?)\bET\b/g)) {
    const inner = m[1];
    const pos = /(-?[\d.]+)\s+(-?[\d.]+)\s+Td/.exec(inner);
    const tf = /\/(\w+)\s+(-?[\d.]+)\s+Tf/.exec(inner);
    blocks.push({ x: pos ? Number(pos[1]) : null, y: pos ? Number(pos[2]) : null, font: tf?.[1] ?? null, size: tf ? Number(tf[2]) : null, text: pdfStrings(inner).join('') });
  }
  if (blocks.length === 0) return pdfStrings(content).map((text) => ({ x: null, y: null, font: null, size: null, text }));
  return blocks;
}

/**
 * Parse a PDF without trusting the producer: header, startxref -> xref table (every in-use offset must point at
 * "<num> <gen> obj"), trailer, page tree, content streams (inflated when FlateDecode), fonts.
 */
export function parsePdf(bytes) {
  const s = bytes.toString('latin1');
  const problems = [];
  if (!s.startsWith('%PDF-1.4')) problems.push('does not start with %PDF-1.4');
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s);
  if (!sx) problems.push('no startxref / %%EOF at the end');
  const xrefOff = sx ? Number(sx[1]) : -1;
  if (xrefOff < 0 || s.slice(xrefOff, xrefOff + 4) !== 'xref') problems.push('startxref does not point at "xref"');
  const objs = new Map(); // num -> body text between "obj" and "endobj"
  let size = 0;
  let declared = 0;
  if (!problems.length) {
    let pos = xrefOff + 4;
    const rest = s.slice(pos);
    const sub = /^\s*(\d+)\s+(\d+)\s*\r?\n/.exec(rest);
    if (!sub) problems.push('xref subsection header missing');
    else {
      const first = Number(sub[1]);
      const count = Number(sub[2]);
      declared = first + count;
      pos += sub[0].length;
      for (let i = 0; i < count; i++) {
        const line = s.slice(pos + i * 20, pos + i * 20 + 20);
        const m = /^(\d{10}) (\d{5}) ([nf])( \r| \n|\r\n)$/.exec(line);
        if (!m) {
          problems.push(`xref entry ${first + i} is not 20 bytes: ${JSON.stringify(line)}`);
          continue;
        }
        if (m[3] !== 'n') continue;
        const num = first + i;
        const off = Number(m[1]);
        const head = `${num} ${Number(m[2])} obj`;
        if (!s.startsWith(head, off)) {
          problems.push(`xref offset for object ${num} (${off}) does not point at "${head}"`);
          continue;
        }
        const end = s.indexOf('endobj', off);
        objs.set(num, s.slice(off + head.length, end));
        size++;
      }
    }
    const tr = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(s);
    if (!tr) problems.push('no trailer');
    else if (Number(/\/Size\s+(\d+)/.exec(tr[1])?.[1]) !== declared) problems.push(`trailer /Size != xref entries (${declared})`);
  }
  const streamOf = (body) => {
    const i = body.indexOf('stream');
    if (i < 0) return null;
    const dict = body.slice(0, i);
    let start = i + 6;
    if (body[start] === '\r') start++;
    if (body[start] === '\n') start++;
    let end = body.lastIndexOf('endstream');
    let raw = Buffer.from(body.slice(start, end), 'latin1');
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict)?.[1];
    if (len !== undefined && Number(len) <= raw.length) raw = raw.subarray(0, Number(len));
    if (/\/FlateDecode/.test(dict)) raw = zlib.inflateSync(raw);
    return raw.toString('latin1');
  };
  const refs = (txt) => [...txt.matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
  const root = /\/Root\s+(\d+)\s+0\s+R/.exec(s.slice(Math.max(0, s.lastIndexOf('trailer'))))?.[1];
  const pages = [];
  const walk = (num) => {
    const body = objs.get(num) ?? '';
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(body)?.[1] ?? '';
      for (const k of refs(kids)) walk(k);
    } else if (/\/Type\s*\/Page\b/.test(body)) {
      const mb = /\/MediaBox\s*\[([^\]]*)\]/.exec(body)?.[1].trim().split(/\s+/).map(Number);
      const cont = /\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/.exec(body)?.[1] ?? '';
      const blocks = [];
      for (const c of refs(cont)) {
        const st = streamOf(objs.get(c) ?? '');
        if (st !== null) blocks.push(...pdfBlocks(st));
      }
      pages.push({ num, mediaBox: mb, lines: blocks.map((b) => b.text), blocks });
    }
  };
  if (root) {
    const cat = objs.get(Number(root)) ?? '';
    const pr = /\/Pages\s+(\d+)\s+0\s+R/.exec(cat)?.[1];
    if (pr) walk(Number(pr));
  }
  const all = [...objs.values()].join('\n');
  const fonts = new Set([...all.matchAll(/\/BaseFont\s*\/([A-Za-z0-9-]+)/g)].map((m) => m[1]));
  return {
    problems,
    pages,
    fonts,
    winAnsi: /\/Encoding\s*\/WinAnsiEncoding/.test(all),
    embedsFont: /\/FontFile\d?\b/.test(all),
    objectCount: size,
    text: pages.map((p) => p.lines.join('\n')).join('\n'),
  };
}

// ---------------------------------------------------------------- text of an export, per format

/** Reader-visible text of an export, extracted with the oracles above. */
export function textOf(format, bytes) {
  if (format === 'markdown') return bytes.toString('utf8');
  if (format === 'docx') {
    const z = readZip(bytes);
    const doc = z.entries.find((e) => e.name === 'word/document.xml').data.toString('utf8');
    return docxParagraphs(doc).map((p) => p.text).join('\n');
  }
  if (format === 'epub') {
    const ep = readEpub(bytes);
    return ep.spine.map((p) => htmlText(ep.byName.get(p)?.data.toString('utf8') ?? '')).join('\n');
  }
  if (format === 'pdf') return parsePdf(bytes).text;
  throw new Error(`unknown format ${format}`);
}

/** Index of each phrase in `text` (whitespace-normalised); throws a readable message if one is missing or out of order. */
export function orderProblems(text, phrases) {
  const t = normSpace(text);
  const problems = [];
  let from = 0;
  for (const p of phrases) {
    const i = t.indexOf(normSpace(p), from);
    if (i < 0) {
      problems.push(t.includes(normSpace(p)) ? `out of order: ${p}` : `missing: ${p}`);
      continue;
    }
    from = i + p.length;
  }
  return problems;
}
export const occurrences = (text, phrase) => normSpace(text).split(normSpace(phrase)).length - 1;
