// M09-J01 acceptance 1-6 for canvases (planning/canvases/<slug>.canvas, JSON Canvas):
//   GET  /api/books/:b/canvases                  { canvases, archived }
//   GET  /api/books/:b/canvases/:slug            { slug, title, path, sha256, canvas, problem, refs, targets }
//   POST /api/books/:b/canvases                  { title, slug?, dryRun? }
//   PUT  /api/books/:b/canvases/:slug            { canvas, base_sha256 }
//   POST /api/books/:b/canvases/:slug/archive | restore
//   POST /api/books/:b/attachments?name=&for=canvas
// Contract: docs/contracts/M09-J01-canvas.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '../../../packages/format/src/index.mjs';
import { WRITE_CLASSES } from '../src/policy.mjs';
import { BOOK, KEY, LOWTIDE, closeAll, freshBook, move, readAll, send, startApi } from './move-helpers.mjs';

after(closeAll);

const MAREN = 'entry_01S5000000000000000000000G';
const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const read = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')));
const codes = async (root) => (await validate(root)).diagnostics.map((d) => `${d.code}|${d.file}`).sort();

async function newCanvas(port, title = 'Neon Shadows', slug) {
  const r = await send(port, 'POST', u('canvases'), { body: { title, ...(slug ? { slug } : {}) } });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

test('create: an empty JSON Canvas file under planning/canvases/, listed with its title; a dry run writes nothing; a taken name is 409', async () => {
  const { root, port } = await freshBook();
  const before = await readAll(root);
  const codesBefore = await codes(root);
  const dry = await send(port, 'POST', u('canvases'), { body: { title: 'Neon Shadows', dryRun: true } });
  assert.equal(dry.status, 200, dry.text);
  assert.equal(dry.json.path, 'planning/canvases/neon-shadows.canvas');
  assert.deepEqual([...(await readAll(root)).keys()].sort(), [...before.keys()].sort(), 'a dry run writes nothing');

  const made = await newCanvas(port);
  assert.equal(made.slug, 'neon-shadows');
  assert.deepEqual(await codes(root), codesBefore, 'a canvas adds no diagnostics to validate()');
  const doc = JSON.parse((await read(root, 'planning/canvases/neon-shadows.canvas')).toString('utf8'));
  assert.deepEqual(doc, { nodes: [], edges: [], storyforge: { schema: 'storyforge.canvas/v1', title: 'Neon Shadows' } });

  const list = await send(port, 'GET', u('canvases'));
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.canvases.map((c) => [c.slug, c.title, c.nodes, c.problem]), [['neon-shadows', 'Neon Shadows', 0, null]]);
  assert.deepEqual(list.json.archived, []);

  const again = await send(port, 'POST', u('canvases'), { body: { title: 'Neon Shadows' } });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.code, 'REFUSED_PATH_TAKEN');
  assert.equal((await send(port, 'POST', u('canvases'), { body: { title: '!!!' } })).status, 400);
});

