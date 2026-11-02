// M02-J03 acceptance 5: atomic create. A real child process dies (exit 86) between staging and the rename;
// after a restart the target does not exist, the staging folder is in the trash, recovery reports it,
// and no partial book is ever visible to listBooks.
//
// The fault point is named by the implementation; override with SF_TREE_FAULT if it is called something else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '@storyforge/format';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture, snapshot } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, 'fixtures', 'create-book-crash-child.mjs');
const FAULT = process.env.SF_TREE_FAULT ?? 'before-tree-rename';

const exists = (p) => fs.access(p).then(() => true, () => false);
const dirs = (p) => fs.readdir(p).catch(() => []);

async function filesUnder(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function crash(root, input, at = FAULT) {
  const child = spawnSync(process.execPath, [CHILD, JSON.stringify({ root, at, input })], { encoding: 'utf8', timeout: 60000 });
  assert.equal(child.status, 86, `child must die at the fault point "${at}" (exit 86); status ${child.status}; stderr: ${child.stderr}`);
}

for (const [label, input, rel] of [
  ['standalone', { title: 'Crash Book', template: 'story-circle' }, 'crash-book'],
  ['in a series', { title: 'Crash Book', template: 'heros-journey', seriesSlug: 'harbour-lights' }, 'harbour-lights/crash-book'],
]) {
  test(`atomic create (${label}): crash before the rename leaves no book, staging goes to trash, recovery reports it`, async () => {
    const root = await copyFixture('valid/covers');
    const booksBefore = (await createFsRepository(root).listBooks()).map((b) => b.id).sort();
    const authorBefore = await snapshot(root, { skipStoryforge: true });
    const target = path.join(root, ...rel.split('/'));

    crash(root, input);

    // the crash state: the target does not exist; the staged tree is waiting in .storyforge/staging
    assert.equal(await exists(target), false, 'target folder must not exist after the crash');
    const staged = await dirs(path.join(root, '.storyforge', 'staging'));
    assert.equal(staged.length, 1, `exactly one staging folder left behind, found ${JSON.stringify(staged)}`);
    const opId = staged[0];
    const stagedFiles = await filesUnder(path.join(root, '.storyforge', 'staging', opId));
    assert.ok(stagedFiles.includes('book.md'), 'the staged tree is a whole book (book.md present)');

    // restart: no partial book is visible to listBooks or the validator, even before recovery has run
    const repo = createFsRepository(root);
    assert.deepEqual((await repo.listBooks()).map((b) => b.id).sort(), booksBefore, 'listBooks shows no new book');
    assert.deepEqual((await validate(root)).diagnostics, [], 'validator sees no partial book');

    // recovery moves staging to trash and says so
    const report = await repo.recover();
    assert.ok(JSON.stringify(report).includes(opId), `recover() reports the staging op ${opId}: ${JSON.stringify(report)}`);
    assert.deepEqual(report.needsAttention ?? [], [], 'nothing is stuck');
    assert.equal(await exists(target), false, 'target still does not exist after recovery');
    assert.equal(await exists(path.join(root, '.storyforge', 'staging', opId)), false, 'staging folder is gone');
    const trashed = path.join(root, '.storyforge', 'trash', opId);
    assert.equal(await exists(trashed), true, 'the staging folder is in the trash (never deleted)');
    assert.ok((await filesUnder(trashed)).some((f) => f.endsWith('book.md')), 'the trashed copy holds the book files');

    // nothing else about the author's files changed
    assert.deepEqual(await snapshot(root, { skipStoryforge: true }), authorBefore);
    assert.deepEqual((await repo.listBooks()).map((b) => b.id).sort(), booksBefore);

    // a second recovery is a no-op
    const again = await repo.recover();
    assert.ok(!JSON.stringify(again).includes(opId), 'second recover() does not report it again');
    assert.deepEqual(again.needsAttention ?? [], []);
    assert.equal(await exists(trashed), true);

    // and the same book can now be created normally
    const r = await repo.createBook(input);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await exists(path.join(target, 'book.md')), true);
    assert.deepEqual((await validate(root)).diagnostics, []);
    await repo.close();
  });
}

test('atomic create: a crash leaves the existing library byte-identical, including its own .storyforge data', async () => {
  const root = await copyFixture('valid/covers');
  const before = await snapshot(root, { skipStoryforge: true });
  crash(root, { title: 'Crash Two', template: 'seven-point' });
  assert.deepEqual(await snapshot(root, { skipStoryforge: true }), before);
});
