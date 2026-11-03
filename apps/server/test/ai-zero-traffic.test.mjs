// M05-J04 acceptance 1: with no AI provider configured the server makes ZERO outbound network calls, and the AI routes answer 409 AI_NOT_CONFIGURED.
// Plus the lint rule (contract section 1): outbound network APIs are restricted outside packages/ai/src/transport.mjs.
//
// Method: a REAL server process (main.mjs) is started with `node --import ai-net-preload.mjs`; the preload wraps fetch, WebSocket, http(s).request/get,
// net.connect/createConnection/Socket#connect, tls.connect and dgram.createSocket and appends every call to a file. A spawned process (rather than an
// in-process server) keeps the test's own HTTP client out of the record: only the server's calls are logged. A positive control proves the recorder
// really sees each API, so "zero" cannot be a recorder that records nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ESLint } from 'eslint';
import { REPO_ROOT, snapshot } from './helpers.mjs';
import { AI, ARRIVAL, BOOK, KEY, freshLibrary, makeHome, startApp, stopAll } from './ai-helpers.mjs';

after(stopAll);

const PRELOAD = path.join(REPO_ROOT, 'apps', 'server', 'test', 'ai-net-preload.mjs');

test('the recorder sees every outbound API (positive control)', async () => {
  const home = await makeHome();
  await fs.mkdir(home.home, { recursive: true });
  const log = path.join(home.home, 'control.jsonl');
  const script = `
    import http, { request as namedRequest } from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    import dgram from 'node:dgram';
    const swallow = (x) => { try { const r = x(); r?.on?.('error', () => {}); r?.destroy?.(); r?.close?.(); r?.catch?.(() => {}); } catch {} };
    swallow(() => fetch('http://127.0.0.1:9/'));
    swallow(() => http.request({ host: '127.0.0.1', port: 9 }));
    swallow(() => http.get({ host: '127.0.0.1', port: 9 }));
    swallow(() => namedRequest({ host: '127.0.0.1', port: 9 }));
    swallow(() => https.request({ host: '127.0.0.1', port: 9 }));
    swallow(() => https.get({ host: '127.0.0.1', port: 9 }));
    swallow(() => net.connect(9, '127.0.0.1'));
    swallow(() => net.createConnection(9, '127.0.0.1'));
    swallow(() => tls.connect(9, '127.0.0.1'));
    swallow(() => dgram.createSocket('udp4'));
    setTimeout(() => process.exit(0), 200);
  `;
  const r = spawnSync(process.execPath, ['--import', new URL(`file:///${PRELOAD.replace(/\\/g, '/')}`).href, '--input-type=module', '-e', script], {
    env: { ...process.env, SF_NET_LOG: log },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  const apis = new Set((await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).api));
  for (const api of ['fetch', 'http.request', 'http.get', 'https.request', 'https.get', 'net.connect', 'net.createConnection', 'tls.connect', 'dgram.createSocket']) {
    assert.ok(apis.has(api), `${api} recorded (saw ${[...apis].join(', ')})`);
  }
});

test('no provider: every read route and every write route family makes zero outbound calls; AI routes are 409 AI_NOT_CONFIGURED', async () => {
  const library = await freshLibrary();
  const home = await makeHome(); // empty user config dir
  const app = await startApp({ library, home, net: true });
  const b = (p = '') => `/api/books/${BOOK}${p}`;

  // ---- every read route (status is not the point; each must be answered without touching the network)
  const reads = [
    '/api/health', '/api/status', '/api/library', '/api/library/recent', '/api/templates', '/api/search?q=maren', '/api/index/status', '/api/recover/last',
    '/api/books', b(), b('/diagnostics'), b('/continuity'), b('/repair/plan'), b('/objects'), b(`/scenes/${ARRIVAL}`), b(`/scenes/${ARRIVAL}/revisions`),
    b('/activity'), b('/threads'), b('/timeline'), b('/notes'), b('/scene-notes'), b('/graph'), b('/codex/types'), b('/codex/entries'), b('/mentions'),
    '/api/ai/profiles', // contract: no profile -> an empty list, never a call
  ];
  for (const p of reads) {
    const r = await app.get(p);
    assert.ok(r.status < 500, `GET ${p} -> ${r.status}: ${r.text.slice(0, 200)}`);
  }
  const profiles = await app.get('/api/ai/profiles');
  assert.equal(profiles.status, 200, profiles.text);
  assert.deepEqual(profiles.json.profiles ?? profiles.json, [], 'no profiles by default');

  // ---- every write route family
  const scene = (await app.get(b(`/scenes/${ARRIVAL}`))).json;
  const writes = [
    ['scenes: body', 'PUT', b(`/scenes/${ARRIVAL}/body`), { body: `${scene.body}\nAn added line.\n`, base_sha256: scene.sha256 }],
    ['scenes: create', 'POST', b('/scenes'), { chapter: 1, after: ARRIVAL, title: 'Zero Traffic', slug: 'zero-traffic', body: 'text\n' }],
    ['scenes: fields', 'POST', b(`/scenes/${KEY}/fields`), { status: 'revising' }],
    ['codex: create entry', 'POST', b('/entries'), { type: 'location', name: 'The Long Jetty', slug: 'long-jetty' }],
    ['timeline: create event', 'POST', b('/events'), { title: 'The ferry sinks', slug: 'ferry-sinks', order: 9000 }],
    ['notes: create', 'POST', b('/notes'), { kind: 'research', title: 'Harbour dredging', slug: 'harbour-dredging' }],
    ['threads: create', 'POST', b('/threads'), { title: 'The key', slug: 'the-key-thread' }],
    ['recover', 'POST', '/api/recover', {}],
    ['index rebuild', 'POST', '/api/index/rebuild', {}],
  ];
  const wrote = [];
  for (const [label, method, url, body] of writes) {
    const r = await (method === 'PUT' ? app.put(url, body) : app.post(url, body));
    assert.ok(r.status < 500, `${label}: ${r.status} ${r.text.slice(0, 200)}`);
    wrote.push(r.status < 300);
  }
  assert.ok(wrote.filter(Boolean).length >= 4, `most write families really executed (${wrote.join(',')})`);
  // continuity again after the writes, and export/backup when this branch has them (M05-J03 is a separate job: probed, not required)
  for (const p of [b('/continuity'), b('/export'), b('/backup')]) assert.ok((await app.get(p)).status < 500, p);

  // ---- AI routes: not configured
  const notConfigured = [
    ['POST', AI.context(), { task: 'chat', files: ['book.md'], instruction: 'hello' }],
    ['POST', AI.send(), { contextId: 'ctx_nope' }],
    ['POST', AI.apply(), { contextId: 'ctx_nope' }],
    ['POST', AI.discard(), { contextId: 'ctx_nope' }],
  ];
  for (const [method, url, body] of notConfigured) {
    const r = await app.post(url, body);
    assert.equal(r.status, 409, `${method} ${url}: ${r.text}`);
    assert.equal(r.json.code ?? r.json.error, 'AI_NOT_CONFIGURED', r.text);
  }

  const calls = await app.netCalls();
  assert.deepEqual(calls, [], `outbound calls recorded: ${JSON.stringify(calls)}`);
});

test('no provider: AI routes create nothing in the book (no ai/ folder, nothing changed by a refused request)', async () => {
  const library = await freshLibrary();
  const home = await makeHome();
  const app = await startApp({ library, home });
  const before = await snapshot(library, { skipStoryforge: true });
  const r = await app.post(AI.context(), { task: 'chat', files: ['book.md'], instruction: 'x' });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(await snapshot(library, { skipStoryforge: true }), before);
});

// ---------------------------------------------------------------- lint (contract section 1)
const eslint = new ESLint({ cwd: REPO_ROOT });
async function lintErrors(code, rel) {
  const [res] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, ...rel.split('/')) });
  return res.messages.filter((m) => m.severity === 2 && /restricted/.test(m.ruleId ?? ''));
}

