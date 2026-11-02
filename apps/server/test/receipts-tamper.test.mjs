// M05-J07 acceptance 4: tamper cases. Integrity is reported, never repaired: the exact problem codes come back and every byte under provenance/, the scene and
// the suggestion stays as the tamperer left it. Every case runs on its own copy of the finished 8.1 scenario book.
//   GET /api/books/:b/receipts/verify -> { ok, receipts, problems: [{ code, file, receipt?, detail }] }
// Contract: docs/contracts/M05-J07-receipts.md sections 6 and 8.4. The independent checker in receipts-helpers.mjs must name the same codes.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ARRIVAL, ARRIVAL_PATH, RCPT, bytesUnder, chainOf, checkChain, codesOf, copyDir, opOf, readReceipts, receiptsOf, runScenario, sha } from './receipts-helpers.mjs';
import { makeHome, startApp, startMockProvider, stopAll } from './ai-helpers.mjs';
import { BOOK, closeAll, send, startApi } from './move-helpers.mjs';
import { request } from './helpers.mjs';
import { readBytes } from './suggest-helpers.mjs';

let mock;
let master; // the finished scenario book (app stopped)
let chain;

before(async () => {
  mock = await startMockProvider({ reply: 'unused' });
  const sc = await runScenario({ mock });
  await sc.app.stop();
  master = sc.library;
  chain = chainOf(await readReceipts(master), ARRIVAL);
});
after(async () => {
  await mock.close();
  await stopAll();
  await closeAll();
});

const WATCHED = ['provenance', 'suggestions', 'manuscript'];
async function verifyOn(library) {
  const app = await startApp({ library, home: await makeHome(), net: true });
  try {
    const v = await app.get(RCPT.verify());
    assert.equal(v.status, 200, v.text);
    const rec = await app.get(RCPT.receipts(ARRIVAL));
    return { verify: v.json, receipts: rec };
  } finally {
    await app.stop();
  }
}

