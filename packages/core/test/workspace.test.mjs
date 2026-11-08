// M12 W2: workspace docs (book, style, per-chapter state) through the repository: create, update with base_sha256, conflict, lock, append, setup, archive, restore, Undo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';

async function setup() {
  const root = await copyFixture('valid/salt-orchard');
  return { root, repo: createFsRepository(root) };
}
const errorsOf = async (root) => (await validate(root)).diagnostics.filter((d) => d.severity === 'error');
const read = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
const exists = (root, rel) => fs.access(path.join(root, ...rel.split('/'))).then(() => true, () => false);

test('list and get: empty book, unknown book and bad addresses are null or empty', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal(await repo.listWorkspaceDocs('book_nope'), null);
    assert.deepEqual(await repo.listWorkspaceDocs(BOOK), { docs: [], archived: [] });
    assert.equal(await repo.getWorkspaceDoc(BOOK, 'workspace/book'), null);
    assert.equal(await repo.getWorkspaceDoc(BOOK, '../x'), null);
    assert.equal(await repo.getWorkspaceDoc(BOOK, 'notes/plan'), null);
  } finally {
    await repo.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('save: create needs no base, update needs base_sha256 (409-style CONFLICT with current), unchanged is a no-op, front matter survives', async () => {
  const { root, repo } = await setup();
  try {
    const made = await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/style', body: '# Style\n\nShort sentences.\n' });
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal(made.created, true);
    assert.equal(typeof made.opId, 'string');
    const text = await read(root, 'planning/workspace/style.md');
    assert.match(text, /^---\nschema: storyforge\.doc\/v1\nid: note_[0-9A-HJKMNP-TV-Z]{26}\ntitle: Style\nworkspace: style\n---\n# Style/);
    assert.deepEqual(await errorsOf(root), []);
    const infos = (await validate(root)).diagnostics.filter((d) => d.code === 'I401' && /workspace\/style/.test(d.file));
    assert.deepEqual(infos, [], 'workspace is a known doc field');

    const doc = await repo.getWorkspaceDoc(BOOK, 'workspace/style');
    assert.equal(doc.workspace, 'style');
    assert.equal(doc.chapter, null);
    assert.equal(doc.locked, false);
    assert.equal(doc.body, '# Style\n\nShort sentences.\n');
    assert.equal(doc.sha256, made.sha256);

    // an update without the base is a conflict that carries what is there now
    const noBase = await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/style', body: 'x' });
    assert.equal(noBase.ok, false);
    assert.equal(noBase.code, 'CONFLICT');
    assert.equal(noBase.current.sha256, doc.sha256);
    assert.equal(noBase.current.body, doc.body);
    const stale = await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/style', body: 'x', baseSha256: 'a'.repeat(64) });
    assert.equal(stale.code, 'CONFLICT');
    assert.equal(await read(root, 'planning/workspace/style.md'), text, 'nothing written');

    const upd = await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/style', title: 'Style guide', body: '# Style\n\nLong ones.\n', baseSha256: doc.sha256 });
    assert.equal(upd.ok, true, JSON.stringify(upd));
    assert.equal(upd.created, false);
    const next = await repo.getWorkspaceDoc(BOOK, 'workspace/style');
    assert.equal(next.title, 'Style guide');
    assert.equal(next.body, '# Style\n\nLong ones.\n');
    assert.equal(next.sha256, upd.sha256);
    assert.match(await read(root, 'planning/workspace/style.md'), /^---\nschema: storyforge\.doc\/v1\nid: note_\w{26}\ntitle: Style guide\nworkspace: style\n---\n/);

    const same = await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/style', body: next.body, baseSha256: next.sha256 });
    assert.equal(same.ok, true);
    assert.deepEqual(same.changes, []);

    // a missing doc with a base is not found; bad addresses and bodies are refused
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/other', body: 'x', baseSha256: 'a'.repeat(64) })).code, 'NOT_FOUND');
    for (const p of ['workspace/Book', 'workspace/a/b', 'state/chapter-4/situation', 'state/chapter-04/notes', 'planning/x', '../etc', 'workspace/']) {
      assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: p, body: 'x' })).code, 'REFUSED_BAD_ARGS', p);
    }
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/ok', body: 5 })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.saveWorkspaceDoc('book_nope', { path: 'workspace/ok', body: 'x' })).code, 'NOT_FOUND');
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('state docs carry their chapter; development docs are kind other; list is sorted and carries sha256', async () => {
  const { root, repo } = await setup();
  try {
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'state/chapter-04/knowledge', body: 'Mara knows the key.\n' })).ok, true);
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'development/ideas', body: 'What if?\n' })).ok, true);
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/book', body: 'Book.\n' })).ok, true);
    assert.match(await read(root, 'planning/state/chapter-04/knowledge.md'), /\ntitle: Chapter 04 knowledge\nworkspace: state\nchapter: 4\n---\n/);
    assert.deepEqual(await errorsOf(root), []);
    const { docs, archived } = await repo.listWorkspaceDocs(BOOK);
    assert.deepEqual(archived, []);
    assert.deepEqual(docs.map((d) => [d.path, d.workspace, d.chapter, d.locked]), [
      ['development/ideas', 'other', null, false],
      ['state/chapter-04/knowledge', 'state', 4, false],
      ['workspace/book', 'book', null, false],
    ]);
    for (const d of docs) {
      assert.match(d.sha256, /^[0-9a-f]{64}$/);
      assert.match(d.updated_at, /^\d{4}-/);
    }
  } finally {
    await repo.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('lock: a locked doc refuses save, append, archive; only unlock writes; a prefix locks a whole chapter folder', async () => {
  const { root, repo } = await setup();
  try {
    for (const k of ['situation', 'characters', 'knowledge']) await repo.saveWorkspaceDoc(BOOK, { path: `state/chapter-04/${k}`, body: `${k}\n` });
    await repo.saveWorkspaceDoc(BOOK, { path: 'state/chapter-05/situation', body: 'later\n' });
    const one = await repo.lockWorkspaceDocs(BOOK, { path: 'state/chapter-04/situation', locked: true });
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.deepEqual(one.changed, ['state/chapter-04/situation']);
    assert.match(await read(root, 'planning/state/chapter-04/situation.md'), /\nlocked: true\n---\n/);
    assert.deepEqual(await errorsOf(root), []);
    assert.equal((await repo.getWorkspaceDoc(BOOK, 'state/chapter-04/situation')).locked, true);

    const all = await repo.lockWorkspaceDocs(BOOK, { prefix: 'state/chapter-04', locked: true });
    assert.equal(all.ok, true);
    assert.deepEqual(all.changed, ['state/chapter-04/characters', 'state/chapter-04/knowledge'], 'the one already locked is left alone');
    assert.deepEqual(all.matched, ['state/chapter-04/characters', 'state/chapter-04/knowledge', 'state/chapter-04/situation']);
    assert.equal((await repo.getWorkspaceDoc(BOOK, 'state/chapter-05/situation')).locked, false, 'another chapter is untouched');

    const before = await read(root, 'planning/state/chapter-04/knowledge.md');
    const doc = await repo.getWorkspaceDoc(BOOK, 'state/chapter-04/knowledge');
    for (const r of [
      await repo.saveWorkspaceDoc(BOOK, { path: 'state/chapter-04/knowledge', body: 'x', baseSha256: doc.sha256 }),
      await repo.appendWorkspaceDoc(BOOK, { path: 'state/chapter-04/knowledge', text: 'x' }),
      await repo.archiveWorkspaceDoc(BOOK, { path: 'state/chapter-04/knowledge' }),
    ]) {
      assert.equal(r.ok, false);
      assert.equal(r.code, 'LOCKED');
    }
    assert.equal(await read(root, 'planning/state/chapter-04/knowledge.md'), before, 'nothing written');

    const un = await repo.lockWorkspaceDocs(BOOK, { prefix: 'state/chapter-04', locked: false });
    assert.equal(un.ok, true);
    assert.equal(un.changed.length, 3);
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'state/chapter-04/knowledge', body: 'x', baseSha256: (await repo.getWorkspaceDoc(BOOK, 'state/chapter-04/knowledge')).sha256 })).ok, true);

    // bad arguments
    assert.equal((await repo.lockWorkspaceDocs(BOOK, { locked: true })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.lockWorkspaceDocs(BOOK, { path: 'workspace/book', prefix: 'state/chapter-04', locked: true })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.lockWorkspaceDocs(BOOK, { prefix: 'workspace', locked: true })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.lockWorkspaceDocs(BOOK, { path: 'workspace/book', locked: 'yes' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.lockWorkspaceDocs(BOOK, { path: 'workspace/missing', locked: true })).code, 'NOT_FOUND');
    assert.equal((await repo.lockWorkspaceDocs(BOOK, { prefix: 'state/chapter-77', locked: true })).code, 'NOT_FOUND');
  } finally {
    await repo.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('lock keeps a legacy doc (locked: false line already there) valid', async () => {
  const { root, repo } = await setup();
  try {
    const file = path.join(root, 'planning', 'state', 'chapter-02');
    await fs.mkdir(file, { recursive: true });
    await fs.writeFile(path.join(file, 'situation.md'), '---\nschema: storyforge.doc/v1\nid: note_01S5000000000000000000AAAA\ntitle: Old\nlocked: false\nx-legacy: 1\n---\nBody\n');
    const r = await repo.lockWorkspaceDocs(BOOK, { path: 'state/chapter-02/situation', locked: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await read(root, 'planning/state/chapter-02/situation.md'), '---\nschema: storyforge.doc/v1\nid: note_01S5000000000000000000AAAA\ntitle: Old\nlocked: true\nx-legacy: 1\n---\nBody\n');
    const d = await repo.getWorkspaceDoc(BOOK, 'state/chapter-02/situation');
    assert.equal(d.workspace, 'state');
    assert.equal(d.chapter, 2);
    assert.equal(d.locked, true);
  } finally {
    await repo.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('append: creates a missing doc, adds a blank-line separated block, no base needed', async () => {
  const { root, repo } = await setup();
  try {
    const a = await repo.appendWorkspaceDoc(BOOK, { path: 'workspace/timeline-history', text: 'Day 1: arrival.  \n\n' });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.created, true);
    assert.equal((await repo.getWorkspaceDoc(BOOK, 'workspace/timeline-history')).body, 'Day 1: arrival.\n');
    assert.equal((await repo.listWorkspaceDocs(BOOK)).docs[0].title, 'Timeline history');
    const b = await repo.appendWorkspaceDoc(BOOK, { path: 'workspace/timeline-history', text: 'Day 2: storm.' });
    assert.equal(b.ok, true);
    assert.equal(b.created, false);
    assert.equal((await repo.getWorkspaceDoc(BOOK, 'workspace/timeline-history')).body, 'Day 1: arrival.\n\nDay 2: storm.\n');
    assert.equal((await repo.appendWorkspaceDoc(BOOK, { path: 'workspace/timeline-history', text: '   ' })).code, 'REFUSED_BAD_ARGS');
    assert.equal((await repo.appendWorkspaceDoc(BOOK, { path: 'nope', text: 'x' })).code, 'REFUSED_BAD_ARGS');
    assert.deepEqual(await errorsOf(root), []);
  } finally {
    await repo.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('setup: creates book, style and the four chapter-00 state docs, only what is missing, in one batch', async () => {
  const { root, repo } = await setup();
  try {
    await repo.saveWorkspaceDoc(BOOK, { path: 'workspace/style', body: 'My own style notes.\n' });
    const dry = await repo.setupWorkspace(BOOK, { dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.dryRun, true);
    assert.equal(await exists(root, 'planning/workspace/book.md'), false, 'a dry run writes nothing');
    const r = await repo.setupWorkspace(BOOK, {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.created, ['workspace/book', 'state/chapter-00/situation', 'state/chapter-00/characters', 'state/chapter-00/knowledge', 'state/chapter-00/inventory']);
    assert.deepEqual(r.existing, ['workspace/style']);
    assert.equal((await repo.getWorkspaceDoc(BOOK, 'workspace/style')).body, 'My own style notes.\n', 'an existing doc is untouched');
    const book = await repo.getWorkspaceDoc(BOOK, 'workspace/book');
    assert.match(book.body, /^# Book settings\n/);
    const style = await fs.readFile(path.join(root, 'planning/workspace/style.md'), 'utf8');
    assert.ok(!style.includes('Style guide'));
    const sit = await repo.getWorkspaceDoc(BOOK, 'state/chapter-00/situation');
    assert.equal(sit.chapter, 0);
    assert.match(sit.body, /before chapter 1/);
    assert.deepEqual(await errorsOf(root), []);
    const again = await repo.setupWorkspace(BOOK, {});
    assert.equal(again.ok, true);
    assert.deepEqual(again.created, []);
    assert.equal(again.opId, undefined, 'nothing to write');

    // creating files is not auto-undoable in the store (the same as every other create); the author archives instead
    assert.equal((await repo.restoreOp(BOOK, r.opId)).code, 'REFUSED_NOT_UNDOABLE');
    assert.equal(await exists(root, 'planning/workspace/book.md'), true);
  } finally {
    await repo.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('archive and restore: moves under archive/planning/, never deletes; a live doc blocks the restore; Undo of a save', async () => {
  const { root, repo } = await setup();
  try {
    const made = await repo.saveWorkspaceDoc(BOOK, { path: 'development/ideas', body: 'One.\n' });
    const arc = await repo.archiveWorkspaceDoc(BOOK, { path: 'development/ideas' });
    assert.equal(arc.ok, true, JSON.stringify(arc));
    assert.equal(await exists(root, 'planning/development/ideas.md'), false);
    assert.equal(await exists(root, 'archive/planning/development/ideas.md'), true);
    assert.equal(await repo.getWorkspaceDoc(BOOK, 'development/ideas'), null);
    const list = await repo.listWorkspaceDocs(BOOK);
    assert.deepEqual(list.docs, []);
    assert.deepEqual(list.archived.map((d) => d.path), ['development/ideas']);
    assert.deepEqual(await errorsOf(root), []);
    // a new doc at an archived address is refused
    assert.equal((await repo.saveWorkspaceDoc(BOOK, { path: 'development/ideas', body: 'Two.\n' })).code, 'REFUSED_PATH_TAKEN');
    assert.equal((await repo.archiveWorkspaceDoc(BOOK, { path: 'development/ideas' })).code, 'NOT_FOUND');
    const back = await repo.restoreWorkspaceDoc(BOOK, { path: 'development/ideas', baseSha256: made.sha256 });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal((await repo.getWorkspaceDoc(BOOK, 'development/ideas')).body, 'One.\n');
    assert.equal((await repo.restoreWorkspaceDoc(BOOK, { path: 'development/ideas' })).code, 'NOT_FOUND');
    assert.equal((await repo.archiveWorkspaceDoc(BOOK, { path: 'development/ideas', baseSha256: 'b'.repeat(64) })).code, 'CONFLICT');

    // Undo of an update puts the old text back
    const cur = await repo.getWorkspaceDoc(BOOK, 'development/ideas');
    const upd = await repo.saveWorkspaceDoc(BOOK, { path: 'development/ideas', body: 'Changed.\n', baseSha256: cur.sha256 });
    assert.equal((await repo.restoreOp(BOOK, upd.opId)).ok, true);
    assert.equal((await repo.getWorkspaceDoc(BOOK, 'development/ideas')).body, 'One.\n');
  } finally {
    await repo.close?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});
