// M03-J03 acceptance 1 (move semantics), 4 (undo), 5 (no guessing) and the guards of
// POST /api/books/:b/scenes/:s/move  { chapter, act?, after, dryRun? } -> { ok, code, changes, undo }.
// Contract: docs/contracts/M03-J03-reorder.md section 1; rules in packages/manuscript/CONTRACT.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '../../../packages/format/src/index.mjs';
import { copyFixture, request, snapshot } from './helpers.mjs';
import {
  ARRIVAL, BOOK, FERRY, GRAFTING, KEY, LOWTIDE, ORIGINAL_ORDER, PROLOGUE, UNKNOWN_BOOK, UNKNOWN_SCENE, WALL,
  apiOrder, canonicalFor, closeAll, fmInt, freshBook, move, moveUrl, readAll, scenesById, send, startApi,
} from './move-helpers.mjs';

after(closeAll);

const ACT1 = 'manuscript/act-01-low-water';
const ACT2 = 'manuscript/act-02-high-water';
const E204_BOOK = 'book_01CS0000000000000000000001';

const stripPos = (fm) => fm.replace(/^(act|chapter|sequence):[ \t]*-?\d+[ \t]*\r?$/gm, '');
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const trashListing = async (root) => {
  const out = [];
  async function walk(dir) {
    let es;
    try { es = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const full = path.join(dir, e.name);
      out.push(path.relative(root, full));
      if (e.isDirectory()) await walk(full);
    }
  }
  await walk(path.join(root, '.storyforge', 'trash'));
  return out.sort();
};
const state = async (root) => ({ files: await snapshot(root, { skipStoryforge: true }), trash: await trashListing(root) });

/** Bodies and non-position front matter of every scene are unchanged; non-scene files are byte-identical. */
function assertOnlyPositionChanged(before, after) {
  const b = scenesById(before);
  const a = scenesById(after);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'same set of scenes');
  for (const [id, s] of b) {
    assert.equal(a.get(id).body, s.body, `body of ${id} byte-identical`);
    assert.equal(stripPos(a.get(id).fm), stripPos(s.fm), `front matter of ${id} identical outside act/chapter/sequence`);
  }
  const scenePaths = new Set([...b.values(), ...a.values()].map((s) => s.path));
  for (const [p, buf] of before) {
    if (scenePaths.has(p)) continue;
    assert.ok(after.has(p) && after.get(p).equals(buf), `non-scene file ${p} untouched`);
  }
  for (const p of after.keys()) if (!scenePaths.has(p)) assert.ok(before.has(p), `no new non-scene file ${p}`);
}

/** Run one move and check everything acceptance 1 lists. */
async function check({ root, port }, scene, body, { order, chapter, act, sequence, dir }) {
  const before = await readAll(root);
  const r = await move(port, scene, body);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true, r.text);
  assert.equal(r.json.code, 'OK');
  assert.ok(Array.isArray(r.json.changes) && r.json.changes.length >= 1, r.text);

  const after = await readAll(root);
  const s = scenesById(after).get(scene);
  assert.equal(fmInt(s.fm, 'chapter'), chapter, 'chapter');
  assert.equal(fmInt(s.fm, 'act'), act, 'act');
  if (sequence !== undefined) assert.equal(fmInt(s.fm, 'sequence'), sequence, 'sequence');
  assert.ok(canonicalFor(s.fm, s.path), `canonical path, got ${s.path}`);
  if (dir) assert.ok(s.path.startsWith(`${dir}/`), `${s.path} is under ${dir}`);
  assertOnlyPositionChanged(before, after);
  assert.deepEqual(await errorsOf(root), [], 'validate(): no errors');
  const rows = await apiOrder(port);
  assert.deepEqual(rows.map((x) => x.id), order, 'API reading order');
  const row = rows.find((x) => x.id === scene);
  assert.equal(row.path, s.path);
  assert.equal(row.chapter, chapter);
  return r.json;
}

// ---------------------------------------------------------------- acceptance 1: move semantics

test('1. within a chapter: to first (after: null)', async () => {
  const ctx = await freshBook();
  await check(ctx, KEY, { chapter: 1, after: null }, {
    order: [PROLOGUE, KEY, ARRIVAL, FERRY, GRAFTING, LOWTIDE, WALL], chapter: 1, act: 1, sequence: 5, dir: `${ACT1}/ch-001-the-drowned-rows`,
  });
});

