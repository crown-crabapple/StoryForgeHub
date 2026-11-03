// M08-J05: scripts/version.mjs sets every workspace version in step (package.json files, the exact @storyforge pins and the lockfile), and refuses a bad version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './helpers.mjs';
import { checkLockfile } from '../../../scripts/checks.mjs';
import { setVersion } from '../../../scripts/version.mjs';
import { listPackages } from '../../../scripts/workspaces.mjs';

/** A scratch copy of every package.json and the lockfile (nothing else is needed). */
function scratchRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-version-'));
  for (const p of listPackages(REPO_ROOT)) {
    fs.mkdirSync(path.join(tmp, p.dir), { recursive: true });
    fs.copyFileSync(p.file, path.join(tmp, p.dir, 'package.json'));
  }
  fs.copyFileSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(tmp, 'package-lock.json'));
  return tmp;
}

test('setVersion moves the root, every workspace, the internal pins and the lockfile together', async () => {
  const tmp = scratchRepo();
  try {
    const changed = await setVersion(tmp, '1.2.3');
    assert.ok(changed.includes('package.json') && changed.includes('package-lock.json') && changed.includes('packages/core/package.json'), changed.join(', '));
    const pkgs = listPackages(tmp);
    assert.ok(pkgs.length >= 15);
    const names = new Set(pkgs.map((p) => p.json.name));
    for (const p of pkgs) {
      assert.equal(p.json.version, '1.2.3', p.json.name);
      for (const field of ['dependencies', 'devDependencies']) {
        for (const [dep, spec] of Object.entries(p.json[field] ?? {})) if (names.has(dep) && /^\d/.test(spec)) assert.equal(spec, '1.2.3', `${p.json.name} -> ${dep}`);
      }
    }
    assert.equal(pkgs.find((p) => p.json.name === '@storyforge/manuscript').json.dependencies['@storyforge/format'], 'file:../format', 'file: links are left alone');
    assert.equal(pkgs.find((p) => p.json.name === '@storyforge/core').json.dependencies.yaml, '2.9.1', 'outside packages are left alone');
    assert.deepEqual(checkLockfile(tmp), [], 'the lockfile still agrees with every package.json');
    const lock = JSON.parse(fs.readFileSync(path.join(tmp, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '1.2.3');
    assert.equal(lock.packages['apps/server'].version, '1.2.3');
    assert.equal(lock.packages['apps/server'].dependencies['@storyforge/core'], '1.2.3');
    // every other byte stays: going back gives the original files
    await setVersion(tmp, '0.1.0');
    for (const p of listPackages(REPO_ROOT)) assert.equal(fs.readFileSync(path.join(tmp, p.dir, 'package.json'), 'utf8'), fs.readFileSync(p.file, 'utf8'), p.dir || 'root');
    assert.equal(fs.readFileSync(path.join(tmp, 'package-lock.json'), 'utf8'), fs.readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a version that is not x.y.z is refused and nothing is written', async () => {
  const tmp = scratchRepo();
  try {
    const before = fs.readFileSync(path.join(tmp, 'package.json'), 'utf8');
    for (const bad of ['1.2', 'v1.2.3', '1.2.x', '', 'latest']) await assert.rejects(() => setVersion(tmp, bad), /not a version/);
    assert.equal(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the command line refuses a missing or bad version with exit 2 and changes nothing', () => {
  const script = path.join(REPO_ROOT, 'scripts', 'version.mjs');
  const before = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  for (const args of [[], ['nope'], ['1.2.3', 'extra']]) {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage|not a version/);
  }
  assert.equal(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'), before);
});
