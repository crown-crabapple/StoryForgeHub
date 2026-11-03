// Helpers for the M08-J03 acceptance tests (not a test file): a richer mock provider (model lists, streaming, usage on or off, images, a stream that holds open so the
// client can cancel), a webhook receiver, a recording client, and the "the key appears nowhere" scan. Everything talks to the server over HTTP only.
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { unzip } from '../../../packages/export/src/index.mjs';
import { AI, BOOK, readEverything, send } from './ai-helpers.mjs';

/** A valid (tiny) PNG: signature plus filler. The server only checks the signature. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('storyforge-test-image')]);

/** A recognisable fake key, different on every run. */
export const fakeKey = (label = 'key') => `sk-test-${label}-${randomBytes(9).toString('hex')}`;

const servers = [];
export async function closeMocks() {
  await Promise.all(servers.splice(0).map((s) => s.close()));
}

/**
 * A provider on 127.0.0.1 (port 0) that answers: GET /v1/models, GET /api/tags (only with `ollama`), POST /v1/chat/completions (whole, or SSE when the request says
 * stream: true), POST /v1/images/generations. Every request is recorded in `calls` (method, url, headers, raw body, parsed body).
 *   reply     text of the reply (a string, or (parsedBody) => string)
 *   usage     false: the provider reports no usage (so the totals are estimated)
 *   hold      true: a streamed reply sends its first piece and then waits (until the client goes away), so a test can cancel; `onHeld` resolves when it is waiting
 *   stall     ms between the pieces of a streamed reply (state.stall, changeable while running)
 *   state.truncate  true: a streamed reply ends after two pieces with no finish marker
 */
export async function startProvider({ reply = 'OK', usage = true, models = ['mock-model-a', 'mock-model-b'], ollama = false, hold = false, stall = 0 } = {}) {
  const calls = [];
  const state = { reply, usage, hold, stall, truncate: false, clientGone: 0, held: null };
  let heldResolve;
  const onHeld = new Promise((r) => (heldResolve = r));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        /* not JSON */
      }
      calls.push({ method: req.method, url: req.url, headers: req.headers, raw, body });
      const json = (status, value) => {
        const text = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      };
      if (req.method === 'GET' && req.url === '/v1/models') return json(200, { object: 'list', data: models.map((id) => ({ id, object: 'model' })) });
      if (req.method === 'GET' && req.url === '/api/tags') return ollama ? json(200, { models: [{ name: 'llama3:8b' }] }) : json(404, { error: 'not found' });
      if (req.method === 'POST' && req.url === '/v1/images/generations') return json(200, { created: 1, data: [{ b64_json: PNG.toString('base64') }] });
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const text = typeof state.reply === 'function' ? state.reply(body) : state.reply;
        const promptChars = JSON.stringify(body?.messages ?? []).length;
        const usageBlock = state.usage ? { prompt_tokens: 11 + Math.ceil(promptChars / 1000), completion_tokens: 7 } : undefined;
        if (!body?.stream) {
          return json(200, { id: 'mock-1', object: 'chat.completion', model: 'mock-model-a', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], ...(usageBlock ? { usage: usageBlock } : {}) });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        req.on('close', () => {
          if (!res.writableEnded) state.clientGone++;
        });
        const pieces = text.match(/.{1,12}/gs) ?? [text];
        const write = (v) => res.write(`data: ${JSON.stringify(v)}\n\n`);
        (async () => {
          for (let i = 0; i < pieces.length; i++) {
            write({ id: 'mock-1', model: 'mock-model-a', choices: [{ index: 0, delta: { content: pieces[i] } }] });
            if (state.hold && i === 0) {
              heldResolve?.();
              return; // stay open: the client must cancel
            }
            if (state.truncate && i === 1) return void res.end(); // the connection ends before the reply is complete
            if (state.stall) await new Promise((r) => setTimeout(r, state.stall));
          }
          write({ id: 'mock-1', model: 'mock-model-a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          if (usageBlock && body.stream_options?.include_usage) write({ id: 'mock-1', choices: [], usage: usageBlock });
          res.end('data: [DONE]\n\n');
        })();
        return;
      }
      return json(404, { error: { message: 'not found' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const mock = {
    calls,
    state,
    onHeld,
    port,
    host: `127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    posts: () => calls.filter((c) => c.method === 'POST'),
    chats: () => calls.filter((c) => c.url === '/v1/chat/completions'),
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
  servers.push(mock);
  return mock;
}

/** A webhook receiver on 127.0.0.1: records every delivery with its signature. */
export async function startReceiver() {
  const deliveries = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      deliveries.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const rx = {
    deliveries,
    url: `http://127.0.0.1:${port}/hook`,
    /** Does a delivery verify against `secret`? */
    verifies: (d, secret) => d.headers['x-storyforge-signature'] === `sha256=${createHmac('sha256', secret).update(d.body, 'utf8').digest('hex')}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
  servers.push(rx);
  return rx;
}

/** Wait until `fn()` is truthy. @param {() => any} fn @param {string} what @param {number} [ms] */
export async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Wrap a running app so every JSON/text response it gives is kept (the scan looks at them all), and add raw GET for downloads.
 * @param {any} app @returns {any} the app, with `.seen` (all response texts) and `.download(path)`
 */
export function recording(app) {
  const seen = [];
  const wrap = (name) => {
    const orig = app[name];
    app[name] = async (...args) => {
      const r = await orig(...args);
      seen.push({ where: `${name.toUpperCase()} ${args[0]}`, text: r.text });
      return r;
    };
  };
  for (const n of ['get', 'post', 'put', 'del']) wrap(n);
  app.seen = seen;
  app.download = async (p) => {
    const r = await send(app.port, 'GET', p);
    return r;
  };
  return app;
}

/** The download as bytes (a raw GET that keeps binary bodies intact). */
export function getBytes(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Every file of a zip as name -> bytes, and, for files that are zips themselves (docx, epub), their entries too. @param {Buffer} bytes */
export function zipContents(bytes) {
  const out = new Map();
  for (const [name, data] of unzip(bytes)) out.set(name, data);
  return out;
}

/** Does `bytes` hold `needle` as plain text, or in its base64 / hex / URL-encoded form? @param {Buffer} bytes @param {string} needle */
export function holds(bytes, needle) {
  const forms = [needle, Buffer.from(needle).toString('base64'), Buffer.from(needle).toString('hex'), encodeURIComponent(needle)];
  const text = bytes.toString('latin1');
  return forms.some((f) => text.includes(f));
}

/** The files (relative paths) under `dir` that hold `needle`. */
export async function filesHolding(dir, needle) {
  const files = await readEverything(dir);
  return [...files].filter(([, b]) => holds(b, needle)).map(([p]) => p);
}

export { AI, BOOK, fs, path };
