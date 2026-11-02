// M03-J03 acceptance 6: "Tidy file names" = planRepair restricted to rename actions (W201/W202), previewed, then
// applied through the repair routes. On the spec-example: the preview lists exactly the renames, applying them
// clears the warnings and leaves every body (and the reading order) alone. Never automatic.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request, snapshot } from './helpers.mjs';
import { copyFixture } from './helpers.mjs';
import { apiOrder, closeAll, readAll, scenesById, send, startApi } from './move-helpers.mjs';

after(closeAll);

const SPEC_BOOK = 'book_01JQ9CW8VBHXF4W6305FATZYDS';
const FERRY_FROM = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-ferry.md';
const FERRY_TO = 'manuscript/act-01-low-water/ch-002/0010-ferry.md';
const KEY_FROM = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0015-the-key.md';
const KEY_TO = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md';

async function fresh() {
  const root = await copyFixture('valid/spec-example');
  const api = await startApi(root);
  return { root, ...api };
}
const diagnostics = async (port) => (await request(port, 'GET', `/api/books/${SPEC_BOOK}/diagnostics`)).json;
const warnings = (diags) => diags.filter((d) => d.code === 'W201' || d.code === 'W202');

test('6. the book starts with exactly one W201 and one W202', async () => {
  const { port } = await fresh();
  const w = warnings(await diagnostics(port));
  assert.deepEqual(w.map((d) => d.code).sort(), ['W201', 'W202']);
});

test('6. preview: the rename actions are exactly the two from -> to pairs, and planning writes nothing', async () => {
  const { root, port } = await fresh();
  const before = await snapshot(root, { skipStoryforge: true });
  const plan = await request(port, 'GET', `/api/books/${SPEC_BOOK}/repair/plan`);
  assert.equal(plan.status, 200, plan.text);
  const renames = plan.json.actions.filter((a) => a.kind === 'rename').map((a) => ({ from: a.from, to: a.to })).sort((a, b) => (a.from < b.from ? -1 : 1));
  assert.deepEqual(renames, [{ from: FERRY_FROM, to: FERRY_TO }, { from: KEY_FROM, to: KEY_TO }]);
  assert.deepEqual(plan.json.actions.filter((a) => a.kind !== 'rename'), [], 'nothing but renames on this book');
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before, 'preview wrote nothing');
});

test('6. opening and reading the book never renames anything on its own', async () => {
  const { root, port } = await fresh();
  const before = await snapshot(root, { skipStoryforge: true });
  await request(port, 'GET', `/api/books/${SPEC_BOOK}`);
  await request(port, 'GET', `/api/books/${SPEC_BOOK}/diagnostics`);
  await request(port, 'GET', `/api/books/${SPEC_BOOK}/repair/plan`);
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});

test('6. apply: the warnings are gone, order is unchanged, every body is byte-identical, files sit at the planned paths', async () => {
  const { root, port } = await fresh();
  const orderBefore = (await apiOrder(port, SPEC_BOOK)).map((s) => s.id);
  const filesBefore = await readAll(root);
  const bodiesBefore = new Map([...scenesById(filesBefore)].map(([id, s]) => [id, s.raw]));

  const plan = (await request(port, 'GET', `/api/books/${SPEC_BOOK}/repair/plan`)).json;
  const actions = plan.actions.filter((a) => a.kind === 'rename');
  const applied = await send(port, 'POST', `/api/books/${SPEC_BOOK}/repair`, { body: { actions } });
  assert.equal(applied.status, 200, applied.text);

  assert.deepEqual(warnings(await diagnostics(port)), [], 'W201/W202 cleared');
  assert.deepEqual((await apiOrder(port, SPEC_BOOK)).map((s) => s.id), orderBefore, 'reading order unchanged');

  const filesAfter = await readAll(root);
  for (const [from, to] of [[FERRY_FROM, FERRY_TO], [KEY_FROM, KEY_TO]]) {
    assert.ok(!filesAfter.has(from), `${from} gone`);
    assert.ok(filesAfter.has(to), `${to} exists`);
  }
  // renames only: the files are byte-identical (not just their bodies), nothing else changed
  const after = scenesById(filesAfter);
  for (const [id, raw] of bodiesBefore) assert.ok(after.get(id).raw.equals(raw), `${id} byte-identical after the rename`);
  for (const [p, buf] of filesBefore) {
    if (p === FERRY_FROM || p === KEY_FROM) continue;
    assert.ok(filesAfter.get(p)?.equals(buf), `${p} untouched`);
  }
  assert.equal(filesAfter.size, filesBefore.size, 'no file added or removed overall');
});

test('6. a second preview after applying is empty (nothing left to tidy)', async () => {
  const { port } = await fresh();
  const plan = (await request(port, 'GET', `/api/books/${SPEC_BOOK}/repair/plan`)).json;
  await send(port, 'POST', `/api/books/${SPEC_BOOK}/repair`, { body: { actions: plan.actions.filter((a) => a.kind === 'rename') } });
  const again = (await request(port, 'GET', `/api/books/${SPEC_BOOK}/repair/plan`)).json;
  assert.deepEqual(again.actions.filter((a) => a.kind === 'rename'), []);
});
