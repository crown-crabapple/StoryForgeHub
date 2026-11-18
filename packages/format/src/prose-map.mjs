// Prose projection and offset conversion (M13-J01). Engines check prose, not Markdown: projectProse() builds the text an engine sees
// plus a map from every projected unit back to the body, so a finding's range lands on the exact words in the editor.
// Pure: no node:* import, no I/O, no dependency. The web app keeps a byte-identical copy (apps/web/src/findings/prose-map.js).
//
// Limits of the scanner (it is a small scanner, not a CommonMark parser; on doubt it keeps text rather than drops it):
//  - Indented code blocks (4+ spaces) are not recognised: their text is kept as prose.
//  - HTML blocks other than `<!-- ... -->` comments are not recognised; inline tags like <b> are kept. An unclosed `<!--` is kept.
//  - Brackets: `[label](dest)` and `![alt](src)` are recognised, including one level of nested brackets and parentheses in the destination.
//    Reference links `[label][ref]` and shortcut references keep their brackets; footnote markers `[^1]` are kept.
//  - Emphasis markers are dropped by adjacency, not paired: a `*`, `_` or `~~` run is dropped unless whitespace is on both sides
//    (a `_` inside a word, as in snake_case, is kept). A stray unpaired marker next to a word is therefore dropped.
//  - Line prefixes: `> ` (repeated), `#`..`######` plus one space, and `-`, `*`, `+`, `1.`, `1)` plus one space are dropped at line start only.
//    Setext headings, thematic breaks (`---`), tables and task-list brackets are kept as text.
//  - An inline code span must close before a blank line; otherwise its backticks are kept.
//  - Fenced blocks (``` or ~~~, up to 3 spaces of indent) run to the closing fence or the end of the body.
//  - Front matter is not handled: pass the body only.
// Combining marks (\p{M}) and surrogate pairs are never split at a range end by toBodyRange().

/**
 * @typedef {{ text: string, map: Int32Array }} Projection
 * `map[i]` is the body offset of `text[i]`; `map[text.length]` is the body offset just after the last projected unit (0 for empty text).
 */

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const AUTOLINK = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/y;
const isWs = (ch) => ch === '' || ch === undefined || /\s/.test(ch);
const isWordChar = (ch) => ch !== '' && ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isHigh = (u) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u) => u >= 0xdc00 && u <= 0xdfff;

/**
 * Project a body (LF line breaks, as the editor holds it) to the prose an engine checks.
 * Left out: fenced code, inline code, HTML comments, link and image destinations, reference definitions, autolinks, images, emphasis markers,
 * heading / quote / list markers at line start, and the backslash of an escape. Everything else is kept, line breaks included.
 * @param {string} body @returns {Projection}
 */
