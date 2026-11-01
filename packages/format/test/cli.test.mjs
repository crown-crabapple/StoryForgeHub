import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, VALID, INVALID } from './helpers.mjs';

const run = (...args) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 30000 });

const SALT = path.join(VALID, 'salt-orchard');
const E204 = path.join(INVALID, 'E204-duplicate-sequence');

test('exit 0 on a valid project; JSON has no diagnostics', () => {
  const r = run(SALT);
  assert.equal(r.status, 0, r.stderr);
  const j = run(SALT, '--json');
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(JSON.parse(j.stdout).diagnostics, []);
});

test('exit 1 on a project with an error; text output is one diagnostic per line', () => {
  const r = run(E204);
  assert.equal(r.status, 1, r.stderr);
  const e204 = r.stdout.split('\n').filter((l) => l.startsWith('E204 error '));
  assert.equal(e204.length, 2, r.stdout);
  for (const l of e204) assert.ok(l.includes('sequence'), l);
});

test('--json prints the full Result and still exits 1 on errors', () => {
  const r = run(E204, '--json');
  assert.equal(r.status, 1, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.ok(Array.isArray(result.books));
  assert.deepEqual(
    result.diagnostics.map((d) => [d.code, d.severity, d.location]),
    [['E204', 'error', 'sequence'], ['E204', 'error', 'sequence']],
  );
  assert.equal(run('--json', E204).status, 1, 'flag order must not matter');
});

test('warnings and info alone exit 0', () => {
  const spec = run(path.join(VALID, 'spec-example'), '--json');
  assert.equal(spec.status, 0, spec.stderr);
  assert.equal(JSON.parse(spec.stdout).diagnostics.length, 4);
  assert.equal(run(path.join(INVALID, 'W204-bom')).status, 0);
});

test('exit 2 with no arguments, usage not on stdout', () => {
  const r = run();
  assert.equal(r.status, 2);
  assert.equal(r.stdout.trim(), '');
});

test('exit 2 when only a flag is given', () => {
  assert.equal(run('--json').status, 2);
});
