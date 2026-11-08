// M12 W3: the ledgers end to end on copies of salt-orchard: the chapter cast (only the scene's `cast` key), the promises / questions ledger, knowledge and state events
// (items appended to a chapter's "Chapter N (state)" event), tasks for the AI, and the AI words of the writing log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, snapshot } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const MAREN = 'entry_01S5000000000000000000000G';
const ARRIVAL = 'scene_01S50000000000000000000002';
const KEY = 'scene_01S50000000000000000000003';
const FERRY = 'scene_01S50000000000000000000005';
const ARRIVAL_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const read = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
const bodyOf = (text) => text.slice(text.indexOf('\n---', 3) + 4);

async function withRepo(fn, fixture = 'valid/salt-orchard') {
  const root = await copyFixture(fixture);
  const repo = createFsRepository(root);
  try {
    await fn(repo, root);
  } finally {
    await repo.close?.();
  }
}

// ---------------------------------------------------------------- chapter cast

test('setSceneCast: writes only the cast key of the scene (the prose and every other line stay byte for byte), and getCast reads it back resolved', async () => {
  await withRepo(async (repo, root) => {
    const before = await read(root, ARRIVAL_PATH);
    const r = await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'maren-hollis', role: 'pov' }, { entry: MAREN.replace('G', 'J'), role: 'appears' }, { entry: 'pell', role: 'mentioned' }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = await read(root, ARRIVAL_PATH);
    assert.equal(bodyOf(after), bodyOf(before), 'the prose is untouched');
    assert.match(after, /\ncast:\n {2}- entry: maren-hollis\n {4}role: pov\n/);
    assert.equal(after.replace(/cast:\n(?: {2,}.*\n)+/, ''), before, 'removing the cast block gives back the old file');
    assert.deepEqual(await errorsOf(root), []);

    const cast = await repo.getCast(BOOK, { chapter: 1 });
    assert.equal(cast[0].scene, ARRIVAL);
    assert.ok(cast.every((s) => s.chapter === 1), 'one chapter only');
    const arrival = cast.find((s) => s.scene === ARRIVAL);
    assert.equal(arrival.chapter, 1);
    assert.deepEqual(arrival.cast.map((c) => [c.slug, c.role]), [['maren-hollis', 'pov'], ['tobin-reyes', 'appears'], ['pell', 'mentioned']]);
    assert.equal(arrival.cast[0].id, MAREN);
    assert.equal(arrival.cast[0].name, 'Maren Hollis');
    assert.ok((await repo.getCast(BOOK)).length > cast.length, 'no chapter: every scene');
    assert.equal(await repo.getCast('book_nope'), null);

    // replacing the list, then clearing it
    const again = await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'pell', role: 'pov' }] });
    assert.equal(again.ok, true);
    assert.deepEqual((await repo.getCast(BOOK, { chapter: 1 })).find((s) => s.scene === ARRIVAL).cast.map((c) => c.slug), ['pell']);
    const cleared = await repo.setSceneCast(BOOK, ARRIVAL, { cast: [] });
    assert.equal(cleared.ok, true);
    assert.equal(await read(root, ARRIVAL_PATH), before, 'an empty cast removes the block: the file is as it was');
  });
});

test('setSceneCast: refusals write nothing (two pov, unknown entry, unknown role, a duplicate, a stale sha, an unknown scene); a dry run previews', async () => {
  await withRepo(async (repo, root) => {
    const snap = await snapshot(root, { skipStoryforge: true });
    const two = await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'pell', role: 'pov' }, { entry: 'maren-hollis', role: 'pov' }] });
    assert.equal(two.ok, false);
    assert.equal(two.code, 'REFUSED_BAD_ARGS');
    const ghost = await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'nobody-here', role: 'appears' }] });
    assert.equal(ghost.code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal(ghost.index, 0);
    assert.equal((await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'pell', role: 'star' }] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'pell', role: 'appears' }, { entry: 'pell', role: 'mentioned' }] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'pell', role: 'appears', extra: 1 }] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.setSceneCast(BOOK, ARRIVAL, { cast: 'pell' })).code, 'REFUSED_BAD_ARGS');
    const stale = await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'pell', role: 'appears' }], baseSha256: '0'.repeat(64) });
    assert.equal(stale.code, 'CONFLICT');
    assert.equal((await repo.setSceneCast(BOOK, 'scene_01S5000000000000000000ZZZZ', { cast: [] })).code, 'NOT_FOUND');
    assert.equal((await repo.setSceneCast('book_nope', ARRIVAL, { cast: [] })).code, 'NOT_FOUND');
    const dry = await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'pell', role: 'appears' }], dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.changes.length, 1);
    assert.deepEqual(await snapshot(root, { skipStoryforge: true }), snap, 'nothing was written');
    // the right sha is accepted
    const sha = (await repo.getScene(BOOK, ARRIVAL)).sha256;
    assert.equal((await repo.setSceneCast(BOOK, ARRIVAL, { cast: [{ entry: 'pell', role: 'appears' }], baseSha256: sha })).ok, true);
  });
});