export function projectProse(body) {
  const n = body.length;
  /** @type {number[]} */
  const units = [];
  /** @type {number[]} */
  const offs = [];
  const keep = (i) => { units.push(body.charCodeAt(i)); offs.push(i); };
  /** index of a `]` -> index just after the `(...)` that follows it, for links whose label is being kept */
  const closers = new Map();
  const blankBetween = (a, b) => /\n[ \t]*\n/.test(body.slice(a, b));

  /** Index of the `]` that matches the `[` at `open`, or -1. */
  const closeBracket = (open) => {
    let depth = 0;
    for (let k = open; k < n; k += 1) {
      const c = body[k];
      if (c === '\\') k += 1;
      else if (c === '\n' && /^\n[ \t]*\n/.test(body.slice(k, k + 64))) return -1;
      else if (c === '[') depth += 1;
      else if (c === ']') { depth -= 1; if (depth === 0) return k; }
    }
    return -1;
  };
  /** Index just after the `)` that matches the `(` at `open`, or -1. */
  const closeParen = (open) => {
    let depth = 0;
    for (let k = open; k < n; k += 1) {
      const c = body[k];
      if (c === '\\') k += 1;
      else if (c === '\n' && /^\n[ \t]*\n/.test(body.slice(k, k + 64))) return -1;
      else if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) return k + 1; }
    }
    return -1;
  };

  /** @type {{ ch: string, len: number } | null} */
  let fence = null;
  let i = 0;
  while (i < n) {
    // i is at the start of a line
    const eol = body.indexOf('\n', i);
    const end = eol < 0 ? n : eol;
    const nl = eol < 0 ? n : eol + 1;
    const line = body.slice(i, end);

    if (fence) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) {
        fence = null;
        if (eol >= 0) keep(eol); // the block leaves one line break, so the paragraphs around it stay apart
      }
      i = nl;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { ch: open[1][0], len: open[1].length };
      i = nl;
      continue;
    }
    if (/^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*\S/.test(line)) {
      if (eol >= 0) keep(eol);
      i = nl;
      continue;
    }

    let p = i;
    for (;;) {
      const m = /^ {0,3}> /.exec(body.slice(p, end));
      if (!m) break;
      p += m[0].length;
    }
    const rest = body.slice(p, end);
    const prefix = /^ {0,3}#{1,6} /.exec(rest) ?? /^ *(?:[-*+]|\d{1,9}[.)]) /.exec(rest);
    if (prefix) p += prefix[0].length;

    let j = p;
    for (;;) {
      if (j >= n) { i = n; break; }
      const c = body[j];
      if (c === '\n') { keep(j); i = j + 1; break; }

      if (c === ']' && closers.has(j)) { j = closers.get(j); continue; }
      if (c === '\\') {
        const d = body[j + 1];
        if (d !== undefined && d !== '\n' && ESCAPABLE.test(d)) { keep(j + 1); j += 2; } else { keep(j); j += 1; }
        continue;
      }
      if (c === '<') {
        if (body.startsWith('<!--', j)) {
          const e = body.indexOf('-->', j + 4);
          if (e >= 0) { j = e + 3; continue; }
        }
        AUTOLINK.lastIndex = j;
        const m = AUTOLINK.exec(body);
        if (m) { j += m[0].length; continue; }
        keep(j); j += 1;
        continue;
      }
      if (c === '`') {
        let k = 1;
        while (body[j + k] === '`') k += 1;
        let found = -1;
        let q = j + k;
        while (q < n) {
          const s = body.indexOf('`', q);
          if (s < 0) break;
          let e = s;
          while (body[e] === '`') e += 1;
          if (e - s === k) { found = s; break; }
          q = e;
        }
        if (found >= 0 && !blankBetween(j, found)) { j = found + k; continue; }
        for (let t = 0; t < k; t += 1) keep(j + t);
        j += k;
        continue;
      }
      if (c === '!' && body[j + 1] === '[') {
        const cb = closeBracket(j + 1);
        if (cb >= 0 && body[cb + 1] === '(') {
          const pe = closeParen(cb + 1);
          if (pe >= 0) { j = pe; continue; }
        }
        keep(j); j += 1;
        continue;
      }
      if (c === '[') {
        const cb = closeBracket(j);
        if (cb >= 0 && body[cb + 1] === '(') {
          const pe = closeParen(cb + 1);
          if (pe >= 0) { closers.set(cb, pe); j += 1; continue; }
        }
        keep(j); j += 1;
        continue;
      }
      if (c === '*' || c === '_' || c === '~') {
        let e = j;
        while (body[e] === c) e += 1;
        const prev = j > 0 ? body[j - 1] : '';
        const next = e < n ? body[e] : '';
        let drop = !(isWs(prev) && isWs(next));
        if (c === '_' && isWordChar(prev) && isWordChar(next)) drop = false;
        if (c === '~' && e - j < 2) drop = false;
        if (!drop) for (let t = j; t < e; t += 1) keep(t);
        j = e;
        continue;
      }
      keep(j); j += 1;
    }
  }

  const map = new Int32Array(units.length + 1);
  for (let k = 0; k < units.length; k += 1) map[k] = offs[k];
  map[units.length] = units.length > 0 ? offs[units.length - 1] + 1 : 0;
  let text = '';
  for (let k = 0; k < units.length; k += 8192) text += String.fromCharCode(...units.slice(k, k + 8192));
  return { text, map };
}

