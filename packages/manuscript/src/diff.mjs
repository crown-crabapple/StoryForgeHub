// A small unified-diff writer (no dependency). Used for the dry-run previews of structure commands.

/** Split text into lines that keep their terminator ("a\n", "b" for a last line without one). */
function splitLines(text) {
  const out = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(pos, end));
    pos = end;
  }
  return out;
}

const MAX_CELLS = 4_000_000;

/**
 * Edit script between two line lists as ops: { t: ' ' | '-' | '+', line }.
 * Common head and tail are trimmed first; the middle uses an LCS table (or a plain replace when huge).
 */
function editScript(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  const ops = a.slice(0, head).map((line) => ({ t: ' ', line }));
  if (ma.length * mb.length > MAX_CELLS) {
    for (const line of ma) ops.push({ t: '-', line });
    for (const line of mb) ops.push({ t: '+', line });
  } else {
    const n = ma.length;
    const m = mb.length;
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        ops.push({ t: ' ', line: ma[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) ops.push({ t: '-', line: ma[i++] });
      else ops.push({ t: '+', line: mb[j++] });
    }
    while (i < n) ops.push({ t: '-', line: ma[i++] });
    while (j < m) ops.push({ t: '+', line: mb[j++] });
  }
  for (const line of a.slice(a.length - tail)) ops.push({ t: ' ', line });
  return ops;
}

/** One diff line as text: the marker, the line without its terminator, and the "no newline" note if needed. */
function show(t, line) {
  const body = line.replace(/\r?\n$/, '');
  return `${t}${body}${line.endsWith('\n') ? '' : '\n\\ No newline at end of file'}`;
}

/**
 * Unified diff of two texts. `from`/`to` null means the file is created/removed.
 * With identical text and different names the result has only the two header lines (a pure move).
 * @param {string|null} fromName @param {string|null} toName @param {string} before @param {string} after
 * @param {number} [context]
 */
export function unifiedDiff(fromName, toName, before, after, context = 3) {
  const header = `--- ${fromName === null ? '/dev/null' : `a/${fromName}`}\n+++ ${toName === null ? '/dev/null' : `b/${toName}`}`;
  if (before === after) return `${header}\n`;
  const ops = editScript(splitLines(before), splitLines(after));
  // hunks: runs of changes with `context` lines around them
  const changed = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
  const hunks = [];
  for (const i of changed) {
    const last = hunks[hunks.length - 1];
    if (last && i - last.end <= 2 * context + 1) last.end = i;
    else hunks.push({ start: i, end: i });
  }
  // line numbers (1-based) at the start of every op
  const aAt = [];
  const bAt = [];
  let a = 1;
  let b = 1;
  for (const o of ops) {
    aAt.push(a);
    bAt.push(b);
    if (o.t !== '+') a++;
    if (o.t !== '-') b++;
  }
  const out = [header];
  for (const h of hunks) {
    const from = Math.max(0, h.start - context);
    const to = Math.min(ops.length - 1, h.end + context);
    const slice = ops.slice(from, to + 1);
    const aCount = slice.filter((o) => o.t !== '+').length;
    const bCount = slice.filter((o) => o.t !== '-').length;
    const aStart = aCount === 0 ? aAt[from] - 1 : aAt[from];
    const bStart = bCount === 0 ? bAt[from] - 1 : bAt[from];
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) out.push(show(o.t, o.line));
  }
  return `${out.join('\n')}\n`;
}