// ---------------------------------------------------------------- the promises / questions ledger

test('getLedger: promises and questions are threads of that kind with scene ids and chapters; the planner clues come with it', async () => {
  await withRepo(async (repo) => {
    assert.equal(await repo.getLedger('book_nope'), null);
    const empty = await repo.getLedger(BOOK);
    assert.deepEqual(empty.promises, []);
    assert.deepEqual(empty.questions, []);
    const p = await repo.createThread(BOOK, { title: 'Maren will mend the wall', kind: 'promise', status: 'planned' });
    assert.equal(p.ok, true, JSON.stringify(p));
    const q = await repo.createThread(BOOK, { title: 'Who left the key?', kind: 'question' });
    assert.equal(q.ok, true);
    const set = await repo.setThreadFields(BOOK, p.slug, { status: 'planted', setup: [ARRIVAL, FERRY], payoff: [KEY] });
    assert.equal(set.ok, true, JSON.stringify(set));
    const clue = await repo.createClue(BOOK, { fact: 'The harbour key opens the sea gate', fields: { planted: [ARRIVAL], revealed: FERRY } });
    assert.equal(clue.ok, true, JSON.stringify(clue));
    const l = await repo.getLedger(BOOK);
    assert.equal(l.promises.length, 1);
    assert.equal(l.questions.length, 1);
    const [promise] = l.promises;
    assert.equal(promise.slug, p.slug);
    assert.equal(promise.status, 'planted');
    assert.equal(promise.open, true);
    assert.deepEqual(promise.setup, [ARRIVAL, FERRY]);
    assert.deepEqual(promise.setup_chapters, [1, 2]);
    assert.deepEqual(promise.payoff, [KEY]);
    assert.deepEqual(promise.payoff_chapters, [1]);
    assert.equal(l.questions[0].kind, 'question');
    assert.equal(l.clues.length, 1);
    assert.equal(l.clues[0].status, 'revealed');
    assert.deepEqual(l.clues[0].planted, [ARRIVAL]);
    assert.deepEqual(l.clues[0].planted_chapters, [1]);
    assert.equal(l.clues[0].revealed, FERRY);
    assert.equal(l.clues[0].revealed_chapter, 2);
    // retiring is a status change: paid is closed
    assert.equal((await repo.setThreadFields(BOOK, p.slug, { status: 'paid' })).ok, true);
    const closed = await repo.getLedger(BOOK);
    assert.equal(closed.promises[0].open, false);
    assert.deepEqual(closed.counts, { promises: 1, open_promises: 0, questions: 1, open_questions: 1, clues: 1 });
    // the existing mystery thread is not part of the promise / question ledger
    assert.equal(closed.promises.concat(closed.questions).some((t) => t.slug === 'brass-key'), false);
  });
});

// ---------------------------------------------------------------- knowledge and state events

