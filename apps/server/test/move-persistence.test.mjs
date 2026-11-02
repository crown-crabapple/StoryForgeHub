// M03-J03 acceptance 2: moves survive a server restart (real child process running main.mjs), the deletion of
// every .storyforge/ folder, and an independent reader that only knows front matter and a (chapter, sequence) sort.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { copyFixture } from './helpers.mjs';
import { ARRIVAL, BOOK, FERRY, GRAFTING, KEY, LOWTIDE, PROLOGUE, WALL, apiOrder, independentOrder, move, readAll } from './move-helpers.mjs';
import { killAll, startServer } from './proc-helpers.mjs';

after(killAll);

/** Remove every directory named .storyforge anywhere under root; returns how many were removed. */
async function deleteAllProjections(root) {
  let n = 0;
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === '.storyforge') {
        await fs.rm(full, { recursive: true, force: true });
        n += 1;
      } else await walk(full);
    }
  }
  await walk(root);
  return n;
}

const EXPECTED = [PROLOGUE, WALL, FERRY, ARRIVAL, GRAFTING, LOWTIDE, KEY];

test('2. after a series of moves: restart the server, delete every .storyforge/, reopen: same order; an independent parser agrees', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const first = await startServer(root);
  for (const [scene, body] of [
    [KEY, { chapter: 3, after: LOWTIDE }],
    [ARRIVAL, { chapter: 2, after: FERRY }],
    [WALL, { chapter: 1, after: null }],
  ]) {
    const r = await move(first.port, scene, body);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true, r.text);
  }
  const live = await apiOrder(first.port);
  assert.deepEqual(live.map((s) => s.id), EXPECTED);

  await first.stop();
  const filesAfterMoves = await readAll(root);

  // independent reader straight from the files (no projection, no product code)
  const indep = independentOrder(filesAfterMoves);
  assert.deepEqual(indep.map((s) => s.id), EXPECTED, 'test-local parser: front matter + (chapter, sequence) sort');
  assert.deepEqual(indep.map((s) => [s.id, s.act, s.chapter, s.sequence]), live.map((s) => [s.id, s.act, s.chapter, s.sequence]));

  // projections gone, then reopen
  await deleteAllProjections(root);
  await assert.rejects(fs.access(path.join(root, '.storyforge')), 'no .storyforge left');
  const second = await startServer(root);
  const reopened = await apiOrder(second.port);
  assert.deepEqual(reopened, live, 'same order, positions and paths after restart + projection deletion');

  // the restart itself rewrote no scene file
  const filesAfterRestart = await readAll(root);
  assert.deepEqual([...filesAfterRestart.keys()].sort(), [...filesAfterMoves.keys()].sort());
  for (const [p, buf] of filesAfterMoves) assert.ok(filesAfterRestart.get(p).equals(buf), `${p} unchanged by the restart`);

  // and the reopened server keeps working on the moved book
  const again = await move(second.port, GRAFTING, { chapter: 1, after: WALL });
  assert.equal(again.status, 200, again.text);
  assert.equal((await apiOrder(second.port))[2].id, GRAFTING);
  const book = await fetch(`http://127.0.0.1:${second.port}/api/books/${BOOK}`);
  assert.equal(book.status, 200);
});
