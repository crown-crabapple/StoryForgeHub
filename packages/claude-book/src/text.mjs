// Pure text helpers for the author-side commands (contract M05-J06): front matter splitting, line endings,
// ids and slugs, and small line-based edits of a document's front matter. No I/O.
import crypto from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 26-char ULID (48-bit time + 80 random bits, Crockford base32). @param {number} [now] */
export function ulid(now = Date.now()) {
  let t = BigInt(now);
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[Number(t % 32n)] + time;
    t /= 32n;
  }
  let r = 0n;
  for (const b of crypto.randomBytes(10)) r = (r << 8n) | BigInt(b);
  let rand = '';
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(r % 32n)] + rand;
    r /= 32n;
  }
  return time + rand;
}

/** @param {string} text */
export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The file's own line ending. @param {string} text */
export const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

/** @param {string} text @param {string} eol */
export const withEol = (text, eol) => text.replace(/\r\n/g, '\n').replace(/\n/g, eol);

/**
 * Split a document into its front matter (opening and closing `---` lines included, bytes kept) and its body.
 * @param {string} text @returns {{ head: string, body: string } | null} null when there is no front matter
 */
export function splitFrontMatter(text) {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  return { head: m[0], body: text.slice(m[0].length) };
}

/** Title-case a slug ("the-ferryman" -> "The Ferryman"). @param {string} slug */
export const titleOfSlug = (slug) => slug.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

// ---------------------------------------------------------------------------
// front matter line edits (the file's own line ending is kept; unrelated lines stay byte-identical)

/** @param {string} text @returns {{ lines: string[], eol: string, end: number }} end = index of the closing --- line */
function open(text) {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0] ?? '')) throw new Error('no front matter');
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) { end = i; break; }
  if (end < 0) throw new Error('front matter is not closed');
  return { lines, eol, end };
}

/** Last line index (exclusive) of the block value that starts after line `s` (indented or `- ` lines). */
function blockEnd(lines, s, end) {
  let j = s + 1;
  while (j < end && (/^\s+\S/.test(lines[j]) || /^-(\s|$)/.test(lines[j]))) j++;
  return j;
}

/** Double-quoted YAML scalar. @param {string} v */
export const q = (v) => JSON.stringify(v);

/**
 * Append `state` items ({ slug, event, value? }) to the front matter's `state` list.
 * @param {string} text @param {{ slug: string, event: string, value?: string }[]} items
 */
export function addStateItems(text, items) {
  const { lines, eol, end } = open(text);
  const item = (indent, it) => `${indent}- { slug: ${q(it.slug)}, event: ${q(it.event)}${it.value === undefined ? '' : `, value: ${q(it.value)}`} }`;
  const s = lines.findIndex((l, i) => i > 0 && i < end && /^state:/.test(l));
  if (s < 0) {
    lines.splice(end, 0, 'state:', ...items.map((it) => item('  ', it)));
  } else {
    const rest = lines[s].slice('state:'.length).replace(/\s+#.*$/, '').trim();
    if (rest === '[]') {
      lines.splice(s, 1, 'state:', ...items.map((it) => item('  ', it)));
    } else if (rest === '') {
      const j = blockEnd(lines, s, end);
      const indent = /^(\s*)-/.exec(lines[s + 1] ?? '')?.[1] ?? '  ';
      lines.splice(j, 0, ...items.map((it) => item(indent, it)));
    } else {
      throw new Error('the existing `state` value is not a block list; edit it by hand');
    }
  }
  return lines.join(eol);
}

/**
 * Set a one-line scalar key in the front matter (replaces the line, or inserts it before the closing ---).
 * @param {string} text @param {string} key @param {string} value already YAML-safe
 */
export function setScalar(text, key, value) {
  const { lines, eol, end } = open(text);
  const at = lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${key}:`).test(l));
  if (at < 0) lines.splice(end, 0, `${key}: ${value}`);
  else lines.splice(at, blockEnd(lines, at, end) - at, `${key}: ${value}`);
  return lines.join(eol);
}

/**
 * Append one value to a list key of the front matter (flow `[a, b]`, empty `[]`, block list, or missing key).
 * @param {string} text @param {string} key @param {string} value already YAML-safe
 */
export function appendToList(text, key, value) {
  const { lines, eol, end } = open(text);
  const at = lines.findIndex((l, i) => i > 0 && i < end && new RegExp(`^${key}:`).test(l));
  if (at < 0) {
    lines.splice(end, 0, `${key}: [${value}]`);
  } else {
    const rest = lines[at].slice(key.length + 1).trim();
    if (rest === '' ) {
      const j = blockEnd(lines, at, end);
      const indent = /^(\s*)-/.exec(lines[at + 1] ?? '')?.[1] ?? '  ';
      lines.splice(j, 0, `${indent}- ${value}`);
    } else if (/^\[.*\]$/.test(rest) && !rest.includes('#')) {
      const inner = rest.slice(1, -1).trim();
      lines[at] = `${key}: [${inner === '' ? value : `${inner}, ${value}`}]`;
    } else {
      throw new Error(`the existing \`${key}\` value is not a list this tool can extend; edit it by hand`);
    }
  }
  return lines.join(eol);
}