/**
 * Map a projected `[from, to)` back to a body range `{ from, to }`. Neither end splits a surrogate pair, and the end is moved past any
 * combining marks that follow it. An empty or invalid range returns null.
 * @param {Projection} projection @param {number} from @param {number} to
 * @returns {{ from: number, to: number } | null}
 */
export function toBodyRange(projection, from, to) {
  const { text, map } = projection;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || to <= from) return null;
  let f = from;
  let t = to;
  if (f > 0 && isLow(text.charCodeAt(f)) && isHigh(text.charCodeAt(f - 1))) f -= 1;
  if (t < text.length && isHigh(text.charCodeAt(t - 1)) && isLow(text.charCodeAt(t))) t += 1;
  while (t < text.length) {
    const cp = text.codePointAt(t);
    if (!/\p{M}/u.test(String.fromCodePoint(cp))) break;
    t += cp > 0xffff ? 2 : 1;
  }
  return { from: map[f], to: map[t - 1] + 1 };
}

/** UTF-16 index of the code point at index `cp` (counted in code points). Past the end: text.length. @param {string} text @param {number} cp */
export function codePointToUtf16(text, cp) {
  let units = 0;
  let count = 0;
  while (count < cp && units < text.length) {
    units += text.codePointAt(units) > 0xffff ? 2 : 1;
    count += 1;
  }
  return units;
}

/**
 * UTF-16 index for a UTF-8 byte offset. An offset inside a character rounds down to that character's start; past the end gives text.length.
 * A lone surrogate counts 3 bytes (it encodes as U+FFFD).
 * @param {string} text @param {number} byteOffset
 */
export function utf8ToUtf16(text, byteOffset) {
  let bytes = 0;
  let units = 0;
  while (units < text.length) {
    const cp = text.codePointAt(units);
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + size > byteOffset) return units;
    bytes += size;
    units += cp > 0xffff ? 2 : 1;
  }
  return units;
}

/**
 * UTF-16 index of a 1-based line and 0-based UTF-16 column (`\n` line breaks). Null when the line or column is out of range
 * (a column equal to the line length is the end of the line and is allowed).
 * @param {string} text @param {number} line @param {number} column @returns {number | null}
 */
export function lineColumnToUtf16(text, line, column) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 0) return null;
  let start = 0;
  for (let l = 1; l < line; l += 1) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return null;
    start = nl + 1;
  }
  const nl = text.indexOf('\n', start);
  const lineEnd = nl < 0 ? text.length : nl;
  return column <= lineEnd - start ? start + column : null;
}

/**
 * Offset in a raw body (which may hold CRLF) for an LF-view offset. Gives the same answer as `rawOffset` in packages/core/src/ai-rewrite.mjs.
 * @param {string} raw @param {number} lf
 */
export function lfOffsetToRaw(raw, lf) {
  if (!raw.includes('\r\n')) return lf;
  let r = 0;
  let l = 0;
  while (l < lf && r < raw.length) {
    if (raw.charCodeAt(r) === 13 && raw.charCodeAt(r + 1) === 10) r += 2;
    else r += 1;
    l += 1;
  }
  return r;
}

/**
 * LF-view offset for an offset in a raw body that may hold CRLF. An offset between the CR and LF of a CRLF rounds down to before it.
 * @param {string} raw @param {number} rawOffset
 */
export function rawOffsetToLf(raw, rawOffset) {
  const limit = Math.min(rawOffset, raw.length);
  let r = 0;
  let l = 0;
  while (r < limit) {
    if (raw.charCodeAt(r) === 13 && raw.charCodeAt(r + 1) === 10) {
      if (r + 2 > limit) break;
      r += 2;
    } else r += 1;
    l += 1;
  }
  return l;
}
