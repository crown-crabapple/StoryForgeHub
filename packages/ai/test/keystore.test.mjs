// M08-J03 security core: the key store. DPAPI round trip on Windows, the AES-GCM file backend everywhere; no secret in files, arguments or errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeystore, KeystoreError } from '../src/keystore.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-keys-'));
const SECRET = `sk-test-${Math.random().toString(36).slice(2)}-Ünïcode-"quote'-$dollar`;
const allText = (dir) => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

test('file-key backend: round trip, ciphertext only on disk, survives a restart, a replaced key file cannot unlock', async () => {
  const dir = tmp();
  const env = { STORYFORGE_SECRETS_BACKEND: 'file-key' };
  const ks = createKeystore({ dir, env });
  assert.equal(await ks.backend(), 'file-key');
  assert.equal(await ks.get('ai.profile1'), null);
  await ks.set('ai.profile1', SECRET);
  assert.equal(await ks.get('ai.profile1'), SECRET);
  assert.equal(allText(dir).includes(SECRET), false, 'never in clear on disk');
  assert.equal(await createKeystore({ dir, env }).get('ai.profile1'), SECRET, 'a new process reads it back');
  fs.writeFileSync(path.join(dir, 'secrets-key.json'), JSON.stringify({ version: 1, key: Buffer.alloc(32, 7).toString('base64') }));
  const err = await createKeystore({ dir, env }).get('ai.profile1').catch((e) => e);
  assert.ok(err instanceof KeystoreError);
  assert.equal(err.code, 'LOCKED');
  assert.equal(String(err.message).includes(SECRET), false);
});

test('file-key backend with STORYFORGE_SECRETS_KEY: no key file written; the wrong key cannot unlock; ids and remove', async () => {
  const dir = tmp();
  const key = Buffer.alloc(32, 3).toString('base64');
  const ks = createKeystore({ dir, env: { STORYFORGE_SECRETS_BACKEND: 'file-key', STORYFORGE_SECRETS_KEY: key } });
  await ks.set('webhook.w1', SECRET);
  assert.equal(fs.existsSync(path.join(dir, 'secrets-key.json')), false);
  assert.deepEqual(await ks.ids(), ['webhook.w1']);
  const wrong = createKeystore({ dir, env: { STORYFORGE_SECRETS_BACKEND: 'file-key', STORYFORGE_SECRETS_KEY: Buffer.alloc(32, 4).toString('base64') } });
  assert.equal((await wrong.get('webhook.w1').catch((e) => e)).code, 'LOCKED');
  await ks.remove('webhook.w1');
  assert.deepEqual(await ks.ids(), []);
  assert.equal(await ks.get('webhook.w1'), null);
});

test('a secret never reaches a child process through its arguments or environment', async () => {
  const calls = [];
  const run = async (cmd, args, input, env) => {
    calls.push({ cmd, args, env });
    return { code: 0, stdout: Buffer.from('cipher').toString('base64') };
  };
  const ks = createKeystore({ dir: tmp(), env: { STORYFORGE_SECRETS_BACKEND: 'dpapi', STORYFORGE_SECRETS_KEY: 'x' }, run });
  await ks.set('ai.p', SECRET);
  for (const c of calls) {
    assert.equal(JSON.stringify(c.args).includes(SECRET), false);
    assert.equal(JSON.stringify(c.args).includes(Buffer.from(SECRET).toString('base64')), false);
  }
});

test('bad ids and empty secrets are refused; a damaged secrets.json is LOCKED, not reset', async () => {
  const dir = tmp();
  const ks = createKeystore({ dir, env: { STORYFORGE_SECRETS_BACKEND: 'file-key' } });
  await assert.rejects(ks.set('../x', 'k'), /bad secret id/);
  await assert.rejects(ks.set('ok', ''), /1 to 8192/);
  fs.writeFileSync(path.join(dir, 'secrets.json'), '{oops');
  assert.equal((await ks.get('ok').catch((e) => e)).code, 'LOCKED');
  assert.equal(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'), '{oops');
});

test('DPAPI round trip (Windows only): ciphertext on disk, readable by a new process, never in clear', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = tmp();
  const ks = createKeystore({ dir, env: process.env });
  assert.equal(await ks.backend(), 'dpapi');
  await ks.set('ai.profile1', SECRET);
  assert.equal(allText(dir).includes(SECRET), false);
  assert.equal(await createKeystore({ dir, env: process.env }).get('ai.profile1'), SECRET);
  const f = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
  f.entries['ai.profile1'].data = Buffer.from('not dpapi').toString('base64');
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify(f));
  assert.equal((await createKeystore({ dir, env: process.env }).get('ai.profile1').catch((e) => e)).code, 'LOCKED');
});
