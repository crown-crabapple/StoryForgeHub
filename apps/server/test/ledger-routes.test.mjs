// M12 W3: the app routes for the AI workspace ledgers (the same routes the plugin API and MCP tools reach).
//   POST /api/books/:b/scenes/:id/cast        { cast: [{ entry, role }], base_sha256? }          (route scene-cast; writes only the scene's `cast` key)
//   GET  /api/books/:b/ledger                 { promises, questions, clues, counts }
//   GET  /api/books/:b/cast[?chapter=N]       [{ scene, title, chapter, cast }]
//   GET  /api/books/:b/knowledge?character=&at=      POST /api/books/:b/knowledge { character, fact, chapter }       (route ledger-knowledge-record)
//   GET  /api/books/:b/state-events[?chapter=N|all]  POST /api/books/:b/state-events { chapter, items }              (route ledger-state-record)
//   GET  /api/books/:b/tasks?for=ai           POST .../tasks { title, for }     POST .../tasks/:id/status { status, for? }
//   POST /api/books/:b/activity/ai-words      { words, chapter?, note? }                         (route activity-ai-log)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { validate } from '../../../packages/format/src/index.mjs';
import { setBookPreferences } from './custom-helpers.mjs';
import { readAll } from './move-helpers.mjs';
import { BOOK, SCENE, SCENE_PATH, bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const b = (p) => `/api/books/${BOOK}${p}`;
const errorKeys = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}|${d.file}|${d.location}`);
const changed = (a, c) => [...new Set([...a.keys(), ...c.keys()])].filter((p) => !a.has(p) || !c.has(p) || !a.get(p).equals(c.get(p))).sort();
const bodyOf = (buf) => buf.toString('utf8').slice(buf.toString('utf8').indexOf('\n---', 3) + 4);

test('scene-cast: sets the cast, reads it back per chapter, changes only that scene file (front matter, never the prose), and refuses bad input', async () => {
  const t = await bootPersonal();
  const errorsBefore = await errorKeys(t.root);
  const before = await readAll(t.root);
  const r = await t.member('POST', b(`/scenes/${SCENE}/cast`), { cast: [{ entry: 'maren-hollis', role: 'pov' }, { entry: 'tobin-reyes', role: 'appears' }] });
  assert.equal(r.status, 200, r.text);
  const after1 = await readAll(t.root);
  const touched = changed(before, after1).filter((p) => !p.startsWith('.storyforge/') && !p.startsWith('provenance/'));
  assert.deepEqual(touched, [SCENE_PATH], 'one file changed');
  assert.equal(bodyOf(after1.get(SCENE_PATH)), bodyOf(before.get(SCENE_PATH)), 'the prose is byte for byte the same');
  assert.deepEqual(await errorKeys(t.root), errorsBefore);

  const cast = await t.member('GET', b('/cast?chapter=1'));
  assert.equal(cast.status, 200);
  assert.equal(cast.json[0].scene, SCENE);
  assert.deepEqual(cast.json[0].cast.map((c) => [c.slug, c.role]), [['maren-hollis', 'pov'], ['tobin-reyes', 'appears']]);
  assert.ok((await t.member('GET', b('/cast'))).json.length > cast.json.length);
  assert.equal((await t.member('GET', b('/cast?chapter=x'))).status, 400);
  assert.equal((await t.member('GET', '/api/books/book_nope/cast')).status, 404);

  // stale base, bad input, unknown things
  assert.equal((await t.member('POST', b(`/scenes/${SCENE}/cast`), { cast: [], base_sha256: '0'.repeat(64) })).status, 409);
  assert.equal((await t.member('POST', b(`/scenes/${SCENE}/cast`), { cast: [{ entry: 'maren-hollis', role: 'pov' }, { entry: 'pell', role: 'pov' }] })).status, 400);
  const ghost = await t.member('POST', b(`/scenes/${SCENE}/cast`), { cast: [{ entry: 'nobody-here', role: 'appears' }] });
  assert.equal(ghost.status, 400);
  assert.equal(ghost.json.code, 'REFUSED_UNKNOWN_ENTRY');
  assert.equal((await t.member('POST', b(`/scenes/${SCENE}/cast`), { cast: 'x' })).status, 400);
  assert.equal((await t.member('POST', b('/scenes/scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ/cast'), { cast: [] })).status, 404);
  assert.deepEqual(await readAll(t.root), after1, 'refusals wrote nothing');

  // dry run, then the right sha
  const dry = await t.member('POST', b(`/scenes/${SCENE}/cast`), { cast: [], dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.dryRun, true);
  assert.deepEqual(await readAll(t.root), after1);
  const sha = (await t.member('GET', b(`/scenes/${SCENE}`))).json.sha256;
  assert.equal((await t.member('POST', b(`/scenes/${SCENE}/cast`), { cast: [], base_sha256: sha })).status, 200);
  assert.equal(bodyOf((await readAll(t.root)).get(SCENE_PATH)), bodyOf(before.get(SCENE_PATH)));
});

test('knowledge and state events: record, read at a chapter, retire with a later item; the chapter state event is made once', async () => {
  const t = await bootPersonal();
  const errorsBefore = await errorKeys(t.root);
  const k1 = await t.member('POST', b('/knowledge'), { character: 'maren-hollis', fact: 'The key opens the sluice', chapter: 1 });
  assert.equal(k1.status, 200, k1.text);
  assert.equal(k1.json.fact, 'the-key-opens-the-sluice');
  assert.equal(k1.json.slug, 'chapter-1-state');
  assert.equal((await t.member('POST', b('/knowledge'), { character: 'maren-hollis', fact: 'The wall will fall', chapter: 3 })).status, 200);
  const at1 = await t.member('GET', b('/knowledge?character=maren-hollis&at=1'));
  assert.equal(at1.status, 200, at1.text);
  assert.deepEqual(at1.json.facts.map((f) => f.fact), ['the-key-opens-the-sluice']);
  assert.equal(at1.json.character.slug, 'maren-hollis');
  assert.deepEqual((await t.member('GET', b('/knowledge?character=maren-hollis'))).json.facts.map((f) => f.fact), ['the-key-opens-the-sluice', 'the-wall-will-fall']);
  assert.deepEqual((await t.member('GET', b('/knowledge?character=maren-hollis&at=0'))).json.facts, []);
  assert.equal((await t.member('GET', b('/knowledge'))).status, 400);
  assert.equal((await t.member('GET', b('/knowledge?character=maren-hollis&at=one'))).status, 400);
  assert.equal((await t.member('GET', b('/knowledge?character=nobody-here'))).status, 404);

  const s1 = await t.member('POST', b('/state-events'), { chapter: 2, items: [{ subject: 'ferry-bell', kind: 'lost' }, { subject: 'pell', kind: 'died' }] });
  assert.equal(s1.status, 200, s1.text);
  assert.equal((await t.member('POST', b('/state-events'), { chapter: 3, items: [{ subject: 'ferry-bell', kind: 'found' }] })).status, 200);
  const all = await t.member('GET', b('/state-events'));
  assert.deepEqual(all.json.map((e) => [e.chapter, e.subject.slug, e.kind]), [[2, 'ferry-bell', 'lost'], [2, 'pell', 'died'], [3, 'ferry-bell', 'found']]);
  assert.deepEqual((await t.member('GET', b('/state-events?chapter=2'))).json.map((e) => e.kind), ['lost', 'died']);
  assert.equal((await t.member('GET', b('/state-events?chapter=all'))).json.length, 3);
  assert.equal((await t.member('GET', b('/state-events?chapter=x'))).status, 400);
  assert.deepEqual(await errorKeys(t.root), errorsBefore);

  const files = (await fs.readdir(path.join(t.root, 'planning', 'timeline'))).filter((f) => f.startsWith('chapter-'));
  assert.deepEqual(files.sort(), ['chapter-1-state.md', 'chapter-2-state.md', 'chapter-3-state.md']);

  // refusals
  const before = await readAll(t.root);
  assert.equal((await t.member('POST', b('/knowledge'), { character: 'maren-hollis', fact: 'x y' })).status, 400);
  assert.equal((await t.member('POST', b('/knowledge'), { character: 'nobody-here', fact: 'x y', chapter: 1 })).status, 400);
  assert.equal((await t.member('POST', b('/knowledge'), { character: 'pell', fact: 'x y', chapter: 77 })).status, 400);
  assert.equal((await t.member('POST', b('/state-events'), { chapter: 2, items: [{ subject: 'pell', kind: 'exploded' }] })).status, 400);
  assert.equal((await t.member('POST', b('/state-events'), { chapter: 2 })).status, 400);
  assert.equal((await t.member('POST', b('/state-events'), { chapter: 2, items: [{ subject: 'ferry-bell', kind: 'died' }] })).status, 409, 'an object cannot die: the check after the write refuses it');
  assert.deepEqual(await readAll(t.root), before, 'refusals wrote nothing');
});

test('ledger: promises and questions are threads of that kind, with scene ids and chapters (the thread routes write them)', async () => {
  const t = await bootPersonal();
  const made = await t.member('POST', b('/threads'), { title: 'Maren will mend the wall', kind: 'promise' });
  assert.equal(made.status, 201, made.text);
  assert.equal((await t.member('POST', b('/threads'), { title: 'Who left the key?', kind: 'question' })).status, 201);
  assert.equal((await t.member('POST', b(`/threads/${made.json.slug}/fields`), { status: 'planted', setup: [SCENE] })).status, 200);
  const l = await t.member('GET', b('/ledger'));
  assert.equal(l.status, 200, l.text);
  assert.deepEqual(l.json.promises.map((p) => [p.slug, p.status, p.open, p.setup, p.setup_chapters]), [[made.json.slug, 'planted', true, [SCENE], [1]]]);
  assert.equal(l.json.questions.length, 1);
  assert.deepEqual(l.json.clues, []);
  assert.equal(l.json.counts.open_promises, 1);
  assert.equal((await t.member('GET', '/api/books/book_nope/ledger')).status, 404);
});

test('tasks for the AI: create with for, list with ?for=, change it with the status; AI words in activity', async () => {
  const t = await bootPersonal();
  const mine = await t.member('POST', b('/tasks'), { title: 'Fix the ferry scene' });
  const ai = await t.member('POST', b('/tasks'), { title: 'Check the tide times', for: 'ai' });
  assert.equal(mine.status, 201, mine.text);
  assert.equal(ai.status, 201, ai.text);
  assert.equal((await t.member('POST', b('/tasks'), { title: 'x', for: 'robot' })).status, 400);
  assert.deepEqual((await t.member('GET', b('/tasks?for=ai'))).json.tasks.map((x) => x.slug), [ai.json.slug]);
  assert.deepEqual((await t.member('GET', b('/tasks?for=author'))).json.tasks.map((x) => x.slug), [mine.json.slug]);
  assert.equal((await t.member('GET', b('/tasks?for=robot'))).status, 400);
  const st = await t.member('POST', b(`/tasks/${mine.json.slug}/status`), { status: 'doing', for: 'ai' });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json.for, 'ai');
  assert.equal((await t.member('GET', b('/tasks?for=ai'))).json.tasks.length, 2);
  assert.equal((await t.member('POST', b(`/tasks/${mine.json.slug}/status`), { status: 'doing', for: 'robot' })).status, 400);

  const log = await t.member('POST', b('/activity/ai-words'), { words: 200, chapter: 1, note: 'Drafted a scene' });
  assert.equal(log.status, 200, log.text);
  assert.equal(log.json.today.ai_words, 200);
  const act = await t.member('GET', b('/activity'));
  assert.equal(act.json.today.ai_words, 200);
  assert.deepEqual(act.json.totals, { human_words: 0, ai_words: 200, ai_share: 1 });
  assert.match(await fs.readFile(path.join(t.root, 'activity', 'writing-log.md'), 'utf8'), /\| AI words \|/);
  assert.equal((await t.member('POST', b('/activity/ai-words'), { words: 0 })).status, 400);
  assert.equal((await t.member('POST', b('/activity/ai-words'), { words: 'many' })).status, 400);
  assert.equal((await t.member('POST', '/api/books/book_nope/activity/ai-words', { words: 5 })).status, 404);
  const ins = await t.member('GET', b('/insights'));
  assert.deepEqual(ins.json.progress.ai, { human_words: 0, ai_words: 200, ai_share: 1 });
});

test('the workspace module: with it off the new write routes are refused (403 MODULE_OFF) and nothing is written; reads still work', async () => {
  const t = await bootPersonal();
  await setBookPreferences(t.root, '  modules:\n    workspace: false\n');
  const before = await readAll(t.root);
  const writes = [
    [`/scenes/${SCENE}/cast`, { cast: [] }],
    ['/knowledge', { character: 'maren-hollis', fact: 'a b', chapter: 1 }],
    ['/state-events', { chapter: 1, items: [{ subject: 'pell', kind: 'died' }] }],
    ['/activity/ai-words', { words: 5 }],
  ];
  for (const [p, body] of writes) {
    const r = await t.member('POST', b(p), body);
    assert.equal(r.status, 403, `${p}: ${r.text}`);
    assert.equal(r.json.code, 'MODULE_OFF', p);
    assert.equal(r.json.module, 'workspace', p);
  }
  assert.deepEqual(await readAll(t.root), before);
  assert.equal((await t.member('GET', b('/ledger'))).status, 200);
  assert.equal((await t.member('GET', b('/cast'))).status, 200);
});