test('1. within a chapter: to last', async () => {
  const ctx = await freshBook();
  await check(ctx, ARRIVAL, { chapter: 1, after: KEY }, {
    order: [PROLOGUE, KEY, ARRIVAL, FERRY, GRAFTING, LOWTIDE, WALL], chapter: 1, act: 1, dir: `${ACT1}/ch-001-the-drowned-rows`,
  });
});

test('1. within a chapter: last to first, and first to last (chapter 2)', async () => {
  const a = await freshBook();
  await check(a, GRAFTING, { chapter: 2, after: null }, { order: [PROLOGUE, ARRIVAL, KEY, GRAFTING, FERRY, LOWTIDE, WALL], chapter: 2, act: 1, sequence: 5 });
  const b = await freshBook();
  await check(b, FERRY, { chapter: 2, after: GRAFTING }, { order: [PROLOGUE, ARRIVAL, KEY, GRAFTING, FERRY, LOWTIDE, WALL], chapter: 2, act: 1, sequence: 30 });
});

test('1. to the middle of another chapter in the same act (midpoint sequence, no neighbour touched)', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  await check(ctx, FERRY, { chapter: 1, after: ARRIVAL }, {
    order: [PROLOGUE, ARRIVAL, FERRY, KEY, GRAFTING, LOWTIDE, WALL], chapter: 1, act: 1, sequence: 15, dir: `${ACT1}/ch-001-the-drowned-rows`,
  });
  const after = await readAll(ctx.root);
  const changed = [...scenesById(after).values()].filter((s) => !before.has(s.path) || !before.get(s.path).equals(s.raw)).map((s) => s.path);
  assert.equal(changed.length, 1, `only the mover's file changed: ${changed}`);
});

test('1. to another chapter in the same act: first and last positions', async () => {
  const a = await freshBook();
  await check(a, ARRIVAL, { chapter: 2, after: null }, { order: [PROLOGUE, KEY, ARRIVAL, FERRY, GRAFTING, LOWTIDE, WALL], chapter: 2, act: 1, sequence: 5 });
  const b = await freshBook();
  await check(b, PROLOGUE, { chapter: 2, after: GRAFTING }, { order: [ARRIVAL, KEY, FERRY, GRAFTING, PROLOGUE, LOWTIDE, WALL], chapter: 2, act: 1, sequence: 30 });
});

test('1. to another act: after a scene, first (explicit act), and back to act 1', async () => {
  const a = await freshBook();
  await check(a, KEY, { chapter: 3, after: LOWTIDE }, {
    order: [PROLOGUE, ARRIVAL, FERRY, GRAFTING, LOWTIDE, KEY, WALL], chapter: 3, act: 2, sequence: 15, dir: `${ACT2}/ch-003-the-wall`,
  });
  const b = await freshBook();
  await check(b, ARRIVAL, { chapter: 3, act: 2, after: null }, {
    order: [PROLOGUE, KEY, FERRY, GRAFTING, ARRIVAL, LOWTIDE, WALL], chapter: 3, act: 2, sequence: 5, dir: `${ACT2}/ch-003-the-wall`,
  });
  const c = await freshBook();
  await check(c, WALL, { chapter: 2, after: FERRY }, {
    order: [PROLOGUE, ARRIVAL, KEY, FERRY, WALL, GRAFTING, LOWTIDE], chapter: 2, act: 1, sequence: 15, dir: `${ACT1}/ch-002-the-grafting`,
  });
});

async function withEmptyChapter() {
  const ctx = await freshBook();
  const made = await send(ctx.port, 'POST', `/api/books/${BOOK}/chapters`, { body: { act: 2, after: 3, title: 'Aftermath' } });
  assert.ok(made.status === 200 || made.status === 201, made.text);
  // createChapter gives the new chapter one starter scene; move it away so the chapter is scene-less.
  const chapters = (await request(ctx.port, 'GET', `/api/books/${BOOK}`)).json.acts.flatMap((c) => c.chapters);
  const created = chapters.find((c) => c.chapter === 4);
  assert.ok(created && created.scenes.length === 1, 'the new chapter 4 has its starter scene');
  const starter = created.scenes[0].id;
  const out = await move(ctx.port, starter, { chapter: 3, after: WALL });
  assert.equal(out.status, 200, out.text);
  const after = (await request(ctx.port, 'GET', `/api/books/${BOOK}`)).json.acts.flatMap((c) => c.chapters).find((c) => c.chapter === 4);
  assert.ok(after, 'chapter 4 still exists');
  assert.equal(after.scenes.length, 0, 'chapter 4 is empty');
  return { ...ctx, n: 4, starter };
}

