// M04-J03 acceptance 1 (every board/thread operation changes exactly the expected Markdown lines, CRLF included),
// 2 (survive cache loss), 5 (thread validation through the routes) and the guards / dry runs / refusals of
//   GET  /api/books/:b/threads                { threads, scenes }
//   GET  /api/books/:b/threads/:t             thread + body
//   POST /api/books/:b/threads                { title, slug?, kind?, status?, dryRun? }
//   POST /api/books/:b/threads/:t/fields      { status?, setup?, develop?, payoff?, characters?, add?, remove?, base_sha256?, dryRun? }
//   PUT  /api/books/:b/threads/:t/body        { body, base_sha256 }
//   POST /api/books/:b/scenes (status, summary) and POST /api/books/:b/scenes/:s/fields (title, status, pov, summary)
// Contract: docs/contracts/M04-J03-board-outline-threads.md sections 1, 3 and 4.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '../../../packages/format/src/index.mjs';
import {
  ARRIVAL, BOOK, FERRY, GRAFTING, KEY, LOWTIDE, PROLOGUE, WALL,
  closeAll, freshBook, move, readAll, send, startApi,
} from './move-helpers.mjs';

after(closeAll);

const THREAD = 'planning/threads/brass-key.md';
const THREAD_ID = 'thread_01S5000000000000000000000T';
const GRAFTING_FILE = 'manuscript/act-01-low-water/ch-002-the-grafting/0020-the-grafting.md'; // CRLF in the fixture
const FERRY_FILE = 'manuscript/act-01-low-water/ch-002-the-grafting/0010-ferry.md'; // no summary in the fixture
const ARRIVAL_FILE = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';

const u = (...p) => `/api/books/${BOOK}/${p.join('/')}`;
const post = (port, url, body) => send(port, 'POST', url, { body });
const fields = (port, thread, body) => post(port, u('threads', thread, 'fields'), body);
const sceneFields = (port, scene, body) => post(port, u('scenes', scene, 'fields'), body);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const text = async (root, rel) => (await fs.readFile(path.join(root, ...rel.split('/')))).toString('utf8');
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const codes = async (root) => (await validate(root)).diagnostics.map((d) => `${d.code}|${d.file}`).sort();
const toCrlf = (rel) => async (root) => {
  const f = path.join(root, ...rel.split('/'));
  await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/\r?\n/g, '\r\n'));
};
const sameFiles = (a, b) => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), 'same set of paths');
  for (const [p, buf] of a) assert.ok(b.get(p).equals(buf), `${p} byte-identical`);
};

/** Lines removed and added between two texts (LCS), independent of the code under test. */
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) added.push(b[j++]);
    else removed.push(a[i++]);
  }
  return { removed, added };
}

/** Apply one request against a fresh salt-orchard copy and return the line diff of one file. */
async function diffOf(file, act, { prep, expectStatus = [200, 201] } = {}) {
  const ctx = await freshBook('valid/salt-orchard', prep);
  const before = await text(ctx.root, file);
  const r = await act(ctx);
  assert.ok(expectStatus.includes(r.status), `${r.status}: ${r.text}`);
  return { ctx, r, before, after: await text(ctx.root, file), ...lineDiff(before, await text(ctx.root, file)) };
}

/** Only `file` differs from the original tree. */
async function assertOnlyFileChanged(root, original, file) {
  const now = await readAll(root);
  assert.deepEqual([...now.keys()].sort(), [...original.keys()].sort());
  for (const [p, buf] of original) if (p !== file) assert.ok(now.get(p).equals(buf), `${p} untouched`);
}

// ---------------------------------------------------------------- reads

