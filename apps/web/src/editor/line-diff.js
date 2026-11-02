// A small line diff for the conflict "Compare" view: your text on the left, the file on disk on the right.
// Pure. Line endings are ignored when comparing (a trailing CR does not make a line differ).

const MAX_CELLS = 4_000_000;

/** @param {string} text @returns {string[]} lines (no line endings); '' gives [] */
export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * @typedef {{ type: 'same' | 'change' | 'left-only' | 'right-only', left: string | null, right: string | null, leftNo: number | null, rightNo: number | null }} DiffRow
 */

/**
 * Side-by-side rows. 'same' lines are equal; a run of removed and added lines becomes 'change' rows (paired in
 * order), then 'left-only' / 'right-only' for the unpaired rest.
 * @param {string} mine @param {string} theirs @returns {DiffRow[]}
 */
export function diffLines(mine, theirs) {
  const a = splitLines(mine);
  const b = splitLines(theirs);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = lcsOps(midA, midB);

  /** @type {DiffRow[]} */
  const rows = [];
  let ln = 0;
  let rn = 0;
  const same = (text) => rows.push({ type: 'same', left: text, right: text, leftNo: ++ln, rightNo: ++rn });
  for (let i = 0; i < start; i++) same(a[i]);
  let dels = [];
  let adds = [];
  const flush = () => {
    const paired = Math.min(dels.length, adds.length);
    for (let i = 0; i < paired; i++) rows.push({ type: 'change', left: dels[i], right: adds[i], leftNo: ++ln, rightNo: ++rn });
    for (let i = paired; i < dels.length; i++) rows.push({ type: 'left-only', left: dels[i], right: null, leftNo: ++ln, rightNo: null });
    for (let i = paired; i < adds.length; i++) rows.push({ type: 'right-only', left: null, right: adds[i], leftNo: null, rightNo: ++rn });
    dels = [];
    adds = [];
  };
  for (const op of ops) {
    if (op.type === 'same') {
      flush();
      same(op.text);
    } else if (op.type === 'del') dels.push(op.text);
    else adds.push(op.text);
  }
  flush();
  for (let i = endA; i < a.length; i++) same(a[i]);
  return rows;
}

/** Longest-common-subsequence edit script over two line arrays (a whole-block change if they are very large). */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    return [...a.map((text) => ({ type: 'del', text })), ...b.map((text) => ({ type: 'add', text }))];
  }
  // dp[i][j] = length of the LCS of a[i..] and b[j..]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ type: 'del', text: a[i++] });
    else ops.push({ type: 'add', text: b[j++] });
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] });
  while (j < m) ops.push({ type: 'add', text: b[j++] });
  return ops;
}

/** True when the two texts differ only in line endings or are equal. @param {string} a @param {string} b */
export const sameLines = (a, b) => diffLines(a, b).every((r) => r.type === 'same');
