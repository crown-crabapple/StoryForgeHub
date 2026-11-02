import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/index.mjs';

const norm = (p) => p.replace(/\\/g, '/');

test('--library arg beats STORYFORGE_LIBRARY env', () => {
  const c = loadConfig({ argv: ['--library', '/from/arg'], env: { STORYFORGE_LIBRARY: '/from/env' } });
  assert.ok(norm(c.libraryRoot).endsWith('/from/arg'));
});

test('env is used when no arg', () => {
  const c = loadConfig({ argv: [], env: { STORYFORGE_LIBRARY: '/from/env' } });
  assert.ok(norm(c.libraryRoot).endsWith('/from/env'));
});

test('default port 4317 and host 127.0.0.1', () => {
  const c = loadConfig({ argv: ['--library', '/x'], env: {} });
  assert.equal(c.port, 4317);
  assert.equal(c.host, '127.0.0.1');
});

test('--port beats STORYFORGE_PORT; env used otherwise', () => {
  assert.equal(loadConfig({ argv: ['--library', '/x', '--port', '5000'], env: { STORYFORGE_PORT: '6000' } }).port, 5000);
  assert.equal(loadConfig({ argv: ['--library', '/x'], env: { STORYFORGE_PORT: '6000' } }).port, 6000);
});

test('host cannot be changed by flag or env', () => {
  const c = loadConfig({ argv: ['--library', '/x', '--host', '0.0.0.0'], env: { STORYFORGE_HOST: '0.0.0.0' } });
  assert.equal(c.host, '127.0.0.1');
});

test('missing library throws a clear error', () => {
  assert.throws(() => loadConfig({ argv: [], env: {} }), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /library/i);
    return true;
  });
});

// ---- M06-J03: resolveConfig (no --library: the library used last, else a default folder, else a clear error) ----
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig, defaultLibraryRoot } from '../src/index.mjs';

async function withConfigDir(paths, fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-cfg-'));
  const saved = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.APPDATA = path.join(home, 'AppData');
  process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
  try {
    if (paths) {
      const dir = process.platform === 'win32' ? path.join(process.env.APPDATA, 'StoryForge') : path.join(process.env.XDG_CONFIG_HOME, 'storyforge');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'recent.json'), JSON.stringify({ version: 1, paths: paths(home) }));
    }
    return await fn(home);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('resolveConfig: --library and the variable win, and say where the library came from', async () => {
  await withConfigDir((home) => [home], async () => {
    const a = await resolveConfig({ argv: ['--library', '/from/arg'], env: { STORYFORGE_LIBRARY: '/from/env' } });
    assert.ok(norm(a.libraryRoot).endsWith('/from/arg'));
    assert.equal(a.source, 'flag');
    const e = await resolveConfig({ argv: [], env: { STORYFORGE_LIBRARY: '/from/env' } });
    assert.equal(e.source, 'env');
  });
});

test('resolveConfig: without either, the newest remembered library that still exists', async () => {
  await withConfigDir((home) => [path.join(home, 'gone'), home], async (home) => {
    const c = await resolveConfig({ argv: ['--port', '5000'], env: {} });
    assert.equal(c.source, 'recent');
    assert.equal(c.libraryRoot, path.resolve(home));
    assert.equal(c.port, 5000);
  });
});

test('resolveConfig: nothing remembered gives the home-folder default for serve, and the clear error for the commands that change files', async () => {
  await withConfigDir(null, async () => {
    const d = await resolveConfig({ argv: [], env: {}, fallback: 'default' });
    assert.equal(d.source, 'default');
    assert.equal(d.libraryRoot, defaultLibraryRoot());
    assert.equal(path.basename(d.libraryRoot), 'StoryForge');
    await assert.rejects(resolveConfig({ argv: [], env: {} }), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /--library/);
      assert.match(err.message, /STORYFORGE_LIBRARY/);
      return true;
    });
  });
});
