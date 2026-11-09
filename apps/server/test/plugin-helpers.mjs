// Helpers for the M08-J02 acceptance tests (not a test file): a personal-mode server in this process over a copy of a fixture library, one request the way a
// plugin sends it (Authorization: Bearer, no cookies, no write header) and one the way the browser app sends it, and a loopback receiver for webhooks.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { createReceiver } from '../../../examples/webhook-receiver/receiver.mjs';
import { close, copyFixture, listen } from './helpers.mjs';

export const BOOK = 'book_01S5000000000000000000000A';
export const SLUG = 'salt-orchard';
export const SCENE = 'scene_01S50000000000000000000002';
export const SCENE_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
export const MEMBER = { 'content-type': 'application/json', 'x-storyforge': '1' };

const live = [];
/** Close every server and receiver this module started (call from `after`). */
export async function closeAll() {
  for (const fn of live.splice(0)) await fn();
}

/** One raw request. `headers` are sent as given (no write header unless you add it). */
export function raw(port, method, pathname, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json, bytes });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** A request as a plugin sends it. */
export const asPlugin = (port, token, method, pathname, { body, headers = {} } = {}) =>
  raw(port, method, pathname, { body, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } });

/** A request as the app in the browser sends it (personal mode: no cookies). */
export const asMember = (port, method, pathname, body) => raw(port, method, pathname, { body, headers: method === 'GET' ? {} : MEMBER });

/**
 * A personal-mode server over a copy of `fixture`. `profile` names the profile of the run (a fresh name keeps module settings out of other tests).
 * @param {{ fixture?: string, profile?: string, integrations?: object, manifests?: Record<string, string>, root?: string, webRoot?: string }} [o] `webRoot`: a built web app to serve (default none)
 */
export async function bootPersonal({ fixture = 'valid/salt-orchard', profile, integrations, manifests, webRoot } = {}) {
  // a fresh user config folder for this server (tests in a file run one after another, so the environment can be pointed at it): tokens, webhooks and profiles
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-j02-config-'));
  Object.assign(process.env, { APPDATA: path.join(config, 'AppData'), XDG_CONFIG_HOME: path.join(config, 'xdg') });
  const root = await copyFixture(fixture);
  // a library whose root is a book keeps its manifests next to book.md; _plugins/ is read from the library root
  for (const [name, text] of Object.entries(manifests ?? {})) {
    await fs.mkdir(path.join(root, '_plugins', name), { recursive: true });
    await fs.writeFile(path.join(root, '_plugins', name, 'plugin.md'), text);
  }
  const repository = createFsRepository(root, { watch: false, pollMs: 0 });
  const server = createServer({ repository, profile: profile ?? `j02-${process.hrtime.bigint()}`, ...(integrations ? { integrations } : {}), ...(webRoot ? { webRoot } : {}) });
  const port = await listen(server);
  live.push(async () => {
    await close(server);
    await repository.close?.();
  });
  const t = {
    root, repository, server, port, profile,
    member: (method, p, body) => asMember(port, method, p, body),
    plugin: (token, method, p, o) => asPlugin(port, token, method, p, o),
    /** grant a token as the author would in Settings; returns { token, grant } */
    async grant({ plugin = 'word-frequency', permissions = ['read'], books = 'all' } = {}) {
      const r = await asMember(port, 'POST', '/api/plugins/grants', { plugin, permissions, books });
      if (r.status !== 201) throw new Error(`grant failed: ${r.status} ${r.text}`);
      return r.json;
    },
  };
  return t;
}

/** The bytes of a scene file on disk. */
export const sceneBytes = (root, rel = SCENE_PATH) => fs.readFile(path.join(root, ...rel.split('/')));

/** A receiver on 127.0.0.1 (port 0) that verifies signatures with `secret()` (a function, set after the subscription is made). */
export async function startReceiver() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-recv-'));
  const out = path.join(dir, 'events.jsonl');
  await fs.writeFile(out, '');
  let secret = '';
  /** @type {{ raw: Buffer, headers: any, status: number | null }[]} */
  const seen = [];
  // the sample receiver itself, plus a listener that records the exact bytes of every request it gets (good or bad) and what it answered
  const server = createReceiver({ getSecret: () => secret, out });
  server.prependListener('request', (req, res) => {
    const chunks = [];
    const entry = { raw: Buffer.alloc(0), headers: req.headers, status: null };
    seen.push(entry);
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => (entry.raw = Buffer.concat(chunks)));
    res.on('finish', () => (entry.status = res.statusCode));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  live.push(() => close(server));
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}/hook`,
    setSecret: (s) => (secret = s),
    seen,
    out,
    events: async () => (await fs.readFile(out, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