describe('8.4 tamper', () => {
  test('control: the untouched copy verifies ok (so the cases below test the tamper, not the setup)', async () => {
    const library = await copyDir(master);
    const { verify } = await verifyOn(library);
    assert.equal(verify.ok, true);
    assert.deepEqual(verify.problems, []);
  });

  test('editing one byte of a receipt -> RCPT_PARENT_ALTERED on its child, and nothing else; nothing is repaired', async () => {
    const library = await copyDir(master);
    const target = chain[0]; // the baseline; only the next author.edit names it as a parent
    const file = path.join(library, ...target.rel.split('/'));
    const bytes = Buffer.from(await fs.readFile(file));
    const text = bytes.toString('utf8');
    const fmEnd = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)[0].length;
    const i = Buffer.byteLength(text.slice(0, fmEnd + text.slice(fmEnd).search(/[A-Za-z]/)));
    bytes[i] = bytes[i] === 0x58 ? 0x59 : 0x58; // one byte of the plain-language summary line
    await fs.writeFile(file, bytes);
    const frozen = await bytesUnder(library, WATCHED);

    const { verify, receipts } = await verifyOn(library);
    assert.equal(verify.ok, false);
    assert.deepEqual(codesOf(verify.problems), ['RCPT_PARENT_ALTERED']);
    assert.deepEqual(verify.problems.map((p) => p.receipt), [chain[1].fm.id], 'reported on the child, which holds the old hash');
    assert.ok(verify.problems.every((p) => typeof p.file === 'string' && typeof p.detail === 'string'));
    assert.deepEqual(codesOf(await checkChain(library)), ['RCPT_PARENT_ALTERED'], 'the independent checker agrees');
    assert.equal(receipts.status, 200, 'the lineage is still served; the author sees the problem list, not a wall');
    assert.deepEqual(receiptsOf(receipts.json).map(opOf), chain.map((r) => r.fm.operation));
    assert.deepEqual(await bytesUnder(library, WATCHED), frozen, 'nothing was rewritten, renumbered or repaired');
  });

  test('deleting an object -> RCPT_OBJECT_MISSING (only); nothing is repaired', async () => {
    const library = await copyDir(master);
    const last = chain[5].fm.after_sha256; // the scene as it is now: named by the last receipt only
    assert.equal(chain.filter((r) => [r.fm.before_sha256, r.fm.after_sha256].includes(last)).length, 1);
    await fs.rm(path.join(library, 'provenance', 'objects', last.slice(0, 2), last));
    const frozen = await bytesUnder(library, WATCHED);

    const { verify } = await verifyOn(library);
    assert.equal(verify.ok, false);
    assert.deepEqual(codesOf(verify.problems), ['RCPT_OBJECT_MISSING']);
    assert.ok(verify.problems.some((p) => p.receipt === chain[5].fm.id));
    assert.deepEqual(codesOf(await checkChain(library)), ['RCPT_OBJECT_MISSING']);
    assert.deepEqual(await bytesUnder(library, WATCHED), frozen, 'the object was not recreated');
    await assert.rejects(fs.stat(path.join(library, 'provenance', 'objects', last.slice(0, 2), last)));
  });

  test('an object whose bytes changed -> RCPT_OBJECT_ALTERED', async () => {
    const library = await copyDir(master);
    const h = chain[5].fm.after_sha256;
    const f = path.join(library, 'provenance', 'objects', h.slice(0, 2), h);
    await fs.appendFile(f, 'x');
    const { verify } = await verifyOn(library);
    assert.ok(codesOf(verify.problems).includes('RCPT_OBJECT_ALTERED'), JSON.stringify(verify.problems));
    assert.ok(!codesOf(verify.problems).includes('RCPT_OBJECT_MISSING'));
    assert.ok(codesOf(await checkChain(library)).includes('RCPT_OBJECT_ALTERED'));
  });

  test('a receipt file removed -> RCPT_PARENT_MISSING on the receipts that named it', async () => {
    const library = await copyDir(master);
    await fs.rm(path.join(library, ...chain[1].rel.split('/')));
    const { verify } = await verifyOn(library);
    assert.equal(verify.ok, false);
    assert.ok(codesOf(verify.problems).includes('RCPT_PARENT_MISSING'), JSON.stringify(verify.problems));
    assert.ok(verify.problems.some((p) => p.code === 'RCPT_PARENT_MISSING' && p.receipt === chain[2].fm.id));
    assert.ok(codesOf(await checkChain(library)).includes('RCPT_PARENT_MISSING'));
  });

  test('a diff that no longer produces `after` -> RCPT_DIFF_MISMATCH (receipt re-hashed into the child so only the diff is wrong)', async () => {
    const library = await copyDir(master);
    // change the receipt that has no child (the last), so no parent hash breaks
    const last = chain[5];
    const f = path.join(library, ...last.rel.split('/'));
    const text = await fs.readFile(f, 'utf8');
    const edited = text.replace(/^\+(.*)$/m, (_, s) => `+${s} (tampered)`);
    assert.notEqual(edited, text, 'the receipt has a + line to tamper with');
    await fs.writeFile(f, edited);
    const { verify } = await verifyOn(library);
    assert.deepEqual(codesOf(verify.problems), ['RCPT_DIFF_MISMATCH']);
    assert.deepEqual(codesOf(await checkChain(library)), ['RCPT_DIFF_MISMATCH']);
  });

  test('front matter that fails the schema -> RCPT_MALFORMED', async () => {
    const library = await copyDir(master);
    const last = chain[5];
    const f = path.join(library, ...last.rel.split('/'));
    const text = await fs.readFile(f, 'utf8');
    await fs.writeFile(f, text.replace(/^operation: .*$/m, 'operation: [not, a, string]').replace(/^actor: .*$/m, 'actor: nobody'));
    const { verify } = await verifyOn(library);
    assert.ok(codesOf(verify.problems).includes('RCPT_MALFORMED'), JSON.stringify(verify.problems));
  });

  test('a scene edited outside StoryForge while it was stopped -> RCPT_UNRECORDED (info) and no receipt is written by looking', async () => {
    const library = await copyDir(master);
    const file = path.join(library, ...ARRIVAL_PATH.split('/'));
    const edited = (await fs.readFile(file, 'utf8')).replace('ticket hut', 'ticket kiosk');
    await fs.writeFile(file, edited);
    const frozen = await bytesUnder(library, ['provenance', 'suggestions']);

    const { verify, receipts } = await verifyOn(library);
    assert.deepEqual(codesOf(verify.problems), ['RCPT_UNRECORDED']);
    assert.equal(verify.problems[0].receipt, chain[5].fm.id, 'names the last receipt the scene no longer matches');
    assert.deepEqual(codesOf(await checkChain(library, { [ARRIVAL]: Buffer.from(edited) })), ['RCPT_UNRECORDED']);
    assert.deepEqual(receiptsOf(receipts.json).map(opOf), chain.map((r) => r.fm.operation), 'viewing is not recording');
    assert.deepEqual(await bytesUnder(library, ['provenance', 'suggestions']), frozen);
    assert.equal((await fs.readFile(file, 'utf8')), edited, 'the scene is left exactly as the outside editor wrote it');
  });

  test('after restart with the watcher the outside edit becomes an external.change receipt on the next flush, and the chain verifies', async () => {
    const library = await copyDir(master);
    const file = path.join(library, ...ARRIVAL_PATH.split('/'));
    const marker = 'zzquillfeather';
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('ticket hut', `ticket ${marker} hut`));
    const frozen = await bytesUnder(library, ['provenance']);

    const { port } = await startApi(library); // in-process: the repository's watcher is on
    for (let i = 0; i < 200; i++) {
      const hit = await request(port, 'GET', `/api/search?q=${marker}&book=${BOOK}`);
      if (hit.status === 200 && JSON.stringify(hit.json).includes(ARRIVAL)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const flush = await send(port, 'POST', RCPT.flush(), { body: { sceneId: ARRIVAL } });
    assert.ok(flush.status < 300, flush.text);

    const now = chainOf(await readReceipts(library), ARRIVAL);
    assert.equal(now.length, chain.length + 1, 'exactly one new receipt');
    const ext = now.at(-1).fm;
    assert.equal(ext.operation, 'external.change');
    assert.equal(ext.actor, 'external');
    assert.equal(ext.before_sha256, chain[5].fm.after_sha256);
    assert.equal(ext.after_sha256, sha(await readBytes(library, ARRIVAL_PATH)));
    assert.equal(ext.parents[0].id, chain[5].fm.id);
    assert.ok(now.at(-1).body.includes(marker), 'the diff shows the outside change');
    assert.deepEqual(codesOf(await checkChain(library, { [ARRIVAL]: await readBytes(library, ARRIVAL_PATH) })), []);
    const after = await bytesUnder(library, ['provenance']);
    for (const [k, v] of Object.entries(frozen)) assert.equal(after[k], v, `${k} untouched`);
    const v = await request(port, 'GET', RCPT.verify());
    assert.equal(v.json.ok, true, v.text);
    assert.deepEqual(v.json.problems, []);
  });
});
