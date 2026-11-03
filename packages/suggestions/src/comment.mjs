// Comment documents (M07-J03, FORMAT-v1 9.5): build the file text, parse it back, append a reply, change the status line, find the anchor again.
// A comment is an author-data file under comments/<YYYY>/; it is never story text and never exported. Pure: no filesystem, no network.
import { parse as parseYaml } from 'yaml';
import { sha256Hex, splitLines } from './suggestion.mjs';

export const COMMENT_SCHEMA = 'storyforge.comment/v1';
export const COMMENT_STATUSES = Object.freeze(['open', 'resolved']);
export const MAX_COMMENT_CHARS = 20_000;
export const MAX_QUOTE_CHARS = 500;

const fail = (code, message) => Object.assign(new Error(message), { code });

const PLAIN_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);
const scalar = (v) => {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v ?? '');
  return PLAIN_RE.test(s) && !RESERVED.has(s.toLowerCase()) ? s : JSON.stringify(s);
};
const flowMap = (o) => `{ ${Object.entries(o).map(([k, x]) => `${k}: ${k === 'sha256' || k === 'quote' ? JSON.stringify(String(x)) : scalar(x)}`).join(', ')} }`; // a hash or a quote is always quoted, so YAML never reads it as a number

/** A name safe for one line of a reply header. @param {unknown} name */
const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Someone';

