// GET /api/books/:b/suggestions/:id: `body_line` of each pending hunk = its line in the scene BODY (after the front matter), null for front matter / stale / decided.
// Suggestions are written by suggest-helpers.mjs; the scene is the salt-orchard Arrival (front matter is lines 1-14, the body starts at line 15).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeAll, freshBook, send } from './move-helpers.mjs';
import { ARRIVAL_PATH, NEW, SUG, SUG_ID, SUG_PATH, suggestionText } from './suggest-helpers.mjs';

after(closeAll);

const get = async (port) => (await send(port, 'GET', SUG.one(SUG_ID))).json;
const bodyLines = (s) => Object.fromEntries(s.hunks.map((h) => [h.id, h.body_line]));

/** prep: hunk h1 in the front matter (line 7), h2 = line 15, h3 = line 17, h4 = line 19. h2 grows by one line when `grow`. */
const prep = (grow) => async (root) => {
  const file = path.join(root, ...ARRIVAL_PATH.split('/'));
  const pristine = await fs.readFile(file, 'utf8');
  let sug = suggestionText(pristine, { 7: 'status: revising', ...NEW });
  if (grow) sug = sug.replace(/(@@ -15,1 )\+15,1( @@ h2\n-.*\n\+.*)/, '$1+15,2$2\n+An extra line.');
  const sugFile = path.join(root, ...SUG_PATH.split('/'));
  await fs.mkdir(path.dirname(sugFile), { recursive: true });
  await fs.writeFile(sugFile, sug);
};

test('body hunks get their body line, a front-matter hunk gets null', async () => {
  const { port } = await freshBook('valid/salt-orchard', prep(false));
  const s = await get(port);
  assert.deepEqual(bodyLines(s), { h1: null, h2: 1, h3: 3, h4: 5 });
});

test('accepting an earlier hunk that adds a line shifts the next hunks; decided hunks have null', async () => {
  const { port } = await freshBook('valid/salt-orchard', prep(true));
  assert.deepEqual(bodyLines(await get(port)), { h1: null, h2: 1, h3: 3, h4: 5 });
  const r = await send(port, 'POST', SUG.decideHunk(SUG_ID, 'h2'), { body: { decision: 'accept' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(bodyLines(await get(port)), { h1: null, h2: null, h3: 4, h4: 6 });
});
