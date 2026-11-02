// M05-J02 acceptance 1-4 (server side): the continuity exception write routes and the context route, driven through HTTP only.
//   POST   /api/books/:b/continuity/exceptions        { fingerprint, rationale, title?, dryRun? } -> { file, slug, undo: { op } }
//   DELETE /api/books/:b/continuity/exceptions/:slug  -> { archived, undo }   (archives, never deletes)
//   GET    /api/books/:b/continuity/context?file=&line=&radius=   -> { lines: [{ n, text }] }
//   Undo = POST /api/books/:b/ops/:opId/restore (M03-J03 restoreOp); `undo.op` is the op id.
// Contract: docs/contracts/M05-J02-continuity-review.md sections 1, 3 (context route), 4 and acceptance 1-4.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { validate } from '../../../packages/format/src/index.mjs';
import { BOOK, UNKNOWN_BOOK, closeAll, freshBook, readAll, send } from './move-helpers.mjs';

after(closeAll);

const FP = 'cf1-e85d78f4354c4ffc';
const MAREN = 'codex/characters/maren-hollis.md';
const ARRIVAL = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
const RATIONALE = 'Maren sees her own eyes as green in the hut glass; it is the glass, not the canon.';
const WRITABLE = ['planning/continuity/', 'archive/planning/continuity/'];

const u = (...p) => `/api/books/${BOOK}/continuity${p.length ? '/' + p.join('/') : ''}`;
const post = (port, body, book = BOOK) => send(port, 'POST', `/api/books/${book}/continuity/exceptions`, { body });
const del = (port, slug) => send(port, 'DELETE', u('exceptions', encodeURIComponent(slug)));
const get = (port, qs = '') => send(port, 'GET', u('context') + qs);
const ctxQs = (file, line = 17, radius = 3) => `?file=${encodeURIComponent(file)}&line=${line}&radius=${radius}`;
const undoOf = async (port, r) => {
  const op = r.json?.undo?.op;
  assert.ok(op !== undefined && op !== null, `response has undo.op: ${r.text}`);
  const id = typeof op === 'string' ? op : op.opId ?? op.id;
  assert.equal(typeof id, 'string', `op id: ${r.text}`);
  const un = await send(port, 'POST', `/api/books/${BOOK}/ops/${encodeURIComponent(id)}/restore`, { body: {} });
  assert.equal(un.status, 200, un.text);
  return un;
};
const fmOf = (raw) => YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)[1]);
const bodyOf = (raw) => raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
const sameFiles = (a, b, msg = '') => {
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `same set of paths ${msg}`);
  for (const [p, buf] of a) assert.ok(b.get(p).equals(buf), `${p} byte-identical ${msg}`);
};
const getContinuity = async (port) => {
  const r = await send(port, 'GET', u());
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const putFile = (rel, content) => async (root) => {
  const f = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, content);
};
const STALE_FP = 'cf1-0123456789abcdef';
const exceptionFile = (slug, fp, title, body = 'Because.') => `---
schema: storyforge.continuity-exception/v1
id: note_01T6000000000000000000EX01
slug: ${slug}
fingerprint: ${fp}
rule: CF1
title: ${title}
created: "2026-11-02"
---
${body}
`;

// ---------------------------------------------------------------- acceptance 1 + 2: the whole flow, byte for byte

