// The repository's package.json files: the root and every workspace (apps/*, packages/*). Shared by ci.mjs, version.mjs and release-build.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} [root]
 * @returns {{ dir: string, file: string, json: any }[]} the root first (dir ''), then every workspace in sorted order; `dir` uses forward slashes
 */
export function listPackages(root = REPO_ROOT) {
  const dirs = [];
  for (const group of ['apps', 'packages']) {
    const base = path.join(root, group);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base).sort()) {
      if (fs.existsSync(path.join(base, name, 'package.json'))) dirs.push(`${group}/${name}`);
    }
  }
  return ['', ...dirs].map((dir) => {
    const file = path.join(root, dir, 'package.json');
    return { dir, file, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
  });
}
