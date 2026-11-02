// Deterministic line diff: common prefix/suffix trimmed, then Myers O(ND) on the middle. A pathological middle (edit distance above the cap)
// becomes one replace group, so the result is always the same for the same input.

const MAX_D = 1500;

/**
 * @param {string[]} a original lines
 * @param {string[]} b proposed lines
 * @returns {{ aStart: number, aEnd: number, bStart: number, bEnd: number }[]} changed groups (0-based, end exclusive), in order; deletes and inserts that touch are one group
 */
export function diffGroups(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (A.length === 0 && B.length === 0) return [];
  const ops = myers(A, B); // array of 'e' | 'd' | 'i'
  const groups = [];
  let ai = 0;
  let bi = 0;
  let cur = null;
  for (const op of ops) {
    if (op === 'e') {
      if (cur) groups.push(cur);
      cur = null;
      ai++;
      bi++;
      continue;
    }
    cur ??= { aStart: pre + ai, aEnd: pre + ai, bStart: pre + bi, bEnd: pre + bi };
    if (op === 'd') {
      ai++;
      cur.aEnd = pre + ai;
    } else {
      bi++;
      cur.bEnd = pre + bi;
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

function myers(A, B) {
  const n = A.length;
  const m = B.length;
  const fallback = () => [...Array(n).fill('d'), ...Array(m).fill('i')];
  if (n === 0) return Array(m).fill('i');
  if (m === 0) return Array(n).fill('d');
  const max = Math.min(n + m, MAX_D);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return fallback();
  // backtrack
  const out = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && pv[offset + k - 1] < pv[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = pv[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push('e');
      x--;
      y--;
    }
    if (x === prevX) {
      out.push('i');
      y--;
    } else {
      out.push('d');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    out.push('e');
    x--;
    y--;
  }
  return out.reverse();
}
