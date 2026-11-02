// Shared helpers for the M03-J03 move tests (not a test file; `node --test "test/*.test.mjs"` skips it).
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { close, copyFixture, listen, request } from './helpers.mjs';

export const BOOK = 'book_01S5000000000000000000000A';
export const UNKNOWN_BOOK = 'book_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
export const UNKNOWN_SCENE = 'scene_01S5ZZZZZZZZZZZZZZZZZZZZZZ';
export const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };
const sid = (n) => `scene_01S500000000000000000000${String(n).padStart(2, '0')}`;
// salt-orchard reading order: PROLOGUE | ARRIVAL KEY | FERRY GRAFTING | LOWTIDE WALL   (scene 04 is a variant, 07 archived)
export const PROLOGUE = sid(1);
export const ARRIVAL = sid(2);
export const KEY = sid(3);
export const KEY_ALT = sid(4);
export const FERRY = sid(5);
export const GRAFTING = sid(6);
export const LOWTIDE = sid(8);
export const WALL = sid(9);
export const ORIGINAL_ORDER = [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL];

const servers = [];
const repos = [];
/** Close every server started by `startApi` (call from `after`). */
export async function closeAll() {
  for (const s of servers.splice(0)) await close(s);
  for (const r of repos.splice(0)) await r.close?.();
}

/** In-process server over a book root. Returns { port }. */
export async function startApi(root) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-web-'));
  const webRoot = path.join(outer, 'dist');
  await fs.mkdir(webRoot);
  await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>SPA</title>');
  const repo = createFsRepository(root, { debounceMs: 50, pollMs: 60000 });
  const server = createServer({ repository: repo, webRoot });
  servers.push(server);
  repos.push(repo);
  return { port: await listen(server), repo };
}

export async function freshBook(fixture = 'valid/salt-orchard', prep) {
  const root = await copyFixture(fixture);
  if (prep) await prep(root);
  const api = await startApi(root);
  return { root, ...api };
}

export function send(port, method, pathname, { headers = GOOD, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: host ?? `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const moveUrl = (scene, book = BOOK) => `/api/books/${book}/scenes/${scene}/move`;
export const move = (port, scene, body, opts = {}) => send(port, 'POST', moveUrl(scene, opts.book), { body, headers: opts.headers });

/** Reading order from the API: [{ id, act, chapter, sequence, path }] */
export async function apiOrder(port, book = BOOK) {
  const r = await request(port, 'GET', `/api/books/${book}`);
  if (r.status !== 200) throw new Error(`GET book ${r.status}: ${r.text}`);
  return r.json.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes)).map((s) => ({ id: s.id, act: s.act, chapter: s.chapter, sequence: s.sequence, path: s.path }));
}
export const apiIds = async (port) => (await apiOrder(port)).map((s) => s.id);

/** Every file under root except .storyforge/ and .git/: relative path -> Buffer. */
export async function readAll(root) {
  const out = new Map();
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === '.storyforge' || e.name === '.git' || e.name === '.storyforge-lock') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.set(path.relative(root, full).split(path.sep).join('/'), await fs.readFile(full));
    }
  }
  await walk(root);
  return out;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
/** Front matter text and body of a scene file (body = everything after the closing --- line, byte-exact). */
export function splitScene(buf) {
  const text = buf.toString('utf8');
  const m = FM.exec(text);
  if (!m) throw new Error('no front matter');
  return { fm: m[1], body: text.slice(m[0].length) };
}
/** id -> { path, fm, body } for every scene file under manuscript/. */
export function scenesById(files) {
  const out = new Map();
  for (const [p, buf] of files) {
    if (!p.startsWith('manuscript/') || !/\/\d+-[^/]*\.md$/.test(p)) continue;
    const { fm, body } = splitScene(buf);
    const id = /^id:\s*(\S+)\s*$/m.exec(fm)?.[1];
    if (id) out.set(id, { path: p, fm, body, raw: buf });
  }
  return out;
}
export const fmInt = (fm, key) => {
  const m = new RegExp('^' + key + ':[ \\t]*(-?\\d+)[ \\t]*\\r?$', 'm').exec(fm);
  return m ? Number(m[1]) : null;
};

/**
 * Independent reader (M00-J02 approach): only front matter and a (act, chapter, sequence) sort, nothing from the
 * product's code. Skips chapter/act files, variants (variant_of) and anything outside manuscript/.
 */
export function independentOrder(files) {
  const rows = [];
  for (const [id, s] of scenesById(files)) {
    if (/^variant_of:/m.test(s.fm)) continue;
    rows.push({ id, chapter: fmInt(s.fm, 'chapter'), sequence: fmInt(s.fm, 'sequence'), act: fmInt(s.fm, 'act') });
  }
  // A chapter belongs to one act; order chapters by number (acts are contiguous ranges of chapter numbers in the fixtures).
  rows.sort((a, b) => a.chapter - b.chapter || a.sequence - b.sequence || (a.id < b.id ? -1 : 1));
  return rows;
}

/** Canonical filename check: <NNNN>-<slug>.md in .../ch-<NNN>[-slug]/ under act-<NN>[-slug]/. */
export function canonicalFor(fm, p) {
  const act = fmInt(fm, 'act');
  const chapter = fmInt(fm, 'chapter');
  const seq = fmInt(fm, 'sequence');
  const m = /^manuscript\/act-(\d+)(?:-[^/]+)?\/ch-(\d+)(?:-[^/]+)?\/(\d+)-[^/]+\.md$/.exec(p);
  return !!m && Number(m[1]) === act && Number(m[2]) === chapter && Number(m[3]) === seq;
}