test('recordKnowledge / knowledgeAt: a learns item on the chapter state event (made when missing); the answer follows the chapters; nothing is ever removed', async () => {
  await withRepo(async (repo, root) => {
    const first = await repo.recordKnowledge(BOOK, { character: 'maren-hollis', fact: 'The key opens the sluice', chapter: 1 });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.fact, 'the-key-opens-the-sluice');
    assert.equal(first.created, true);
    assert.equal(first.slug, 'chapter-1-state');
    const eventText = await read(root, 'planning/timeline/chapter-1-state.md');
    assert.match(eventText, /title: Chapter 1 \(state\)\norder: 1\nscenes: \[scene_01S50000000000000000000002\]\nstate:\n {2}- slug: maren-hollis\n {4}event: learns\n {4}value: the-key-opens-the-sluice\n/);
    assert.deepEqual(await errorsOf(root), []);

    const second = await repo.recordKnowledge(BOOK, { character: MAREN, fact: 'Pell is the ferryman', chapter: 1 });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.created, false, 'the same event takes the second item');
    const third = await repo.recordKnowledge(BOOK, { character: 'maren-hollis', fact: 'The wall will fall', chapter: 3 });
    assert.equal(third.ok, true, JSON.stringify(third));
    assert.equal(third.slug, 'chapter-3-state');
    // the same fact again changes nothing
    const dup = await repo.recordKnowledge(BOOK, { character: 'maren-hollis', fact: 'The key opens the sluice', chapter: 1 });
    assert.equal(dup.ok, true);
    assert.equal(dup.added, 0);
    assert.deepEqual(await errorsOf(root), []);

    const at0 = await repo.knowledgeAt(BOOK, { character: 'maren-hollis', at: 0 });
    assert.deepEqual(at0.facts, []);
    const at1 = await repo.knowledgeAt(BOOK, { character: 'maren-hollis', at: 1 });
    assert.deepEqual(at1.facts.map((f) => [f.fact, f.chapter, f.how]), [['the-key-opens-the-sluice', 1, 'learns'], ['pell-is-the-ferryman', 1, 'learns']]);
    assert.equal(at1.character.slug, 'maren-hollis');
    const at2 = await repo.knowledgeAt(BOOK, { character: 'maren-hollis', at: 2 });
    assert.equal(at2.facts.length, 2);
    const all = await repo.knowledgeAt(BOOK, { character: 'maren-hollis' });
    assert.deepEqual(all.facts.map((f) => f.fact), ['the-key-opens-the-sluice', 'pell-is-the-ferryman', 'the-wall-will-fall']);
    assert.deepEqual((await repo.knowledgeAt(BOOK, { character: 'pell' })).facts, []);

    assert.equal((await repo.knowledgeAt(BOOK, { character: 'nobody-here' })).code, 'NOT_FOUND');
    assert.equal((await repo.knowledgeAt('book_nope', { character: 'pell' })).code, 'NOT_FOUND');
    assert.equal((await repo.knowledgeAt(BOOK, { character: 'pell', at: -1 })).code, 'BAD_ARGS');
    // refusals
    assert.equal((await repo.recordKnowledge(BOOK, { character: 'nobody-here', fact: 'x y', chapter: 1 })).code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal((await repo.recordKnowledge(BOOK, { character: 'pell', fact: 'x y', chapter: 99 })).code, 'REFUSED_UNKNOWN_CHAPTER');
    assert.equal((await repo.recordKnowledge(BOOK, { character: 'pell', fact: '!!!', chapter: 1 })).code, 'BAD_ARGS');
    assert.equal((await repo.recordKnowledge(BOOK, { character: 'pell', fact: 'a\nb', chapter: 1 })).code, 'BAD_ARGS');
    assert.equal((await repo.recordKnowledge(BOOK, { character: 'salt-orchard', fact: 'a place cannot learn', chapter: 1 })).ok, false, 'a location is not a character (the check after the write refuses it)');
    assert.deepEqual(await errorsOf(root), []);
  });
});

