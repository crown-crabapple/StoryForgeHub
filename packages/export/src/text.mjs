// Text helpers shared by every writer and by verification: scene-body clean-up, a small Markdown block and inline reader,
// the search key used to check scene order, and the WinAnsi (Windows-1252) mapping used by the PDF writer.

/** An error with a stable `code`. */
export class ExportError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

/** Thrown by exportBook when the bytes it just produced do not match the manuscript. */
export class ExportVerificationError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`export verification failed: ${problems.join('; ')}`);
    this.name = 'ExportVerificationError';
    this.code = 'EXPORT_VERIFICATION_FAILED';
    this.problems = problems;
  }
}

// ----------------------------------------------------------------------------------------------- scene bodies

/**
 * Reader-facing Markdown of a scene body: HTML comments (notes, `sf:` anchors, opaque comments) removed, `[[slug|label]]` turned into
 * its label and `[[slug]]` into the target's name. Everything else is kept as written.
 * @param {string} body
 * @param {(target: string) => string | null} nameOf display name for a link target, or null when it does not resolve
 */
export function cleanBody(body, nameOf) {
  let s = body.replace(/\r\n?/g, '\n');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  s = s.replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner) => {
    const bar = inner.indexOf('|');
    const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const label = bar < 0 ? '' : inner.slice(bar + 1).trim();
    return label !== '' ? label : (nameOf(target) ?? target);
  });
  s = s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ----------------------------------------------------------------------------------------------- Markdown reader

/** @typedef {{ text: string, em: boolean, strong: boolean }} Run */
/** @typedef {{ type: 'p', runs: Run[] } | { type: 'heading', level: number, runs: Run[] } | { type: 'break' }} Block */

/**
 * Inline Markdown to runs: `*em*`, `_em_`, `**strong**`, `***both***`; backslash escapes; code spans, links and images reduced to their text.
 * Delimiters that do not pair up stay as literal characters.
 * @param {string} src
 * @returns {Run[]}
 */
