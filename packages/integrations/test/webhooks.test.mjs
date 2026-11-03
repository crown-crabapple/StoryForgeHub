// Webhook subscriptions, the dispatcher (signing, retries, disabling after 20 failures, zero traffic with no subscription) and the URL rules (M08-J02 section 4).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_FAILURES, WEBHOOK_EVENTS, WebhookDataError, checkWebhookUrl, createDispatcher, isPrivateIp, openWebhooks } from '../src/index.mjs';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sf-hooks-'));
const URL_OK = 'http://127.0.0.1:9/hook';
const make = async (dir, over = {}) => {
  const hooks = await openWebhooks(dir);
  const r = await hooks.create({ url: URL_OK, events: ['scene.saved'], books: 'all', ...over });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { hooks, ...r };
};

test('create: the secret is returned once, kept in the folder given, never listed; a revoked webhook is not matched', async () => {
  const dir = await tmp();
  const { hooks, secret, webhook } = await make(dir);
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(hooks.list()).includes(secret), false);
  assert.equal(JSON.stringify(webhook).includes(secret), false);
  assert.match(webhook.id, /^whk_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual([webhook.include_content, webhook.allow_local, webhook.revoked, webhook.disabled, webhook.failures], [false, false, false, false, 0]);
  const file = await fs.readFile(path.join(dir, 'webhooks.json'), 'utf8');
  assert.ok(file.includes(secret), 'the secret is kept where the dispatcher can sign with it (M08-J03 moves it)');
  // reopened: the same subscriptions
  const again = await openWebhooks(dir);
  assert.equal(again.matching('scene.saved', 'any').length, 1);
  assert.equal(again.matching('scene.moved', 'any').length, 0);
  assert.deepEqual((await again.revoke(webhook.id)).ok, true);
  assert.equal(again.matching('scene.saved', 'any').length, 0);
  assert.equal((await again.revoke('whk_NOPE')).ok, false);
});

test('create: bad addresses, events and books are refused with a code; a plugin\'s own subscriptions are separate', async () => {
  const dir = await tmp();
  const hooks = await openWebhooks(dir);
  const code = async (over) => (await hooks.create({ url: URL_OK, events: ['scene.saved'], books: 'all', ...over })).code;
  assert.equal(await code({ url: 'http://example.com/x' }), 'REFUSED_INSECURE');
  assert.equal(await code({ url: 'https://10.1.2.3/x' }), 'REFUSED_PRIVATE');
  assert.equal(await code({ url: 'https://user@example.com/x' }), 'REFUSED_CREDENTIALS');
  assert.equal(await code({ url: 'gopher://example.com/x' }), 'REFUSED_PROTOCOL');
  assert.equal(await code({ url: 42 }), 'BAD_URL');
  assert.equal(await code({ events: [] }), 'BAD_ARGS');
  assert.equal(await code({ events: ['scene.saved', 'nope'] }), 'BAD_ARGS');
  assert.equal(await code({ books: [] }), 'BAD_ARGS');
  assert.equal(await code({ books: ['Bad Slug'] }), 'BAD_ARGS');
  assert.equal(await code({ include_content: 'true' }), 'BAD_ARGS');
  assert.equal((await hooks.create({ url: 'https://10.1.2.3/x', events: ['scene.saved'], books: 'all', allow_local: true })).ok, true, 'allowed when the author ticked the box');
  assert.equal((await hooks.create({ url: URL_OK, events: ['scene.saved'], books: ['a'], plugin: 'mine' })).ok, true);
  assert.equal(hooks.list({ plugin: 'mine' }).length, 1);
  assert.equal(hooks.list({ plugin: 'other' }).length, 0);
  assert.equal((await hooks.revoke(hooks.list({ plugin: 'mine' })[0].id, { plugin: 'other' })).ok, false, 'not another plugin\'s to revoke');
  assert.equal(hooks.list().length, 2);
  assert.equal(WEBHOOK_EVENTS.length, 8);
});