test('1. salt-orchard: acknowledge writes the exception file, the finding is suppressed, restore archives it, Undo of each step is byte-identical', async () => {
  const ctx = await freshBook();
  const original = await readAll(ctx.root);
  const start = await getContinuity(ctx.port);
  assert.deepEqual(start.findings.map((f) => f.fingerprint), [FP]);
  const finding = start.findings[0];

  // --- acknowledge
  const ack = await post(ctx.port, { fingerprint: FP, rationale: RATIONALE });
  assert.ok([200, 201].includes(ack.status), ack.text);
  const { slug } = ack.json;
  assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(String(ack.json.file).replace(/\\/g, '/').endsWith(`planning/continuity/${slug}.md`), `file: ${ack.json.file}`);
  const rel = `planning/continuity/${slug}.md`;
  const afterAck = await readAll(ctx.root);
  const raw = afterAck.get(rel)?.toString('utf8');
  assert.ok(raw, `${rel} exists`);
  const fm = fmOf(raw);
  assert.equal(fm.schema, 'storyforge.continuity-exception/v1');
  assert.equal(fm.fingerprint, FP);
  assert.equal(fm.rule, 'CF1');
  assert.equal(fm.title, finding.title, 'title defaults to the finding title');
  assert.equal(fm.slug, slug);
  assert.match(String(fm.id), /^note_/);
  assert.match(String(fm.created), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(bodyOf(raw).trim(), RATIONALE, 'body is the rationale');
  assert.deepEqual([...afterAck.keys()].filter((p) => !original.has(p)), [rel], 'exactly one new file');
  assert.deepEqual((await validate(ctx.root)).diagnostics, [], 'the exception file is valid');

  const suppressed = await getContinuity(ctx.port);
  assert.deepEqual(suppressed.findings, []);
  assert.deepEqual(suppressed.suppressed.map((s) => [s.finding.fingerprint, s.exception.slug]), [[FP, slug]]);
  assert.deepEqual(suppressed.stale_exceptions, []);

  // --- Undo of the acknowledge
  await undoOf(ctx.port, ack);
  sameFiles(original, await readAll(ctx.root), '(undo acknowledge)');
  assert.deepEqual((await getContinuity(ctx.port)).findings.map((f) => f.fingerprint), [FP]);

  // --- acknowledge again, then restore (DELETE archives)
  const ack2 = await post(ctx.port, { fingerprint: FP, rationale: RATIONALE });
  assert.ok([200, 201].includes(ack2.status), ack2.text);
  const slug2 = ack2.json.slug;
  const acked = await readAll(ctx.root);
  const del1 = await del(ctx.port, slug2);
  assert.equal(del1.status, 200, del1.text);
  assert.ok(del1.json.archived, 'archived is reported');
  const afterDel = await readAll(ctx.root);
  assert.ok(!afterDel.has(`planning/continuity/${slug2}.md`), 'no longer in planning/continuity');
  const archivedPath = [...afterDel.keys()].find((p) => p.startsWith('archive/planning/continuity/') && p.includes(slug2));
  assert.ok(archivedPath, 'archived under archive/planning/continuity/');
  assert.ok(afterDel.get(archivedPath).equals(acked.get(`planning/continuity/${slug2}.md`)), 'archived with the same bytes, not rewritten');
  const back = await getContinuity(ctx.port);
  assert.deepEqual(back.findings.map((f) => f.fingerprint), [FP], 'finding is back');
  assert.deepEqual(back.suppressed, []);
  assert.deepEqual(back.stale_exceptions, [], 'an archived exception is not a stale exception');

  // --- Undo of the restore puts the exception back, byte-identical
  await undoOf(ctx.port, del1);
  sameFiles(acked, await readAll(ctx.root), '(undo restore)');
  assert.deepEqual((await getContinuity(ctx.port)).suppressed.map((s) => s.finding.fingerprint), [FP]);

  // --- 2. the full flow touched nothing but the continuity folders
  const del2 = await del(ctx.port, slug2);
  assert.equal(del2.status, 200, del2.text);
  const end = await readAll(ctx.root);
  for (const [p, buf] of original) {
    if (WRITABLE.some((w) => p.startsWith(w))) continue;
    assert.ok(end.has(p) && end.get(p).equals(buf), `${p} byte-identical`);
  }
  for (const p of end.keys()) if (!original.has(p)) assert.ok(WRITABLE.some((w) => p.startsWith(w)), `new file ${p} is under a continuity folder`);
  assert.ok(end.get(MAREN).equals(original.get(MAREN)));
  assert.ok(end.get(ARRIVAL).equals(original.get(ARRIVAL)));
});

test('1. a custom title is used for the file title and the slug; a taken slug gets -2', async () => {
  const taken = 'planning/continuity/maren-eyes.md';
  const ctx = await freshBook('valid/salt-orchard', putFile(taken, exceptionFile('maren-eyes', STALE_FP, 'Maren eyes')));
  const r = await post(ctx.port, { fingerprint: FP, rationale: RATIONALE, title: 'Maren eyes' });
  assert.ok([200, 201].includes(r.status), r.text);
  assert.equal(r.json.slug, 'maren-eyes-2');
  const raw = (await readAll(ctx.root)).get('planning/continuity/maren-eyes-2.md').toString('utf8');
  assert.equal(fmOf(raw).title, 'Maren eyes');
  assert.equal(fmOf(raw).fingerprint, FP);
  const c = await getContinuity(ctx.port);
  assert.deepEqual(c.suppressed.map((s) => s.exception.slug), ['maren-eyes-2']);
  assert.deepEqual(c.stale_exceptions.map((s) => s.slug), ['maren-eyes'], 'the made-up one is stale');
});

test('1. the rationale is stored as given (multi-line Markdown kept)', async () => {
  const ctx = await freshBook();
  const text = 'Line one.\n\nLine two with *emphasis*.';
  const r = await post(ctx.port, { fingerprint: FP, rationale: text });
  assert.ok([200, 201].includes(r.status), r.text);
  const raw = (await readAll(ctx.root)).get(`planning/continuity/${r.json.slug}.md`).toString('utf8');
  assert.equal(bodyOf(raw).trim(), text);
});

test('1. dry run returns the file text and writes nothing', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const r = await post(ctx.port, { fingerprint: FP, rationale: RATIONALE, dryRun: true });
  assert.equal(r.status, 200, r.text);
  const shown = JSON.stringify(r.json);
  assert.ok(shown.includes(FP) && shown.includes('storyforge.continuity-exception/v1') && shown.includes('Maren sees her own eyes'), `dry run shows the file text: ${r.text}`);
  sameFiles(before, await readAll(ctx.root));
  assert.deepEqual((await getContinuity(ctx.port)).findings.map((f) => f.fingerprint), [FP]);
});

