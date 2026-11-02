// M05-J04 contract section 1: packages/ai/src/transport.mjs, `postJson(url, body, { headers, timeoutMs, signal })`.
// It refuses non-http(s) URLs, http: to non-loopback hosts (cloud must be https), redirects, and responses over 8 MB; it honours the timeout and the abort signal.
// Real network is never used: refusals are proven by a fetch spy that must NOT be reached, and acceptance by a mock on 127.0.0.1.
// (The https/cloud path end to end, with a throwaway certificate, is in ai-credentials.test.mjs.)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockProvider } from './ai-helpers.mjs';

const { postJson } = await import('../../../packages/ai/src/transport.mjs');

const mocks = [];
after(async () => {
  for (const m of mocks) await m.close();
});

/** Run fn with globalThis.fetch replaced by a spy that records and then fails; returns { calls, error }. */
async function withFetchSpy(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error('SPY: fetch reached');
  };
  let error;
  try {
    await fn();
  } catch (e) {
    error = e;
  } finally {
    globalThis.fetch = real;
  }
  return { calls, error };
}

test('http: to a non-loopback host is refused before anything is sent', async () => {
  for (const url of ['http://example.com/v1/chat/completions', 'http://192.168.1.5:11434/v1/x', 'http://127.0.0.2/v1/x', 'http://[2001:db8::1]/v1/x']) {
    const { calls, error } = await withFetchSpy(() => postJson(url, { a: 1 }, { headers: { authorization: 'Bearer should-not-leave' }, timeoutMs: 2000 }));
    assert.ok(error, `${url} rejected`);
    assert.ok(!/SPY/.test(error.message), `${url}: refused by the transport itself (${error.message})`);
    assert.equal(calls.length, 0, `${url}: no request was made`);
  }
});

test('non-http(s) schemes are refused: file:, ftp:, data:, ws:, javascript:, and garbage', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hi', 'ws://127.0.0.1/x', 'javascript:alert(1)', 'not a url', '']) {
    const { calls, error } = await withFetchSpy(() => postJson(url, {}, { timeoutMs: 2000 }));
    assert.ok(error, `${JSON.stringify(url)} rejected`);
    assert.ok(!/SPY/.test(error.message), `${JSON.stringify(url)}: ${error.message}`);
    assert.equal(calls.length, 0);
  }
});

test('http: to loopback (localhost, 127.0.0.1, [::1]) is allowed through to the network layer', async () => {
  for (const url of ['http://localhost:9/x', 'http://127.0.0.1:9/x', 'http://[::1]:9/x']) {
    const { calls } = await withFetchSpy(() => postJson(url, {}, { timeoutMs: 2000 }));
    assert.equal(calls.length, 1, `${url} was passed on (the spy then fails it)`);
  }
});

test('https: to a remote host is allowed through to the network layer and redirects are never followed', async () => {
  const { calls } = await withFetchSpy(() => postJson('https://api.example.com/v1/chat/completions', { m: 1 }, { headers: { authorization: 'Bearer k' }, timeoutMs: 2000 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, 'error', 'fetch is called with redirect: "error"');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.authorization ?? calls[0][1].headers.Authorization, 'Bearer k');
});

test('a good POST: JSON body and headers reach a loopback server, and its JSON answer comes back', async () => {
  const mock = await startMockProvider({ reply: 'pong' });
  mocks.push(mock);
  const out = await postJson(`${mock.baseUrl}/chat/completions`, { messages: [{ role: 'user', content: 'ping' }] }, { headers: { authorization: 'Bearer abc' }, timeoutMs: 5000 });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].method, 'POST');
  assert.equal(mock.calls[0].headers.authorization, 'Bearer abc');
  assert.match(mock.calls[0].headers['content-type'], /application\/json/);
  assert.deepEqual(mock.calls[0].body, { messages: [{ role: 'user', content: 'ping' }] });
  assert.ok(JSON.stringify(out).includes('pong'), `the answer is returned: ${JSON.stringify(out).slice(0, 200)}`);
});

/** A raw loopback server with a custom handler. */
async function rawServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const m = {
    url: `http://127.0.0.1:${server.address().port}/x`,
    hits: 0,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
  server.on('request', () => m.hits++);
  mocks.push(m);
  return m;
}

test('a redirect is an error and is not followed (the target is never contacted)', async () => {
  const target = await rawServer((req, res) => res.end('{}'));
  const redir = await rawServer((req, res) => {
    res.writeHead(307, { location: target.url });
    res.end();
  });
  await assert.rejects(() => postJson(redir.url, { a: 1 }, { timeoutMs: 5000 }));
  assert.equal(target.hits, 0);
});

test('a response larger than 8 MB is refused', async () => {
  const big = await rawServer((req, res) => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"pad":"');
    for (let i = 0; i < 9; i++) res.write(chunk.toString());
    res.end('"}');
  });
  await assert.rejects(() => postJson(big.url, {}, { timeoutMs: 15000 }));
});

test('a response just under 8 MB is accepted', async () => {
  const ok = await rawServer((req, res) => {
    const chunk = 'x'.repeat(1024 * 1024);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"pad":"');
    for (let i = 0; i < 7; i++) res.write(chunk);
    res.end('"}');
  });
  const out = await postJson(ok.url, {}, { timeoutMs: 15000 });
  assert.ok(out);
});

test('timeoutMs: a server that never answers is abandoned', async () => {
  const hang = await rawServer(() => {});
  const started = Date.now();
  await assert.rejects(() => postJson(hang.url, {}, { timeoutMs: 300 }));
  assert.ok(Date.now() - started < 10000, 'returned long before the test timeout');
});

test('signal: aborting the signal cancels the request', async () => {
  const hang = await rawServer(() => {});
  const ac = new AbortController();
  const p = postJson(hang.url, {}, { timeoutMs: 30000, signal: ac.signal });
  queueMicrotask(() => ac.abort());
  await assert.rejects(() => p);
});

test('a non-2xx answer is an error, not a result', async () => {
  const bad = await rawServer((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  let out;
  let err;
  try {
    out = await postJson(bad.url, {}, { timeoutMs: 5000 });
  } catch (e) {
    err = e;
  }
  // either shape is a legitimate contract reading; what matters is that the caller can tell: a throw, or a result that carries the 500
  assert.ok(err || JSON.stringify(out).includes('500'), 'failure is visible to the caller');
});
