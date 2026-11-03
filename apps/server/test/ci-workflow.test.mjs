// M08-J05: the GitHub Actions workflow and the local CI script say the same thing. The workflow is never run here (no remote), so this is its check:
// it parses, runs on the three systems with Node 24 and an npm cache, and calls `npm run ci -- --install`; the script's steps come in the contract's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT } from './helpers.mjs';
import { GROUPS, buildSteps, resolveFiles } from '../../../scripts/ci.mjs';

const workflow = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

test('the workflow parses and runs the CI job on ubuntu, windows and macos', () => {
  const job = workflow.jobs.ci;
  assert.ok(job, 'a job named ci');
  assert.equal(job.strategy['fail-fast'], false, 'one system failing does not hide the others');
  assert.deepEqual([...job.strategy.matrix.os].sort(), ['macos-latest', 'ubuntu-latest', 'windows-latest']);
  assert.equal(job['runs-on'], '${{ matrix.os }}');
});

test('the workflow uses Node 24, caches npm and runs npm run ci with --install', () => {
  const steps = workflow.jobs.ci.steps;
  const setup = steps.find((s) => String(s.uses).startsWith('actions/setup-node@'));
  assert.ok(setup, 'setup-node step');
  assert.equal(String(setup.with['node-version']), '24');
  assert.equal(setup.with.cache, 'npm');
  assert.ok(steps.some((s) => String(s.uses).startsWith('actions/checkout@')));
  const ci = steps.filter((s) => typeof s.run === 'string' && /npm run ci\b/.test(s.run));
  assert.equal(ci.length, 1);
  assert.equal(ci[0].run.trim(), 'npm run ci -- --install');
  assert.equal(workflow.permissions.contents, 'read', 'least privilege');
});

test('the root package has the ci and release:build scripts the workflow and checklist name', () => {
  assert.equal(rootPkg.scripts.ci, 'node scripts/ci.mjs');
  assert.equal(rootPkg.scripts['release:build'], 'node scripts/release-build.mjs');
});

test('ci.mjs runs the contract steps in order', () => {
  const names = buildSteps({ install: true, skipAudit: false }).map((s) => s.name);
  const order = ['install (npm ci)', 'lockfile in sync', 'build', 'lint', 'test', 'test:large'];
  assert.deepEqual(names.slice(0, order.length), order);
  const rest = names.slice(order.length);
  assert.deepEqual(rest.filter((n) => n.startsWith('group: ')), GROUPS.map((g) => `group: ${g.name}`));
  const after = rest.filter((n) => !n.startsWith('group: '));
  assert.deepEqual(after, ['UI smoke', 'security: npm audit', 'security: licences', 'security: secret scan', 'security: network boundary', 'release build']);
  assert.equal(buildSteps({ install: false, skipAudit: false })[0].name, 'lockfile in sync', 'no npm ci unless asked');
});

test('every named test group matches real test files', () => {
  const names = GROUPS.map((g) => g.name);
  for (const want of ['format fixtures', 'atomic write', 'rebuild', 'import', 'export', 'plugin and webhook', 'shared-mode proof']) assert.ok(names.includes(want), want);
  for (const g of GROUPS) {
    for (const pattern of g.files) assert.ok(resolveFiles([pattern]).length > 0, `${g.name}: ${pattern} matches nothing`);
  }
});
