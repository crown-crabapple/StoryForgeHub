// No network code in the finding layer (M13-J01): the editor module and, once it exists, every file in src/findings/.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../src/', import.meta.url);
const FORBIDDEN = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'import(', 'http://', 'https://'];

const files = [new URL('editor/finding-marks.js', root)];
const dir = new URL('findings/', root);
if (existsSync(dir)) for (const name of readdirSync(dir)) files.push(new URL(`findings/${name}`, root));

test('finding-marks.js and src/findings/ contain no network code', () => {
  for (const url of files) {
    const text = readFileSync(url, 'utf8');
    for (const word of FORBIDDEN) assert.ok(!text.includes(word), `${url.pathname} contains ${word}`);
  }
});
