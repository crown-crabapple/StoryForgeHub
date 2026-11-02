// The exact line diff between two saved states of a file, as written into a receipt, and its replay.
// Hunk header: `@@ -s,n +t,m @@` = n lines removed starting at line s of the before text, m lines added starting at line t of the after text
// (for n = 0 the lines are inserted before line s; for m = 0 line t is the line that follows the removed block). Lines are `-text` / `+text`.
// A last line `\ after: eol=lf|crlf trailing=yes|no` records the line ending of the after text when it differs from the before text.
import { lineDiff as groupDiff, splitLines } from '@storyforge/suggestions';

const HEADER_RE = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/;
const META_RE = /^\\ after: eol=(lf|crlf) trailing=(yes|no)$/;

const EOL = { lf: '\n', crlf: '\r\n' };
const eolName = (eol) => (eol === '\r\n' ? 'crlf' : 'lf');

/**
 * The line diff from `beforeBytes` to `afterBytes` (Buffers or strings): minimal hunks without context.
 * @returns {{ diff: string, ranges: { before: [number, number], after: [number, number] }[], hunks: object[], exact: boolean }}
 *   `ranges` are 1-based inclusive (an empty range has end = start - 1); `exact` is false when replaying the diff would not give `afterBytes`
 *   byte for byte (mixed line endings or bytes that are not UTF-8).
 */
export function lineDiff(beforeBytes, afterBytes) {
  const before = splitLines(beforeBytes);
  const after = splitLines(afterBytes);
  const hunks = [];
  for (const h of groupDiff(beforeBytes, afterBytes).hunks) {
    const o = h.originalLines;
    const n = h.newLines;
    let pre = 0;
    while (pre < o.length && pre < n.length && o[pre] === n[pre]) pre++;
    let suf = 0;
    while (suf < o.length - pre && suf < n.length - pre && o[o.length - 1 - suf] === n[n.length - 1 - suf]) suf++;
    const removed = o.slice(pre, o.length - suf);
    const added = n.slice(pre, n.length - suf);
    if (removed.length === 0 && added.length === 0) continue;
    hunks.push({ beforeStart: h.line + pre, beforeCount: removed.length, afterStart: h.newLine + pre, afterCount: added.length, removed, added });
  }
  const out = [];
  for (const h of hunks) {
    out.push(`@@ -${h.beforeStart},${h.beforeCount} +${h.afterStart},${h.afterCount} @@`, ...h.removed.map((l) => `-${l}`), ...h.added.map((l) => `+${l}`));
  }
  const meta = after.eol !== before.eol || after.trailing !== before.trailing;
  if (meta) out.push(`\\ after: eol=${eolName(after.eol)} trailing=${after.trailing ? 'yes' : 'no'}`);
  const ranges = hunks.map((h) => ({ before: [h.beforeStart, h.beforeStart + h.beforeCount - 1], after: [h.afterStart, h.afterStart + h.afterCount - 1] }));
  const diff = out.join('\n');
  const want = Buffer.isBuffer(afterBytes) ? afterBytes : Buffer.from(afterBytes, 'utf8');
  const exact = (() => {
    try {
      return applyDiff(beforeBytes, diff).equals(want);
    } catch {
      return false;
    }
  })();
  return { diff, ranges, hunks, exact };
}

/**
 * Parse diff text (the hunk lines, no fence).
 * @param {string} text
 * @returns {{ hunks: { beforeStart: number, beforeCount: number, afterStart: number, afterCount: number, removed: string[], added: string[] }[], after: { eol: string, trailing: boolean } | null }}
 */
export function parseDiff(text) {
  const hunks = [];
  let after = null;
  let cur = null;
  const lines = text === '' ? [] : text.split('\n');
  for (const line of lines) {
    const head = HEADER_RE.exec(line);
    if (head) {
      cur = { beforeStart: Number(head[1]), beforeCount: Number(head[2]), afterStart: Number(head[3]), afterCount: Number(head[4]), removed: [], added: [] };
      hunks.push(cur);
      continue;
    }
    const meta = META_RE.exec(line);
    if (meta) {
      after = { eol: EOL[meta[1]], trailing: meta[2] === 'yes' };
      cur = null;
      continue;
    }
    if (!cur) throw Object.assign(new Error(`diff line outside a hunk: ${line.slice(0, 40)}`), { code: 'RCPT_MALFORMED' });
    if (line.startsWith('-')) cur.removed.push(line.slice(1));
    else if (line.startsWith('+')) cur.added.push(line.slice(1));
    else throw Object.assign(new Error(`bad diff line: ${line.slice(0, 40)}`), { code: 'RCPT_MALFORMED' });
  }
  for (const h of hunks) {
    if (h.removed.length !== h.beforeCount || h.added.length !== h.afterCount) throw Object.assign(new Error('a hunk header does not match its lines'), { code: 'RCPT_MALFORMED' });
  }
  return { hunks, after };
}

/**
 * Apply a receipt diff to `beforeBytes`. Throws (code RCPT_DIFF_MISMATCH) when a removed line is not where the diff says.
 * @param {Buffer | string} beforeBytes @param {string} diffText @returns {Buffer}
 */
export function applyDiff(beforeBytes, diffText) {
  const { hunks, after } = parseDiff(diffText);
  const base = splitLines(beforeBytes);
  const out = [];
  let pos = 0;
  for (const h of hunks) {
    const start = h.beforeStart - 1;
    if (start < pos || start + h.beforeCount > base.lines.length) throw Object.assign(new Error('a hunk lies outside the text'), { code: 'RCPT_DIFF_MISMATCH' });
    for (let i = 0; i < h.beforeCount; i++) {
      if (base.lines[start + i] !== h.removed[i]) throw Object.assign(new Error(`line ${start + i + 1} is not what the diff removes`), { code: 'RCPT_DIFF_MISMATCH' });
    }
    out.push(...base.lines.slice(pos, start), ...h.added);
    pos = start + h.beforeCount;
  }
  out.push(...base.lines.slice(pos));
  const eol = after ? after.eol : base.eol;
  const trailing = after ? after.trailing : base.trailing;
  return Buffer.from(out.join(eol) + (trailing && out.length > 0 ? eol : ''), 'utf8');
}
