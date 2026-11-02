// Small pure helpers for the legacy importer: deterministic IDs, PHP-compatible trimming, natural ordering, YAML front matter text.
import crypto from 'node:crypto';
import { slugify } from '@storyforge/manuscript';

export { slugify };

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `<prefix>_` + 26 Crockford chars from the first 130 bits of sha256('storyforge-legacy-v1' | table | id). */
export function deterministicId(prefix, table, id) {
  const hex = crypto.createHash('sha256').update(`storyforge-legacy-v1|${table}|${id}`, 'utf8').digest('hex');
  const n = BigInt(`0x${hex.slice(0, 33)}`) >> 2n; // 132 bits -> 130 bits
  let out = '';
  for (let i = 25; i >= 0; i--) out += CROCKFORD[Number((n >> BigInt(i * 5)) & 31n)];
  return `${prefix}_${out}`;
}

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const md5Hex = (text) => crypto.createHash('md5').update(Buffer.from(text, 'utf8')).digest('hex');

/** PHP trim() with the default character list. */
export const phpTrim = (s, chars = ' \t\n\r\0\x0B') => {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
};

export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const pad = (n, w) => String(n).padStart(w, '0');

/** Legacy chapter reference (ch_ref in continuity.php): "chapter-04" / "Ch. 4" / "04" -> "4"; "3.5" stays; prologue/epilogue by name; '' blank; null unparseable. */
export function chRef(s) {
  const c = String(s ?? '').trim().toLowerCase();
  if (c === '') return '';
  if (c.includes('prologue')) return 'prologue';
  if (c.includes('epilogue')) return 'epilogue';
  const m = /^(?:ch(?:apter)?[\s._-]*)?0*(\d+(?:\.\d+)?)\b/.exec(c);
  if (m) return m[1];
  const z = /^(?:ch(?:apter)?[\s._-]*)?(0+)\b/.exec(c);
  return z ? '0' : null;
}

/** Natural order key of a legacy chapter `num` string: [class, number, text]. */
export function numKey(num) {
  const r = chRef(num);
  if (r === 'prologue') return [0, 0, ''];
  if (r === 'epilogue') return [3, 0, ''];
  if (r !== null && r !== '' && /^\d/.test(r)) return [1, Number(r), ''];
  return [2, 0, String(num ?? '').toLowerCase()];
}
export function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Numeric ids compare numerically, anything else by code point. */
export function compareIds(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y) && String(x) === String(a) && String(y) === String(b)) return x - y;
  return byCodePoint(String(a), String(b));
}

// ---- YAML front matter text -----------------------------------------------------------------------------------------------------
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n', '~']);
const PLAIN_RE = /^[A-Za-z][A-Za-z0-9 _.()'-]*$/;
const CTRL_RE = new RegExp("[" + String.fromCharCode(0x80) + "-" + String.fromCharCode(0x9f) + String.fromCharCode(0x2028, 0x2029, 0xfeff) + "]", "g");
const jsonQuote = (s) => JSON.stringify(s).replace(CTRL_RE, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** One scalar as YAML: plain when that is certainly safe, else a double-quoted (JSON) string. */
export function yamlScalar(v) {
  if (v === null || v === undefined) return '""';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '""';
  const s = String(v);
  if (PLAIN_RE.test(s) && s === s.trim() && !RESERVED.has(s.toLowerCase())) return s;
  return jsonQuote(s);
}
const yamlKey = (k) => (/^[A-Za-z][A-Za-z0-9_-]*$/.test(k) && !RESERVED.has(k.toLowerCase()) ? k : jsonQuote(k));

/** @param {Record<string, any>} obj ordered keys; undefined values are skipped */
export function frontMatter(obj) {
  const lines = ['---'];
  const emit = (key, v, indent) => {
    const pre = `${' '.repeat(indent)}${yamlKey(key)}:`;
    if (Array.isArray(v)) {
      if (v.length === 0) lines.push(`${pre} []`);
      else if (v.every((x) => x === null || typeof x !== 'object')) lines.push(`${pre} [${v.map(yamlScalar).join(', ')}]`);
      else {
        lines.push(pre);
        for (const item of v) {
          const entries = Object.entries(item).filter(([, x]) => x !== undefined);
          entries.forEach(([k, x], i) => lines.push(`${' '.repeat(indent + 2)}${i === 0 ? '- ' : '  '}${yamlKey(k)}: ${yamlScalar(x)}`));
        }
      }
    } else if (v && typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined);
      if (entries.length === 0) lines.push(`${pre} {}`);
      else {
        lines.push(pre);
        for (const [k, x] of entries) lines.push(`${' '.repeat(indent + 2)}${yamlKey(k)}: ${yamlScalar(x)}`);
      }
    } else lines.push(`${pre} ${yamlScalar(v)}`);
  };
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) emit(k, v, 0);
  lines.push('---');
  return `${lines.join('\n')}\n`;
}