test('GET threads: threads with scene lists and the scenes with summary / plot_threads, in book order', async () => {
  const { port } = await freshBook();
  const r = await send(port, 'GET', u('threads'));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.threads.length, 1);
  const t = r.json.threads[0];
  assert.equal(t.id, THREAD_ID);
  assert.equal(t.slug, 'brass-key');
  assert.equal(t.status, 'paid');
  assert.deepEqual(t.setup, [KEY]);
  assert.deepEqual(t.develop, []);
  assert.deepEqual(t.payoff, [WALL]);
  assert.deepEqual(r.json.scenes.map((s) => s.id), [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL].filter(Boolean));
  const by = (id) => r.json.scenes.find((s) => s.id === id);
  assert.equal(by(KEY).summary, 'Maren finds the key under the porch step.');
  assert.deepEqual(by(KEY).plot_threads, [THREAD_ID]);
  assert.deepEqual(by(PROLOGUE).plot_threads, [THREAD_ID]);
  assert.deepEqual(by(FERRY).plot_threads, []);
  assert.equal(by(FERRY).summary, '');
});

test('GET one thread returns its body byte for byte; unknown thread and unknown book are 404', async () => {
  const { port, root } = await freshBook();
  const r = await send(port, 'GET', u('threads', THREAD_ID));
  assert.equal(r.status, 200, r.text);
  const raw = await text(root, THREAD);
  assert.ok(raw.endsWith(r.json.body), 'body is the text after the front matter');
  assert.match(r.json.body, /What the key opens/);
  assert.equal(r.json.sha256, sha(await fs.readFile(path.join(root, THREAD))));
  assert.equal((await send(port, 'GET', u('threads', 'thread_01S5ZZZZZZZZZZZZZZZZZZZZZZ'))).status, 404);
  assert.equal((await send(port, 'GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/threads')).status, 404);
});

test('GET threads on codex-graph: the one thread lists its setup scene', async () => {
  const { port } = await freshBook('valid/codex-graph');
  const r = await send(port, 'GET', '/api/books/book_01CG0000000000000000000001/threads');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.threads.length, 1);
  assert.deepEqual(r.json.threads[0].setup, ['scene_01CG0000000000000000000002']);
  assert.deepEqual(r.json.threads[0].payoff, []);
  assert.deepEqual(r.json.scenes.find((s) => s.id === 'scene_01CG0000000000000000000002').plot_threads, [r.json.threads[0].id]);
});

// ---------------------------------------------------------------- acceptance 1: exact line diffs

for (const [label, prep, eol] of [['LF', undefined, ''], ['CRLF', toCrlf(THREAD), '\r']]) {
  test(`1. mark a scene as setup (${label} thread file): only the setup line changes`, async () => {
    const d = await diffOf(THREAD, ({ port }) => fields(port, THREAD_ID, { add: { setup: [FERRY] } }), { prep });
    assert.deepEqual(d.removed, [`setup: [${KEY}]${eol}`]);
    assert.deepEqual(d.added, [`setup: [${KEY}, ${FERRY}]${eol}`]);
    assert.deepEqual(await errorsOf(d.ctx.root), []);
  });

  test(`1. mark a scene as development when the file has no develop key (${label}): exactly one inserted line, after setup`, async () => {
    const d = await diffOf(THREAD, ({ port }) => fields(port, THREAD_ID, { add: { develop: [GRAFTING] } }), { prep });
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.added, [`develop: [${GRAFTING}]${eol}`]);
    const lines = d.after.split('\n').map((l) => l.replace(/\r$/, ''));
    assert.equal(lines[lines.findIndex((l) => l.startsWith('setup:')) + 1], `develop: [${GRAFTING}]`);
    if (eol) assert.ok(!/[^\r]\n/.test(d.after), 'no bare LF appeared');
    assert.deepEqual(await errorsOf(d.ctx.root), []);
  });

  test(`1. unmark a scene (${label}): only that list line changes`, async () => {
    const d = await diffOf(THREAD, ({ port }) => fields(port, THREAD_ID, { remove: { payoff: [WALL] } }), { prep });
    assert.deepEqual(d.removed, [`payoff: [${WALL}]${eol}`]);
    assert.deepEqual(d.added, [`payoff: []${eol}`]);
  });

  test(`1. thread state change (${label}): only the status line changes`, async () => {
    const d = await diffOf(THREAD, ({ port }) => fields(port, THREAD_ID, { status: 'unresolved' }), { prep });
    assert.deepEqual(d.removed, [`status: paid${eol}`]);
    assert.deepEqual(d.added, [`status: unresolved${eol}`]);
    assert.deepEqual(await errorsOf(d.ctx.root), []);
  });
}

