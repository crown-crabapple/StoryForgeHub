// Minimal front-matter line edits (contract rule 2). Bytes are handled as latin1 so every
// byte outside the replaced line survives exactly; YAML is never parsed or re-serialised.

const BOM = '\xEF\xBB\xBF';
const SIMPLE_RE = /^(act|chapter|sequence):[ \t]*-?\d+[ \t]*$/gm;

/**
 * Offsets of the front-matter interior in a latin1 string: from the start of the line after the
 * opening `---` up to the start of the closing `---` line. null if there is no closed front matter.
 * @param {string} s
 */
export function frontMatterRange(s) {
  const i = s.startsWith(BOM) ? 3 : 0;
  const nl = s.indexOf('\n', i);
  if (nl < 0 || s.slice(i, nl).replace(/\r$/, '') !== '---') return null;
  let pos = nl + 1;
  while (pos <= s.length) {
    const e = s.indexOf('\n', pos);
    const lineEnd = e < 0 ? s.length : e;
    if (s.slice(pos, lineEnd).replace(/\r$/, '') === '---') return { start: nl + 1, end: pos };
    if (e < 0) return null;
    pos = e + 1;
  }
  return null;
}

/**
 * Replace the simple integer lines for the given keys.
 * @param {Buffer} buf
 * @param {{act?:number, chapter?:number, sequence?:number}} edits
 * @returns {{buf: Buffer} | {error: {field: string}}}
 */
export function setFields(buf, edits) {
  const keys = Object.keys(edits);
  if (keys.length === 0) return { buf };
  const s = buf.toString('latin1');
  const range = frontMatterRange(s);
  if (!range) return { error: { field: keys[0] } };
  let region = s.slice(range.start, range.end);
  for (const key of keys) {
    const matches = [...region.matchAll(SIMPLE_RE)].filter((m) => m[1] === key);
    const anyLines = region.match(new RegExp(`^${key}:`, 'gm')) ?? [];
    if (matches.length !== 1 || anyLines.length !== 1) return { error: { field: key } };
    const m = matches[0];
    region = region.slice(0, m.index) + `${key}: ${edits[key]}` + region.slice(m.index + m[0].length);
  }
  return { buf: Buffer.from(s.slice(0, range.start) + region + s.slice(range.end), 'latin1') };
}

/**
 * Is the front-matter line for `key` in the simple `key: <integer>` form (exactly once)?
 * @param {Buffer} buf @param {string} key
 */
export function hasSimpleField(buf, key) {
  return !('error' in setFields(buf, { [key]: 0 }));
}

/**
 * Read a top-level scalar line (`key: value`) from front matter; used only for act.md/chapter.md
 * title/number lookups. Returns the raw string with surrounding quotes removed, or null.
 * @param {Buffer} buf @param {string} key
 */
export function readSimpleLine(buf, key) {
  const s = buf.toString('utf8');
  const range = frontMatterRange(s);
  if (!range) return null;
  const m = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'm').exec(s.slice(range.start, range.end));
  if (!m) return null;
  return m[1].replace(/^(["'])(.*)\1$/, '$2');
}

const ESC = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** YAML double-quoted scalar (escapes `"`, `\` and line breaks). */
export function yamlQuote(text) {
  return `"${text.replace(/[\\"\n\r\t]/g, (c) => ESC[c])}"`;
}

// ------------------------------------------------------------------ single-line string edits (M03-J01)

/** Keys inserted after a fixed anchor when they are absent (first existing anchor wins). */
const ANCHORS = { title: ['id'], status: ['sequence'], pov: ['status'], label: ['chapter'] };
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);
const PLAIN_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The YAML text for a string value: plain if it is a safe word, else double-quoted (escapes `\` and `"`). */
export function formatYamlString(value) {
  if (PLAIN_RE.test(value) && !RESERVED.has(value.toLowerCase())) return value;
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Lines of a region as { start, end, text, eol } (text without its terminator). */
function regionLines(region) {
  const out = [];
  let pos = 0;
  while (pos < region.length) {
    const nl = region.indexOf('\n', pos);
    const end = nl < 0 ? region.length : nl + 1;
    const raw = region.slice(pos, end);
    const eol = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    out.push({ start: pos, end, text: raw.slice(0, raw.length - eol.length), eol });
    pos = end;
  }
  return out;
}

/** End index (exclusive) of a complete quoted scalar starting at s[0], or -1 if it is not closed on this line. */
function quotedEnd(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') i++;
    else if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") i++;
      else return i + 1;
    }
  }
  return -1;
}

