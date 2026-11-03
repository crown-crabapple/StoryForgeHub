// The webhook transport (the one network module of M08-J02): what it sends, what it refuses without sending, no redirects, the timeout. Loopback servers only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { isRefusal, postWebhook } from '../src/index.mjs';

const servers = [];
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise((r) => s.close(() => r()));
  }
});

/** A loopback server answering with `answer(req, bodyBuffer, res)`; records what it received. */
async function serve(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      answer(req, body, res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { seen, url: `http://127.0.0.1:${server.address().port}/hook` };
}

test('it POSTs the exact body bytes with the given headers, and a 2xx is ok', async () => {
  const s = await serve((req, body, res) => res.writeHead(204).end());
  const body = JSON.stringify({ event: 'scene.saved', note: 'café ☃' });
  const r = await postWebhook({ url: s.url, body, headers: { 'x-storyforge-signature': 'sha256=abc', 'x-storyforge-event': 'scene.saved' } });
  assert.deepEqual(r, { ok: true, status: 204 });
  assert.equal(s.seen.length, 1);
  assert.equal(s.seen[0].method, 'POST');
  assert.equal(s.seen[0].body.toString('utf8'), body, 'byte for byte');
  assert.equal(s.seen[0].headers['x-storyforge-signature'], 'sha256=abc');
  assert.equal(s.seen[0].headers['content-type'], 'application/json');
  assert.equal(s.seen[0].headers['content-length'], String(Buffer.byteLength(body)));
  assert.match(s.seen[0].headers['user-agent'], /^StoryForge-Webhook/);
  assert.equal(s.seen[0].headers.authorization, undefined);
  assert.equal(s.seen[0].headers.cookie, undefined);
});

test('a redirect is never followed: the target is not called and the delivery fails', async () => {
  const target = await serve((req, body, res) => res.writeHead(204).end());
  const s = await serve((req, body, res) => res.writeHead(302, { location: target.url }).end());
  const r = await postWebhook({ url: s.url, body: '{}' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REDIRECT_REFUSED');
  assert.equal(r.status, 302);
  assert.equal(target.seen.length, 0);
});

test('other answers fail with the status; the answer body is not kept and a huge one does not hang it', async () => {
  const s = await serve((req, body, res) => res.writeHead(500).end('x'.repeat(500_000)));
  const r = await postWebhook({ url: s.url, body: '{}' });
  assert.deepEqual([r.ok, r.code, r.status], [false, 'HTTP_500', 500]);
  assert.equal(JSON.stringify(r).includes('xxxx'), false);
  const bad = await serve((req, body, res) => res.writeHead(404).end());
  assert.equal((await postWebhook({ url: bad.url, body: '{}' })).code, 'HTTP_404');
});

test('a receiver that does not answer in time is a TIMEOUT', async () => {
  const s = await serve(() => {});
  const t0 = Date.now();
  const r = await postWebhook({ url: s.url, body: '{}', timeoutMs: 300 });
  assert.equal(r.code, 'TIMEOUT');
  assert.ok(Date.now() - t0 < 3000);
});

test('a closed port is NETWORK; no message holds the signature, the body or the address credentials', async () => {
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const r = await postWebhook({ url: `http://127.0.0.1:${port}/x`, body: '{"secret":"BODY-TEXT"}', headers: { 'x-storyforge-signature': 'sha256=SIGNATURE-VALUE' } });
  assert.equal(r.code, 'NETWORK');
  assert.equal(JSON.stringify(r).includes('SIGNATURE-VALUE'), false);
  assert.equal(JSON.stringify(r).includes('BODY-TEXT'), false);
});

test('refusals send nothing: plain http off this computer, a private network, credentials, another scheme', async () => {
  const s = await serve((req, body, res) => res.writeHead(204).end());
  const port = new URL(s.url).port;
  const refusals = [
    ['http://example.com/hook', 'REFUSED_INSECURE'],
    ['http://192.168.1.5/hook', 'REFUSED_INSECURE'],
    ['https://192.168.1.5/hook', 'REFUSED_PRIVATE'],
    ['https://169.254.169.254/latest/meta-data', 'REFUSED_PRIVATE'],
    ['https://[fd00::1]/hook', 'REFUSED_PRIVATE'],
    [`http://user:pw@127.0.0.1:${port}/hook`, 'REFUSED_CREDENTIALS'],
    [`ftp://127.0.0.1:${port}/hook`, 'REFUSED_PROTOCOL'],
    ['nonsense', 'BAD_URL'],
  ];
  for (const [url, code] of refusals) {
    const r = await postWebhook({ url, body: '{}' });
    assert.equal(r.code, code, url);
    assert.equal(isRefusal(r.code), true);
  }
  assert.equal(s.seen.length, 0);
  assert.equal(isRefusal('NETWORK'), false);
  assert.equal(isRefusal('HTTP_500'), false);
});