test('1. thread edits leave every other file and the thread body byte-identical', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await fields(ctx.port, THREAD_ID, { status: 'developed', add: { develop: [GRAFTING] } });
  assert.equal(r.status, 200, r.text);
  await assertOnlyFileChanged(ctx.root, original, THREAD);
  const before = original.get(THREAD).toString('utf8');
  const after = await text(ctx.root, THREAD);
  assert.equal(after.slice(after.indexOf('\n---', 4)), before.slice(before.indexOf('\n---', 4)), 'closing --- and body identical');
});

test('1. a no-op add (scene already listed) changes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const r = await fields(ctx.port, THREAD_ID, { add: { setup: [KEY] } });
  assert.ok(r.status === 200 || r.status === 400, r.text);
  sameFiles(before, await readAll(ctx.root));
});

test('1. new thread: one new file planning/threads/<slug>.md, exact front matter, valid, listed', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await post(ctx.port, u('threads'), { title: 'The drowned bell', slug: 'drowned-bell', kind: 'mystery' });
  assert.equal(r.status, 201, r.text);
  const now = await readAll(ctx.root);
  assert.deepEqual([...now.keys()].filter((p) => !original.has(p)), ['planning/threads/drowned-bell.md']);
  for (const [p, buf] of original) assert.ok(now.get(p).equals(buf), `${p} untouched`);
  const raw = await text(ctx.root, 'planning/threads/drowned-bell.md');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  const fm = YAML.parse(m[1]);
  assert.equal(fm.schema, 'storyforge.thread/v1');
  assert.match(fm.id, /^thread_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(fm.slug, 'drowned-bell');
  assert.equal(fm.title, 'The drowned bell');
  assert.equal(fm.kind, 'mystery');
  assert.equal(fm.status, 'planned', 'default state is planned');
  assert.deepEqual(fm.setup, []);
  assert.deepEqual(fm.payoff, []);
  assert.deepEqual(await errorsOf(ctx.root), []);
  assert.deepEqual(await codes(ctx.root), []);
  const list = await send(ctx.port, 'GET', u('threads'));
  assert.ok(list.json.threads.some((t) => t.id === fm.id && t.slug === 'drowned-bell' && t.status === 'planned'));
});

test('1. new thread: slug defaults from the title; explicit state is honoured', async () => {
  const ctx = await freshBook();
  const r = await post(ctx.port, u('threads'), { title: 'The Lantern Debt', status: 'planted' });
  assert.equal(r.status, 201, r.text);
  const raw = await text(ctx.root, 'planning/threads/the-lantern-debt.md');
  assert.match(raw, /^status: planted\r?$/m);
  // planted with no setup: a warning (W306), never an error, and the write is not refused
  assert.deepEqual(await errorsOf(ctx.root), []);
  assert.ok((await codes(ctx.root)).includes('W306|planning/threads/the-lantern-debt.md'));
});

test('1. new card: one new scene file with status outline and the summary; nothing else changes', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await post(ctx.port, u('scenes'), { chapter: 1, after: KEY, title: 'The sluice gate', slug: 'the-sluice-gate', body: '', status: 'outline', summary: 'Pell opens the gate: the tide turns.' });
  assert.equal(r.status, 201, r.text);
  const now = await readAll(ctx.root);
  const added = [...now.keys()].filter((p) => !original.has(p));
  assert.equal(added.length, 1, added.join(', '));
  assert.match(added[0], /^manuscript\/act-01-low-water\/ch-001-[^/]+\/\d{4}-the-sluice-gate\.md$/);
  for (const [p, buf] of original) assert.ok(now.get(p).equals(buf), `${p} untouched`);
  const fm = YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(now.get(added[0]).toString('utf8'))[1]);
  assert.equal(fm.status, 'outline');
  assert.equal(fm.summary, 'Pell opens the gate: the tide turns.');
  assert.equal(fm.title, 'The sluice gate');
  assert.equal(fm.chapter, 1);
  assert.deepEqual(await errorsOf(ctx.root), []);
  const board = (await send(ctx.port, 'GET', u('threads'))).json.scenes;
  assert.equal(board.find((s) => s.id === r.json.id).summary, 'Pell opens the gate: the tide turns.');
});

