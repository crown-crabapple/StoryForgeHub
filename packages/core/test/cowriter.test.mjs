// M12 W6: the co-writer in the repository. A scene made with origin ai, the draft body replace (only for origin ai + status drafting, race-safe with the sha), AI Activity
// marking created scenes and chapters as archivable, the scene summary carrying origin, and the context pack gathered from a planned book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { runAsActor } from '@storyforge/store';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const ARRIVAL = 'scene_01S50000000000000000000002';
const FERRY = 'scene_01S50000000000000000000005';
const ARRIVAL_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
const ACTOR = { kind: 'plugin', id: 'tok_test', name: 'mcp-laptop' };
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const read = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');

async function withRepo(fn, fixture = 'valid/salt-orchard') {
  const root = await copyFixture(fixture);
  const repo = createFsRepository(root);
  try {
    await fn(repo, root);
  } finally {
    await repo.close?.();
  }
}

/** A draft by the AI at the end of chapter 1. */
const aiScene = (repo, over = {}) => runAsActor(ACTOR, () => repo.createScene(BOOK, { chapter: 1, after: null, title: 'The Crossing', slug: 'the-crossing', body: 'The water was black and slow.\n', status: 'drafting', origin: 'ai', ...over }));

test('createScene with origin ai writes origin: ai in the front matter, the book stays valid, and the scene summary carries origin only for AI scenes', async () => {
  await withRepo(async (repo, root) => {
    const r = await aiScene(repo);
    assert.equal(r.ok, true, JSON.stringify(r));
    const text = await read(root, r.path);
    assert.match(text, /\nstatus: drafting\norigin: ai\n/);
    assert.deepEqual(await errorsOf(root), []);
    const book = await repo.getBook(BOOK);
    const scenes = book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));
    assert.equal(scenes.find((s) => s.id === r.id).origin, 'ai');
    assert.equal(scenes.find((s) => s.id === ARRIVAL).origin, undefined, 'an author scene has no origin key in the summary');
    assert.equal((await repo.getScene(BOOK, r.id)).origin, 'ai');
    // origin is optional and checked
    const bad = await repo.createScene(BOOK, { chapter: 1, after: null, title: 'X', slug: 'x', body: 'x\n', origin: 'robot' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'REFUSED_BAD_ARGS');
    const plain = await repo.createScene(BOOK, { chapter: 1, after: null, title: 'Plain', slug: 'plain', body: 'p\n' });
    assert.doesNotMatch(await read(root, plain.path), /origin:/);
  });
});