test('save: nodes and edges round-trip; story-card paths are refreshed; unknown keys are kept; the answer carries the new sha256', async () => {
  const { root, port } = await freshBook();
  await newCanvas(port, 'Board');
  const got = await send(port, 'GET', u('canvases', 'board'));
  assert.equal(got.status, 200, got.text);
  assert.ok(got.json.targets.some((t) => t.ref === MAREN && t.kind === 'entry'));
  assert.ok(got.json.targets.some((t) => t.ref === KEY && t.kind === 'scene'));
  const canvas = {
    nodes: [
      { id: 'n1', type: 'text', text: '# Atmosphere\n- rain', x: 10.4, y: 20, width: 250, height: 120, obsidianOnly: true },
      { id: 'n2', type: 'text', text: '**Pearl Bush**\n#E8DDD4', x: 300, y: 20, width: 120, height: 120, color: '#E8DDD4', storyforge: { kind: 'swatch', name: 'Pearl Bush', hex: '#E8DDD4' } },
      { id: 'n3', type: 'file', file: 'wrong/path.md', x: 0, y: 200, width: 260, height: 140, storyforge: { ref: MAREN } },
      { id: 'n4', type: 'file', file: 'codex/nowhere.md', x: 300, y: 200, width: 260, height: 140, storyforge: { ref: 'entry_GONE' } },
      { id: 'g1', type: 'group', label: 'Wall', x: -20, y: -20, width: 600, height: 400, storyforge: { kind: 'column' } },
      { id: 'l1', type: 'link', url: 'https://example.com/ref', x: 600, y: 0, width: 200, height: 80 },
    ],
    edges: [{ id: 'e1', fromNode: 'n1', fromSide: 'right', toNode: 'n2', toSide: 'left', toEnd: 'arrow', label: 'palette' }],
    storyforge: { schema: 'storyforge.canvas/v1', title: 'Board' },
    extraTopLevel: { kept: 1 },
  };
  const r = await send(port, 'PUT', u('canvases', 'board'), { body: { canvas, base_sha256: got.json.sha256 } });
  assert.equal(r.status, 200, r.text);
  const bytes = await read(root, 'planning/canvases/board.canvas');
  assert.equal(r.json.sha256, sha(bytes));
  const doc = JSON.parse(bytes.toString('utf8'));
  assert.equal(doc.nodes[0].x, 10, 'coordinates are saved as integers');
  assert.equal(doc.nodes[0].obsidianOnly, true, 'unknown node keys are kept');
  assert.deepEqual(doc.extraTopLevel, { kept: 1 }, 'unknown top-level keys are kept');
  assert.equal(doc.nodes[2].file, 'codex/characters/maren-hollis.md', 'a story card file is refreshed to its target');
  assert.equal(doc.nodes[3].file, 'codex/nowhere.md', 'a broken story card keeps its file');

  const back = await send(port, 'GET', u('canvases', 'board'));
  assert.equal(back.json.refs.n3.state, 'ok');
  assert.equal(back.json.refs.n3.kind, 'entry');
  assert.equal(back.json.refs.n3.title, 'Maren Hollis');
  assert.equal(back.json.refs.n4.state, 'broken');
});

test('refusals write nothing: a bad canvas is 400 REFUSED_BAD_CANVAS; a stale base is 409 with the current canvas', async () => {
  const { root, port } = await freshBook();
  await newCanvas(port, 'Board');
  const { json } = await send(port, 'GET', u('canvases', 'board'));
  const before = await read(root, 'planning/canvases/board.canvas');
  const bad = [
    { nodes: [{ id: 'a', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10 }, { id: 'a', type: 'text', text: 'y', x: 0, y: 0, width: 10, height: 10 }], edges: [] },
    { nodes: [{ id: 'a', type: 'shape', x: 0, y: 0, width: 10, height: 10 }], edges: [] },
    { nodes: [{ id: 'a', type: 'link', url: 'javascript:alert(1)', x: 0, y: 0, width: 10, height: 10 }], edges: [] },
    { nodes: [{ id: 'a', type: 'file', file: '../../etc/passwd', x: 0, y: 0, width: 10, height: 10 }], edges: [] },
    { nodes: [{ id: 'a', type: 'text', text: 'x', x: 'left', y: 0, width: 10, height: 10 }], edges: [] },
    { nodes: [{ id: 'a', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10 }], edges: [{ id: 'e', fromNode: 'a', toNode: 'zzz' }] },
    { nodes: [{ id: 'a', type: 'text', text: 'x', x: 0, y: 0, width: 10, height: 10, color: 'red' }], edges: [] },
    'not a canvas',
  ];
  for (const canvas of bad) {
    const r = await send(port, 'PUT', u('canvases', 'board'), { body: { canvas, base_sha256: json.sha256 } });
    assert.equal(r.status, 400, `${JSON.stringify(canvas).slice(0, 80)}: ${r.text}`);
    assert.equal(r.json.code, 'REFUSED_BAD_CANVAS');
  }
  assert.ok((await read(root, 'planning/canvases/board.canvas')).equals(before), 'byte-identical after refusals');

  const ok = await send(port, 'PUT', u('canvases', 'board'), { body: { canvas: { nodes: [], edges: [], storyforge: { title: 'Mine' } }, base_sha256: json.sha256 } });
  assert.equal(ok.status, 200, ok.text);
  const stale = await send(port, 'PUT', u('canvases', 'board'), { body: { canvas: { nodes: [], edges: [] }, base_sha256: json.sha256 } });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.current.sha256, ok.json.sha256);
  assert.equal(stale.json.current.canvas.storyforge.title, 'Mine');
  assert.equal((await send(port, 'PUT', u('canvases', 'nope'), { body: { canvas: { nodes: [], edges: [] }, base_sha256: 'x' } })).status, 404);
});

