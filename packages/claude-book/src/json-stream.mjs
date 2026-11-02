// Parse a text made of concatenated JSON values (pretty-printed objects one after another, optionally
// separated by blank lines), the layout Claude-Book uses for ledger.md, entries-index.md, state-events.md
// and knowledge/<slug>.md. Pure; no I/O.

/**
 * @param {string} text
 * @returns {unknown[]} the values in order
 * @throws {Error} when the text is not a sequence of complete JSON objects or arrays
 */
export function parseConcatenatedJson(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '﻿' || c === ',') {
      i++;
      continue;
    }
    if (c !== '{' && c !== '[') throw new Error(`unexpected character at offset ${i}`);
    let depth = 0;
    let inString = false;
    let j = i;
    for (; j < n; j++) {
      const d = text[j];
      if (inString) {
        if (d === '\\') j++;
        else if (d === '"') inString = false;
      } else if (d === '"') inString = true;
      else if (d === '{' || d === '[') depth++;
      else if (d === '}' || d === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error(`unterminated JSON value starting at offset ${i}`);
    out.push(JSON.parse(text.slice(i, j + 1)));
    i = j + 1;
  }
  return out;
}