test('1. new card without a summary has no summary line; status defaults are unchanged for other callers', async () => {
  const ctx = await freshBook();
  const r = await post(ctx.port, u('scenes'), { chapter: 1, after: KEY, title: 'Plain', slug: 'plain', body: '', status: 'outline' });
  assert.equal(r.status, 201, r.text);
  assert.ok(!/^summary:/m.test(await text(ctx.root, r.json.path)));
  const r2 = await post(ctx.port, u('scenes'), { chapter: 1, after: KEY, title: 'Old style', slug: 'old-style', body: 'Text.\n' });
  assert.equal(r2.status, 201, r2.text);
  assert.match(await text(ctx.root, r2.json.path), /^status: drafting\r?$/m);
});

test('1. edit card summary (CRLF scene): one summary line replaced, still CRLF', async () => {
  const d = await diffOf(GRAFTING_FILE, ({ port }) => sceneFields(port, GRAFTING, { summary: 'Pell shows Maren how to graft.' }));
  assert.deepEqual(d.removed, ['summary: Pell teaches Maren to graft a drowned tree.\r']);
  assert.deepEqual(d.added, ['summary: Pell shows Maren how to graft.\r']);
  assert.ok(!/[^\r]\n/.test(d.after.slice(0, d.after.indexOf('\n---', 4))), 'front matter is still CRLF throughout');
  assert.deepEqual(await errorsOf(d.ctx.root), []);
});

test('1. edit card summary on a scene that has none: exactly one inserted line inside the front matter', async () => {
  const d = await diffOf(FERRY_FILE, ({ port }) => sceneFields(port, FERRY, { summary: 'A silent crossing.' }));
  assert.deepEqual(d.removed, []);
  assert.deepEqual(d.added.map((l) => l.replace(/\r$/, '')), ['summary: A silent crossing.']);
  const closing = d.after.split('\n').findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === '---');
  assert.ok(d.after.split('\n').findIndex((l) => l.startsWith('summary:')) < closing, 'inserted above the closing ---');
});

test('1. edit card: title, status and pov each change only their own line; summary round-trips awkward text', async () => {
  const t = await diffOf(ARRIVAL_FILE, ({ port }) => sceneFields(port, ARRIVAL, { title: 'Arrival at the rows' }));
  assert.equal(t.removed.length, 1);
  assert.match(t.removed[0], /^title: /);
  assert.match(t.added[0], /^title: .*Arrival at the rows/);
  const s = await diffOf(ARRIVAL_FILE, ({ port }) => sceneFields(port, ARRIVAL, { status: 'outline' }));
  assert.deepEqual(s.removed, ['status: drafting']);
  assert.deepEqual(s.added, ['status: outline']);
  const p = await diffOf(ARRIVAL_FILE, ({ port }) => sceneFields(port, ARRIVAL, { pov: 'pell' }));
  assert.deepEqual(p.removed, ['pov: maren-hollis']);
  assert.deepEqual(p.added, ['pov: pell']);
  const awkward = 'He said: "wait" # not a comment, then [left].';
  const a = await diffOf(ARRIVAL_FILE, ({ port }) => sceneFields(port, ARRIVAL, { summary: awkward }));
  assert.equal(a.removed.length, 1);
  assert.equal(a.added.length, 1);
  const fm = YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(a.after)[1]);
  assert.equal(fm.summary, awkward);
  assert.deepEqual(await errorsOf(a.ctx.root), []);
});

test('1. a scene body is never touched by an edit card', async () => {
  const ctx = await freshBook();
  const before = await text(ctx.root, ARRIVAL_FILE);
  const r = await sceneFields(ctx.port, ARRIVAL, { summary: 'New.', status: 'revised', title: 'Renamed' });
  assert.equal(r.status, 200, r.text);
  const after = await text(ctx.root, ARRIVAL_FILE);
  const bodyOf = (t) => t.slice(t.indexOf('\n---', 4));
  assert.equal(bodyOf(after), bodyOf(before));
});