for (const [label, code, rel] of [
  ['a planted fetch( in packages/format/src', 'export const x = () => fetch("http://example.com");\n', 'packages/format/src/planted.mjs'],
  ['a planted fetch( in packages/core/src', 'export const x = () => fetch("http://example.com");\n', 'packages/core/src/planted.mjs'],
  ['a planted fetch( in apps/server/src', 'export const x = () => fetch("http://example.com");\n', 'apps/server/src/planted.mjs'],
  ['globalThis.fetch in packages/store/src', 'export const x = () => globalThis.fetch("http://example.com");\n', 'packages/store/src/planted.mjs'],
  ['node:https in packages/core/src', 'import https from "node:https";\nexport const x = https;\n', 'packages/core/src/planted.mjs'],
  ['node:net in packages/continuity/src', 'import net from "node:net";\nexport const x = net;\n', 'packages/continuity/src/planted.mjs'],
  ['node:tls in packages/index/src', 'import tls from "node:tls";\nexport const x = tls;\n', 'packages/index/src/planted.mjs'],
  ['node:dgram in apps/server/src', 'import dgram from "node:dgram";\nexport const x = dgram;\n', 'apps/server/src/planted.mjs'],
  ['undici in packages/manuscript/src', 'import { fetch as f } from "undici";\nexport const x = f;\n', 'packages/manuscript/src/planted.mjs'],
  ['http.request in apps/server/src', 'import http from "node:http";\nexport const x = () => http.request("http://example.com");\n', 'apps/server/src/planted.mjs'],
  ['named http.get import in packages/templates/src', 'import { get } from "node:http";\nexport const x = get;\n', 'packages/templates/src/planted.mjs'],
]) {
  test(`lint: ${label} fails`, async () => {
    const errors = await lintErrors(code, rel);
    assert.ok(errors.length > 0, `expected a no-restricted-* error for ${rel}`);
  });
}

test('lint: the same fetch( is allowed in packages/ai/src/transport.mjs (the one network module)', async () => {
  assert.deepEqual(await lintErrors('export const x = () => fetch("http://example.com", { redirect: "error" });\n', 'packages/ai/src/transport.mjs'), []);
});

test('lint: apps/server/src/server.mjs keeps http.createServer', async () => {
  const code = await fs.readFile(path.join(REPO_ROOT, 'apps/server/src/server.mjs'), 'utf8');
  assert.deepEqual(await lintErrors(code, 'apps/server/src/server.mjs'), []);
  assert.ok(code.includes('http.createServer'), 'server.mjs still creates its server with http.createServer');
});

test('lint: only transport.mjs under packages/ and apps/server/src names an outbound network API (source scan, independent of the lint rule)', async () => {
  const hits = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'test' || e.name === 'fixtures') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(mjs|js|jsx)$/.test(e.name) && !/transport\.mjs$/.test(e.name)) {
        const text = await fs.readFile(full, 'utf8');
        if (/\bfetch\s*\(|from\s+['"](node:)?(https|net|tls|dgram)['"]|from\s+['"]undici['"]|\bhttps?\.(request|get)\s*\(/.test(text)) hits.push(path.relative(REPO_ROOT, full));
      }
    }
  };
  await walk(path.join(REPO_ROOT, 'packages'));
  await walk(path.join(REPO_ROOT, 'apps', 'server', 'src'));
  assert.deepEqual(hits, []);
});
