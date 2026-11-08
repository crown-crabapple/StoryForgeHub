// M12 W1: the AI level (preferences.ai.level in book.md / library.md) set through the app, the actor every plugin-token write records in the op journal, and
// GET /api/books/:b/ai-activity with Undo. A canvas write and a plan write made with a token both appear; a write the author makes does not.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { withAiLevel } from '../../../packages/core/src/fs-writes.mjs';
import { BOOK } from './move-helpers.mjs';
import { projectLibrary } from './custom-helpers.mjs';
import { bootPersonal, closeAll } from './plugin-helpers.mjs';

after(closeAll);

const canvases = `/api/v1/books/${BOOK}/canvases`;
const clues = `/api/v1/books/${BOOK}/plan/clues`;
const activity = (t) => t.member('GET', `/api/books/${BOOK}/ai-activity`);
const setLevel = (t, level, scope) => t.member('POST', `/api/books/${BOOK}/ai-level`, { level, ...(scope ? { scope } : {}) });

async function boot() {
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const token = (await t.grant({ plugin: 'mcp-laptop', permissions: ['read', 'canvas', 'plan'] })).token;
  return { t, token };
}

test('a plugin canvas write and a plugin plan write both appear in AI Activity, newest first, with the token as actor; a member write does not', async () => {
  const { t, token } = await boot();
  assert.deepEqual((await activity(t)).json, { activity: [] });

  const made = await t.plugin(token, 'POST', canvases, { body: { title: 'Board' } });
  assert.equal(made.status, 201, made.text);
  const card = { id: 'n1', type: 'text', text: 'n1', x: 0, y: 0, width: 100, height: 60 };
  const saved = await t.plugin(token, 'PUT', `${canvases}/board`, { body: { canvas: { nodes: [card], edges: [] }, base_sha256: made.json.sha256 } });
  assert.equal(saved.status, 200, saved.text);
  const clue = await t.plugin(token, 'POST', clues, { body: { fact: 'The lamp is cold.', kind: 'clue' } });
  assert.equal(clue.status, 201, clue.text);
  // the author's own write (the daily goal edits book.md)
  assert.equal((await t.member('POST', `/api/books/${BOOK}/goal`, { daily_word_goal: 700 })).status, 200);

  const r = await activity(t);
  assert.equal(r.status, 200, r.text);
  const items = r.json.activity;
  assert.equal(items.length, 3, JSON.stringify(items));
  for (const it of items) {
    assert.match(it.opId, /^\d{8}T\d{9}Z-[0-9A-HJKMNP-TV-Z]{6}$/);
    assert.equal(it.actor.kind, 'plugin');
    assert.equal(it.actor.name, 'mcp-laptop');
    assert.match(it.actor.id, /^tok_/);
    assert.ok(Date.parse(it.at) > 0);
    assert.equal(it.undone, false);
    assert.equal(typeof it.summary, 'string');
    assert.ok(it.files.length > 0);
    assert.ok(!it.files.includes('book.md'), 'the author\'s own write is not AI activity');
  }
  assert.deepEqual(items.map((i) => i.opId), [...items.map((i) => i.opId)].sort().reverse(), 'newest first');
  assert.ok(items[0].files.some((f) => f.startsWith('planning/clues/')), 'the plan write is the newest');
  assert.deepEqual(items[1].files, ['planning/canvases/board.canvas']);
  assert.deepEqual(items[2].files, ['planning/canvases/board.canvas']);
  assert.equal(items[1].undoable, true, 'a canvas save can be undone');
  assert.equal(items[2].undoable, false, 'a canvas creation cannot be undone automatically');
  assert.equal(items[0].undoable, true, 'a new clue can be undone');
});

