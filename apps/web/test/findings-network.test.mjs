// No network code in the finding layer (M13-J01) or the grammar checker (M13-J02): the editor module and every file in src/findings/ and src/grammar/.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../src/', import.meta.url);
const FORBIDDEN = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'import(', 'http://', 'https://'];

const files = [new URL('editor/finding-marks.js', root)];
for (const folder of ['findings', 'grammar']) {
  const dir = new URL(`${folder}/`, root);
  if (existsSync(dir)) for (const name of readdirSync(dir)) files.push(new URL(`${folder}/${name}`, root));
}

test('finding-marks.js, src/findings/ and src/grammar/ contain no network code', () => {
  assert.ok(files.some((u) => u.pathname.endsWith('/grammar/harper.worker.js')));
  for (const url of files) {
    const text = readFileSync(url, 'utf8');
    for (const word of FORBIDDEN) assert.ok(!text.includes(word), `${url.pathname} contains ${word}`);
  }
});