// ---------------------------------------------------------------- Undo and dry runs

test('Undo (ops/:opId/restore) of a thread edit is byte-identical', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await fields(ctx.port, THREAD_ID, { add: { develop: [GRAFTING] }, status: 'developed' });
  assert.equal(r.status, 200, r.text);
  assert.equal(typeof r.json.opId, 'string');
  assert.notDeepEqual(await text(ctx.root, THREAD), original.get(THREAD).toString('utf8'));
  const un = await post(ctx.port, u('ops', encodeURIComponent(r.json.opId), 'restore'), {});
  assert.equal(un.status, 200, un.text);
  sameFiles(original, await readAll(ctx.root));
});

test('Undo of an edit card (summary) is byte-identical', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const r = await sceneFields(ctx.port, GRAFTING, { summary: 'Changed.' });
  const un = await post(ctx.port, u('ops', encodeURIComponent(r.json.opId), 'restore'), {});
  assert.equal(un.status, 200, un.text);
  sameFiles(original, await readAll(ctx.root));
});

test('dry runs write nothing and report the would-be changes with a diff', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const [url, body] of [
    [u('threads', THREAD_ID, 'fields'), { status: 'developed', add: { develop: [GRAFTING] }, dryRun: true }],
    [u('threads'), { title: 'Dry thread', dryRun: true }],
    [u('scenes', GRAFTING, 'fields'), { summary: 'Dry.', dryRun: true }],
    [u('scenes'), { chapter: 1, after: KEY, title: 'Dry card', slug: 'dry-card', body: '', status: 'outline', summary: 'x', dryRun: true }],
  ]) {
    const r = await post(ctx.port, url, body);
    assert.equal(r.status, 200, `${url}: ${r.text}`);
    assert.ok(Array.isArray(r.json.changes) && r.json.changes.length >= 1, `${url}: ${r.text}`);
    sameFiles(before, await readAll(ctx.root));
  }
});

// ---------------------------------------------------------------- guards and refusals