const REPLY_RE = /^## Reply — (.+) — (\S+)$/;
/** The text of a comment or reply as written to the file: a line that would read as a reply header is escaped. @param {string} text */
const escapeText = (text) => text.replace(/\r\n?/g, '\n').replace(/^(\\*)## Reply — /gm, '$1\\## Reply — ').replace(/\s+$/, '');
const unescapeText = (text) => text.replace(/^\\(\\*## Reply — )/gm, '$1');

/** `comments/<YYYY>/<YYYYMMDD-HHMMSS>-<slug>.md` from `created` (UTC). @param {string | Date} created @param {string} slug */
export function commentPath(created, slug) {
  const d = created instanceof Date ? created : new Date(created);
  if (Number.isNaN(d.getTime())) throw fail('BAD_ARGS', 'created must be a date');
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  const clean = String(slug ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'comment';
  return `comments/${p(d.getUTCFullYear(), 4)}/${stamp}-${clean}.md`;
}

/**
 * A comment file. `anchor` is { line, lines, quote?, sha256? } (file lines, 1-based); `by` is { id?, name }.
 * @param {{ id: string, targetId: string, anchor: { line: number, lines: number, quote?: string, sha256?: string }, by?: { id?: string, name: string }, created: string, text: string, status?: string }} f
 */
export function buildComment({ id, targetId, anchor, by, created, text, status = 'open' }) {
  if (typeof text !== 'string' || text.trim() === '') throw fail('BAD_ARGS', 'a comment needs text');
  if (!COMMENT_STATUSES.includes(status)) throw fail('BAD_ARGS', 'status must be open or resolved');
  const a = { line: anchor.line, lines: anchor.lines, ...(anchor.quote ? { quote: anchor.quote.replace(/\s+/g, ' ').slice(0, MAX_QUOTE_CHARS) } : {}), ...(anchor.sha256 !== undefined ? { sha256: anchor.sha256 } : {}) };
  const fm = ['---', `schema: ${COMMENT_SCHEMA}`, `id: ${id}`, `target: ${scalar(targetId)}`, `anchor: ${flowMap(a)}`, `status: ${status}`];
  if (by && typeof by.name === 'string') fm.push(`by: ${flowMap(by.id ? { id: by.id, name: by.name } : { name: by.name })}`);
  fm.push(`created: ${JSON.stringify(created)}`, '---');
  return `${fm.join('\n')}\n${escapeText(text)}\n`;
}

/** The text with a reply section appended. @param {string} text @param {{ name: string, at: string, text: string }} reply */
export function addReply(text, { name, at, text: reply }) {
  if (typeof reply !== 'string' || reply.trim() === '') throw fail('BAD_ARGS', 'a reply needs text');
  return `${text.replace(/\s+$/, '')}\n\n## Reply — ${cleanName(name)} — ${at}\n${escapeText(reply)}\n`;
}

/** The text with the front-matter `status:` line changed (and nothing else). @param {string} text @param {'open' | 'resolved'} status */
export function setCommentStatus(text, status) {
  if (!COMMENT_STATUSES.includes(status)) throw fail('BAD_ARGS', 'status must be open or resolved');
  const lines = text.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') {
      close = i;
      break;
    }
  }
  if (lines[0].replace(/\r$/, '') !== '---' || close < 0) throw fail('COMMENT_MALFORMED', 'no front matter');
  const at = lines.slice(1, close).findIndex((l) => /^status:/.test(l));
  if (at < 0) throw fail('COMMENT_MALFORMED', 'status missing');
  const cr = lines[at + 1].endsWith('\r') ? '\r' : '';
  lines[at + 1] = `status: ${status}${cr}`;
  return lines.join('\n');
}

/**
 * Parse a comment file. Throws code COMMENT_MALFORMED when the front matter is not a comment.
 * @param {string | Uint8Array} input
 * @returns {{ fm: Record<string, any>, id: string, target: string, status: string, anchor: { line: number, lines: number, quote: string, sha256: string },
 *   by: { id?: string, name: string } | null, created: string, text: string, replies: { name: string, at: string, text: string }[] }}
 */
export function parseComment(input) {
  const text = (typeof input === 'string' ? input : Buffer.from(input).toString('utf8')).replace(/^﻿/, '');
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---') throw fail('COMMENT_MALFORMED', 'no front matter');
  const close = lines.indexOf('---', 1);
  if (close < 0) throw fail('COMMENT_MALFORMED', 'front matter never closed');
  let fm;
  try {
    fm = parseYaml(lines.slice(1, close).join('\n'), { version: '1.2', schema: 'core' });
  } catch (e) {
    throw fail('COMMENT_MALFORMED', `front matter: ${String(e.message).split('\n')[0]}`);
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm) || fm.schema !== COMMENT_SCHEMA) throw fail('COMMENT_MALFORMED', `schema must be ${COMMENT_SCHEMA}`);
  const a = fm.anchor;
  if (typeof fm.id !== 'string' || typeof fm.target !== 'string' || !COMMENT_STATUSES.includes(fm.status) || !a || typeof a !== 'object' || !Number.isInteger(a.line) || !Number.isInteger(a.lines)) {
    throw fail('COMMENT_MALFORMED', 'id, target, status and anchor { line, lines } are required');
  }
  const by = fm.by && typeof fm.by === 'object' && typeof fm.by.name === 'string' ? { ...(typeof fm.by.id === 'string' ? { id: fm.by.id } : {}), name: fm.by.name } : null;
  /** @type {{ name: string, at: string, lines: string[] }[]} */
  const sections = [{ name: '', at: '', lines: [] }];
  for (const l of lines.slice(close + 1)) {
    const m = REPLY_RE.exec(l);
    if (m) sections.push({ name: m[1], at: m[2], lines: [] });
    else sections[sections.length - 1].lines.push(l);
  }
  const body = (s) => unescapeText(s.lines.join('\n').trim());
  return {
    fm,
    id: fm.id,
    target: fm.target,
    status: fm.status,
    anchor: { line: a.line, lines: a.lines, quote: typeof a.quote === 'string' ? a.quote : '', sha256: typeof a.sha256 === 'string' ? a.sha256 : '' },
    by,
    created: typeof fm.created === 'string' ? fm.created : '',
    text: body(sections[0]),
    replies: sections.slice(1).map((s) => ({ name: s.name, at: s.at, text: body(s) })),
  };
}

/** The sha256 a comment stores for the lines it is about: the exact lines joined with the file's own line ending. @param {string | Uint8Array} bytes @param {number} line @param {number} lines */
export function anchorSha(bytes, line, lines) {
  const { lines: all, eol } = splitLines(bytes);
  return sha256Hex(all.slice(line - 1, line - 1 + lines).join(eol));
}

/**
 * Where a comment's lines are in `bytes` now: at `anchor.line` when they still hash the same, else the one place anywhere that does; none or several → not found.
 * An anchor without a sha256 is trusted at its line (when the file still has that many lines).
 * @param {string | Uint8Array} bytes @param {{ line: number, lines: number, sha256?: string }} anchor
 * @returns {{ ok: true, line: number } | { ok: false }}
 */
export function locateAnchor(bytes, anchor) {
  const { lines, eol } = splitLines(bytes);
  const n = anchor.lines;
  if (!anchor.sha256) return anchor.line >= 1 && anchor.line - 1 + n <= lines.length ? { ok: true, line: anchor.line } : { ok: false };
  const matches = (i) => i >= 0 && i + n <= lines.length && sha256Hex(lines.slice(i, i + n).join(eol)) === anchor.sha256;
  if (matches(anchor.line - 1)) return { ok: true, line: anchor.line };
  const found = [];
  for (let i = 0; i + n <= lines.length; i++) if (matches(i)) found.push(i);
  return found.length === 1 ? { ok: true, line: found[0] + 1 } : { ok: false };
}
