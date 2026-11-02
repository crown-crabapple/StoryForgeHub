// M05-J07 acceptance 1 (the scenario), 2 (hash chain, checked by an independent checker) and 3 (rebuild without .storyforge/), over HTTP against a real
// server process (own user config, network recorder, mock provider on 127.0.0.1).
//   GET  /api/books/:b/receipts?scene=<id>              -> { receipts, lineage, status }
//   GET  /api/books/:b/receipts/blame?scene=&from=&to=  -> per line { line, receiptId, actor, label }
//   POST /api/books/:b/receipts/flush { sceneId }       (Record now)
//   GET  /api/books/:b/receipts/verify                  -> { ok, receipts, problems }
// Expected values come from the contract (docs/contracts/M05-J07-receipts.md sections 1, 2, 4, 6, 8) and from files read here, not from the product's writer.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARRIVAL, ARRIVAL_PATH, AUTHOR_TAIL, HAND_19, MODEL, PROMPT, PROVIDER, RCPT, blameOracle, chainOf, checkChain, copyDir, linesOfBlame, objectBytes, opOf, readReceipts, receiptsOf, runScenario, sha, splitLines, stepText } from './receipts-helpers.mjs';
import { makeHome, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';
import { A, NEW, readBytes } from './suggest-helpers.mjs';

const SEQUENCE = ['baseline', 'author.edit', 'ai.proposal', 'suggestion.accept', 'suggestion.decline', 'author.edit'];

let mock;
let sc; // the scenario
let chain; // Arrival's receipts in chain order, read from disk
let api; // what the routes said while the app was running
let objectOf;

before(async () => {
  mock = await startMockProvider({ reply: 'unused' });
  sc = await runScenario({ mock });
  const all = await readReceipts(sc.library);
  chain = chainOf(all, ARRIVAL);
  const cache = new Map();
  for (const r of chain) for (const h of [r.fm.before_sha256, r.fm.after_sha256]) if (h) cache.set(h, await objectBytes(sc.library, h));
  objectOf = (h) => cache.get(h);
  api = {
    receipts: await sc.app.get(RCPT.receipts(ARRIVAL)),
    verify: await sc.app.get(RCPT.verify()),
    blame: {},
  };
  for (const n of [A.L1, A.L2, A.L3]) api.blame[n] = await sc.app.get(RCPT.blame(ARRIVAL, n, n));
  api.blameAll = await sc.app.get(RCPT.blame(ARRIVAL, 15, 19));
});
after(async () => {
  await mock.close();
  await stopAll();
});

describe('8.1 the scenario', () => {
  test('opening Arrival wrote a system baseline receipt: before empty, after = the file as first seen', async () => {
    const opened = receiptsOf(sc.log.openedReceipts.json);
    assert.equal(sc.log.openedReceipts.status, 200, sc.log.openedReceipts.text);
    assert.deepEqual(opened.map(opOf), ['baseline']);
    const first = chain[0].fm;
    assert.equal(first.schema, 'storyforge.receipt/v1');
    assert.match(first.id, /^rcpt_[0-9A-Z]{26}$/);
    assert.equal(first.operation, 'baseline');
    assert.equal(first.actor, 'system');
    assert.equal(first.target.id, ARRIVAL);
    assert.equal(first.target.path, ARRIVAL_PATH);
    assert.equal(first.before_sha256, '');
    assert.equal(first.after_sha256, sha(sc.log.original), 'the baseline names the bytes StoryForge first saw');
    assert.ok(!first.parents?.length, 'the first receipt of a scene has no parents');
    assert.match(chain[0].rel, /^provenance\/\d{4}\/\d{2}\/rcpt_[0-9A-Z]{26}\.md$/);
  });

  test('the receipts are, in order: baseline, author.edit, ai.proposal, suggestion.accept, suggestion.decline, author.edit', () => {
    assert.deepEqual(chain.map((r) => r.fm.operation), SEQUENCE);
    assert.deepEqual(chain.map((r) => r.fm.actor).slice(0, 2), ['system', 'author']);
    assert.equal(chain[2].fm.actor, 'ai');
    assert.equal(chain[5].fm.actor, 'author');
    assert.equal(chain.length, new Set(chain.map((r) => r.fm.id)).size);
    // the route agrees, in the same order
    assert.equal(api.receipts.status, 200, api.receipts.text);
    assert.deepEqual(receiptsOf(api.receipts.json).map(opOf), SEQUENCE);
  });

  test('each receipt names the right bytes: ai.proposal and decline wrote nothing, accept and author edits did', () => {
    const [base, edit1, proposal, accept, decline, edit2] = chain.map((r) => r.fm);
    assert.equal(edit1.before_sha256, base.after_sha256);
    assert.equal(edit1.after_sha256, sha(Buffer.concat([sc.log.original, Buffer.from(`\n\n${AUTHOR_TAIL}`)])), 'author edit = original plus the appended line');
    assert.notEqual(edit1.before_sha256, edit1.after_sha256);
    assert.equal(proposal.before_sha256, proposal.after_sha256, 'a proposal writes nothing');
    assert.equal(proposal.after_sha256, edit1.after_sha256);
    assert.equal(accept.before_sha256, proposal.after_sha256);
    assert.equal(accept.after_sha256, sha(sc.log.afterDecisions), 'accept = the scene after the accepted hunk');
    assert.notEqual(accept.before_sha256, accept.after_sha256);
    assert.equal(decline.before_sha256, decline.after_sha256, 'a decline writes nothing');
    assert.equal(decline.before_sha256, accept.after_sha256);
    assert.equal(edit2.before_sha256, decline.after_sha256);
    assert.equal(edit2.after_sha256, sha(sc.log.final), 'the last receipt names the scene as it is now');
  });

  test('the AI receipts carry the provider block, the hunk ids and the acceptance state', () => {
    const [, , proposal, accept, decline] = chain.map((r) => r.fm);
    const h = sc.hunkIds;
    assert.equal(proposal.ai.provider, PROVIDER);
    assert.equal(proposal.ai.model, MODEL);
    assert.equal(proposal.ai.locality, 'local');
    assert.equal(proposal.ai.prompt_sha256, sha(PROMPT), 'prompt_sha256 = sha256 of the instruction text');
    assert.match(String(proposal.ai.context_sha256), /^[0-9a-f]{64}$/);
    assert.match(String(proposal.ai.settings_sha256), /^[0-9a-f]{64}$/);
    assert.equal(proposal.ai.suggestion, sc.log.suggestion.fm.id);
    assert.deepEqual(proposal.ai.hunks, h);
    assert.equal(proposal.ai.acceptance, 'proposed');
    assert.deepEqual(accept.ai.hunks, [h[0]]);
    assert.equal(accept.ai.suggestion, proposal.ai.suggestion);
    assert.ok(['accepted', 'partial'].includes(accept.ai.acceptance), accept.ai.acceptance);
    assert.deepEqual(decline.ai.hunks, [h[1]]);
    assert.equal(decline.ai.suggestion, proposal.ai.suggestion);
    assert.equal(decline.ai.acceptance, 'partial', 'one accepted and one declined on the same suggestion = partial');
    assert.deepEqual(accept.ranges.map((x) => x.after), [[A.L1, A.L1]]);
    assert.deepEqual(accept.ranges.map((x) => x.before), [[A.L1, A.L1]]);
  });

  test('the Inspector lineage reads in the contract order', () => {
    const lineage = api.receipts.json.lineage;
    assert.ok(Array.isArray(lineage), 'lineage is an array of steps');
    const steps = lineage.map(stepText);
    const expected = [/baseline|wrote/i, /author edited/i, /AI suggested 3 changes/i, /accepted lines 15/i, /declined 1 change/i, /revised lines 19/i];
    let at = -1;
    for (const re of expected) {
      const i = steps.findIndex((s, k) => k > at && re.test(s));
      assert.ok(i > at, `step ${re} missing or out of order in:\n${steps.join('\n')}`);
      at = i;
    }
    assert.ok(steps.some((s) => s.includes(MODEL) && /local/i.test(s)), 'the AI step names model and locality');
    assert.ok(api.receipts.json.status !== undefined && api.receipts.json.status !== null, 'the integrity status for the badge is part of the answer');
  });

  test('"Where did this come from?": accepted line -> Author text edited with AI', () => {
    const r = api.blame[A.L1];
    assert.equal(r.status, 200, r.text);
    const [one] = linesOfBlame(r.json);
    assert.equal(linesOfBlame(r.json).length, 1);
    assert.equal(one.line, A.L1);
    assert.match(one.label, /author text edited with ai/i);
    assert.equal(one.receiptId, chain[3].fm.id, 'introduced by the suggestion.accept receipt');
  });

  test('"Where did this come from?": declined line -> Author-written, still the first-seen text', () => {
    const [one] = linesOfBlame(api.blame[A.L2].json);
    assert.equal(one.line, A.L2);
    assert.match(one.label, /author-written/i);
    assert.doesNotMatch(one.label, /ai/i);
    assert.equal(one.receiptId, chain[0].fm.id, 'last introduced by the baseline');
  });

  test('"Where did this come from?": hand-revised line -> Author-written, introduced by the author edit after the AI proposal', () => {
    const [one] = linesOfBlame(api.blame[A.L3].json);
    assert.equal(one.line, A.L3);
    assert.match(one.label, /author-written/i);
    assert.equal(one.actor, 'author');
    assert.equal(one.receiptId, chain[5].fm.id);
    // the proposal that suggested a different line 19 is still in the history, before that edit
    assert.ok(chain.findIndex((r) => r.fm.operation === 'ai.proposal') < 5);
    assert.ok(chain[2].body.includes(NEW[19]), 'the proposal receipt keeps the proposed text');
  });

  test('a range query returns one answer per line and agrees with an independent replay of the chain', () => {
    const rows = linesOfBlame(api.blameAll.json);
    assert.deepEqual(rows.map((r) => r.line), [15, 16, 17, 18, 19]);
    const oracle = blameOracle(chain, objectOf);
    for (const r of rows) assert.equal(r.receiptId, oracle.owners[r.line - 1].fm.id, `line ${r.line}`);
    assert.deepEqual(oracle.lines, splitLines(sc.log.final), 'the replay ends at the file on disk');
    assert.equal(oracle.lines[A.L1 - 1], NEW[15]);
    assert.equal(oracle.lines[A.L2 - 1], splitLines(sc.log.original)[A.L2 - 1]);
    assert.equal(oracle.lines[A.L3 - 1], HAND_19);
  });

  test('the scene on disk is exactly: hunk 1 accepted, hunk 2 declined, line 19 the author\'s own, the appended line kept', async () => {
    const lines = splitLines(await readBytes(sc.library, ARRIVAL_PATH));
    assert.equal(lines[A.L1 - 1], NEW[15]);
    assert.equal(lines[A.L2 - 1], splitLines(sc.log.original)[A.L2 - 1]);
    assert.equal(lines[A.L3 - 1], HAND_19);
    assert.equal(lines.at(-1), AUTHOR_TAIL);
  });
});

describe('8.2 hash chain (independent checker)', () => {
  test('every parent resolves and hash-matches, every object exists and hashes to its name, every diff replays before -> after', async () => {
    assert.deepEqual(await checkChain(sc.library, { [ARRIVAL]: sc.log.final }), []);
    // and spelled out, so a bug in the checker cannot hide a bug in the product
    const all = await readReceipts(sc.library);
    const byId = new Map(all.map((r) => [r.fm.id, r]));
    for (const r of chain) {
      for (const p of r.fm.parents ?? []) {
        assert.ok(byId.has(p.id), `${r.fm.id}: parent ${p.id} has a file`);
        assert.equal(byId.get(p.id).sha, p.sha256, `${r.fm.id}: parent ${p.id} hash`);
      }
    }
    for (let i = 1; i < chain.length; i++) {
      assert.equal(chain[i].fm.parents[0].id, chain[i - 1].fm.id, 'first parent = previous receipt of the scene');
      assert.equal(chain[i].fm.before_sha256, chain[i - 1].fm.after_sha256);
    }
    for (const r of chain) for (const h of new Set([r.fm.before_sha256, r.fm.after_sha256].filter(Boolean))) {
      const o = await objectBytes(sc.library, h);
      assert.ok(o, `object ${h.slice(0, 8)} exists under provenance/objects/${h.slice(0, 2)}/`);
      assert.equal(sha(o), h);
    }
  });

  test('suggestion.accept and suggestion.decline also list the ai.proposal receipt as a parent', () => {
    const proposal = chain[2].fm.id;
    for (const i of [3, 4]) {
      const ids = chain[i].fm.parents.map((p) => p.id);
      assert.equal(ids[0], chain[i - 1].fm.id);
      assert.ok(ids.includes(proposal), `${chain[i].fm.operation} lists ${proposal}`);
    }
  });

  test('the accept diff is the exact line diff of the accepted hunk, and the author edits replay by themselves', () => {
    assert.match(chain[3].body, /```diff\r?\n@@ -15,1 \+15,1 @@/);
    assert.ok(chain[3].body.includes(`+${NEW[15]}`));
    assert.ok(chain[3].body.includes(`-${splitLines(sc.log.original)[14]}`));
    assert.ok(chain[3].body.trim().length > 0 && /accepted/i.test(chain[3].body.split('```')[0]), 'plain-language summary line comes first');
    assert.ok(chain[5].body.includes(`+${HAND_19}`));
  });

  test('verifyReceipts (route) says ok and counts the receipts', () => {
    assert.equal(api.verify.status, 200, api.verify.text);
    assert.equal(api.verify.json.ok, true);
    assert.deepEqual(api.verify.json.problems, []);
    assert.equal(api.verify.json.receipts, chain.length);
  });

  test('the CLI `receipts verify` agrees (exit 0, the book is named ok)', async () => {
    const { runCli } = await import('./proc-helpers.mjs');
    const r = await runCli(['receipts', 'verify', '--library', sc.library, '--book', 'salt-orchard']);
    assert.equal(r.code, 0, r.output);
    assert.doesNotMatch(r.output, /RCPT_/);
  });
});

describe('8.3 rebuild: .storyforge/ deleted entirely, restart', () => {
  test('the receipts still verify and the lineage and blame are identical (all from provenance/)', async () => {
    await sc.app.stop();
    const library = await copyDir(sc.library);
    await fs.rm(path.join(library, '.storyforge'), { recursive: true, force: true });
    await assert.rejects(fs.stat(path.join(library, '.storyforge')), 'precondition: .storyforge is gone');
    const provBefore = (await readReceipts(library)).map((r) => [r.rel, r.sha]);

    const app = await startApp({ library, home: await makeHome(), net: true });
    const rec = await app.get(RCPT.receipts(ARRIVAL));
    assert.equal(rec.status, 200, rec.text);
    assert.deepEqual(receiptsOf(rec.json).map(opOf), SEQUENCE);
    assert.deepEqual(receiptsOf(rec.json).map((r) => r.id ?? r.fm?.id), chain.map((r) => r.fm.id));
    assert.deepEqual(rec.json.lineage.map(stepText), api.receipts.json.lineage.map(stepText));
    for (const n of [A.L1, A.L2, A.L3]) {
      const again = linesOfBlame((await app.get(RCPT.blame(ARRIVAL, n, n))).json);
      assert.deepEqual(again, linesOfBlame(api.blame[n].json), `blame of line ${n}`);
    }
    const v = await app.get(RCPT.verify());
    assert.equal(v.json.ok, true, v.text);
    assert.deepEqual(v.json.problems, []);
    assert.deepEqual((await readReceipts(library)).map((r) => [r.rel, r.sha]), provBefore, 'restart wrote nothing new into provenance/');
    assert.deepEqual(await checkChain(library, { [ARRIVAL]: await readBytes(library, ARRIVAL_PATH) }), []);
    await app.stop();
  });
});