test('every new write route is 403 without the write guard and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const sha0 = sha(before.get(THREAD));
  const calls = [
    ['POST', u('threads'), { title: 'Nope' }],
    ['POST', u('threads', THREAD_ID, 'fields'), { status: 'dropped' }],
    ['PUT', u('threads', THREAD_ID, 'body'), { body: 'x\n', base_sha256: sha0 }],
    ['POST', u('scenes', KEY, 'fields'), { summary: 'Nope.' }],
    ['POST', u('scenes'), { chapter: 1, after: KEY, title: 'Nope', slug: 'nope', body: '', status: 'outline' }],
  ];
  for (const [m, p, body] of calls) {
    assert.equal((await send(ctx.port, m, p, { headers: { 'content-type': 'application/json' }, body })).status, 403, `${m} ${p} without x-storyforge`);
    assert.equal((await send(ctx.port, m, p, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' }, body })).status, 403, `${m} ${p} wrong content type`);
  }
  sameFiles(before, await readAll(ctx.root));
});

test('refusals write nothing: bad state, unknown scene, unknown thread, empty change, malformed lists, bad kind', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const cases = [
    [u('threads', THREAD_ID, 'fields'), { status: 'sleeping' }],
    [u('threads', THREAD_ID, 'fields'), { add: { setup: ['scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ'] } }],
    [u('threads', THREAD_ID, 'fields'), { setup: ['not-an-id'] }],
    [u('threads', THREAD_ID, 'fields'), { add: { payoff: 'scene' } }],
    [u('threads', THREAD_ID, 'fields'), { add: { bogus: [KEY] } }],
    [u('threads', THREAD_ID, 'fields'), {}],
    [u('threads', 'thread_01S5ZZZZZZZZZZZZZZZZZZZZZZ', 'fields'), { status: 'dropped' }],
    [u('threads'), { title: '' }],
    [u('threads'), { title: 'Fine', kind: 'nonsense' }],
    [u('threads'), { title: 'Fine', status: 'nonsense' }],
    [u('threads'), { title: 'Fine', slug: 'Not A Slug' }],
    [u('threads'), {}],
  ];
  for (const [url, body] of cases) {
    const r = await post(ctx.port, url, body);
    assert.ok(r.status >= 400 && r.status < 500, `${url} ${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    sameFiles(before, await readAll(ctx.root));
  }
});

test('new thread: SLUG_TAKEN (thread, entry and event slugs) is 409 and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const slug of ['brass-key', 'maren-hollis', 'the-flood']) {
    const r = await post(ctx.port, u('threads'), { title: 'Clash', slug });
    assert.equal(r.status, 409, `${slug}: ${r.text}`);
    assert.equal(r.json.code, 'SLUG_TAKEN');
    sameFiles(before, await readAll(ctx.root));
  }
});

test('edit card refuses multi-line summaries (every line-break kind) and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const bad of ['two\nlines', 'two\r\nlines', 'cr\rlone', 'sep here', 'para here', 'tab\there']) {
    const r = await sceneFields(ctx.port, KEY, { summary: bad });
    assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
    sameFiles(before, await readAll(ctx.root));
  }
  const card = await post(ctx.port, u('scenes'), { chapter: 1, after: KEY, title: 'X', slug: 'x', body: '', status: 'outline', summary: 'a\nb' });
  assert.equal(card.status, 400, card.text);
  sameFiles(before, await readAll(ctx.root));
});

test('a stale base_sha256 on a thread edit is 409 and the external edit stays', async () => {
  const ctx = await freshBook();
  const base = sha(await fs.readFile(path.join(ctx.root, ...THREAD.split('/'))));
  const file = path.join(ctx.root, ...THREAD.split('/'));
  await fs.writeFile(file, `${await fs.readFile(file, 'utf8')}\nAn edit made elsewhere.\n`);
  const before = await readAll(ctx.root);
  const r = await fields(ctx.port, THREAD_ID, { status: 'dropped', base_sha256: base });
  assert.equal(r.status, 409, r.text);
  sameFiles(before, await readAll(ctx.root));
  const ok = await fields(ctx.port, THREAD_ID, { status: 'dropped', base_sha256: sha(before.get(THREAD)) });
  assert.equal(ok.status, 200, ok.text);
});

test('thread body PUT: new text saved, front matter bytes identical; a stale base is 409', async () => {
  const ctx = await freshBook();
  const raw = await fs.readFile(path.join(ctx.root, ...THREAD.split('/')));
  const base = sha(raw);
  const r = await send(ctx.port, 'PUT', u('threads', THREAD_ID, 'body'), { body: { body: 'Rewritten.\n', base_sha256: base } });
  assert.equal(r.status, 200, r.text);
  const now = await text(ctx.root, THREAD);
  const head = (t) => t.slice(0, t.indexOf('\n---', 4) + 5);
  assert.equal(head(now), head(raw.toString('utf8')));
  assert.ok(now.endsWith('Rewritten.\n'));
  const stale = await send(ctx.port, 'PUT', u('threads', THREAD_ID, 'body'), { body: { body: 'Again.\n', base_sha256: base } });
  assert.equal(stale.status, 409, stale.text);
  assert.ok((await text(ctx.root, THREAD)).endsWith('Rewritten.\n'));
});

// ---------------------------------------------------------------- acceptance 5 through the routes

test('5. every state is accepted by the state route and validates without errors; legacy open/abandoned too', async () => {
  for (const status of ['planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved', 'open', 'abandoned']) {
    const ctx = await freshBook();
    const r = await fields(ctx.port, THREAD_ID, { status });
    assert.equal(r.status, 200, `${status}: ${r.text}`);
    assert.match(await text(ctx.root, THREAD), new RegExp(`^status: ${status}\\r?$`, 'm'));
    assert.deepEqual(await errorsOf(ctx.root), [], status);
  }
});

test('5. a thread in "developed" without develop scenes is a W306 warning, not a refusal; with one it is clean', async () => {
  const ctx = await freshBook();
  const r = await fields(ctx.port, THREAD_ID, { status: 'developed' });
  assert.equal(r.status, 200, r.text);
  assert.ok((await codes(ctx.root)).includes(`W306|${THREAD}`));
  assert.deepEqual(await errorsOf(ctx.root), []);
  const r2 = await fields(ctx.port, THREAD_ID, { add: { develop: [GRAFTING] } });
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual(await codes(ctx.root), []);
});

test('5. a develop list written through the route is listed back, resolved to scene ids', async () => {
  const ctx = await freshBook();
  assert.equal((await fields(ctx.port, THREAD_ID, { add: { develop: [GRAFTING] } })).status, 200);
  const listed = (await send(ctx.port, 'GET', u('threads'))).json.threads[0];
  assert.deepEqual(listed.develop, [GRAFTING]);
});

// ---------------------------------------------------------------- acceptance 2: cache loss

/** Everything the four views draw: the manuscript tree (cards), threads and scenes planning fields. */
async function viewData(port) {
  const book = (await send(port, 'GET', `/api/books/${BOOK}`)).json;
  const planning = (await send(port, 'GET', u('threads'))).json;
  const one = (await send(port, 'GET', u('threads', THREAD_ID))).json;
  return JSON.parse(JSON.stringify({ book, planning, one }));
}

test('2. after a sequence of board and thread operations, deleting .storyforge/ changes nothing (files fallback and rebuild)', async () => {
  const ctx = await freshBook();
  const steps = [
    () => post(ctx.port, u('threads'), { title: 'The drowned bell', slug: 'drowned-bell', kind: 'mystery' }),
    () => fields(ctx.port, THREAD_ID, { add: { develop: [GRAFTING], setup: [FERRY] } }),
    () => fields(ctx.port, THREAD_ID, { status: 'developed' }),
    () => fields(ctx.port, THREAD_ID, { remove: { setup: [KEY] } }),
    () => fields(ctx.port, 'drowned-bell', { status: 'planted', add: { setup: [LOWTIDE] } }),
    () => post(ctx.port, u('scenes'), { chapter: 1, after: KEY, title: 'The sluice gate', slug: 'the-sluice-gate', body: '', status: 'outline', summary: 'Pell opens the gate.' }),
    () => sceneFields(ctx.port, ARRIVAL, { summary: 'Edited summary.', status: 'revised' }),
    () => move(ctx.port, FERRY, { chapter: 3, after: LOWTIDE }),
    () => move(ctx.port, ARRIVAL, { chapter: 2, after: null }),
  ];
  for (const s of steps) {
    const r = await s();
    assert.ok(r.status === 200 || r.status === 201, r.text);
  }
  await ctx.repo.rebuildIndex(BOOK);
  const live = await viewData(ctx.port);
  assert.ok(live.planning.threads.length === 2);

  await ctx.repo.close?.();
  await fs.rm(path.join(ctx.root, '.storyforge'), { recursive: true, force: true });
  const reopened = await startApi(ctx.root);
  assert.deepEqual(await viewData(reopened.port), live, 'identical from the files fallback');

  await reopened.repo.rebuildIndex(BOOK);
  assert.deepEqual(await viewData(reopened.port), live, 'identical after the rebuild');
  assert.deepEqual(await errorsOf(ctx.root), []);
});

test('2. codex-graph: the thread data is the same with and without .storyforge/', async () => {
  const CG = 'book_01CG0000000000000000000001';
  const ctx = await freshBook('valid/codex-graph');
  await ctx.repo.rebuildIndex(CG);
  const a = (await send(ctx.port, 'GET', `/api/books/${CG}/threads`)).json;
  await fs.rm(path.join(ctx.root, '.storyforge'), { recursive: true, force: true });
  const b = (await send(ctx.port, 'GET', `/api/books/${CG}/threads`)).json;
  assert.deepEqual(b, a);
  const reopened = await startApi(ctx.root);
  assert.deepEqual((await send(reopened.port, 'GET', `/api/books/${CG}/threads`)).json, a);
});