test('a hand-written JSON Canvas (no storyforge keys) opens and saves; a broken file is listed with its problem', async () => {
  const hand = JSON.stringify({ nodes: [{ id: 'abc123', type: 'text', text: 'From Obsidian', x: -100, y: 40, width: 250, height: 60, color: '4' }], edges: [] }, null, '\t');
  const { port } = await freshBook('valid/salt-orchard', async (root) => {
    await fs.mkdir(path.join(root, 'planning', 'canvases'), { recursive: true });
    await fs.writeFile(path.join(root, 'planning', 'canvases', 'from-obsidian.canvas'), hand);
    await fs.writeFile(path.join(root, 'planning', 'canvases', 'broken.canvas'), '{ nope');
  });
  const list = await send(port, 'GET', u('canvases'));
  assert.deepEqual(list.json.canvases.map((c) => [c.slug, c.title, c.nodes, c.problem === null]), [['broken', 'broken', 0, false], ['from-obsidian', 'from-obsidian', 1, true]]);
  const got = await send(port, 'GET', u('canvases', 'from-obsidian'));
  assert.equal(got.json.canvas.nodes[0].text, 'From Obsidian');
  const r = await send(port, 'PUT', u('canvases', 'from-obsidian'), { body: { canvas: got.json.canvas, base_sha256: got.json.sha256 } });
  assert.equal(r.status, 200, r.text);
});

test('story cards follow a scene move; archive and restore move the file; deleting .storyforge/ changes nothing; validate() gains no diagnostics', async () => {
  const { root, port: firstPort, repo } = await freshBook();
  let port = firstPort;
  await newCanvas(port, 'Board');
  const got = await send(port, 'GET', u('canvases', 'board'));
  const keyPath = got.json.targets.find((t) => t.ref === KEY);
  assert.ok(keyPath);
  const canvas = { nodes: [{ id: 's1', type: 'file', file: 'x.md', x: 0, y: 0, width: 260, height: 140, storyforge: { ref: KEY } }], edges: [] };
  const saved = await send(port, 'PUT', u('canvases', 'board'), { body: { canvas, base_sha256: got.json.sha256 } });
  assert.equal(saved.status, 200, saved.text);
  const p1 = (await send(port, 'GET', u('canvases', 'board'))).json.refs.s1.path;
  const m = await move(port, KEY, { chapter: 3, after: LOWTIDE });
  assert.equal(m.status, 200, m.text);
  {
    const after = await send(port, 'GET', u('canvases', 'board'));
    assert.notEqual(after.json.refs.s1.path, p1, 'the ref resolves to the moved scene');
    const again = await send(port, 'PUT', u('canvases', 'board'), { body: { canvas: after.json.canvas, base_sha256: after.json.sha256 } });
    assert.equal(again.status, 200, again.text);
    assert.equal(JSON.parse((await read(root, 'planning/canvases/board.canvas')).toString('utf8')).nodes[0].file, after.json.refs.s1.path);
  }

  const snapshot = (await send(port, 'GET', u('canvases', 'board'))).json;
  // Close the index first: Windows will not delete an open sqlite file. Then read the canvas from a new server with no index.
  await repo.close();
  await fs.rm(path.join(root, '.storyforge'), { recursive: true, force: true });
  port = (await startApi(root)).port;
  const fresh = (await send(port, 'GET', u('canvases', 'board'))).json;
  assert.deepEqual(fresh.canvas, snapshot.canvas);
  assert.equal(fresh.sha256, snapshot.sha256);

  const arch = await send(port, 'POST', u('canvases', 'board', 'archive'), { body: {} });
  assert.equal(arch.status, 200, arch.text);
  await fs.access(path.join(root, 'archive', 'planning', 'canvases', 'board.canvas'));
  const list = (await send(port, 'GET', u('canvases'))).json;
  assert.deepEqual([list.canvases.length, list.archived.map((c) => c.slug)], [0, ['board']]);
  assert.equal((await send(port, 'POST', u('canvases'), { body: { title: 'Board' } })).status, 409, 'an archived name is taken');
  const rest = await send(port, 'POST', u('canvases', 'board', 'restore'), { body: {} });
  assert.equal(rest.status, 200, rest.text);
  await fs.access(path.join(root, 'planning', 'canvases', 'board.canvas'));
  assert.deepEqual((await codes(root)).filter((c) => c.includes('canvas')), [], 'canvases add no diagnostics');
});

