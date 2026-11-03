// M08-J03 acceptance 4 (backends): dpapi round trip on this machine (Windows), file-key everywhere, the macOS keychain and the Linux Secret Service only where their tool
// exists (skipped with a message otherwise), and a wrong key or a wrong user is a clear "cannot unlock stored keys" error: never a crash and never a silent empty key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeystore, KeystoreError } from '../src/keystore.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-backends-'));
const SECRET = `sk-test-${Math.random().toString(36).slice(2)}-Ünï "quote" $dollar`;
const has = (cmd, args) => {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
};

/** The same round trip for any backend: set, get (also from a new process), replace, remove, and the ciphertext file never holds the secret. */
async function roundTrip(env) {
  const dir = tmp();
  const ks = createKeystore({ dir, env });
  await ks.set('ai.prof_one', SECRET);
  assert.equal(await ks.get('ai.prof_one'), SECRET);
  assert.equal(await createKeystore({ dir, env }).get('ai.prof_one'), SECRET, 'a new process reads it back');
  for (const f of fs.readdirSync(dir)) assert.equal(fs.readFileSync(path.join(dir, f), 'utf8').includes(SECRET), false, `${f} holds no clear secret`);
  await ks.set('ai.prof_one', `${SECRET}-2`);
  assert.equal(await createKeystore({ dir, env }).get('ai.prof_one'), `${SECRET}-2`);
  await ks.remove('ai.prof_one');
  assert.equal(await createKeystore({ dir, env }).get('ai.prof_one'), null);
}

test('file-key backend: round trip on every platform', async () => {
  await roundTrip({ STORYFORGE_SECRETS_BACKEND: 'file-key' });
});

test('dpapi backend: round trip on this machine', { skip: process.platform !== 'win32' && 'Windows only: DPAPI is not available on this platform' }, async () => {
  await roundTrip({ STORYFORGE_SECRETS_BACKEND: 'dpapi' });
});

test('dpapi backend: ciphertext that this Windows user cannot unprotect is a LOCKED error, not an empty key or a crash', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = tmp();
  const env = { STORYFORGE_SECRETS_BACKEND: 'dpapi' };
  await createKeystore({ dir, env }).set('ai.prof_one', SECRET);
  // another user or computer: the stored blob does not decrypt for us (simulated by damaging it)
  const file = path.join(dir, 'secrets.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const blob = Buffer.from(doc.entries['ai.prof_one'].data, 'base64');
  blob[blob.length - 5] ^= 0xff;
  doc.entries['ai.prof_one'].data = blob.toString('base64');
  fs.writeFileSync(file, JSON.stringify(doc));
  const err = await createKeystore({ dir, env }).get('ai.prof_one').catch((e) => e);
  assert.ok(err instanceof KeystoreError, String(err));
  assert.equal(err.code, 'LOCKED');
  assert.match(err.message, /cannot unlock stored keys/);
  assert.equal(err.message.includes(SECRET), false);
});

test('a wrong STORYFORGE_SECRETS_KEY is a LOCKED error naming the problem; a malformed one too', async () => {
  const dir = tmp();
  const right = Buffer.alloc(32, 1).toString('base64');
  await createKeystore({ dir, env: { STORYFORGE_SECRETS_BACKEND: 'file-key', STORYFORGE_SECRETS_KEY: right } }).set('webhook.whk-x', SECRET);
  for (const key of [Buffer.alloc(32, 2).toString('base64'), 'not-32-bytes']) {
    const err = await createKeystore({ dir, env: { STORYFORGE_SECRETS_BACKEND: 'file-key', STORYFORGE_SECRETS_KEY: key } }).get('webhook.whk-x').catch((e) => e);
    assert.equal(err.code, 'LOCKED');
    assert.match(err.message, /cannot unlock stored keys/);
  }
  // and nothing was reset: the right key still reads it
  assert.equal(await createKeystore({ dir, env: { STORYFORGE_SECRETS_BACKEND: 'file-key', STORYFORGE_SECRETS_KEY: right } }).get('webhook.whk-x'), SECRET);
});

const mac = process.platform === 'darwin' && has('security', ['list-keychains']);
test('macOS keychain backend: round trip', { skip: !mac && 'macOS keychain not available here (needs macOS with the `security` tool)' }, async () => {
  await roundTrip({ STORYFORGE_SECRETS_BACKEND: 'macos-keychain' });
});

const linux = process.platform === 'linux' && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS) && has('secret-tool', ['--version']);
test('Linux Secret Service backend: round trip', { skip: !linux && 'Secret Service not available here (needs Linux with secret-tool and a D-Bus session)' }, async () => {
  await roundTrip({ STORYFORGE_SECRETS_BACKEND: 'secret-service' });
});

test('the default backend is chosen in the documented order: dpapi on Windows, else a native store when its tool exists, else the encrypted file', async () => {
  const picked = await createKeystore({ dir: tmp(), env: {} }).backend();
  if (process.platform === 'win32') assert.equal(picked, 'dpapi');
  else if (process.platform === 'darwin' && mac) assert.equal(picked, 'macos-keychain');
  else if (linux) assert.equal(picked, 'secret-service');
  else assert.equal(picked, 'file-key');
  assert.equal(await createKeystore({ dir: tmp(), env: { STORYFORGE_SECRETS_BACKEND: 'file-key' }, platform: 'win32' }).backend(), 'file-key', 'the operator can force the file backend (containers)');
});
