// M08-J05: the release artifact installs and starts. Unzip it into a temp folder, `npm ci --omit=dev --offline` (from the local npm cache), start StoryForge on
// a copy of the sample and check that it answers. When the npm cache cannot satisfy the offline install the test skips with a notice rather than failing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzip } from '@storyforge/export';
import { FIXTURES, REPO_ROOT } from './helpers.mjs';
import { buildRelease } from '../../../scripts/release-build.mjs';

const built = fs.existsSync(path.join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-release-install-'));
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
after(async () => {
  if (child) {
    const gone = new Promise((r) => child?.once('exit', r));
    child.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('the unzipped release installs with npm ci --omit=dev --offline and serves the sample', { timeout: 300000, skip: built ? false : 'the web app is not built (run npm run build); install test skipped' }, async (t) => {
  const r = await buildRelease({ outDir: path.join(tmp, 'out') });
  const home = path.join(tmp, 'unzipped');
  for (const [name, bytes] of unzip(fs.readFileSync(r.zip))) {
    const dest = path.join(home, ...name.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  const app = path.join(home, `storyforge-${r.version}`);
  assert.ok(fs.existsSync(path.join(app, 'package-lock.json')));

  const install = spawnSync('npm ci --omit=dev --offline --ignore-scripts --no-audit --no-fund', { cwd: app, encoding: 'utf8', shell: true, timeout: 240000, windowsHide: true });
  if (install.status !== 0) {
    const why = `${install.stderr}${install.stdout}`.split('\n').find((l) => /ENOTCACHED|ENOTFOUND|EAI_AGAIN|offline|cache mode|network/i.test(l));
    if (why) {
      t.skip(`npm cache cannot satisfy an offline install here (${why.trim()}); the check runs wherever the cache is warm`);
      process.stdout.write(`NOTICE: release install test skipped: ${why.trim()}\n`);
      return;
    }
    assert.fail(`npm ci --omit=dev --offline failed (${install.status}):\n${install.stderr}\n${install.stdout}`);
  }
  assert.ok(!fs.existsSync(path.join(app, 'node_modules', 'vite')), 'development dependencies are not installed');
  assert.ok(fs.existsSync(path.join(app, 'node_modules', '@storyforge', 'core')), 'the workspace packages are linked');

  const library = path.join(tmp, 'salt-orchard');
  fs.cpSync(path.join(FIXTURES, 'valid', 'salt-orchard'), library, { recursive: true });
  const config = path.join(tmp, 'config');
  child = spawn(process.execPath, [path.join(app, 'apps', 'server', 'src', 'main.mjs'), '--library', library, '--port', '0'], {
    cwd: app,
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
  assert.ok(port, `the server did not start:\n${out}`);
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Host: `127.0.0.1:${port}` } });
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /<div id="root">/);
  const health = await get('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});
