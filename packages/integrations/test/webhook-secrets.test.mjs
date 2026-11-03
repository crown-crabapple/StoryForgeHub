// M08-J03: with a key store the webhook signing secret is never in webhooks.json; plain secrets of an earlier version move on open; a locked store sends nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDispatcher, openWebhooks } from '../src/index.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sf-hooksec-'));
const URL_OK = 'http://127.0.0.1:9/hook';
/** An in-memory stand-in for the key store (the real one is tested in packages/ai). */
const memoryKeystore = () => {
  const m = new Map();
  return { m, set: async (id, v) => void m.set(id, v), get: async (id) => m.get(id) ?? null, remove: async (id) => void m.delete(id) };
};

test('create with a key store: the secret is returned once and kept only in the store', async () => {
  const dir = await tmp();
  const ks = memoryKeystore();
  const hooks = await openWebhooks(dir, { keystore: ks });
  const r = await hooks.create({ url: URL_OK, events: ['scene.saved'], books: 'all' });
  assert.equal(r.ok, true);
  assert.equal((await fs.readFile(path.join(dir, 'webhooks.json'), 'utf8')).includes(r.secret), false);
  assert.equal(await hooks.secretOf(r.webhook.id), r.secret);
  assert.equal(JSON.stringify(hooks.list()).includes(r.secret), false);
  const again = await openWebhooks(dir, { keystore: ks });
  assert.equal(again.matching('scene.saved', 'x').length, 1, 'reopened');
  await again.revoke(r.webhook.id);
  assert.equal(ks.m.size, 0, 'revoking forgets the secret');
});

test('open with a key store moves a plain secret from an earlier version; nothing else changes', async () => {
  const dir = await tmp();
  const plain = await openWebhooks(dir);
  const r = await plain.create({ url: URL_OK, events: ['scene.saved'], books: 'all' });
  assert.equal((await fs.readFile(path.join(dir, 'webhooks.json'), 'utf8')).includes(r.secret), true);
  const ks = memoryKeystore();
  const moved = await openWebhooks(dir, { keystore: ks });
  assert.equal((await fs.readFile(path.join(dir, 'webhooks.json'), 'utf8')).includes(r.secret), false);
  assert.equal(await moved.secretOf(r.webhook.id), r.secret);
  assert.equal(moved.list()[0].secret_hash, r.webhook.secret_hash);
});

test('dispatcher: signs with the store secret; a secret that cannot be unlocked sends nothing', async () => {
  const dir = await tmp();
  const ks = memoryKeystore();
  const hooks = await openWebhooks(dir, { keystore: ks });
  const r = await hooks.create({ url: URL_OK, events: ['scene.saved'], books: 'all' });
  const sent = [];
  const dispatcher = createDispatcher({ store: async () => hooks, deliver: async (req) => (sent.push(req), { ok: true, status: 200 }), sleep: async () => {}, backoffMs: [] });
  await dispatcher.emit({ event: 'scene.saved', book_id: 'book_1', book: 'b' });
  await dispatcher.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['x-storyforge-signature'], `sha256=${crypto.createHmac('sha256', r.secret).update(sent[0].body, 'utf8').digest('hex')}`);

  ks.get = async () => {
    throw Object.assign(new Error('cannot unlock stored keys'), { code: 'LOCKED' });
  };
  await dispatcher.emit({ event: 'scene.saved', book_id: 'book_1', book: 'b' });
  await dispatcher.flush();
  assert.equal(sent.length, 1, 'no request without a signature');
  assert.equal(hooks.list()[0].last_delivery.code, 'SECRET_LOCKED');
});
