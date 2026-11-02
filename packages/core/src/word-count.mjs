// Word count: runs of non-whitespace in the body, after removing HTML comments and fenced code.
// Computed on demand, never stored.

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * @param {string} text
 * @returns {string} text with fenced code blocks removed (an unclosed fence runs to the end)
 */
function stripFences(text) {
  const kept = [];
  /** @type {{char: string, len: number} | null} */
  let open = null;
  for (const line of text.split('\n')) {
    const m = FENCE_RE.exec(line.replace(/\r$/, ''));
    if (open) {
      if (m && m[1][0] === open.char && m[1].length >= open.len) open = null;
      continue;
    }
    if (m) {
      open = { char: m[1][0], len: m[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * @param {string} body
 * @returns {number}
 */
export function countWords(body) {
  const noComments = body.replace(/<!--[\s\S]*?-->/g, ' ');
  const text = stripFences(noComments);
  const runs = text.match(/\S+/g);
  return runs ? runs.length : 0;
}
