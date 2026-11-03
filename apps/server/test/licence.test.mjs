// M08-J05: the licence is AGPL-3.0-only everywhere, the lockfile is in sync, and production dependencies are under licences that fit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT } from './helpers.mjs';
import { LICENSE_ALLOW, checkLicenses, checkLockfile, licenseAllowed } from '../../../scripts/checks.mjs';
import { listPackages } from '../../../scripts/workspaces.mjs';

test('LICENSE is the full, unmodified GNU AGPL version 3', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'LICENSE'), 'utf8');
  assert.match(text, /^\s+GNU AFFERO GENERAL PUBLIC LICENSE\n\s+Version 3, 19 November 2007\n/);
  for (let n = 0; n <= 17; n++) assert.match(text, new RegExp(`^  ${n}\\. [A-Z]`, 'm'), `section ${n}`);
  for (const phrase of ['13. Remote Network Interaction; Use with the GNU General Public License.', 'END OF TERMS AND CONDITIONS', 'How to Apply These Terms to Your New Programs']) {
    assert.ok(text.includes(phrase), phrase);
  }
  assert.equal(Buffer.byteLength(text), 34523, 'the official agpl-3.0.txt is 34523 bytes');
});

test('the root and every workspace package.json declares AGPL-3.0-only', () => {
  const pkgs = listPackages(REPO_ROOT);
  assert.ok(pkgs.length >= 15, `found ${pkgs.length} package.json files`);
  assert.equal(pkgs[0].dir, '');
  for (const p of pkgs) assert.equal(p.json.license, 'AGPL-3.0-only', `${p.dir || 'root'} (${p.json.name})`);
});

test('every workspace has the same version as the root', () => {
  const pkgs = listPackages(REPO_ROOT);
  for (const p of pkgs) assert.equal(p.json.version, pkgs[0].json.version, p.json.name);
});

test('package-lock.json is in sync with every package.json', () => {
  assert.deepEqual(checkLockfile(REPO_ROOT), []);
});

test('checkLockfile reports a version or dependency that drifted', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lock-'));
  try {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0', dependencies: { yaml: '2.9.1' } }));
    const lock = { packages: { '': { name: 'r', version: '1.0.0', dependencies: { yaml: '2.9.1' } }, 'node_modules/yaml': { version: '2.9.1' } } };
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify(lock));
    assert.deepEqual(checkLockfile(tmp), []);
    lock.packages[''].version = '1.0.1';
    lock.packages['node_modules/yaml'].version = '2.9.0';
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify(lock));
    const problems = checkLockfile(tmp);
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /version 1\.0\.0 in package\.json, 1\.0\.1/);
    assert.match(problems.join('\n'), /pinned to 2\.9\.1 but the lockfile has 2\.9\.0/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the licence allow-list: permissive, AGPL family, SPDX expressions; not proprietary or unknown', () => {
  for (const ok of ['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause', 'AGPL-3.0-only', '(MIT OR GPL-2.0-only)', 'MIT AND Zlib', '(BSD-2-Clause OR MIT OR Apache-2.0)']) assert.ok(licenseAllowed(ok), ok);
  for (const bad of ['UNLICENSED', 'SEE LICENSE IN LICENSE.txt', 'GPL-2.0-only', 'CC-BY-NC-4.0', 'SSPL-1.0', 'MIT AND GPL-2.0-only', 'BUSL-1.1']) assert.ok(!licenseAllowed(bad), bad);
  assert.ok(LICENSE_ALLOW.has('OFL-1.1'), 'the bundled font packages');
});

test('every installed production dependency has an allowed licence', () => {
  const r = checkLicenses(REPO_ROOT);
  assert.deepEqual(r.problems, []);
  assert.ok(r.checked >= 20, `checked ${r.checked}`);
});
