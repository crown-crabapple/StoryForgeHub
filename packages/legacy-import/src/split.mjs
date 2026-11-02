// Byte-preserving scene split (contract section 2, risks 1 and 2).
// A chapter body is cut on lines that are exactly `---`, `***` or `___`, outside fenced code blocks and tables. Every scene body is the
// segment text byte for byte; only the separator line and the single blank line on each side of it are left out, and they are recorded
// as the `glue` between two neighbouring scenes. Invariant: body[0] + glue[0] + body[1] + ... + body[n] === the chapter body.
import { md5Hex, phpTrim } from './util.mjs';

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const SEPARATORS = new Set(['---', '***', '___']);
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const HEADING_RE = /^ {0,3}#{1,6}(\s+|$)/;

/**
 * @typedef {{ body: string, kind: 'prose' | 'comment-only' | 'heading-only' | 'empty', glue: string | null }} Segment
 * `glue` is the exact text between this scene's body and the next one's (null for the last scene).
 */

/**
 * @param {string} text the chapter body
 * @returns {Segment[]} no segments for an empty body
 */
export function splitChapter(text) {
  if (text === '') return [];
  // line table
  const starts = [];
  const ends = [];
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    starts.push(pos);
    ends.push(end);
    if (nl < 0) break;
    pos = nl + 1;
  }
  const lineText = (i) => text.slice(starts[i], ends[i]);
  const isPipeRow = (i) => i >= 0 && i < starts.length && lineText(i).trimStart().startsWith('|');

  const seps = [];
  let fence = null;
  for (let i = 0; i < starts.length; i++) {
    const line = lineText(i);
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length };
      continue;
    }
    const content = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!SEPARATORS.has(content)) continue;
    if (isPipeRow(i - 1) && isPipeRow(i + 1)) continue; // a rule between table rows
    seps.push(i);
  }

  const cuts = [];
  for (let k = 0; k <= seps.length; k++) {
    let s = k === 0 ? 0 : Math.min(ends[seps[k - 1]] + 1, text.length);
    let e = k === seps.length ? text.length : Math.max(starts[seps[k]] - 1, s); // e: the line terminator before the next separator
    if (k < seps.length && e > s && text[e - 1] === '\r') e -= 1; // a CRLF terminator belongs to the glue as a whole
    if (k > 0 && s < e) {
      if (text[s] === '\n') s += 1;
      else if (text[s] === '\r' && text[s + 1] === '\n') s += 2;
    }
    if (k < seps.length && s < e && text[e - 1] === '\n') {
      e -= 1; // the single blank line before the separator
      if (e > s && text[e - 1] === '\r') e -= 1;
    }
    if (e < s) e = s;
    cuts.push([s, e]);
  }
  return cuts.map(([s, e], k) => {
    const body = text.slice(s, e);
    return { body, kind: classify(body), glue: k < cuts.length - 1 ? text.slice(e, cuts[k + 1][0]) : null };
  });
}

/** @param {string} body */
function classify(body) {
  if (body.trim() === '') return 'empty';
  const rest = body.replace(COMMENT_RE, '');
  if (rest.trim() === '') return 'comment-only';
  const lines = rest.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.every((l) => HEADING_RE.test(l)) ? 'heading-only' : 'prose';
}

/** First ATX heading of a segment outside fenced code, as plain text ('' when none). @param {string} body */
export function sceneTitle(body) {
  let fence = null;
  for (const line of body.split('\n')) {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') fence = null;
      continue;
    }
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length };
      continue;
    }
    const h = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.replace(/\r$/, ''));
    if (h) return h[1].replace(/[*_`]/g, '').trim();
  }
  return '';
}

/** The hash the legacy `reconcile_scenes` stores for a scene: md5(prose without comments + NUL + note). @param {string} segmentText */
export function legacySceneHash(segmentText) {
  const text = segmentText.replaceAll('\r', '').replaceAll('\0', '');
  const seg = phpTrim(text, '\n');
  const comments = [];
  const prose = seg.replace(COMMENT_RE, (_m, c) => {
    const t = phpTrim(c);
    if (t !== '') comments.push(t);
    return '';
  });
  return md5Hex(`${phpTrim(prose, '\n')}\0${phpTrim(comments.join('\n'))}`);
}
