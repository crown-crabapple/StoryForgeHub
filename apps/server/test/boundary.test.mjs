import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ESLint } from 'eslint';
import { REPO_ROOT } from './helpers.mjs';

let eslint;
before(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

/** Lint `code` as if it lived at `rel` (relative to repo root); return no-restricted-imports messages. */
async function boundaryMessages(code, rel) {
  const [res] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, rel) });
  assert.ok(!res.messages.some((m) => m.fatal), `parse error: ${JSON.stringify(res.messages)}`);
  return res.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

test('apps/web: import fs from node:fs is an error', async () => {
  const msgs = await boundaryMessages("import fs from 'node:fs';\nexport default fs;\n", 'apps/web/src/Bad.jsx');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].severity, 2);
});

test('apps/web: import of @storyforge/format is an error', async () => {
  const msgs = await boundaryMessages("import { validate } from '@storyforge/format';\nexport default validate;\n", 'apps/web/src/Bad.jsx');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].severity, 2);
});

test('apps/web: other @storyforge/* and bare fs/path are errors', async () => {
  for (const spec of ['@storyforge/core', '@storyforge/manuscript', 'fs', 'path', 'node:path']) {
    const msgs = await boundaryMessages(`import x from '${spec}';\nexport default x;\n`, 'apps/web/src/Bad.jsx');
    assert.equal(msgs.length, 1, spec);
    assert.equal(msgs[0].severity, 2, spec);
  }
});

test('apps/server: import from node:fs/promises in a route file is an error', async () => {
  const msgs = await boundaryMessages("import { readFile } from 'node:fs/promises';\nexport default readFile;\n", 'apps/server/src/routes-bad.mjs');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].severity, 2);
});

test('apps/server: node:fs and fs are errors in a route file', async () => {
  for (const spec of ['node:fs', 'fs']) {
    const msgs = await boundaryMessages(`import fs from '${spec}';\nexport default fs;\n`, 'apps/server/src/routes-bad.mjs');
    assert.equal(msgs.length, 1, spec);
    assert.equal(msgs[0].severity, 2, spec);
  }
});

test('apps/server/src/static.mjs is the allowed exception', async () => {
  const msgs = await boundaryMessages("import { readFile } from 'node:fs/promises';\nexport default readFile;\n", 'apps/server/src/static.mjs');
  assert.deepEqual(msgs, []);
});

test('packages/core/src/fs-repository.mjs may import node:fs', async () => {
  for (const spec of ['node:fs', 'node:fs/promises']) {
    const msgs = await boundaryMessages(`import fs from '${spec}';\nexport default fs;\n`, 'packages/core/src/fs-repository.mjs');
    assert.deepEqual(msgs, [], spec);
  }
});

test('packages/core/src: any other module may not import node:fs', async () => {
  const msgs = await boundaryMessages("import fs from 'node:fs';\nexport default fs;\n", 'packages/core/src/other.mjs');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].severity, 2);
});