export function parseInline(src) {
  // 1. flatten links / images / code spans / escapes into plain text, protecting literal * and _ with private-use stand-ins
  const STAR = '';
  const UNDER = '';
  const lit = (s) => s.replace(/\*/g, STAR).replace(/_/g, UNDER);
  let s = src.replace(/`+([^`]*?)`+/g, (_m, code) => lit(code));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_m, ch) => lit(ch));
  s = s.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1').replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');

  // 2. delimiter runs
  /** @type {({ t: 'text', s: string } | { t: 'd', ch: string, n: number, left: number, right: number, canOpen: boolean, canClose: boolean, opens: number[], closes: number[] })[]} */
  const toks = [];
  let buf = '';
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === '*' || ch === '_') {
      let j = i;
      while (s[j] === ch) j++;
      const prev = i > 0 ? s[i - 1] : ' ';
      const next = j < s.length ? s[j] : ' ';
      const ws = (c) => /\s/.test(c);
      const alnum = (c) => /[\p{L}\p{N}]/u.test(c);
      let canOpen = !ws(next);
      let canClose = !ws(prev);
      if (ch === '_') {
        canOpen = canOpen && !alnum(prev);
        canClose = canClose && !alnum(next);
      }
      if (buf) toks.push({ t: 'text', s: buf });
      buf = '';
      toks.push({ t: 'd', ch, n: j - i, left: j - i, right: 0, canOpen, canClose, opens: [], closes: [] });
      i = j;
    } else {
      buf += ch;
      i++;
    }
  }
  if (buf) toks.push({ t: 'text', s: buf });

  // 3. pair closers with the nearest opener of the same character
  /** @type {number[]} */
  const stack = [];
  toks.forEach((tok, idx) => {
    if (tok.t !== 'd') return;
    if (tok.canClose) {
      while (tok.left > 0) {
        let k = stack.length - 1;
        while (k >= 0 && !(toks[stack[k]].ch === tok.ch && toks[stack[k]].left > 0)) k--;
        if (k < 0) break;
        const open = /** @type {any} */ (toks[stack[k]]);
        const m = Math.min(open.left, tok.left, 3);
        open.left -= m;
        tok.left -= m;
        open.opens.unshift(m);
        tok.closes.push(m);
        stack.length = k + (open.left > 0 ? 1 : 0);
      }
    }
    if (tok.canOpen && tok.left > 0) stack.push(idx);
  });

  // 4. emit runs
  let em = 0;
  let strong = 0;
  /** @type {Run[]} */
  const runs = [];
  const push = (text) => {
    if (text === '') return;
    const last = runs[runs.length - 1];
    if (last && last.em === em > 0 && last.strong === strong > 0) last.text += text;
    else runs.push({ text, em: em > 0, strong: strong > 0 });
  };
  const apply = (m, sign) => {
    if (m === 1 || m === 3) em += sign;
    if (m === 2 || m === 3) strong += sign;
  };
  for (const tok of toks) {
    if (tok.t === 'text') {
      push(tok.s);
      continue;
    }
    for (const m of tok.closes) apply(m, -1);
    push(tok.ch.repeat(tok.left));
    for (const m of tok.opens) apply(m, 1);
  }
  return runs.map((r) => ({ ...r, text: r.text.replaceAll(STAR, '*').replaceAll(UNDER, '_') }));
}

const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * Block structure of a cleaned scene body: paragraphs (soft line breaks joined with a space), headings, scene breaks (`***`, `---`, `* * *`).
 * Block quotes and list markers are dropped to their text; fenced code becomes plain paragraphs.
 * @param {string} markdown
 * @returns {Block[]}
 */
export function parseBlocks(markdown) {
  /** @type {Block[]} */
  const out = [];
  /** @type {string[]} */
  let para = [];
  const flush = () => {
    if (para.length) out.push({ type: 'p', runs: parseInline(para.join(' ')) });
    para = [];
  };
  let fence = null;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      else if (line !== '') out.push({ type: 'p', runs: [{ text: line, em: false, strong: false }] });
      continue;
    }
    if (f) {
      flush();
      fence = f[1];
      continue;
    }
    if (line === '') {
      flush();
      continue;
    }
    if (HR_RE.test(raw)) {
      flush();
      out.push({ type: 'break' });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) {
      flush();
      out.push({ type: 'heading', level: h[1].length, runs: parseInline(h[2]) });
      continue;
    }
    const item = /^(?:[-+*]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      para = [item[1]];
      flush();
      continue;
    }
    para.push(line.replace(/^(?:>\s?)+/, ''));
  }
  flush();
  return out;
}

/** Plain text of runs. @param {Run[]} runs */
export const runsText = (runs) => runs.map((r) => r.text).join('');

/** Reader-visible plain text of a cleaned scene body (blocks joined by one space). @param {string} markdown */
export function plainText(markdown) {
  return parseBlocks(markdown)
    .map((b) => (b.type === 'break' ? '* * *' : runsText(b.runs)))
    .join(' ');
}

// ----------------------------------------------------------------------------------------------- verification keys

/** Normal form for comparing text across formats: no emphasis marks or backslashes, one space between words. @param {string} s */
export function norm(s) {
  return s.normalize('NFC').replace(/[*_\\]/g, '').replace(/\s+/g, ' ').trim();
}

/** The first 40 normalised characters of a scene, as it reads in `format`. @param {string} markdown @param {string} format */
export function sceneKey(markdown, format) {
  if (format === 'markdown') return norm(markdown).slice(0, 40).trim();
  const plain = plainText(markdown);
  return norm(format === 'pdf' ? toWinAnsiText(plain).text : plain).slice(0, 40).trim();
}

// ----------------------------------------------------------------------------------------------- XML

/** @param {string} s */
export const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Characters XML 1.0 cannot hold are dropped. @param {string} s */
export const xmlSafe = (s) => Array.from(s).filter((ch) => { const c = /** @type {number} */ (ch.codePointAt(0)); return !(c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) && c !== 0xfffe && c !== 0xffff; }).join('');

/** @param {string} s */
export function xmlUnescape(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ----------------------------------------------------------------------------------------------- WinAnsi

/** Windows-1252 code points for bytes 0x80-0x9F (undefined bytes are absent). */
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030,
  0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};
/** @type {Map<number, number>} code point -> WinAnsi byte */
const UNICODE_TO_WIN = new Map();
/** @type {Map<number, number>} WinAnsi byte -> code point */
const WIN_TO_UNICODE = new Map();
for (let b = 0x20; b <= 0x7e; b++) UNICODE_TO_WIN.set(b, b);
for (let b = 0xa0; b <= 0xff; b++) UNICODE_TO_WIN.set(b, b);
for (const [b, cp] of Object.entries(CP1252_HIGH)) UNICODE_TO_WIN.set(cp, Number(b));
for (const [cp, b] of UNICODE_TO_WIN) WIN_TO_UNICODE.set(b, cp);

/**
 * Text as the PDF will show it: tabs and line breaks become spaces, zero-width characters vanish, anything WinAnsi cannot show becomes `?`.
 * @param {string} text
 * @returns {{ text: string, replaced: string[] }} `replaced`: the distinct characters that became `?`, in order of first use
 */
export function toWinAnsiText(text) {
  let out = '';
  /** @type {string[]} */
  const replaced = [];
  for (const ch of text) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += ' ';
    else if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff || cp === 0x2060) continue;
    else if (UNICODE_TO_WIN.has(cp)) out += ch;
    else {
      out += '?';
      if (!replaced.includes(ch)) replaced.push(ch);
    }
  }
  return { text: out, replaced };
}

/** WinAnsi byte for a character that toWinAnsiText kept. @param {string} ch */
export const winAnsiByte = (ch) => UNICODE_TO_WIN.get(/** @type {number} */ (ch.codePointAt(0))) ?? 0x3f;

/** Character for a WinAnsi byte; bytes with no mapping give `?`. @param {number} b */
export const winAnsiChar = (b) => String.fromCodePoint(WIN_TO_UNICODE.get(b) ?? 0x3f);