/** Is the value text (after `key:`) a single-line scalar with no comment, anchor, tag or collection? */
function isSimpleScalar(v, next) {
  if (v === '') return false;
  if (next && next.text.trim() !== '' && /^[ \t]/.test(next.text)) return false; // continuation line
  if (v[0] === '"' || v[0] === "'") {
    const end = quotedEnd(v);
    return end > 0 && v.slice(end).trim() === '';
  }
  if (/^[[{|>&*!%@`#]/.test(v) || /^-[ \t]/.test(v) || v === '-') return false;
  return !/[ \t]#/.test(v) && !/:[ \t]/.test(v) && !v.endsWith(':');
}

/**
 * Replace (or insert after an anchor) one top-level single-line string line of the front matter.
 * Every other byte stays identical; line endings are kept. YAML is never re-serialised.
 * @param {Buffer} bytes
 * @param {string} key
 * @param {string} value the new string (no control characters or line breaks)
 * @param {{anchors?: string[], integer?: boolean}} [opts] anchor keys to insert after when `key` is absent (defaults: title after id, status after sequence, pov after status);
 *   `integer: true` writes `value` (digits, no leading zero) as a plain YAML integer instead of a string
 * @returns {{ok: true, code: 'OK', buf: Buffer, bytes: Buffer, changed: boolean} | {ok: false, code: string, field: string, message: string, error: {code: string, field: string, message: string}}}
 */
export function editFrontMatterLine(bytes, key, value, { anchors, integer = false } = {}) {
  const refuse = (code, message) => ({ ok: false, code, field: key, message, error: { code, field: key, message } });
  if (typeof key !== 'string' || !KEY_RE.test(key)) return refuse('REFUSED_BAD_ARGS', 'key is not a plain YAML key');
  if (typeof value !== 'string' || CONTROL_RE.test(value)) return refuse('REFUSED_BAD_ARGS', 'value must be a string without control characters or line breaks');
  if (integer && !/^[1-9][0-9]{0,8}$/.test(value)) return refuse('REFUSED_BAD_ARGS', 'value must be a whole number written in digits');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const s = buf.toString('latin1');
  const range = frontMatterRange(s);
  if (!range) return refuse('REFUSED_UNSIMPLE_FIELD', 'the file has no closed front matter');
  const region = s.slice(range.start, range.end);
  const lines = regionLines(region);
  const keyed = (k) => lines.map((l, i) => ({ l, i })).filter(({ l }) => l.text.startsWith(`${k}:`));
  const newText = `${key}: ${integer ? value : formatYamlString(value)}`;
  const asLatin1 = (t) => Buffer.from(t, 'utf8').toString('latin1');
  const rebuild = (nextRegion) => Buffer.from(s.slice(0, range.start) + nextRegion + s.slice(range.end), 'latin1');

  const hits = keyed(key);
  if (hits.length > 1) return refuse('REFUSED_UNSIMPLE_FIELD', `"${key}" appears more than once`);
  if (hits.length === 1) {
    const { l, i } = hits[0];
    if (!isSimpleScalar(l.text.slice(key.length + 1).trim(), lines[i + 1])) {
      return refuse('REFUSED_UNSIMPLE_FIELD', `"${key}" is not a single-line scalar without comment, anchor or tag`);
    }
    const next = region.slice(0, l.start) + asLatin1(newText) + l.eol + region.slice(l.end);
    const out = rebuild(next);
    return { ok: true, code: 'OK', buf: out, bytes: out, changed: !out.equals(buf) };
  }
  for (const a of anchors ?? ANCHORS[key] ?? []) {
    const at = keyed(a);
    if (at.length !== 1) continue;
    const { l, i } = at[0];
    const next = lines[i + 1];
    if (next && next.text.trim() !== '' && /^[ \t]/.test(next.text)) return refuse('REFUSED_UNSIMPLE_FIELD', `anchor "${a}" is a multi-line value`);
    const eol = l.eol || '\n';
    const insertion = (l.eol ? '' : eol) + asLatin1(newText) + eol;
    const out = rebuild(region.slice(0, l.end) + insertion + region.slice(l.end));
    return { ok: true, code: 'OK', buf: out, bytes: out, changed: true };
  }
  return refuse('REFUSED_UNSIMPLE_FIELD', `"${key}" is missing and has no anchor line to insert after`);
}

/**
 * Split a document into front matter and body. `bodyStart` is the byte offset just past the closing `---` line.
 * @param {Buffer} buf @returns {{ bodyStart: number, region: string } | null}
 */
export function splitDocument(buf) {
  const s = buf.toString('latin1');
  const range = frontMatterRange(s);
  if (!range) return null;
  const nl = s.indexOf('\n', range.end);
  return { bodyStart: nl < 0 ? s.length : nl + 1, region: s.slice(range.start, range.end) };
}

/**
 * Top-level front-matter keys with their raw text (including continuation lines), in file order.
 * @param {string} region latin1 front-matter interior @returns {{key: string, text: string}[]}
 */
export function topLevelBlocks(region) {
  const out = [];
  for (const l of regionLines(region)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:/.exec(l.text);
    if (m) out.push({ key: m[1], text: region.slice(l.start, l.end) });
    else if (out.length) out[out.length - 1].text += region.slice(l.start, l.end);
  }
  return out;
}
