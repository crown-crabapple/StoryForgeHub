// Golden-file helper for the v1-compat tests (not a test file). UPDATE_GOLDEN=1 writes the golden; otherwise the value is compared.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** A short hint naming the first path where `a` and `b` differ (and counts for arrays/objects). */
function firstDiff(a, b, at = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: length ${a.length} (golden) vs ${b.length} (actual)`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${at}[${i}]`); if (d) return d; }
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const k of keys) {
      if (!(k in a)) return `${at}.${k}: added (not in golden)`;
      if (!(k in b)) return `${at}.${k}: removed (in golden, missing now)`;
      const d = firstDiff(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: ${JSON.stringify(a)?.slice(0, 80)} (golden) vs ${JSON.stringify(b)?.slice(0, 80)} (actual)`;
}

/** Compare `actual` with the JSON golden at `file`, or write it when UPDATE_GOLDEN=1. `cmd` is the command printed to regenerate it. */
export function checkGolden(file, actual, cmd) {
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    assert.deepEqual(JSON.parse(text), golden);
  } catch (e) {
    e.message = `The external API surface changed. First difference: ${firstDiff(golden, JSON.parse(text))}\nIf the change is intended, regenerate with: ${cmd}\n\n${e.message}`;
    throw e;
  }
}