// ---------------------------------------------------------------- acceptance 3: refusals write nothing

test('3. refusals: unknown fingerprint 404 FINDING_NOT_FOUND, duplicate 409 ALREADY_EXCEPTED, empty rationale 400 RATIONALE_REQUIRED; nothing written', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);

  const unknown = await post(ctx.port, { fingerprint: 'cf1-ffffffffffffffff', rationale: RATIONALE });
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(unknown.json.code, 'FINDING_NOT_FOUND');
  for (const rationale of ['', '   ', '\n\t \n', undefined]) {
    const r = await post(ctx.port, { fingerprint: FP, rationale });
    assert.equal(r.status, 400, `rationale ${JSON.stringify(rationale)}: ${r.text}`);
    assert.equal(r.json.code, 'RATIONALE_REQUIRED');
  }
  sameFiles(before, await readAll(ctx.root), '(refusals)');

  const ok = await post(ctx.port, { fingerprint: FP, rationale: RATIONALE });
  assert.ok([200, 201].includes(ok.status), ok.text);
  const acked = await readAll(ctx.root);
  const dup = await post(ctx.port, { fingerprint: FP, rationale: 'second time' });
  assert.equal(dup.status, 409, dup.text);
  assert.equal(dup.json.code, 'ALREADY_EXCEPTED');
  sameFiles(acked, await readAll(ctx.root), '(duplicate)');
});

test('3. a fingerprint that only a stale exception names is not a current finding: 404', async () => {
  const ctx = await freshBook('valid/salt-orchard', putFile('planning/continuity/old.md', exceptionFile('old', STALE_FP, 'Old')));
  const before = await readAll(ctx.root);
  const r = await post(ctx.port, { fingerprint: STALE_FP, rationale: RATIONALE });
  assert.equal(r.status, 404, r.text);
  sameFiles(before, await readAll(ctx.root));
});

test('3. DELETE of a missing exception is 404 and writes nothing; unknown book is 404', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  assert.equal((await del(ctx.port, 'no-such-exception')).status, 404);
  assert.equal((await post(ctx.port, { fingerprint: FP, rationale: RATIONALE }, UNKNOWN_BOOK)).status, 404);
  sameFiles(before, await readAll(ctx.root));
});

