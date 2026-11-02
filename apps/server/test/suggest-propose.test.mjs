// M05-J06 acceptance 6 (last clause) and section 4: `sf-claude-book propose-state` writes suggestion documents; accepting them through the app creates / changes the
// files through the store and the book validates with the same diagnostics as before. Declining a new-file suggestion leaves nothing.
// The adapter runs as a real process BEFORE the app starts (so the app opens a book that already holds the suggestions); the accept calls are the section 1.2 routes.
// Contract: docs/contracts/M05-J06-author-check-suggest.md sections 3, 4 and 6.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../../../packages/format/src/index.mjs';
import { BIN, makeFramework } from '../../../packages/claude-book/test/helpers.mjs';
import { LEDGERS } from '../../../packages/claude-book/test/author-helpers.mjs';
import { closeAll, freshBook, send } from './move-helpers.mjs';
import { SUG, changedContent, fmOf, readText, tree } from './suggest-helpers.mjs';

after(closeAll);

const BRASS_KEY = 'planning/threads/brass-key.md';
const EVENT = 'planning/timeline/chapter-01-state.md';

/** prep(root): run the adapter's propose-state on the book copy. */
const propose = (data = LEDGERS) => async (root) => {
  const from = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-led-')), 'chapter-01-ledgers.json');
  fs.writeFileSync(from, JSON.stringify(data));
  const r = spawnSync(process.execPath, [BIN, 'propose-state', '--book', root, '--framework', makeFramework(), '--chapter', '1', '--from', from], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
};
async function listed(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.push({ rel, fm: fmOf(fs.readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(path.join(root, 'suggestions'));
  return out;
}
const decideAll = (port, id, decision) => send(port, 'POST', SUG.decide(id), { body: { decision } });

test('accept every proposed-state suggestion: the files appear / change through the app and validate() reports what it reported before', async () => {
  let baseline;
  const { root, port } = await freshBook('valid/salt-orchard', async (r) => {
    baseline = (await validate(r)).diagnostics;
    await propose()(r);
  });
  const sugs = await listed(root);
  assert.ok(sugs.length >= 4);
  const brassBefore = fs.readFileSync(path.join(root, BRASS_KEY), 'utf8');

  for (const s of sugs) {
    const r = await decideAll(port, s.fm.id, 'accept');
    assert.equal(r.status, 200, `${s.fm.target_path}: ${r.text}`);
  }
  // new files exist, with the proposed shape
  assert.ok(fs.existsSync(path.join(root, EVENT)));
  const ev = fmOf(await readText(root, EVENT));
  assert.equal(ev.schema, 'storyforge.event/v1');
  assert.ok(ev.order > 300);
  assert.ok(Array.isArray(ev.state) && ev.state.some((i) => i.slug === 'maren-hollis' && i.event === 'location' && i.value === 'port-aldine'));
  const seed = sugs.find((s) => s.fm.mode === 'canon');
  const seedFm = fmOf(await readText(root, seed.fm.target_path));
  assert.equal(seedFm.status, 'seed');
  assert.notEqual(seedFm.status, 'canon');
  const plant = sugs.find((s) => /^planning\/threads\//.test(s.fm.target_path) && s.fm.target === '');
  assert.equal(fmOf(await readText(root, plant.fm.target_path)).status, 'planted');
  // the existing thread changed, and only in the proposed way
  const brass = await readText(root, BRASS_KEY);
  assert.notEqual(brass, brassBefore);
  assert.ok(fmOf(brass).payoff.includes('scene_01S50000000000000000000002'));
  assert.equal(fmOf(brass).status, 'paid');
  // every suggestion is now accepted
  for (const s of await listed(root)) assert.equal(s.fm.status, 'accepted', s.rel);
  // the whole book validates as before
  assert.deepEqual((await validate(root)).diagnostics, baseline);
});

test('decline every proposed-state suggestion: no new canonical file exists, existing files are unchanged, only the suggestions change', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', propose());
  const sugs = await listed(root);
  const before = await tree(root);
  for (const s of sugs) assert.equal((await decideAll(port, s.fm.id, 'decline')).status, 200);
  const after = await tree(root);
  assert.deepEqual(changedContent(before, after), sugs.map((s) => s.rel).sort());
  assert.ok(!fs.existsSync(path.join(root, EVENT)));
  for (const s of sugs.filter((x) => x.fm.target === '')) assert.ok(!fs.existsSync(path.join(root, s.fm.target_path)), `${s.fm.target_path} was not created`);
  for (const s of await listed(root)) assert.equal(s.fm.status, 'declined');
});

test('accepting a new-file suggestion twice never rewrites the created file (no server error, file byte-identical)', async () => {
  const { root, port } = await freshBook('valid/salt-orchard', propose());
  const seed = (await listed(root)).find((s) => s.fm.mode === 'canon');
  assert.equal((await decideAll(port, seed.fm.id, 'accept')).status, 200);
  const bytes = fs.readFileSync(path.join(root, seed.fm.target_path));
  const again = await decideAll(port, seed.fm.id, 'accept');
  assert.ok(again.status < 500, `status ${again.status}`);
  assert.ok(fs.readFileSync(path.join(root, seed.fm.target_path)).equals(bytes));
});
