import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/index.mjs';

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