test('Undo from AI Activity restores the file and marks the item undone', async () => {
  const { t, token } = await boot();
  const made = await t.plugin(token, 'POST', canvases, { body: { title: 'Board' } });
  const file = path.join(t.root, 'planning', 'canvases', 'board.canvas');
  const original = await fs.readFile(file);
  const card = { id: 'n1', type: 'text', text: 'hello', x: 0, y: 0, width: 100, height: 60 };
  assert.equal((await t.plugin(token, 'PUT', `${canvases}/board`, { body: { canvas: { nodes: [card], edges: [] }, base_sha256: made.json.sha256 } })).status, 200);
  assert.notEqual(Buffer.compare(await fs.readFile(file), original), 0);

  const save = (await activity(t)).json.activity.find((i) => i.undoable);
  assert.ok(save);
  const undo = await t.member('POST', `/api/books/${BOOK}/ops/${save.opId}/restore`, {});
  assert.equal(undo.status, 200, undo.text);
  assert.equal(Buffer.compare(await fs.readFile(file), original), 0, 'the canvas is as it was');

  const after2 = (await activity(t)).json.activity;
  assert.equal(after2.length, 2, 'the undo itself is the author\'s, not AI activity');
  const item = after2.find((i) => i.opId === save.opId);
  assert.equal(item.undone, true);
  assert.equal(item.undoable, false);
});

test('Changing the AI level in the book changes what a token can do (and the setting is a plain ai.level line in book.md)', async () => {
  const { t, token } = await boot();
  const newCanvas = (title) => t.plugin(token, 'POST', canvases, { body: { title } });
  assert.equal((await newCanvas('One')).status, 201, 'the default level is planner');

  const advisor = await setLevel(t, 'advisor');
  assert.equal(advisor.status, 200, advisor.text);
  assert.deepEqual(advisor.json, { ok: true, level: 'advisor', scope: 'book' });
  assert.match(await fs.readFile(path.join(t.root, 'book.md'), 'utf8'), /preferences:\n(?:[^\n]*\n)*?\s+ai:\n\s+level: advisor\n/);
  const refused = await newCanvas('Two');
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.code, 'AI_LEVEL');
  assert.equal((await t.plugin(token, 'POST', clues, { body: { fact: 'x', kind: 'clue' } })).status, 403);
  assert.equal((await t.plugin(token, 'GET', canvases)).status, 200, 'reads still work');
  // the effective level and where it comes from are on GET /api/preferences
  const prefs = await t.member('GET', `/api/preferences?book=${BOOK}`);
  assert.equal(prefs.json.effective.ai.level, 'advisor');
  assert.equal(prefs.json.sources['ai.level'], 'book');

  assert.equal((await setLevel(t, 'cowriter')).status, 200);
  assert.equal((await newCanvas('Two')).status, 201);
  assert.equal((await setLevel(t, 'off')).status, 200);
  assert.equal((await newCanvas('Three')).status, 403);

  // removing the setting falls back to the default (planner)
  const cleared = await setLevel(t, null);
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal((await newCanvas('Three')).status, 201);
  assert.doesNotMatch(await fs.readFile(path.join(t.root, 'book.md'), 'utf8'), /preferences:|level:/);
  const back = await t.member('GET', `/api/preferences?book=${BOOK}`);
  assert.equal(back.json.sources['ai.level'], 'builtin');
});

