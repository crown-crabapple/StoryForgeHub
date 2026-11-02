// Helpers for the M05-J04 acceptance tests (not a test file). Everything here talks to the server over HTTP only.
// Contract: docs/contracts/M05-J04-ai-workshop.md. Names the contract leaves open are collected in `AI` below so a rename is a one-line change.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, copyFixture } from './helpers.mjs';
import { MAIN, waitFor } from './proc-helpers.mjs';

export const BOOK = 'book_01S5000000000000000000000A';
export const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };
export const sceneId = (n) => `scene_01S500000000000000000000${String(n).padStart(2, '0')}`;
export const ARRIVAL = sceneId(2);
export const KEY = sceneId(3);
export const ARRIVAL_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
export const KEY_PATH = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0020-the-key.md';
export const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Route and field names the contract does not spell out (sections 3 and 4 give shapes, not every path). */
export const AI = {
  profiles: '/api/ai/profiles',
  profile: (id) => `/api/ai/profiles/${id}`,
  test: (id) => `/api/ai/profiles/${id}/test`,
  bookProfile: (b = BOOK) => `/api/books/${b}/ai/profile`,
  context: (b = BOOK) => `/api/books/${b}/ai/context`,
  send: (b = BOOK) => `/api/books/${b}/ai/send`,
  apply: (b = BOOK) => `/api/books/${b}/ai/apply`,
  discard: (b = BOOK) => `/api/books/${b}/ai/discard`,
  keyField: 'apiKey',
};

/** Throwaway self-signed cert for 127.0.0.2 (valid ~100 years, test only). A server that must trust it gets NODE_EXTRA_CA_CERTS=TLS_CERT. */
const here = path.dirname(fileURLToPath(import.meta.url));
export const TLS_CERT = path.join(here, 'fixtures', 'ai-tls', 'cert.pem');
const TLS_KEY = path.join(here, 'fixtures', 'ai-tls', 'key.pem');

const live = new Set();
export async function stopAll() {
  await Promise.all([...live].map((p) => p.stop()));
}

/** A fresh, empty "home" whose user config dir is the one the server will use. */
export async function makeHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-ai-home-'));
  const env = { APPDATA: path.join(home, 'AppData'), XDG_CONFIG_HOME: path.join(home, 'xdg'), HOME: home, USERPROFILE: home };
  const configDir = process.platform === 'win32' ? path.join(env.APPDATA, 'StoryForge') : path.join(env.XDG_CONFIG_HOME, 'storyforge');
  return { home, env, configDir };
}

/** Text of every file in the user config dir (any file name): name -> text. */
export async function readConfigFiles(configDir) {
  const out = {};
  try {
    for (const e of await fs.readdir(configDir, { withFileTypes: true })) if (e.isFile()) out[e.name] = await fs.readFile(path.join(configDir, e.name), 'utf8');
  } catch {
    /* no dir yet */
  }
  return out;
}

/** Every file under `root` (relative path -> Buffer), including .storyforge/ (a key must be nowhere in it). */
export async function readEverything(root) {
  const out = new Map();
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.set(path.relative(root, full).split(path.sep).join('/'), await fs.readFile(full));
    }
  }
  await walk(root);
  return out;
}

const fileUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`).href;

/**
 * Start main.mjs (a real server process) on `library` with its user config dir inside `home`.
 * `net: true` preloads the network recorder; read the calls with `app.netCalls()`.
 */
export async function startApp({ library, home, net = false, env = {} }) {
  const netLog = path.join(home.home, `net-${process.hrtime.bigint()}.jsonl`);
  const args = [];
  if (net) args.push('--import', fileUrl(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-net-preload.mjs')));
  args.push(MAIN, '--library', library, '--port', '0');
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...home.env, SF_NET_LOG: netLog, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const app = {
    child,
    output: () => out,
    netLog,
    async netCalls() {
      try {
        return (await fs.readFile(netLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      child.stdout.destroy();
      child.stderr.destroy();
      live.delete(app);
    },
  };
  live.add(app);
  const m = await Promise.race([
    waitFor(() => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out), { what: 'server readiness line' }),
    exited.then((r) => {
      throw new Error(`server exited early (${JSON.stringify(r)}):\n${out}`);
    }),
  ]);
  app.port = Number(m[1]);
  app.get = (p) => send(app.port, 'GET', p);
  app.post = (p, body) => send(app.port, 'POST', p, body);
  app.put = (p, body) => send(app.port, 'PUT', p, body);
  app.del = (p) => send(app.port, 'DELETE', p);
  return app;
}

export function send(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { Host: `127.0.0.1:${port}`, ...(method === 'GET' ? {} : GOOD) };
    if (payload !== undefined) headers['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * An OpenAI-compatible provider on 127.0.0.1 (port 0). Records every request (`calls`: method, url, headers, raw body text).
 * `reply` is a string or (parsedBody) => string, returned as choices[0].message.content.
 */
export async function startMockProvider({ reply: initialReply = 'OK', tls = false, host = '127.0.0.1' } = {}) {
  let reply = initialReply;
  const calls = [];
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* keep undefined */
      }
      calls.push({ method: req.method, url: req.url, headers: req.headers, raw, body: parsed });
      const text = typeof reply === 'function' ? reply(parsed) : reply;
      const body = JSON.stringify({ id: 'mock-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
  };
  const server = tls ? https.createServer({ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) }, handler) : http.createServer(handler);
  await new Promise((r) => server.listen(0, host, r));
  const port = server.address().port;
  return {
    calls,
    setReply(r) {
      reply = r;
    },
    port,
    baseUrl: `${tls ? 'https' : 'http'}://${host}:${port}/v1`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

export const profileBody = (over = {}) => ({ name: 'Test provider', kind: 'openai-compatible', model: 'test-model', keyStorage: 'none', ...over });
export const idOf = (r) => r.json?.id ?? r.json?.profile?.id;

/** Create a profile and make it the book's active one; returns its id. */
export async function setupProvider(app, over = {}) {
  const c = await app.post(AI.profiles, profileBody(over));
  if (c.status !== 200 && c.status !== 201) throw new Error(`create profile ${c.status}: ${c.text}`);
  const id = idOf(c);
  const a = await app.put(AI.bookProfile(), { profileId: id });
  if (a.status !== 200) throw new Error(`activate profile ${a.status}: ${a.text}`);
  return id;
}

export const freshLibrary = () => copyFixture('valid/salt-orchard');
export const getScene = async (app, id) => (await app.get(`/api/books/${BOOK}/scenes/${id}`)).json;