test('matching: events and the books filter', async () => {
  const dir = await tmp();
  const hooks = await openWebhooks(dir);
  await hooks.create({ url: URL_OK, events: ['scene.saved', 'scene.moved'], books: ['salt-orchard'] });
  await hooks.create({ url: URL_OK, events: ['scene.saved'], books: 'all' });
  assert.equal(hooks.matching('scene.saved', 'salt-orchard').length, 2);
  assert.equal(hooks.matching('scene.saved', 'tidewater').length, 1);
  assert.equal(hooks.matching('scene.saved', null).length, 1);
  assert.equal(hooks.matching('scene.moved', 'salt-orchard').length, 1);
  assert.equal(hooks.matching('scene.moved', 'tidewater').length, 0);
});

test('a damaged webhooks.json is reported and never replaced', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'webhooks.json'), '{ not json');
  await assert.rejects(openWebhooks(dir), WebhookDataError);
  await fs.writeFile(path.join(dir, 'webhooks.json'), JSON.stringify({ version: 1, webhooks: [{ id: 'x' }] }));
  await assert.rejects(openWebhooks(dir), WebhookDataError);
  assert.match(await fs.readFile(path.join(dir, 'webhooks.json'), 'utf8'), /"id":"x"|"id": "x"/);
});

// ---------------------------------------------------------------- the dispatcher

const EVENT = { event: 'scene.saved', book_id: 'book_1', book: 'salt-orchard', target_id: 'scene_1', path: 'a/b.md', sha256: 'f'.repeat(64) };

/** A dispatcher over a real store with a recording fake transport. `script` answers each call in turn (the last one repeats). */
async function rig({ script = [{ ok: true, status: 204 }], dispatcherOpts = {}, subscribe = true, over = {} } = {}) {
  const dir = await tmp();
  const hooks = await openWebhooks(dir);
  const made = subscribe ? await hooks.create({ url: URL_OK, events: ['scene.saved'], books: 'all', ...over }) : null;
  const calls = [];
  const sleeps = [];
  const deliver = async (c) => {
    calls.push(c);
    return script[Math.min(calls.length - 1, script.length - 1)];
  };
  const d = createDispatcher({ store: async () => hooks, deliver, sleep: async (ms) => void sleeps.push(ms), ...dispatcherOpts });
  return { hooks, made, calls, sleeps, d, dir };
}

test('dispatcher: one signed POST per event; the signature is the HMAC of the exact body, the body has ids and hashes only', async () => {
  const { made, calls, d } = await rig();
  await d.emit({ ...EVENT, content: async () => 'SECRET PROSE' });
  await d.flush();
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, URL_OK);
  assert.equal(c.headers['x-storyforge-signature'], `sha256=${createHmac('sha256', made.secret).update(c.body, 'utf8').digest('hex')}`);
  assert.equal(c.headers['x-storyforge-event'], 'scene.saved');
  assert.match(c.headers['x-storyforge-delivery'], /^dlv_[0-9a-f]{24}$/);
  const body = JSON.parse(c.body);
  assert.deepEqual(Object.keys(body).sort(), ['at', 'book_id', 'event', 'path', 'sha256', 'target_id']);
  assert.equal(c.body.includes('SECRET PROSE'), false);
  assert.equal(c.body.includes('salt-orchard'), false, 'the book slug is only for filtering, not sent');
  assert.equal(c.allowLocal, false);
});

test('dispatcher: include_content adds the text (and `by` when known) and the signature covers it; text is read only when asked for', async () => {
  const { made, calls, d } = await rig({ over: { include_content: true } });
  let reads = 0;
  await d.emit({ ...EVENT, by: { name: 'Ilse' }, content: async () => (reads++, 'THE TEXT') });
  await d.flush();
  const body = JSON.parse(calls[0].body);
  assert.equal(body.content, 'THE TEXT');
  assert.deepEqual(body.by, { name: 'Ilse' });
  assert.equal(calls[0].headers['x-storyforge-signature'], `sha256=${createHmac('sha256', made.secret).update(calls[0].body, 'utf8').digest('hex')}`);
  const none = await rig();
  let touched = false;
  await none.d.emit({ ...EVENT, content: async () => ((touched = true), 'x') });
  await none.d.flush();
  assert.equal(touched, false, 'the text is never even read for a subscriber that did not ask');
  assert.equal(reads, 1);
});

