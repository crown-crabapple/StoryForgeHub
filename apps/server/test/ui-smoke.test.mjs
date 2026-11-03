// M08-J05 UI smoke (also its own step in `npm run ci`): start the server on a temp copy of the sample on port 0, then fetch the index HTML, a deep app route and
// /api/health, and stop it. The index and the deep route must be the built app shell (200). Needs the built web app (npm run build); without it the test skips with a notice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURES, REPO_ROOT } from './helpers.mjs';
import { MAIN } from './proc-helpers.mjs';

const built = fs.existsSync(path.join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ui-smoke-'));
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
after(async () => {
  if (child && child.exitCode === null) {
    const gone = new Promise((r) => child?.once('exit', r));
    child.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the server on a copy of the sample serves the app shell, a deep route and /api/health', { timeout: 60000, skip: built ? false : 'the web app is not built (run npm run build); UI smoke skipped' }, async () => {
  const library = path.join(tmp, 'salt-orchard');
  fs.cpSync(path.join(FIXTURES, 'valid', 'salt-orchard'), library, { recursive: true });
  const config = path.join(tmp, 'config');
  child = spawn(process.execPath, [MAIN, '--library', library, '--port', '0'], {
    cwd: REPO_ROOT,
    env: { ...process.env, STORYFORGE_TEST_CONFIG: config, APPDATA: path.join(config, 'AppData'), XDG_CONFIG_HOME: path.join(config, 'xdg') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (out += d));
  let port = 0;
  for (let i = 0; i < 600 && !port; i++) {
    const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
    if (m) port = Number(m[1]);
    else if (child.exitCode !== null) assert.fail(`the server exited early (${child.exitCode}):\n${out}`);
    else await new Promise((res) => setTimeout(res, 50));
  }
  assert.ok(port, `the server did not start in 30 s:\n${out}`);
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Host: `127.0.0.1:${port}` } });

  const index = await get('/');
  const html = await index.text();
  assert.equal(index.status, 200, 'GET /');
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(html.includes('<div id="root">'), 'the app shell has its root element');
  assert.match(html, /<script[^>]+type="module"[^>]+src="\/assets\//, 'and the built script');

  const script = /<script[^>]+src="(\/assets\/[^"]+)"/.exec(html)?.[1];
  assert.equal((await get(/** @type {string} */ (script))).status, 200, 'the built script is served');

  const deep = await get('/books/salt-orchard/codex');
  assert.equal(deep.status, 200, 'GET a deep app route');
  assert.ok((await deep.text()).includes('<div id="root">'), 'a deep route returns the app shell');

  const health = await get('/api/health');
  assert.equal(health.status, 200, 'GET /api/health');
  assert.equal((await health.json()).ok, true);

  assert.equal((await get('/assets/does-not-exist.js')).status, 404, 'a missing file is a real 404, not the app shell');
});
