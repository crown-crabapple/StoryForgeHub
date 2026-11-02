// Words added / removed by one save: a word-level diff of the old and new body, using the same tokens countWords counts.
// Pure. Above FALLBACK_TOKENS tokens (in the part that changed) the cost is capped: only the net change is reported.
import { wordTokens } from '@storyforge/index';

export const FALLBACK_TOKENS = 20_000;

/**
 * @param {string} oldBody
 * @param {string} newBody
 * @returns {{ added: number, removed: number }}
 */
export function wordDelta(oldBody, newBody) {
  if (oldBody === newBody) return { added: 0, removed: 0 };
  const a = wordTokens(oldBody);
  const b = wordTokens(newBody);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { added: m, removed: n };
  if (n + m > FALLBACK_TOKENS) return { added: Math.max(0, m - n), removed: Math.max(0, n - m) };
  // length of the longest common subsequence, two rows
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const x = a[start + i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = x === b[start + j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[m];
  return { added: m - lcs, removed: n - lcs };
}
