// Display transform for scene prose. Pure: it only describes how to show the text. The source string is
// never changed, and joining every segment's `raw` gives the source back exactly.

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Inline code, an HTML comment, or a wiki-link. The leftmost match wins, so a comment or link inside
// inline code stays code.
const INLINE_RE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)|<!--[\s\S]*?-->|\[\[([^\]\n]+?)\]\]/g;
const NOTE_RE = /^<!--\s*note:\s*([\s\S]*?)\s*-->$/i;

/**
 * @typedef {{ type: 'text', raw: string, text: string }
 *   | { type: 'comment', raw: string, text: string, note: string | null }
 *   | { type: 'wikilink', raw: string, text: string, slug: string, label: string }
 *   | { type: 'code', raw: string, text: string, block: boolean }} ProseSegment
 */

/** Split the part of the body that is not fenced code into text, comment, wikilink and inline-code segments. */
function inlineSegments(source, out) {
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(source); m !== null; m = INLINE_RE.exec(source)) {
    if (m.index > last) out.push({ type: 'text', raw: source.slice(last, m.index), text: source.slice(last, m.index) });
    const raw = m[0];
    if (m[2] !== undefined) {
      const bar = m[2].indexOf('|');
      const slug = (bar === -1 ? m[2] : m[2].slice(0, bar)).trim();
      const label = bar === -1 ? slug : m[2].slice(bar + 1).trim();
      out.push({ type: 'wikilink', raw, text: label === '' ? slug : label, slug, label: label === '' ? slug : label });
    } else if (raw.startsWith('<!--')) {
      const note = NOTE_RE.exec(raw);
      out.push({ type: 'comment', raw, text: raw, note: note ? note[1] : null });
    } else {
      out.push({ type: 'code', raw, text: raw, block: false });
    }
    last = m.index + raw.length;
  }
  if (last < source.length) out.push({ type: 'text', raw: source.slice(last), text: source.slice(last) });
}

/**
 * Split prose into segments for display.
 * @param {string} source
 * @returns {ProseSegment[]}
 */
export function segmentProse(source) {
  /** @type {ProseSegment[]} */
  const out = [];
  let textStart = 0;
  let fenceStart = -1;
  let fence = null; // { ch, len }
  let pos = 0;
  while (pos <= source.length) {
    const nl = source.indexOf('\n', pos);
    const lineEnd = nl === -1 ? source.length : nl;
    const line = source.slice(pos, lineEnd);
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') {
        out.push({ type: 'code', raw: source.slice(fenceStart, lineEnd), text: source.slice(fenceStart, lineEnd), block: true });
        textStart = lineEnd;
        fence = null;
      }
    } else if (m) {
      inlineSegments(source.slice(textStart, pos), out);
      fenceStart = pos;
      fence = { ch: m[1][0], len: m[1].length };
    }
    pos = lineEnd + 1;
  }
  if (fence) out.push({ type: 'code', raw: source.slice(fenceStart), text: source.slice(fenceStart), block: true });
  else inlineSegments(source.slice(textStart), out);
  return out;
}

/** The text of every `<!-- note: ... -->` comment, in order (read-only; for the inspector). @param {string} source */
export function sceneNotes(source) {
  return segmentProse(source).flatMap((s) => (s.type === 'comment' && s.note ? [s.note] : []));
}
