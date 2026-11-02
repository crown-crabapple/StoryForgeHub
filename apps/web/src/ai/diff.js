// Word-level diff for the rewrite view. Pure. `wordDiff(a, b)` returns segments in reading order:
// [{ type: 'same' | 'del' | 'add', text }]. Joining the `same` and `del` texts gives `a`; joining `same` and `add` gives `b`.

const TOKEN = /\s+|[^\s]+/g;
/** Past this many tokens on a side the diff is not worth computing: the whole text shows as removed, then added. */
const MAX_TOKENS = 4000;

/** @param {string} text */
const tokens = (text) => text.match(TOKEN) ?? [];

/** @param {string} a @param {string} b @returns {{ type: 'same' | 'del' | 'add', text: string }[]} */
export function wordDiff(a, b) {
  if (a === b) return a === '' ? [] : [{ type: 'same', text: a }];
  const x = tokens(a);
  const y = tokens(b);
  if (x.length > MAX_TOKENS || y.length > MAX_TOKENS) {
    return [...(a ? [{ type: /** @type {const} */ ('del'), text: a }] : []), ...(b ? [{ type: /** @type {const} */ ('add'), text: b }] : [])];
  }
  // longest common subsequence of tokens
  const w = y.length + 1;
  const table = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      table[i * w + j] = x[i] === y[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
    }
  }
  /** @type {{ type: 'same' | 'del' | 'add', text: string }[]} */
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      push('same', x[i]);
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) push('del', x[i++]);
    else push('add', y[j++]);
  }
  while (i < x.length) push('del', x[i++]);
  while (j < y.length) push('add', y[j++]);
  return out;
}
