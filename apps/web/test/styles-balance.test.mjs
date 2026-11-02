// The stylesheet must be well formed: one unclosed brace silently disables every rule after it
// (found in M05 review: a merge left `.cf-stale-row {` open and the export, AI and suggestion styles stopped applying).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

test('styles.css: braces balance and no rule opens inside another plain rule', () => {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  /** @type {{ line: number, atRule: boolean }[]} */
  const stack = [];
  let line = 1;
  let selector = '';
  for (const ch of text) {
    if (ch === '\n') line += 1;
    if (ch === '{') {
      const atRule = selector.trim().startsWith('@');
      const parent = stack.at(-1);
      assert.ok(!parent || parent.atRule, `line ${line}: a rule opens inside the unclosed rule from line ${parent?.line}`);
      stack.push({ line, atRule });
      selector = '';
    } else if (ch === '}') {
      assert.ok(stack.length > 0, `line ${line}: a closing brace with nothing open`);
      stack.pop();
      selector = '';
    } else if (ch === ';') {
      selector = '';
    } else {
      selector += ch;
    }
  }
  assert.deepEqual(stack, [], 'every rule is closed');
});

test('styles.css: no leftover merge markers', () => {
  assert.doesNotMatch(css, /^(<{7}|={7}|>{7})( |$)/m);
});