test('recordStateEvents / getStateEvents: died, lost, holder and the rest are appended to the chapter state event; the list is in book order and filters by chapter', async () => {
  await withRepo(async (repo, root) => {
    const r = await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ subject: 'ferry-bell', kind: 'lost' }, { subject: 'grafting-knife', kind: 'holder', value: 'maren-hollis' }] });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slug, 'chapter-2-state');
    const next = await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ slug: 'pell', event: 'died' }] });
    assert.equal(next.ok, true, JSON.stringify(next));
    assert.equal(next.created, false);
    const other = await repo.recordStateEvents(BOOK, { chapter: 1, items: [{ subject: 'maren-hollis', kind: 'location', value: 'port-aldine' }] });
    assert.equal(other.ok, true, JSON.stringify(other));
    assert.deepEqual(await errorsOf(root), []);

    const all = await repo.getStateEvents(BOOK);
    assert.deepEqual(all.map((e) => [e.chapter, e.subject.slug, e.kind, e.value ?? null]), [
      [1, 'maren-hollis', 'location', 'port-aldine'],
      [2, 'ferry-bell', 'lost', null],
      [2, 'grafting-knife', 'holder', 'maren-hollis'],
      [2, 'pell', 'died', null],
    ]);
    assert.equal(all[1].event, 'chapter-2-state');
    assert.equal(all[1].subject.name, 'Ferry Bell');
    assert.deepEqual((await repo.getStateEvents(BOOK, { chapter: 2 })).map((e) => e.subject.slug), ['ferry-bell', 'grafting-knife', 'pell']);
    assert.deepEqual(await repo.getStateEvents(BOOK, { chapter: 3 }), []);
    assert.equal(await repo.getStateEvents('book_nope'), null);

    // retiring: a later item that ends the state; the earlier one stays
    const found = await repo.recordStateEvents(BOOK, { chapter: 3, items: [{ subject: 'ferry-bell', kind: 'found' }] });
    assert.equal(found.ok, true);
    assert.deepEqual((await repo.getStateEvents(BOOK)).filter((e) => e.subject.slug === 'ferry-bell').map((e) => [e.chapter, e.kind]), [[2, 'lost'], [3, 'found']]);

    // refusals: bad kind or value, knowledge kinds belong to recordKnowledge, an unknown entry or chapter
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ subject: 'pell', kind: 'exploded' }] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ subject: 'pell', kind: 'learns', value: 'x' }] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ subject: 'pell', kind: 'died', value: 'x' }] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ subject: 'grafting-knife', kind: 'holder' }] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ subject: 'nobody-here', kind: 'died' }] })).code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ subject: 'pell', kind: 'location', value: 'nowhere-land' }] })).code, 'REFUSED_UNKNOWN_ENTRY');
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 42, items: [{ subject: 'pell', kind: 'died' }] })).code, 'REFUSED_UNKNOWN_CHAPTER');
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 2, items: [] })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.recordStateEvents(BOOK, { chapter: 2, items: 'x' })).code, 'BAD_ARGS');
    // a dead item for an object, not a character: the check after the write refuses it and nothing is kept
    const bad = await repo.recordStateEvents(BOOK, { chapter: 2, items: [{ subject: 'ferry-bell', kind: 'died' }] });
    assert.equal(bad.ok, false);
    assert.deepEqual(await errorsOf(root), []);
    assert.equal((await repo.getStateEvents(BOOK)).length, 5);
  });
});

test('the knowledge and state items share one event per chapter, and the existing items are kept as written', async () => {
  await withRepo(async (repo, root) => {
    await repo.recordKnowledge(BOOK, { character: 'maren-hollis', fact: 'The key opens the sluice', chapter: 1 });
    await repo.recordStateEvents(BOOK, { chapter: 1, items: [{ subject: 'pell', kind: 'died' }] });
    const text = await read(root, 'planning/timeline/chapter-1-state.md');
    assert.equal((text.match(/\n {2}- slug:/g) ?? []).length, 2);
    assert.equal((await fs.readdir(path.join(root, 'planning', 'timeline'))).filter((f) => f.startsWith('chapter-1')).length, 1);
    assert.deepEqual((await repo.getStateEvents(BOOK, { chapter: 1 })).map((e) => e.kind), ['died']);
    assert.deepEqual((await repo.knowledgeAt(BOOK, { character: 'maren-hollis', at: 1 })).facts.map((f) => f.fact), ['the-key-opens-the-sluice']);
    // a hand-written state block with a comment is refused, not reformatted
    const file = path.join(root, 'planning', 'timeline', 'chapter-1-state.md');
    await fs.writeFile(file, text.replace('state:\n', 'state: # by hand\n'));
    const refused = await repo.recordStateEvents(BOOK, { chapter: 1, items: [{ subject: 'ferry-bell', kind: 'lost' }] });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'REFUSED_UNSIMPLE_FIELD');
  });
});

// ---------------------------------------------------------------- tasks for the AI

