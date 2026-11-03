// M07-J03a: the audit chain and the settings file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SharedDataError, createAudit, openSettings } from '../src/index.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-audit-'));

test('audit: lines chain by the hash of the previous line, and a changed line breaks the chain at that line', async () => {
  const dir = tmp();
  const audit = createAudit(dir, { now: () => 1_800_000_000_000 });
  assert.deepEqual(await audit.verify(), { ok: true, lines: 0 });
  await Promise.all([1, 2, 3, 4, 5].map((n) => audit.append({ actor: 'usr_X', event: 'write.body', target: `scene_${n}`, result: 200 })));
  assert.deepEqual(await audit.verify(), { ok: true, lines: 5 });
  const file = path.join(dir, 'audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(JSON.parse(lines[0]).prev, '0'.repeat(64));
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), ['seq', 'at', 'actor', 'event', 'target', 'result', 'prev']);
  lines[2] = lines[2].replace('"result":200', '"result":201');
  fs.writeFileSync(file, lines.join('\n'));
  const r = await createAudit(dir).verify();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AUDIT_CHAIN_BROKEN');
  assert.equal(r.line, 3);
});

test('audit: a partial last line is reported as truncated, and the next event starts on a fresh line', async () => {
  const dir = tmp();
  const audit = createAudit(dir);
  await audit.append({ actor: 'system', event: 'a' });
  await audit.append({ actor: 'system', event: 'b' });
  const file = path.join(dir, 'audit.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.slice(0, -10));
  const r = await createAudit(dir).verify();
  assert.equal(r.code, 'AUDIT_TAIL_TRUNCATED');
  const again = createAudit(dir);
  await again.append({ actor: 'system', event: 'c' });
  const v = await again.verify();
  assert.equal(v.ok, false);
  assert.equal(v.line, 2, 'the damaged line is named');
});

test('settings: default off, validated, persisted; a damaged file stops shared mode', async () => {
  const dir = tmp();
  const s = await openSettings(dir);
  assert.equal(s.get().ai_for_members, false);
  assert.equal((await s.set({ ai_for_members: 'yes' })).ok, false);
  assert.equal((await s.set({ other: 1 })).ok, false);
  assert.equal((await s.set({ ai_for_members: true })).ok, true);
  assert.equal((await openSettings(dir)).get().ai_for_members, true);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{nope');
  await assert.rejects(openSettings(dir), SharedDataError);
});