test('dispatcher: ZERO traffic and no work when nobody is subscribed (also for another event, another book, revoked, disabled, module off)', async () => {
  const none = await rig({ subscribe: false });
  await none.d.emit(EVENT);
  await none.d.flush();
  assert.equal(none.calls.length, 0);
  const wrongEvent = await rig({ over: { events: ['scene.moved'] } });
  await wrongEvent.d.emit(EVENT);
  const wrongBook = await rig({ over: { books: ['other-book'] } });
  await wrongBook.d.emit(EVENT);
  const revoked = await rig();
  await revoked.hooks.revoke(revoked.made.webhook.id);
  await revoked.d.emit(EVENT);
  const off = await rig({ dispatcherOpts: { enabled: () => false } });
  await off.d.emit(EVENT);
  const noStore = createDispatcher({ store: async () => null, deliver: async () => assert.fail('no store, no delivery') });
  await noStore.emit(EVENT);
  for (const r of [wrongEvent, wrongBook, revoked, off]) {
    await r.d.flush();
    assert.equal(r.calls.length, 0);
  }
});

test('dispatcher: a failure that could pass is retried 3 times with backoff, then counted once; a success clears the count', async () => {
  const { hooks, made, calls, sleeps, d } = await rig({ script: [{ ok: false, code: 'HTTP_503', status: 503, message: '' }, { ok: false, code: 'TIMEOUT', message: '' }, { ok: false, code: 'NETWORK', message: '' }, { ok: true, status: 204 }] });
  await d.emit(EVENT);
  await d.flush();
  assert.equal(calls.length, 4, 'one try and three retries');
  assert.deepEqual(sleeps, [1000, 4000, 16000]);
  assert.equal(hooks.list()[0].failures, 0, 'the last retry passed');
  assert.equal(hooks.list()[0].last_delivery.ok, true);
  // all four fail: one failure on the subscription
  const bad = await rig({ script: [{ ok: false, code: 'HTTP_500', status: 500, message: '' }] });
  await bad.d.emit(EVENT);
  await bad.d.flush();
  assert.equal(bad.calls.length, 4);
  assert.equal(bad.hooks.list()[0].failures, 1);
  assert.equal(bad.hooks.list()[0].last_delivery.code, 'HTTP_500');
  assert.equal(made.webhook.id, hooks.list()[0].id);
});

test('dispatcher: a failure that cannot pass is not retried (a 4xx, a refused address, a redirect)', async () => {
  for (const answer of [{ ok: false, code: 'HTTP_410', status: 410, message: '' }, { ok: false, code: 'REFUSED_PRIVATE', message: '' }, { ok: false, code: 'REDIRECT_REFUSED', status: 302, message: '' }]) {
    const r = await rig({ script: [answer] });
    await r.d.emit(EVENT);
    await r.d.flush();
    assert.equal(r.calls.length, 1, answer.code);
    assert.equal(r.hooks.list()[0].failures, 1);
  }
  // 408 and 429 are worth another try
  const retry = await rig({ script: [{ ok: false, code: 'HTTP_429', status: 429, message: '' }, { ok: true, status: 200 }] });
  await retry.d.emit(EVENT);
  await retry.d.flush();
  assert.equal(retry.calls.length, 2);
});