test('tasks: for ai | author (default author) is written only for the AI, filters the list, and can be changed with the status', async () => {
  await withRepo(async (repo, root) => {
    const mine = await repo.createTask(BOOK, { title: 'Fix the ferry scene' });
    const ai = await repo.createTask(BOOK, { title: 'Check the tide times', for: 'ai' });
    assert.equal(mine.ok, true, JSON.stringify(mine));
    assert.equal(ai.ok, true, JSON.stringify(ai));
    assert.doesNotMatch(await read(root, mine.file), /^for:/m);
    assert.match(await read(root, ai.file), /\nstatus: open\nfor: ai\nsource:/);
    assert.equal((await repo.createTask(BOOK, { title: 'Nope', for: 'robot' })).code, 'BAD_ARGS');
    assert.deepEqual(await errorsOf(root), []);

    const list = await repo.listTasks(BOOK);
    assert.deepEqual(list.tasks.map((t) => [t.title, t.for]).sort(), [['Check the tide times', 'ai'], ['Fix the ferry scene', 'author']]);
    assert.deepEqual((await repo.listTasks(BOOK, { for: 'ai' })).tasks.map((t) => t.slug), [ai.slug]);
    assert.deepEqual((await repo.listTasks(BOOK, { for: 'author' })).tasks.map((t) => t.slug), [mine.slug]);
    assert.equal((await repo.listTasks(BOOK, { for: 'ai' })).counts.total, 2, 'counts stay the whole book');

    const done = await repo.setTaskStatus(BOOK, ai.slug, 'done');
    assert.equal(done.ok, true);
    assert.equal(done.for, 'ai');
    const hand = await repo.setTaskStatus(BOOK, mine.slug, 'doing', { for: 'ai' });
    assert.equal(hand.ok, true, JSON.stringify(hand));
    assert.equal(hand.for, 'ai');
    assert.deepEqual((await repo.listTasks(BOOK, { for: 'ai' })).tasks.map((t) => t.slug).sort(), [ai.slug, mine.slug].sort());
    const back = await repo.setTaskStatus(BOOK, mine.slug, 'doing', { for: 'author' });
    assert.equal(back.ok, true);
    assert.deepEqual((await repo.listTasks(BOOK, { for: 'ai' })).tasks.map((t) => t.slug), [ai.slug]);
    assert.equal((await repo.setTaskStatus(BOOK, mine.slug, 'doing', { for: 'robot' })).code, 'BAD_ARGS');
    assert.deepEqual(await errorsOf(root), []);
  });
});

// ---------------------------------------------------------------- the AI words of the writing log

test('recordAiWords: today\'s row gets the AI words column (only once a row has AI words), activity and insights show the human and AI share', async () => {
  await withRepo(async (repo, root) => {
    assert.equal((await repo.getActivity(BOOK)).today.ai_words, 0);
    const r = await repo.recordAiWords(BOOK, { words: 120, chapter: 2, note: 'Drafted the ferry scene' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.today.ai_words, 120);
    assert.equal(r.chapter, 2);
    const log = await read(root, 'activity/writing-log.md');
    assert.match(log, /\| Date \| Words added \| Words removed \| Minutes \| Sessions \| AI words \|\n\|---\|---\|---\|---\|---\|---\|\n\| \d{4}-\d{2}-\d{2} \| 0 \| 0 \| 0 \| 0 \| 120 \|\n/);
    assert.deepEqual(await errorsOf(root), []);
    await repo.recordAiWords(BOOK, { words: 30 });
    const a = await repo.getActivity(BOOK);
    assert.equal(a.today.ai_words, 150);
    assert.deepEqual(a.totals, { human_words: 0, ai_words: 150, ai_share: 1 });
    assert.equal(a.days.at(-1).ai_words, 150);
    const ins = (await repo.getInsights(BOOK)).insights;
    assert.deepEqual(ins.progress.ai, { human_words: 0, ai_words: 150, ai_share: 1 });
    assert.equal(ins.progress.days.at(-1).ai_words, 150);
    // refusals
    assert.equal((await repo.recordAiWords(BOOK, { words: 0 })).code, 'BAD_ARGS');
    assert.equal((await repo.recordAiWords(BOOK, { words: 1.5 })).code, 'BAD_ARGS');
    assert.equal((await repo.recordAiWords(BOOK, { words: 5, chapter: -1 })).code, 'BAD_ARGS');
    assert.equal((await repo.recordAiWords(BOOK, { words: 5, note: 'a\nb' })).code, 'BAD_ARGS');
    assert.equal((await repo.recordAiWords('book_nope', { words: 5 })).code, 'NOT_FOUND');
  });
});