test('1. into an empty chapter (created through J01): the act comes from the chapter, given or not', async () => {
  const a = await withEmptyChapter();
  await check(a, KEY, { chapter: a.n, after: null }, {
    order: [PROLOGUE, ARRIVAL, FERRY, GRAFTING, LOWTIDE, WALL, a.starter, KEY], chapter: a.n, act: 2, dir: ACT2,
  });
  const b = await withEmptyChapter();
  await check(b, ARRIVAL, { chapter: b.n, act: 2, after: null }, {
    order: [PROLOGUE, KEY, FERRY, GRAFTING, LOWTIDE, WALL, b.starter, ARRIVAL], chapter: b.n, act: 2, dir: ACT2,
  });
});

test('1. undo of a move out of a chapter that becomes empty puts the scene back (and the chapter is empty in between)', async () => {
  const ctx = await freshBook();
  await send(ctx.port, 'POST', `/api/books/${BOOK}/chapters`, { body: { act: 2, after: 3, title: 'Aftermath' } });
  const starter = (await request(ctx.port, 'GET', `/api/books/${BOOK}`)).json.acts.flatMap((c) => c.chapters).find((c) => c.chapter === 4).scenes[0].id;
  const before = await readAll(ctx.root);
  const r = await move(ctx.port, starter, { chapter: 3, after: WALL });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.undo, { chapter: 4, act: 2, after: null });
  const u = await move(ctx.port, starter, r.json.undo);
  assert.equal(u.status, 200, u.text);
  const back = await readAll(ctx.root);
  assert.deepEqual([...back.keys()].sort(), [...before.keys()].sort());
  for (const [p, buf] of before) assert.ok(back.get(p).equals(buf), `${p} byte-identical`);
});

/** A copy where chapter 2 holds FERRY at 10 and GRAFTING at 11 (no free integer between them). */
async function closeGap(root) {
  const dir = path.join(root, ACT1, 'ch-002-the-grafting');
  const f = path.join(dir, '0020-the-grafting.md');
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/^sequence: 20(\r?)$/m, 'sequence: 11$1'));
  await fs.rename(f, path.join(dir, '0011-the-grafting.md'));
}

test('1. with no sequence gap: the chapter is renumbered, order is right, bodies identical', async () => {
  const ctx = await freshBook('valid/salt-orchard', closeGap);
  assert.deepEqual(await errorsOf(ctx.root), [], 'prepared book is valid');
  const j = await check(ctx, KEY, { chapter: 2, after: FERRY }, {
    order: [PROLOGUE, ARRIVAL, FERRY, KEY, GRAFTING, LOWTIDE, WALL], chapter: 2, act: 1, dir: `${ACT1}/ch-002-the-grafting`,
  });
  assert.ok(j.changes.length >= 2, 'a neighbour was renumbered, so more than the mover changed');
  const seqs = [...scenesById(await readAll(ctx.root)).values()].filter((s) => fmInt(s.fm, 'chapter') === 2).map((s) => fmInt(s.fm, 'sequence'));
  assert.equal(new Set(seqs).size, 3, 'distinct sequences in chapter 2');
});

test('1. moving a scene to the slot it already has leaves the order and validity unchanged', async () => {
  const ctx = await freshBook();
  const r = await move(ctx.port, ARRIVAL, { chapter: 1, after: null });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.deepEqual((await apiOrder(ctx.port)).map((x) => x.id), ORIGINAL_ORDER);
  assert.deepEqual(await errorsOf(ctx.root), []);
});

test('1. response shape: changes carry from/to/hashes/diff; undo is the original position', async () => {
  const ctx = await freshBook();
  const r = await move(ctx.port, KEY, { chapter: 3, after: LOWTIDE });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.code, 'OK');
  for (const c of r.json.changes) {
    assert.equal(typeof c.from, 'string');
    assert.equal(typeof c.to, 'string');
    assert.match(c.after_sha256, /^[0-9a-f]{64}$/);
    assert.ok(c.before_sha256 === null || /^[0-9a-f]{64}$/.test(c.before_sha256));
    assert.equal(typeof c.diff, 'string');
  }
  const moved = r.json.changes.find((c) => c.to.endsWith('-the-key.md'));
  assert.ok(moved && moved.from === `${ACT1}/ch-001-the-drowned-rows/0020-the-key.md`, JSON.stringify(r.json.changes));
  assert.deepEqual(r.json.undo, { chapter: 1, act: 1, after: ARRIVAL });
});

