// M07-J04 themes: text colours come from theme tokens, so the light and high-contrast themes keep every label readable.
// A hard-coded white was the strongest text in the dark reference theme and became invisible on the light background.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** @param {string} dir @returns {string[]} every .css file under dir */
function cssFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? cssFiles(path.join(dir, e.name)) : e.name.endsWith('.css') ? [path.join(dir, e.name)] : []));
}

test('no stylesheet outside the theme tokens sets a literal text colour of white or black', () => {
  const bad = [];
  for (const f of cssFiles(src)) {
    if (path.basename(path.dirname(f)) === 'theme') continue; // tokens.css defines the colours
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*color:\s*(#fff(fff)?|#000(000)?|white|black)\s*;/i.test(line)) bad.push(`${path.relative(src, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});
