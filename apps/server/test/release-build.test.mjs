// M08-J05: the release zip is deterministic, holds what the contract lists and nothing it forbids, and is checked by a .sha256 file.
// Needs the built web app (npm run build; npm run ci builds first). Without it these tests skip with a notice.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzip } from '@storyforge/export';
import { REPO_ROOT } from './helpers.mjs';
import { buildRelease, releaseFiles } from '../../../scripts/release-build.mjs';

const built = fs.existsSync(path.join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html'));
const skip = built ? false : 'the web app is not built (run npm run build); release tests skipped';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-release-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const prefix = `storyforge-${version}/`;

test('building twice gives the same sha256, and the .sha256 file matches the zip', { skip }, async () => {
  const a = await buildRelease({ outDir: path.join(tmp, 'a') });
  const first = fs.readFileSync(a.zip);
  const b = await buildRelease({ outDir: path.join(tmp, 'b') });
  assert.equal(a.sha256, b.sha256);
  assert.ok(first.equals(fs.readFileSync(b.zip)), 'byte-identical');
  assert.equal(createHash('sha256').update(first).digest('hex'), a.sha256);
  assert.equal(path.basename(a.zip), `storyforge-${version}.zip`);
  assert.equal(fs.readFileSync(a.sha256File, 'utf8'), `${a.sha256}  storyforge-${version}.zip\n`);
  assert.deepEqual(a.files, b.files);
});

test('the file list is sorted, under one folder, with the fixed timestamp', { skip }, async () => {
  const r = await buildRelease({ outDir: path.join(tmp, 'order') });
  assert.deepEqual(r.files, [...r.files].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
  assert.ok(r.files.every((f) => f.startsWith(prefix)));
  const bytes = fs.readFileSync(r.zip);
  assert.equal(bytes.readUInt16LE(10), 0, 'DOS time 00:00:00');
  assert.equal(bytes.readUInt16LE(12), (0 << 9) | (1 << 5) | 1, 'DOS date 1980-01-01');
});

test('the contents are what the contract lists', { skip }, async () => {
  const r = await buildRelease({ outDir: path.join(tmp, 'contents') });
  const files = unzip(fs.readFileSync(r.zip));
  const names = [...files.keys()];
  assert.deepEqual(names, r.files, 'the zip holds exactly the listed files');
  const has = (rel) => assert.ok(files.has(prefix + rel), `${rel} is in the zip`);
  for (const rel of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'CHANGELOG.md', 'StoryForge.cmd', 'storyforge.sh', 'scripts/launch.mjs', 'scripts/start.mjs',
    'deploy/Dockerfile', 'deploy/compose.yaml', 'deploy/entrypoint.mjs', 'docs/install.md', 'docs/compatibility.md', 'docs/release-checklist.md', 'docs/release-notes/0.1.0.md',
    'apps/server/package.json', 'apps/server/src/main.mjs', 'apps/web/package.json', 'apps/web/dist/index.html', 'packages/core/src/index.mjs', 'packages/store/src/index.mjs',
    'packages/templates/package.json']) has(rel);
  assert.ok(names.some((n) => n.startsWith(`${prefix}apps/web/dist/assets/`)), 'the built web assets');
  assert.ok(names.some((n) => n.startsWith(`${prefix}packages/templates/templates/`)), 'the template folders that ship with the app');
  for (const rel of ['package.json', 'LICENSE', 'CHANGELOG.md', 'StoryForge.cmd']) {
    assert.ok(files.get(prefix + rel).equals(fs.readFileSync(path.join(REPO_ROOT, rel))), `${rel} is byte-identical to the tree`);
  }
  const root = JSON.parse(files.get(`${prefix}package.json`).toString('utf8'));
  assert.equal(root.version, version);
  assert.equal(root.license, 'AGPL-3.0-only');
});

test('no tests, fixtures, node_modules, .git, local settings or web sources are included', { skip }, async () => {
  const r = await buildRelease({ outDir: path.join(tmp, 'excluded') });
  for (const name of r.files) {
    const rel = name.slice(prefix.length);
    const parts = rel.split('/');
    for (const bad of ['node_modules', '.git', 'test', 'tests', 'fixtures', '.storyforge', '.work', 'coverage']) assert.ok(!parts.includes(bad), `${rel} is inside a ${bad} folder`);
    assert.ok(!/\.(test|large)\.mjs$/.test(rel), rel);
    assert.ok(!/\.env$|\.zip$|\.sha256$/.test(rel), rel);
    assert.ok(!rel.startsWith('dist/'), 'the release folder is not packed into itself');
    assert.ok(!rel.startsWith('apps/web/src/') && !rel.startsWith('bench/') && !rel.startsWith('examples/') && !rel.startsWith('tools/'), rel);
    assert.ok(!/^deploy\/(library|config|shared-data|storyforge\.env)(\/|$)/.test(rel), rel);
  }
  assert.ok(r.files.length > 100, `${r.files.length} files`);
});

test('releaseFiles refuses to run when the web app is not built', async () => {
  const empty = fs.mkdtempSync(path.join(tmp, 'tree-'));
  for (const f of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'CHANGELOG.md', 'StoryForge.cmd', 'storyforge.sh', '.nvmrc', '.dockerignore']) fs.writeFileSync(path.join(empty, f), '{}');
  for (const d of ['scripts', 'deploy', 'docs']) fs.mkdirSync(path.join(empty, d));
  fs.mkdirSync(path.join(empty, 'apps', 'web'), { recursive: true });
  fs.writeFileSync(path.join(empty, 'apps', 'web', 'package.json'), JSON.stringify({ name: '@storyforge/web', version: '0.0.0' }));
  assert.throws(() => releaseFiles(empty), /web app is not built/);
});