test('1. undo names after: null for a first scene and the old act/chapter for a cross-act move', async () => {
  const ctx = await freshBook();
  const r = await move(ctx.port, ARRIVAL, { chapter: 3, after: null });
  assert.deepEqual(r.json.undo, { chapter: 1, act: 1, after: null });
  const r2 = await move(ctx.port, WALL, { chapter: 2, after: FERRY });
  assert.deepEqual(r2.json.undo, { chapter: 3, act: 2, after: LOWTIDE });
});

test('1. dry run: returns the planned changes (position lines only), writes nothing, no trash', async () => {
  const ctx = await freshBook();
  await request(ctx.port, 'GET', `/api/books/${BOOK}`);
  const before = await state(ctx.root);
  const r = await move(ctx.port, KEY, { chapter: 3, after: LOWTIDE, dryRun: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.changes.length >= 1);
  const lines = r.json.changes.flatMap((c) => c.diff.split('\n')).filter((l) => /^[-+](?![-+]{2})/.test(l));
  assert.ok(lines.length > 0, 'diff has changed lines');
  for (const l of lines) assert.match(l, /^[-+](act|chapter|sequence):/, `only position lines in the diff: ${l}`);
  assert.deepEqual(await state(ctx.root), before);
});

// ---------------------------------------------------------------- acceptance 4: undo = POST ops/:opId/restore

const restore = (port, opId, opts = {}) => send(port, 'POST', `/api/books/${BOOK}/ops/${encodeURIComponent(opId)}/restore`, { body: {}, ...opts });

/** Move, then restore the op from the move response; every file must be back byte for byte at its original path. */
async function roundTrip(scene, body, prep) {
  const ctx = await freshBook('valid/salt-orchard', prep);
  const original = await readAll(ctx.root);
  const r = await move(ctx.port, scene, body);
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.opId, 'string', 'the move response carries opId');
  assert.notDeepEqual([...(await readAll(ctx.root)).keys()].sort(), [...original.keys()].sort(), 'the move changed a path');
  const u = await restore(ctx.port, r.json.opId);
  assert.equal(u.status, 200, u.text);
  const back = await readAll(ctx.root);
  assert.deepEqual([...back.keys()].sort(), [...original.keys()].sort(), 'every file at its original path');
  for (const [p, buf] of original) assert.ok(back.get(p).equals(buf), `${p} byte-identical after undo`);
  assert.deepEqual(await errorsOf(ctx.root), []);
  assert.deepEqual((await apiOrder(ctx.port)).map((x) => x.id), ORIGINAL_ORDER, 'API order restored');
}

test('4. undo: cross-act move of the last scene of a chapter', () => roundTrip(WALL, { chapter: 2, after: FERRY }));
test('4. undo: cross-chapter move of a first scene to the start of another chapter', () => roundTrip(ARRIVAL, { chapter: 2, after: null }));
test('4. undo: cross-act move to the first slot', () => roundTrip(FERRY, { chapter: 3, after: null }));
test('4. undo: within a chapter (last to first)', () => roundTrip(GRAFTING, { chapter: 2, after: null }));
test('4. undo: within a chapter (first to last)', () => roundTrip(LOWTIDE, { chapter: 3, after: WALL }));
test('4. undo: a scene that shared its sequence with a variant comes back byte-identical (exact sequence 20)', () => roundTrip(KEY, { chapter: 3, after: LOWTIDE }));
test('4. undo: a move that renumbered neighbours restores the neighbours exactly (sequences, names, bytes)', async () => {
  await roundTrip(KEY, { chapter: 2, after: FERRY }, closeGap);
});
test('4. undo: a scene whose original filename was not canonical comes back at exactly that path', () =>
  roundTrip(FERRY, { chapter: 3, after: null }, async (root) => {
    const dir = path.join(root, ACT1, 'ch-002-the-grafting');
    await fs.rename(path.join(dir, '0010-ferry.md'), path.join(dir, '0010-ferry-misnamed.md'));
  }));

test('4. undo of a move out of a chapter that becomes empty puts the scene back', async () => {
  const ctx = await freshBook();
  await send(ctx.port, 'POST', `/api/books/${BOOK}/chapters`, { body: { act: 2, after: 3, title: 'Aftermath' } });
  const starter = (await request(ctx.port, 'GET', `/api/books/${BOOK}`)).json.acts.flatMap((c) => c.chapters).find((c) => c.chapter === 4).scenes[0].id;
  const before = await readAll(ctx.root);
  const r = await move(ctx.port, starter, { chapter: 3, after: WALL });
  assert.equal(r.status, 200, r.text);
  const u = await restore(ctx.port, r.json.opId);
  assert.equal(u.status, 200, u.text);
  const back = await readAll(ctx.root);
  assert.deepEqual([...back.keys()].sort(), [...before.keys()].sort());
  for (const [p, buf] of before) assert.ok(back.get(p).equals(buf), `${p} byte-identical`);
});

