// M13-J01: the web app keeps copies of the finding contract and the prose map. Each copy must equal its package file after its first line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

for (const name of ['findings', 'prose-map']) {
  test(`apps/web/src/findings/${name}.js matches packages/format/src/${name}.mjs`, () => {
    const copy = read(`apps/web/src/findings/${name}.js`);
    const firstBreak = copy.indexOf('\n');
    assert.ok(copy.startsWith(`// Copy of packages/format/src/${name}.mjs `), 'the copy starts with a comment naming its source');
    assert.equal(copy.slice(firstBreak + 1), read(`packages/format/src/${name}.mjs`), `copy packages/format/src/${name}.mjs to apps/web/src/findings/${name}.js`);
  });
}
