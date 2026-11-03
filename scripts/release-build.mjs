// npm run release:build: dist/storyforge-<version>.zip and dist/storyforge-<version>.zip.sha256, from the working tree.
// The zip holds the built web app, the server and package sources, package.json and package-lock.json, the launchers, scripts/, deploy/, docs/,
// LICENSE, README.md and CHANGELOG.md (plus .nvmrc and .dockerignore, which the launchers and deploy/Dockerfile read). No tests, fixtures, node_modules, .git,
// local settings or build output other than apps/web/dist. Deterministic: entries sorted by path, fixed timestamps (the zip writer of @storyforge/export), bytes read as they are.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeZip } from '@storyforge/export';
import { writeWorkFile } from '@storyforge/store';
import { REPO_ROOT, listPackages } from './workspaces.mjs';

/** Folders that are never shipped, wherever they are. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.storyforge', '.work', 'test', 'tests', 'fixtures', 'dist', 'coverage']);
const SKIP_FILE = /(\.test\.mjs|\.large\.mjs|\.env|\.zip|\.sha256|\.log)$/;
const ROOT_FILES = ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'CHANGELOG.md', 'StoryForge.cmd', 'storyforge.sh', '.nvmrc', '.dockerignore'];
const ROOT_DIRS = ['scripts', 'deploy', 'docs'];
/** Local files inside deploy/ that a person creates from the examples; never packaged (see .gitignore). */
const LOCAL_DEPLOY = new Set(['deploy/library', 'deploy/config', 'deploy/shared-data', 'deploy/storyforge.env']);

/** @param {string} root @param {string} rel posix path of a folder, @param {string[]} out */
function walk(root, rel, out, { keepDist = false } = {}) {
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = `${rel}/${e.name}`;
    if (LOCAL_DEPLOY.has(childRel)) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) && !(keepDist && e.name === 'dist')) continue;
      walk(root, childRel, out, { keepDist });
    } else if (e.isFile() && !SKIP_FILE.test(e.name)) {
      out.push(childRel);
    }
  }
}

/**
 * @param {string} root
 * @returns {string[]} the posix paths of every file to ship, sorted
 */
export function releaseFiles(root) {
  const files = [];
  for (const f of ROOT_FILES) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`release: ${f} is missing`);
    files.push(f);
  }
  for (const d of ROOT_DIRS) walk(root, d, files);
  for (const p of listPackages(root)) {
    if (!p.dir) continue;
    if (p.dir === 'apps/web') {
      files.push('apps/web/package.json');
      if (!fs.existsSync(path.join(root, 'apps/web/dist/index.html'))) throw new Error('release: the web app is not built (apps/web/dist/index.html is missing); run npm run build');
      walk(root, 'apps/web/dist', files, { keepDist: true });
    } else {
      walk(root, p.dir, files);
    }
  }
  return [...new Set(files)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @param {{ root?: string, outDir?: string }} [options]
 * @returns {Promise<{ version: string, zip: string, sha256File: string, sha256: string, files: string[] }>}
 */
export async function buildRelease({ root = REPO_ROOT, outDir = path.join(root, 'dist') } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const files = releaseFiles(root);
  const zipName = `storyforge-${version}.zip`;
  const prefix = `storyforge-${version}/`;
  const bytes = writeZip(files.map((f) => ({ name: prefix + f, data: fs.readFileSync(path.join(root, ...f.split('/'))) })));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const zip = path.join(outDir, zipName);
  const sha256File = `${zip}.sha256`;
  await writeWorkFile(zip, bytes);
  await writeWorkFile(sha256File, `${sha256}  ${zipName}\n`);
  return { version, zip, sha256File, sha256, files: files.map((f) => prefix + f) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await buildRelease();
    process.stdout.write(`release ${r.version}: ${path.relative(REPO_ROOT, r.zip)} (${r.files.length} files)\nsha256 ${r.sha256}\n`);
  } catch (e) {
    process.stderr.write(`release: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}