test('4. undo is refused (409 with a reason), nothing written, after an external edit to a touched file', async () => {
  for (const which of ['mover', 'neighbour']) {
    const ctx = await freshBook('valid/salt-orchard', closeGap);
    const r = await move(ctx.port, KEY, { chapter: 2, after: FERRY });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.changes.length >= 2, 'a neighbour was renumbered');
    const target = which === 'mover'
      ? r.json.changes.find((c) => c.to.endsWith('-the-key.md')).to
      : r.json.changes.find((c) => c.to.includes('the-grafting')).to;
    const file = path.join(ctx.root, ...target.split('/'));
    await fs.appendFile(file, '\nAn external edit.\n');
    const before = await state(ctx.root);
    const u = await restore(ctx.port, r.json.opId);
    assert.equal(u.status, 409, `${which}: ${u.text}`);
    assert.ok(u.json.message || u.json.code, 'says why');
    assert.deepEqual(await state(ctx.root), before, `${which}: nothing written`);
    assert.ok((await fs.readFile(file, 'utf8')).endsWith('An external edit.\n'), 'the edit is kept');
  }
});

test('4. the response still carries the original position as `undo` (informational)', async () => {
  const ctx = await freshBook();
  const r = await move(ctx.port, ARRIVAL, { chapter: 3, after: null });
  assert.deepEqual(r.json.undo, { chapter: 1, act: 1, after: null });
});

// ---------------------------------------------------------------- acceptance 5 / 5b: duplicates and expected state

test('5. a book with a duplicate sequence: move is REFUSED_INVALID_BOOK with diagnostics, nothing written', async () => {
  const root = await copyFixture('invalid/E204-duplicate-sequence');
  const { port } = await startApi(root);
  const before = await state(root);
  for (const dryRun of [false, true]) {
    const r = await move(port, 'scene_01CS0000000000000000000003', { chapter: 1, after: null, dryRun }, { book: E204_BOOK });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, 'REFUSED_INVALID_BOOK');
    assert.ok(Array.isArray(r.json.diagnostics) && r.json.diagnostics.some((d) => d.code === 'E204'), r.text);
    assert.deepEqual(await state(root), before, 'nothing written (no renumber of the duplicates, no trash)');
  }
});

/** `expect` as the UI builds it from a dry run. */
const expectFrom = (plan) => plan.json.changes.map((c) => ({ path: c.from, sha256: c.before_sha256 })).filter((e) => e.sha256);

test('5b. an external edit to the mover after the dry run: apply with expect is 409 CONFLICT listing the path, nothing written', async () => {
  const ctx = await freshBook();
  const plan = await move(ctx.port, KEY, { chapter: 3, after: LOWTIDE, dryRun: true });
  assert.equal(plan.status, 200, plan.text);
  const expect = expectFrom(plan);
  assert.ok(expect.length >= 1);
  const rel = `${ACT1}/ch-001-the-drowned-rows/0020-the-key.md`;
  const file = path.join(ctx.root, ...rel.split('/'));
  await fs.writeFile(file, `${await fs.readFile(file, 'utf8')}\nAn edit made elsewhere.\n`);
  const before = await state(ctx.root);
  const r = await move(ctx.port, KEY, { chapter: 3, after: LOWTIDE, expect });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'CONFLICT');
  assert.deepEqual(r.json.changed, [rel]);
  assert.deepEqual(await state(ctx.root), before, 'nothing written');
});

test('5b. an external edit to a neighbour the dry run renumbers: 409 CONFLICT listing it, nothing written', async () => {
  const ctx = await freshBook('valid/salt-orchard', closeGap);
  const plan = await move(ctx.port, KEY, { chapter: 2, after: FERRY, dryRun: true });
  assert.equal(plan.status, 200, plan.text);
  const neighbour = plan.json.changes.find((c) => c.from.includes('the-grafting'));
  assert.ok(neighbour, 'the plan renumbers the grafting scene');
  const expect = expectFrom(plan);
  const file = path.join(ctx.root, ...neighbour.from.split('/'));
  await fs.writeFile(file, `${await fs.readFile(file, 'utf8')}\nA neighbour edited elsewhere.\n`);
  const before = await state(ctx.root);
  const r = await move(ctx.port, KEY, { chapter: 2, after: FERRY, expect });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.code, 'CONFLICT');
  assert.deepEqual(r.json.changed, [neighbour.from]);
  assert.deepEqual(await state(ctx.root), before);
});