test('dispatcher: after 20 failures in a row the subscription is disabled and no longer sent to; a success in between resets the count', async () => {
  const { hooks, calls, d } = await rig({ dispatcherOpts: { backoffMs: [] }, script: [{ ok: false, code: 'HTTP_500', status: 500, message: '' }] });
  assert.equal(MAX_FAILURES, 20);
  for (let i = 0; i < 19; i++) {
    await d.emit(EVENT);
    await d.flush();
  }
  assert.equal(hooks.list()[0].failures, 19);
  assert.equal(hooks.list()[0].disabled, false);
  await d.emit(EVENT);
  await d.flush();
  assert.equal(hooks.list()[0].disabled, true, 'the 20th failure disables it');
  const sent = calls.length;
  await d.emit(EVENT);
  await d.flush();
  assert.equal(calls.length, sent, 'a disabled subscription gets nothing');
  assert.equal(JSON.stringify(hooks.list()[0]).includes('secret"'), false);

  const mixed = await rig({ dispatcherOpts: { backoffMs: [] }, script: [...Array(19).fill({ ok: false, code: 'NETWORK', message: '' }), { ok: true, status: 204 }, ...Array(19).fill({ ok: false, code: 'NETWORK', message: '' })] });
  for (let i = 0; i < 39; i++) {
    await mixed.d.emit(EVENT);
    await mixed.d.flush();
  }
  assert.equal(mixed.hooks.list()[0].disabled, false, 'never 20 in a row');
  assert.equal(mixed.hooks.list()[0].failures, 19);
});

test('dispatcher: a subscription sees its events in order, and a slow receiver does not block another', async () => {
  const dir = await tmp();
  const hooks = await openWebhooks(dir);
  await hooks.create({ url: 'http://127.0.0.1:1/a', events: ['scene.saved'], books: 'all' });
  await hooks.create({ url: 'http://127.0.0.1:2/b', events: ['scene.saved'], books: 'all' });
  const order = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const deliver = async (c) => {
    const n = JSON.parse(c.body).target_id;
    if (c.url.endsWith('/a')) await gate;
    order.push(`${c.url.slice(-1)}${n}`);
    return { ok: true, status: 204 };
  };
  const d = createDispatcher({ store: async () => hooks, deliver });
  await d.emit({ ...EVENT, target_id: '1' });
  await d.emit({ ...EVENT, target_id: '2' });
  // Poll until b has delivered both (a is still gated, so this can only pass if b is not held up by a); a loaded machine may take long.
  const deadline = Date.now() + 30000;
  while (order.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['b1', 'b2'], 'b is not held up by a');
  release();
  await d.flush();
  assert.deepEqual(order, ['b1', 'b2', 'a1', 'a2'], 'a still got its events in order');
});

// ---------------------------------------------------------------- the address rules

test('url rules: loopback may be http, everything else https; private networks need the tick; credentials and other schemes never', () => {
  const ok = (u, o) => checkWebhookUrl(u, o).ok;
  for (const u of ['http://127.0.0.1:8080/h', 'http://localhost/h', 'http://[::1]:9/h', 'http://127.9.9.9/h', 'https://example.com/h', 'https://hooks.example.org:8443/a?b=c', 'https://8.8.8.8/h']) assert.equal(ok(u), true, u);
  for (const u of ['http://example.com/h', 'http://192.168.0.2/h', 'http://[::ffff:8.8.8.8]/h', 'ftp://example.com', 'https://u:p@example.com/', 'https://a b/', '', 'javascript:alert(1)']) assert.equal(ok(u), false, u);
  for (const u of ['https://10.0.0.1/h', 'https://172.16.5.5/h', 'https://172.31.255.255/h', 'https://192.168.1.1/h', 'https://169.254.169.254/latest', 'https://100.64.0.1/h', 'https://[fd12:3456::1]/h', 'https://[fe80::1]/h', 'https://[::ffff:10.0.0.1]/h', 'https://printer.local/h', 'https://nas.lan/h', 'https://0.0.0.0/h']) {
    assert.equal(ok(u), false, `${u} is a private network`);
    assert.equal(ok(u, { allowLocal: true }), true, `${u} with the tick`);
  }
  for (const u of ['https://172.15.0.1/h', 'https://172.32.0.1/h', 'https://11.0.0.1/h', 'https://[2606:4700::1111]/h']) assert.equal(ok(u), true, `${u} is public`);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(checkWebhookUrl('http://x.example/h').code, 'REFUSED_INSECURE');
  assert.equal(checkWebhookUrl('http://x.example/h', { allowLocal: true }).code, 'REFUSED_INSECURE', 'the tick never allows plain http off this computer');
});
