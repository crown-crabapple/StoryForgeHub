// Word count: the same rule as `countWords` in @storyforge/index (runs of non-whitespace after removing HTML
// comments and fenced code). Duplicated here because the web build cannot import workspace packages; a test
// compares the two over every fixture body and generated strings. Keep them identical.

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** @param {string} text @returns {string} text with fenced code blocks removed (an unclosed fence runs to the end) */
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

/** @param {string} body @returns {number} */
export function countWords(body) {
  const noComments = body.replace(/<!--[\s\S]*?-->/g, ' ');
  const text = stripFences(noComments);
  const runs = text.match(/\S+/g);
  return runs ? runs.length : 0;
}

/**
 * The footer text: "840 words", or "12 of 840 words" with a selection.
 * @param {number} total @param {number | null} selected null (or 0) when nothing is selected
 */
export function describeCount(total, selected) {
  const noun = (n) => (n === 1 ? 'word' : 'words');
  if (selected) return `${selected} of ${total} ${noun(total)}`;
  return `${total} ${noun(total)}`;
}

/**
 * Words in the selected text of an editor state (all selection ranges together), or 0.
 * @param {import('@codemirror/state').EditorState} state
 */
export function selectionWords(state) {
  let n = 0;
  for (const r of state.selection.ranges) if (!r.empty) n += countWords(state.sliceDoc(r.from, r.to));
  return n;
}