test('3. a missing or malformed fingerprint is a 4xx, never a write', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  for (const body of [{ rationale: RATIONALE }, { fingerprint: 42, rationale: RATIONALE }, { fingerprint: '../../x', rationale: RATIONALE }]) {
    const r = await post(ctx.port, body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)}: ${r.status}`);
  }
  sameFiles(before, await readAll(ctx.root));
});

test('3. both write routes are 403 without the write guard (header / content type / host) and write nothing', async () => {
  const ctx = await freshBook();
  const ack = await post(ctx.port, { fingerprint: FP, rationale: RATIONALE });
  const slug = ack.json.slug;
  const before = await readAll(ctx.root);
  const calls = [
    ['POST', u('exceptions'), { fingerprint: 'cf1-ffffffffffffffff', rationale: RATIONALE }],
    ['DELETE', u('exceptions', slug), undefined],
  ];
  for (const [m, p, body] of calls) {
    assert.equal((await send(ctx.port, m, p, { headers: { 'content-type': 'application/json' }, body })).status, 403, `${m} without x-storyforge`);
    assert.equal((await send(ctx.port, m, p, { headers: { 'content-type': 'text/plain', 'x-storyforge': '1' }, body })).status, 403, `${m} wrong content type`);
    assert.equal((await send(ctx.port, m, p, { body, host: 'evil.example.com' })).status, 403, `${m} foreign host`);
  }
  sameFiles(before, await readAll(ctx.root));
});

// ---------------------------------------------------------------- the context route

test('3. context: +-3 lines around the evidence line, 1-based numbers, the evidence text on its own line (clamped at the file end)', async () => {
  const { port, root } = await freshBook();
  const r = await get(port, ctxQs(ARRIVAL, 17, 3));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.lines.map((l) => l.n), [14, 15, 16, 17, 18, 19, 20]);
  const file = (await fs.readFile(path.join(root, ...ARRIVAL.split('/')), 'utf8')).split(/\r?\n/);
  for (const l of r.json.lines) assert.equal(l.text, file[l.n - 1], `line ${l.n}`);
  assert.ok(r.json.lines.find((l) => l.n === 17).text.includes('green eyes'));
});

test('3. context: the codex source line shows `Eyes: Grey`; radius 0 and radius 10 are accepted; the file start clamps', async () => {
  const { port } = await freshBook();
  const c = await get(port, ctxQs(MAREN, 13, 3));
  assert.equal(c.status, 200, c.text);
  assert.ok(c.json.lines.find((l) => l.n === 13).text.includes('Eyes: Grey'));
  const zero = await get(port, ctxQs(MAREN, 13, 0));
  assert.equal(zero.status, 200, zero.text);
  assert.deepEqual(zero.json.lines.map((l) => l.n), [13]);
  const ten = await get(port, ctxQs(MAREN, 13, 10));
  assert.equal(ten.status, 200, ten.text);
  assert.equal(ten.json.lines.length, 21);
  const top = await get(port, ctxQs(MAREN, 2, 3));
  assert.equal(top.status, 200, top.text);
  assert.equal(top.json.lines[0].n, 1, 'no line 0 or negative');
});

test('3. context refusals: escape, .storyforge, absolute path, radius > 10 -> 400; nothing written', async () => {
  const ctx = await freshBook();
  const before = await readAll(ctx.root);
  const bad = [
    ctxQs('../outside.md'),
    ctxQs('codex/../../outside.md'),
    '?file=%2e%2e%2f%2e%2e%2fetc%2fpasswd&line=1&radius=3',
    '?file=codex%5C..%5C..%5Coutside.md&line=1&radius=3',
    ctxQs('/etc/passwd'),
    ctxQs('C:\\Windows\\win.ini'),
    ctxQs('.storyforge/index.sqlite'),
    ctxQs('.storyforge/'),
    ctxQs(ARRIVAL, 17, 11),
    ctxQs(ARRIVAL, 17, 1000),
  ];
  for (const qs of bad) {
    const r = await get(ctx.port, qs);
    assert.equal(r.status, 400, `${qs}: ${r.status} ${r.text}`);
  }
  sameFiles(before, await readAll(ctx.root));
});

// ---------------------------------------------------------------- acceptance 4: outside edits (watcher on)

async function waitFor(fn, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('4. an exception written by hand suppresses the finding within 5 s; deleting it by hand brings the finding back', async () => {
  const ctx = await freshBook();
  assert.deepEqual((await getContinuity(ctx.port)).findings.map((f) => f.fingerprint), [FP]);
  const file = path.join(ctx.root, 'planning', 'continuity', 'by-hand.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, exceptionFile('by-hand', FP, 'By hand', 'Written outside the app.'));

  const hidden = await waitFor(async () => {
    const c = await getContinuity(ctx.port);
    return c.findings.length === 0 ? c : null;
  }, 'the finding to be suppressed');
  assert.deepEqual(hidden.suppressed.map((s) => [s.finding.fingerprint, s.exception.slug]), [[FP, 'by-hand']]);

  await fs.rm(file);
  const shown = await waitFor(async () => {
    const c = await getContinuity(ctx.port);
    return c.findings.length === 1 ? c : null;
  }, 'the finding to come back');
  assert.equal(shown.findings[0].fingerprint, FP);
  assert.deepEqual(shown.suppressed, []);
});

test('4. an exception made through the route and removed by hand: the finding returns within 5 s', async () => {
  const ctx = await freshBook();
  const r = await post(ctx.port, { fingerprint: FP, rationale: RATIONALE });
  assert.ok([200, 201].includes(r.status), r.text);
  assert.equal((await getContinuity(ctx.port)).findings.length, 0);
  await fs.rm(path.join(ctx.root, 'planning', 'continuity', `${r.json.slug}.md`));
  await waitFor(async () => (await getContinuity(ctx.port)).findings.length === 1, 'the finding to come back');
});