test('the AI level route refuses bad input and writes nothing', async () => {
  const { t } = await boot();
  const before = await fs.readFile(path.join(t.root, 'book.md'));
  for (const body of [{ level: 'god' }, {}, { level: 7 }, { level: 'planner', scope: 'series' }]) {
    const r = await t.member('POST', `/api/books/${BOOK}/ai-level`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await t.member('POST', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/ai-level', { level: 'off' })).status, 404);
  assert.equal(Buffer.compare(await fs.readFile(path.join(t.root, 'book.md')), before), 0);
  assert.equal((await t.member('GET', '/api/books/book_01S5ZZZZZZZZZZZZZZZZZZZZZZ/ai-activity')).status, 404);
  // a plugin token cannot reach the author-only route
  const token = (await t.grant({ plugin: 'mcp-x', permissions: ['read', 'canvas', 'plan'] })).token;
  const viaPlugin = await t.plugin(token, 'POST', `/api/books/${BOOK}/ai-level`, { body: { level: 'cowriter' } });
  assert.notEqual(viaPlugin.status, 200);
  assert.equal(Buffer.compare(await fs.readFile(path.join(t.root, 'book.md')), before), 0);
});

test('a library default: library.md holds it, the book overrides it, and the source says which', async () => {
  const root = await projectLibrary();
  const repository = createFsRepository(root, { watch: false, pollMs: 0 });
  try {
    const book = (await repository.listBooks())[0];
    const libraryBefore = await fs.readFile(path.join(root, 'library.md'), 'utf8');
    const r = await repository.setAiLevel(book.id, 'advisor', { scope: 'library' });
    assert.equal(r.ok, true, JSON.stringify(r));
    const libraryText = await fs.readFile(path.join(root, 'library.md'), 'utf8');
    assert.match(libraryText, /preferences:\n {2}ai:\n {4}level: advisor\n---\n$/);
    assert.ok(libraryText.startsWith(libraryBefore.slice(0, libraryBefore.indexOf('---', 4))), 'the rest of the front matter is unchanged');
    assert.deepEqual((await repository.getPreferences({ bookId: book.id })).library, { ai: { level: 'advisor' } });
    assert.equal((await repository.setAiLevel(book.id, 'cowriter')).ok, true);
    assert.deepEqual((await repository.getPreferences({ bookId: book.id })).book.ai, { level: 'cowriter' });
    assert.equal((await repository.setAiLevel(book.id, 'advisor', { scope: 'library' })).unchanged, true, 'the same value writes nothing');
  } finally {
    await repository.close?.();
  }
  // a single-book root has no library.md: refused, nothing created
  const t = await bootPersonal({ fixture: 'valid/planner' });
  const none = await setLevel(t, 'advisor', 'library');
  assert.equal(none.status, 404, none.text);
  await assert.rejects(fs.access(path.join(t.root, 'library.md')));
});

test('withAiLevel keeps comments, other keys, CRLF and the body, and refuses a preferences value that is not a mapping', () => {
  const body = '\nBody text.\n';
  const set = (text, level) => {
    const r = withAiLevel(Buffer.from(text), level);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.buf.toString('utf8');
  };
  const plain = `---\nid: book_1\n# keep me\ntitle: "A: B"\n---${body}`;
  const withLevel = set(plain, 'planner');
  assert.equal(withLevel, `---\nid: book_1\n# keep me\ntitle: "A: B"\npreferences:\n  ai:\n    level: planner\n---${body}`);
  assert.equal(set(withLevel, null), plain, 'removing it puts the file back');
  const existing = `---\nid: book_1\npreferences:\n  theme: dark # mine\n  modules:\n    ai: false\n---${body}`;
  assert.equal(set(existing, 'off'), `---\nid: book_1\npreferences:\n  theme: dark # mine\n  modules:\n    ai: false\n  ai:\n    level: off\n---${body}`);
  assert.equal(set(set(existing, 'off'), 'advisor').includes('level: advisor'), true);
  assert.equal(set(`---\nid: x\npreferences:\n---${body}`, 'advisor'), `---\nid: x\npreferences:\n  ai:\n    level: advisor\n---${body}`);
  const crlf = set('---\r\nid: x\r\n---\r\nBody\r\n', 'advisor');
  assert.equal(crlf, '---\r\nid: x\r\npreferences:\r\n  ai:\r\n    level: advisor\r\n---\r\nBody\r\n');
  assert.equal(withAiLevel(Buffer.from(plain), null).changed, false);
  assert.equal(withAiLevel(Buffer.from(`---\nid: x\npreferences: nope\n---${body}`), 'off').ok, false);
  assert.equal(withAiLevel(Buffer.from('no front matter'), 'off').ok, false);
});

test('the op journal stays as it was for writes without an actor, and a plugin write records one', async () => {
  const { t, token } = await boot();
  assert.equal((await t.member('POST', `/api/books/${BOOK}/goal`, { daily_word_goal: 650 })).status, 200);
  assert.equal((await t.plugin(token, 'POST', canvases, { body: { title: 'Board' } })).status, 201);
  const trash = path.join(t.root, '.storyforge', 'trash');
  const entries = [];
  for (const id of await fs.readdir(trash)) {
    try {
      entries.push(JSON.parse(await fs.readFile(path.join(trash, id, 'journal.json'), 'utf8')));
    } catch {
      // an op without a journal copy
    }
  }
  const mine = entries.filter((e) => e.actor);
  assert.equal(mine.length, 1);
  assert.deepEqual(Object.keys(mine[0].actor).sort(), ['id', 'kind', 'name']);
  assert.ok(entries.some((e) => !('actor' in e)), 'an ordinary write has no actor key');
});