test('upload for=canvas stores under assets/canvas/; every canvas write route has a policy class', async () => {
  const { root, port } = await freshBook();
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const r = await send(port, 'POST', `${u('attachments')}?name=Mood%20Board.png&for=canvas`, { headers: { 'content-type': 'image/png', 'x-storyforge': '1' }, body: png.toString('latin1') });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.path, 'assets/canvas/mood-board.png');
  await fs.access(path.join(root, 'assets', 'canvas', 'mood-board.png'));
  const badFor = await send(port, 'POST', `${u('attachments')}?name=a.png&for=elsewhere`, { headers: { 'content-type': 'image/png', 'x-storyforge': '1' }, body: 'x' });
  assert.equal(badFor.status, 400);
  for (const route of ['canvas-create', 'canvas-save', 'canvas-archive', 'canvas-restore']) assert.equal(WRITE_CLASSES[route], 'write', route);
});

// ---- Story Planner items as story cards (docs/plans/canvas-plan-integration.md, decisions 3-4)

const CLUE = 'note_01S5000000000000000000001E';
const BEAT = 'note_01S50000000000000000000018';
const STRUCTURE = 'note_01S50000000000000000000017';
const card = (id, ref) => ({ id, type: 'file', file: 'x.md', x: 0, y: 0, width: 260, height: 140, storyforge: { ref } });

async function plannerBoard(archiveStructure) {
  return freshBook('valid/planner', async (root) => {
    await fs.mkdir(path.join(root, 'planning', 'canvases'), { recursive: true });
    const canvas = { nodes: [card('c1', CLUE), card('b1', BEAT), card('x1', 'note_01S5ZZZZZZZZZZZZZZZZZZZZZZ')], edges: [] };
    await fs.writeFile(path.join(root, 'planning', 'canvases', 'plan.canvas'), JSON.stringify(canvas));
    if (archiveStructure) {
      const dest = path.join(root, 'archive', 'planning', 'structures');
      await fs.mkdir(dest, { recursive: true });
      await fs.rename(path.join(root, 'planning', 'structures', 'main-three-act.md'), path.join(dest, 'main-three-act.md'));
    }
  });
}

test('planner cards: a clue card and a beat card resolve ok; an unknown id is broken; targets list the planner items with beats after their structure', async () => {
  const { port } = await plannerBoard(false);
  const got = await send(port, 'GET', u('canvases', 'plan'));
  assert.equal(got.status, 200, got.text);
  assert.equal(got.json.refs.c1.state, 'ok');
  assert.equal(got.json.refs.c1.kind, 'clue');
  assert.equal(got.json.refs.c1.title, 'The harbour key opens the sea gate.');
  assert.equal(got.json.refs.c1.path, 'planning/clues/sea-gate-key.md');
  assert.equal(got.json.refs.b1.state, 'ok');
  assert.equal(got.json.refs.b1.kind, 'beat');
  assert.equal(got.json.refs.b1.title, 'Opening image');
  assert.equal(got.json.refs.b1.structure, STRUCTURE);
  assert.equal(got.json.refs.b1.path, 'planning/structures/main-three-act.md');
  assert.equal(got.json.refs.x1.state, 'broken');
  const kinds = new Set(got.json.targets.map((t) => t.kind));
  for (const k of ['clue', 'structure', 'beat', 'arc', 'story-plan']) assert.ok(kinds.has(k), k);
  const at = got.json.targets.findIndex((t) => t.ref === STRUCTURE);
  assert.ok(at >= 0);
  assert.equal(got.json.targets[at + 1].ref, BEAT);
  assert.equal(got.json.targets[at + 1].structure, STRUCTURE);
  assert.ok(got.json.targets.some((t) => t.ref === CLUE && t.kind === 'clue' && t.subtitle === 'clue'));
});

test('planner cards: a beat of an archived structure is archived and keeps the structure path; it is not offered as a target', async () => {
  const { port } = await plannerBoard(true);
  const got = await send(port, 'GET', u('canvases', 'plan'));
  assert.equal(got.json.refs.b1.state, 'archived');
  assert.equal(got.json.refs.b1.kind, 'beat');
  assert.equal(got.json.refs.b1.path, 'archive/planning/structures/main-three-act.md');
  assert.ok(!got.json.targets.some((t) => t.ref === BEAT || t.ref === STRUCTURE));
});
