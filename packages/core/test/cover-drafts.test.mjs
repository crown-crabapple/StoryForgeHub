// M08-J03: cover drafts (assets/drafts/ + asset note, "Use as cover" as a single-line book.md edit, delete to trash) and activity/ai-usage.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { applyAiUsage, newAiUsage, parseAiUsage } from '../src/ai-usage.mjs';
import { createFsRepository } from '../src/index.mjs';
import { copyFixture } from './helpers.mjs';

const BOOK = 'book_01S5000000000000000000000A';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);
const draft = { bytes: PNG, prompt: 'A drowned orchard at dusk,\nwith "quotes": and a colon', provider: 'Pictures', model: 'img-1', locality: /** @type {'local'} */ ('local') };

test('a draft is a PNG and a valid asset note; the validator accepts the library; two saves in one second get different names', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root, { clock: () => new Date(2026, 10, 3, 9, 15, 0).getTime() });
  const a = await repo.saveCoverDraft(BOOK, draft);
  const b = await repo.saveCoverDraft(BOOK, draft);
  assert.equal(a.ok, true);
  assert.equal(a.name, 'cover-20261103-091500-1.png');
  assert.equal(b.name, 'cover-20261103-091500-2.png');
  assert.deepEqual(await fs.readFile(path.join(root, a.path)), PNG);
  const note = await fs.readFile(path.join(root, a.notePath), 'utf8');
  assert.match(note, /^---\nschema: storyforge\.asset-note\/v1\n/);
  assert.match(note, /sha256: [0-9a-f]{64}/);
  const result = await validate(root);
  assert.deepEqual(result.diagnostics.filter((d) => d.severity === 'error' && d.file.includes('assets/drafts')), []);
  const list = await repo.listCoverDrafts(BOOK);
  assert.deepEqual(list.drafts.map((d) => d.name), [b.name, a.name]);
  assert.equal(list.drafts[0].prompt, draft.prompt, 'the prompt round trips through the note');
  assert.equal(list.drafts[0].isCover, false);
});

test('Use as cover changes one line of book.md and nothing else; deleting the cover draft is refused; another draft goes to the trash', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  const a = await repo.saveCoverDraft(BOOK, draft);
  const b = await repo.saveCoverDraft(BOOK, { ...draft, bytes: Buffer.concat([PNG, Buffer.from([1])]) });
  const before = (await fs.readFile(path.join(root, 'book.md'), 'utf8')).split('\n');
  const used = await repo.useCoverDraft(BOOK, a.name);
  assert.equal(used.ok, true);
  const after = (await fs.readFile(path.join(root, 'book.md'), 'utf8')).split('\n');
  const removed = before.filter((l) => !after.includes(l));
  const added = after.filter((l) => !before.includes(l));
  assert.deepEqual(removed, []);
  assert.equal(added.length, 1);
  assert.match(added[0], /^cover: .*assets\/drafts\/cover-.*\.png/);
  assert.equal((await repo.listCoverDrafts(BOOK)).drafts.find((d) => d.name === a.name).isCover, true);
  assert.equal((await repo.deleteCoverDraft(BOOK, a.name)).code, 'IN_USE');
  const gone = await repo.deleteCoverDraft(BOOK, b.name);
  assert.equal(gone.ok, true);
  await assert.rejects(fs.stat(path.join(root, b.path)));
  await assert.rejects(fs.stat(path.join(root, b.notePath)));
  assert.equal((await repo.listCoverDrafts(BOOK)).drafts.length, 1);
  assert.equal((await repo.useCoverDraft(BOOK, 'cover-20260101-000000-9.png')).code, 'NOT_FOUND');
  assert.equal((await repo.useCoverDraft(BOOK, '../book.md')).code, 'BAD_ARGS');
});

test('ai-usage.md: counts per day, profile and locality; the file is created on first use and validates', async () => {
  const text0 = newAiUsage('note_01J00000000000000000000001');
  const u = { date: '2026-11-03', profile: 'Local | model', locality: /** @type {'local'} */ ('local'), promptTokens: 10, completionTokens: 5, estimated: false };
  const t1 = applyAiUsage(applyAiUsage(text0, u), { ...u, estimated: true });
  const t2 = applyAiUsage(t1, { ...u, locality: 'cloud' });
  const rows = parseAiUsage(t2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { date: '2026-11-03', profile: 'Local   model', locality: 'local', requests: 2, promptTokens: 20, completionTokens: 10, estimated: 1 });
  assert.equal(rows[1].locality, 'cloud');

  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  assert.equal((await repo.recordAiUsage(BOOK, { profile: 'P', locality: 'cloud', promptTokens: 3, completionTokens: 4, estimated: true })).ok, true);
  await repo.recordAiUsage(BOOK, { profile: 'P', locality: 'cloud', promptTokens: 3, completionTokens: 4, estimated: false });
  const file = await fs.readFile(path.join(root, 'activity', 'ai-usage.md'), 'utf8');
  assert.match(file, /^---\nschema: storyforge\.doc\/v1\n/);
  assert.equal(parseAiUsage(file)[0].requests, 2);
  assert.deepEqual((await validate(root)).diagnostics.filter((d) => d.severity === 'error'), []);
});

test('the cover draft receipt (ai.generation, workflow ai-cover) names the asset note and the picture by hash, and the receipt chain verifies', async () => {
  const root = await copyFixture('valid/salt-orchard');
  const repo = createFsRepository(root);
  const d = await repo.saveCoverDraft(BOOK, draft);
  await repo.recordProvenance({ kind: 'ai.generation', bookId: BOOK, asset: { id: d.id, path: d.notePath, sha256: d.sha256 }, provider: { name: 'Pictures', model: 'img-1', locality: 'local' }, promptSha256: 'a'.repeat(64) });
  const dir = path.join(root, 'provenance');
  const found = [];
  const walk = async (p) => {
    for (const e of await fs.readdir(p, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(p, e.name));
      else if (e.name.endsWith('.md')) found.push(await fs.readFile(path.join(p, e.name), 'utf8'));
    }
  };
  await walk(dir);
  const receipt = found.find((t) => /operation: ai\.generation/.test(t));
  assert.ok(receipt, 'a receipt was written');
  assert.match(receipt, /workflow: ai-cover/);
  assert.ok(receipt.includes(d.notePath));
  assert.ok(receipt.includes(d.sha256), 'the picture is named by its hash');
  assert.equal(receipt.includes('Pictures') && receipt.includes(draft.prompt), false, 'the prompt is not in the receipt');
  assert.deepEqual(await repo.verifyReceipts(BOOK), { ok: true, receipts: 1, problems: [] });
});