test('5b. apply with a correct expect succeeds; apply without expect still works', async () => {
  const a = await freshBook();
  const plan = await move(a.port, KEY, { chapter: 3, after: LOWTIDE, dryRun: true });
  const ok = await move(a.port, KEY, { chapter: 3, after: LOWTIDE, expect: expectFrom(plan) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true);
  assert.deepEqual((await apiOrder(a.port)).map((x) => x.id), [PROLOGUE, ARRIVAL, FERRY, GRAFTING, LOWTIDE, KEY, WALL]);
  const b = await freshBook();
  const bare = await move(b.port, KEY, { chapter: 3, after: LOWTIDE });
  assert.equal(bare.status, 200, bare.text);
});

test('5b. an expect for the unchanged mover alone (a direct drop) passes, and a wrong sha is a conflict', async () => {
  const a = await freshBook();
  const rel = `${ACT1}/ch-001-the-drowned-rows/0020-the-key.md`;
  const plan = await move(a.port, KEY, { chapter: 3, after: LOWTIDE, dryRun: true });
  const real = plan.json.changes.find((c) => c.from === rel).before_sha256;
  const wrong = await move(a.port, KEY, { chapter: 3, after: LOWTIDE, expect: [{ path: rel, sha256: '0'.repeat(64) }] });
  assert.equal(wrong.status, 409, wrong.text);
  assert.deepEqual(wrong.json.changed, [rel]);
  const right = await move(a.port, KEY, { chapter: 3, after: LOWTIDE, expect: [{ path: rel, sha256: real }] });
  assert.equal(right.status, 200, right.text);
});

// ---------------------------------------------------------------- guards and refusals

test('guard: 403 without x-storyforge, with a wrong content-type, or a foreign Host; nothing written', async () => {
  const { root, port } = await freshBook();
  const before = await state(root);
  const body = { chapter: 3, after: LOWTIDE };
  const noHeader = await send(port, 'POST', moveUrl(KEY), { body, headers: { 'content-type': 'application/json' } });
  assert.equal(noHeader.status, 403, noHeader.text);
  const wrongType = await send(port, 'POST', moveUrl(KEY), { body, headers: { 'content-type': 'text/plain', 'x-storyforge': '1' } });
  assert.equal(wrongType.status, 403, wrongType.text);
  const foreign = await send(port, 'POST', moveUrl(KEY), { body, host: 'evil.example' });
  assert.equal(foreign.status, 403, foreign.text);
  assert.deepEqual(await state(root), before);
});

test('guard: 404 for an unknown book and for an unknown scene; nothing written', async () => {
  const { root, port } = await freshBook();
  const before = await state(root);
  const noBook = await move(port, KEY, { chapter: 3, after: LOWTIDE }, { book: UNKNOWN_BOOK });
  assert.equal(noBook.status, 404, noBook.text);
  const noScene = await move(port, UNKNOWN_SCENE, { chapter: 3, after: LOWTIDE });
  assert.equal(noScene.status, 404, noScene.text);
  assert.deepEqual(await state(root), before);
});

test('refusals: an anchor outside the target chapter and a chapter that does not exist change nothing', async () => {
  const { root, port } = await freshBook();
  const before = await state(root);
  const badAnchor = await move(port, KEY, { chapter: 3, after: ARRIVAL });
  assert.ok(badAnchor.status >= 400 && badAnchor.status < 500, badAnchor.text);
  assert.equal(badAnchor.json.code, 'REFUSED_BAD_ANCHOR');
  const noChapter = await move(port, KEY, { chapter: 99, after: null });
  assert.ok(noChapter.status >= 400 && noChapter.status < 500, noChapter.text);
  assert.notEqual(noChapter.json?.ok, true);
  assert.deepEqual(await state(root), before);
});

test('refusals: a malformed body (missing chapter, not JSON, non-numeric chapter) is a 4xx and changes nothing', async () => {
  const { root, port } = await freshBook();
  const before = await state(root);
  for (const body of [{ after: null }, '{not json', { chapter: 'three', after: null }]) {
    const r = await move(port, KEY, body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
  }
  assert.deepEqual(await state(root), before);
});