test('updateAiDraftBody: replaces the body of an unaccepted AI draft and nothing else, with a required sha', async () => {
  await withRepo(async (repo, root) => {
    const made = await aiScene(repo);
    const first = await repo.getScene(BOOK, made.id);
    const before = await read(root, made.path);
    const r = await repo.updateAiDraftBody(BOOK, made.id, 'The water was black.\nA bell rang twice.\n', { baseSha256: first.sha256 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.words.added >= 1);
    const after = await read(root, made.path);
    assert.equal(after.slice(0, after.indexOf('\n---', 3)), before.slice(0, before.indexOf('\n---', 3)), 'the front matter is untouched');
    assert.match(after, /A bell rang twice\./);
    assert.deepEqual(await errorsOf(root), []);

    const noSha = await repo.updateAiDraftBody(BOOK, made.id, 'x\n', {});
    assert.deepEqual([noSha.ok, noSha.code], [false, 'BAD_ARGS']);
    const stale = await repo.updateAiDraftBody(BOOK, made.id, 'x\n', { baseSha256: first.sha256 });
    assert.deepEqual([stale.ok, stale.code], [false, 'CONFLICT'], 'the sha of the first read is stale now');
    assert.match(await read(root, made.path), /A bell rang twice\./, 'a stale save wrote nothing');
    assert.equal((await repo.updateAiDraftBody(BOOK, 'scene_01S5NOSUCHSCENE0000000000', 'x', { baseSha256: first.sha256 })).code, 'NOT_FOUND');
  });
});

test('updateAiDraftBody: an author scene, and an AI scene the author moved on from drafting, are refused NOT_AI_DRAFT and stay byte for byte', async () => {
  await withRepo(async (repo, root) => {
    const author = await repo.getScene(BOOK, ARRIVAL);
    const authorFile = await read(root, ARRIVAL_PATH);
    const r = await repo.updateAiDraftBody(BOOK, ARRIVAL, 'overwritten\n', { baseSha256: author.sha256 });
    assert.deepEqual([r.ok, r.code], [false, 'NOT_AI_DRAFT']);
    assert.equal(await read(root, ARRIVAL_PATH), authorFile);

    // an author scene that says origin: author is still the author's
    const asAuthor = await repo.createScene(BOOK, { chapter: 1, after: null, title: 'Mine', slug: 'mine', body: 'mine\n', origin: 'author' });
    const mine = await repo.getScene(BOOK, asAuthor.id);
    assert.equal((await repo.updateAiDraftBody(BOOK, asAuthor.id, 'x\n', { baseSha256: mine.sha256 })).code, 'NOT_AI_DRAFT');

    // the author accepts an AI draft by changing its status
    const made = await aiScene(repo, { title: 'Accepted soon', slug: 'accepted-soon' });
    assert.equal((await repo.setSceneFields(BOOK, made.id, { status: 'revised' })).ok, true);
    const accepted = await repo.getScene(BOOK, made.id);
    const file = await read(root, accepted.path);
    const refused = await repo.updateAiDraftBody(BOOK, made.id, 'AI tries again\n', { baseSha256: accepted.sha256 });
    assert.deepEqual([refused.ok, refused.code], [false, 'NOT_AI_DRAFT']);
    assert.match(refused.message, /propose an edit instead/);
    assert.equal(await read(root, accepted.path), file);
  });
});

test('updateAiDraftBody is race-safe: the file the author accepted between the check and the write is never overwritten', async () => {
  await withRepo(async (repo, root) => {
    const made = await aiScene(repo);
    const seen = await repo.getScene(BOOK, made.id);
    // the author accepts the draft; the AI still holds the sha of the draft it read
    assert.equal((await repo.setSceneFields(BOOK, made.id, { status: 'final' })).ok, true);
    const file = await read(root, seen.path);
    const r = await repo.updateAiDraftBody(BOOK, made.id, 'late AI save\n', { baseSha256: seen.sha256 });
    assert.equal(r.ok, false);
    assert.ok(['NOT_AI_DRAFT', 'CONFLICT'].includes(r.code), r.code);
    assert.equal(await read(root, seen.path), file);
  });
});

test('AI Activity: a scene or chapter the AI created is archivable (not undoable) with its target; other ops keep their Undo; archiving takes it off the list', async () => {
  await withRepo(async (repo) => {
    const made = await aiScene(repo);
    const chap = await runAsActor(ACTOR, () => repo.createChapter(BOOK, { after: 3, title: 'The Ferry' }));
    assert.equal(chap.ok, true, JSON.stringify(chap));
    // an AI edit of another kind (a scene's fields) is a normal undoable op
    assert.equal((await runAsActor(ACTOR, () => repo.setSceneFields(BOOK, ARRIVAL, { summary: 'Maren arrives.' }))).ok, true);
    // and the author's own creation is not AI activity at all
    assert.equal((await repo.createScene(BOOK, { chapter: 1, after: null, title: 'Author', slug: 'author', body: 'a\n' })).ok, true);

    const list = await repo.listAiActivity(BOOK);
    assert.equal(list.ok, true);
    assert.equal(list.items.length, 3, JSON.stringify(list.items.map((i) => i.op)));
    const byOp = Object.fromEntries(list.items.map((i) => [i.op, i]));
    assert.deepEqual([byOp.insertScene.archivable, byOp.insertScene.undoable, byOp.insertScene.target], [true, false, { kind: 'scene', id: made.id }]);
    assert.deepEqual([byOp.createChapter.archivable, byOp.createChapter.undoable, byOp.createChapter.target], [true, false, { kind: 'chapter', id: chap.chapter }]);
    const other = list.items.find((i) => i.op !== 'insertScene' && i.op !== 'createChapter');
    assert.deepEqual([other.archivable, other.target], [false, null]);
    assert.equal(other.undoable, true, 'the other op keeps its Undo');

    // archive the scene and the chapter through the existing archive methods: they leave the list's archivable set
    const scene = await repo.getScene(BOOK, made.id);
    assert.equal((await repo.archiveScene(BOOK, made.id, { baseSha256: scene.sha256 })).ok, true);
    assert.equal((await repo.archiveChapter(BOOK, chap.chapter, {})).ok, true);
    const after = (await repo.listAiActivity(BOOK)).items;
    assert.equal(after.some((i) => i.archivable), false, 'nothing left to archive');
    assert.deepEqual(after.filter((i) => i.op === 'insertScene' || i.op === 'createChapter').map((i) => i.target), [null, null]);
  });
});

test('getContext on a planned book: every section is gathered for the chapter, and a small budget names what was cut', async () => {
  await withRepo(async (repo) => {
    assert.equal(await repo.getContext('book_nope', { chapter: 1 }), null);
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/style', body: '# Style\n\nShort sentences. Salt in the air.\n' })).ok, true);
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'state/chapter-01/situation', body: '# Situation\n\nMaren has the key.\n' })).ok, true);
    assert.equal((await repo.setSceneCast(BOOK, FERRY, { cast: [{ entry: 'maren-hollis', role: 'pov' }] })).ok, true);
    assert.equal((await repo.recordKnowledge(BOOK, { character: 'maren-hollis', fact: 'The key opens the sluice', chapter: 1 })).ok, true);
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 1, items: [{ subject: 'ferry-bell', kind: 'lost' }] })).ok, true);
    const promise = await repo.createThread(BOOK, { title: 'Maren will mend the wall', kind: 'promise', status: 'planted' });
    assert.equal((await repo.setThreadFields(BOOK, promise.slug, { setup: [ARRIVAL] })).ok, true);

    const pack = await repo.getContext(BOOK, { chapter: 2, budget: 24000 });
    assert.deepEqual(pack.truncated, []);
    assert.equal(pack.chapter, 2);
    assert.ok(pack.workspace.some((d) => d.path === 'workspace/style' && /Short sentences/.test(d.body)));
    assert.ok(pack.story.logline && pack.story.premise);
    assert.deepEqual(pack.scene_plans.map((s) => s.scene), [FERRY]);
    assert.equal(pack.scene_plans[0].beats[0].beat, 'Opening image');
    assert.deepEqual(pack.cast.map((c) => [c.slug, c.type, c.role]), [['maren-hollis', 'character', 'pov']]);
    assert.ok(pack.cast[0].summary.length > 0);
    assert.deepEqual(pack.knowledge, [{ character: 'Maren Hollis', facts: ['the-key-opens-the-sluice'] }]);
    assert.deepEqual(pack.open_ledger.map((x) => [x.kind, x.title]), [['promise', 'Maren will mend the wall']]);
    assert.deepEqual(pack.state_events.map((e) => [e.subject, e.kind]), [['Ferry Bell', 'lost']]);
    assert.deepEqual(pack.state_docs.map((d) => d.path), ['state/chapter-01/situation']);
    assert.ok(pack.previous_tail.length > 0 && pack.previous_tail.length <= 1500);
    assert.ok(pack.continuity.every((f) => f.rule && f.title), 'findings are projected');

    // nothing known yet at chapter 1: knowledge and state events are those of chapters before it
    const first = await repo.getContext(BOOK, { chapter: 1, budget: 24000 });
    assert.deepEqual(first.knowledge, []);
    assert.deepEqual(first.state_events, []);
    assert.deepEqual(first.open_ledger, [], 'planted in chapter 1 itself, not before it');

    const small = await repo.getContext(BOOK, { chapter: 2, budget: 600 });
    assert.ok(small.chars <= 600);
    assert.ok(small.truncated.length > 0);
    assert.ok(small.truncated.includes('previous_tail'));
  }, 'valid/planner');
});
