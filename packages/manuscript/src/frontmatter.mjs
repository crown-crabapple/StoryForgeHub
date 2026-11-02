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
