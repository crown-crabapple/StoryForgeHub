// Helpers for the M07-J03b shared-mode tests: a real shared server (loopback only) over a copy of salt-orchard with an owner, two editors, a reviewer and a
// viewer, plus two share links; and one request the way the browser app sends it (Origin and the write guard on every non-GET).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createFsRepository } from '../../../packages/core/src/index.mjs';
import { createAudit, openSettings, openSharedData } from '../../../packages/shared/src/index.mjs';
import { createServer } from '../src/server.mjs';
import { createSharedGate } from '../src/shared-gate.mjs';
import { close, copyFixture, listen } from './helpers.mjs';

export const BOOK = 'book_01S5000000000000000000000A';
export const OTHER_BOOK = 'book_01S5000000000000000000000B';
export const SCENE = 'scene_01S50000000000000000000002';
export const PW = 'correct horse battery';

const servers = [];
/** Close every server this module started (call from `after`). */
export async function closeAll() {
  for (const s of servers.splice(0)) await close(s);
}

/** One request the way the browser app sends it. */
export function call(port, method, pathname, { cookie, body, headers = {}, origin = `http://127.0.0.1:${port}`, guard = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { Host: `127.0.0.1:${port}` };
    if (method !== 'GET') {
      if (origin) h.Origin = origin;
      if (guard) Object.assign(h, { 'content-type': 'application/json', 'x-storyforge': '1' });
    }
    if (cookie) h.Cookie = cookie;
    Object.assign(h, headers);
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json, bytes: raw, setCookie: res.headers['set-cookie'] ?? [] });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** `name=value` of the cookie a response set. */
export const cookieOf = (r, name) => {
  const line = r.setCookie.find((c) => c.startsWith(`${name}=`));
  assert.ok(line, `no ${name} cookie in ${JSON.stringify(r.setCookie)}`);
  return line.split(';')[0];
};
const tokenOf = (link) => link.split('#token=')[1];

/**
 * A shared-mode server over a copy of salt-orchard. Users: `owner` (Ilse), `editor` (The editor), `editor2` (Second editor), `reviewer`, `viewer`;
 * `t.c[role]` is the cookie, `t.users[role]` the user. `t.c.share` / `t.c.exportShare` are share cookies for BOOK.
 */
export async function boot({ clock = null } = {}) {
  const root = await copyFixture('valid/salt-orchard');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-shared-data-'));
  const now = clock ? () => clock.now() : undefined; // a test clock for expiry cases; the real one when absent
  const data = await openSharedData(dir, now ? { now } : undefined);
  const settings = await openSettings(dir);
  const audit = createAudit(dir, now ? { now } : undefined);
  const gate = createSharedGate({ data, publicUrl: null, bindHost: '127.0.0.1', aiForMembers: () => settings.get().ai_for_members, audit: (e) => audit.append(e) });
  const repository = createFsRepository(root, { watch: false, pollMs: 0 });
  const server = createServer({ repository, shared: { gate, data, settings, audit: (e) => audit.append(e), publicUrl: null } });
  servers.push(server);
  const port = await listen(server);
  const t = { clock, root, dir, data, settings, audit, port, repository, server, c: {}, users: {}, call: (m, p, o) => call(port, m, p, o) };

  const init = await data.initOwner('ilse', 'Ilse');
  assert.equal(init.ok, true);
  const setup = await t.call('POST', '/api/auth/setup', { body: { token: init.token, password: PW } });
  assert.equal(setup.status, 200, setup.text);
  t.c.owner = cookieOf(setup, 'sf_session');
  t.users.owner = setup.json.user;
  for (const [key, role, display] of [['editor', 'editor', 'The editor'], ['editor2', 'editor', 'Second editor'], ['reviewer', 'reviewer', 'The reviewer'], ['viewer', 'viewer', 'The viewer']]) {
    const inv = await t.call('POST', '/api/shared/invites', { cookie: t.c.owner, body: { role } });
    assert.equal(inv.status, 201, inv.text);
    const acc = await t.call('POST', '/api/auth/invite/accept', { body: { token: tokenOf(inv.json.link), username: `${key}-user`, display_name: display, password: PW } });
    assert.equal(acc.status, 200, acc.text);
    t.c[key] = cookieOf(acc, 'sf_session');
    t.users[key] = acc.json.user;
  }
  const mk = async (scope) => {
    const sh = await t.call('POST', '/api/shared/shares', { cookie: t.c.owner, body: { book: BOOK, scope, expires_days: 30 } });
    assert.equal(sh.status, 201, sh.text);
    const used = await t.call('POST', '/api/auth/share', { body: { token: tokenOf(sh.json.link) } });
    assert.equal(used.status, 200, used.text);
    return cookieOf(used, 'sf_share');
  };
  t.c.share = await mk('read');
  t.c.exportShare = await mk('export');
  return t;
}

/** The scene as GET returns it ({ body, sha256, ... }), read as `role`. */
export async function loadScene(t, role = 'owner') {
  const r = await t.call('GET', `/api/books/${BOOK}/scenes/${SCENE}`, { cookie: t.c[role] });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

/** The whole file of a scene on disk. */
export const sceneFile = async (t) => {
  const rel = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
  return fs.readFile(path.join(t.root, ...rel.split('/')), 'utf8');
};
