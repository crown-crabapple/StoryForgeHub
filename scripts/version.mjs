// node scripts/version.mjs <x.y.z>: set the version of the root and every workspace in step. It also moves the exact "@storyforge/*"
// dependency pins and package-lock.json, so `npm ci` still accepts the lockfile. Prints what it changed; writes nothing when the version is not x.y.z.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeWorkFile } from '@storyforge/store';
import { REPO_ROOT, listPackages } from './workspaces.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** Rewrite the exact pin of every workspace package inside one dependency map. @param {any} json @param {Set<string>} names @param {string} version @returns {boolean} */
function repin(json, names, version) {
  let changed = false;
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(json[field] ?? {})) {
      const spec = json[field][name];
      if (names.has(name) && /^\d/.test(spec) && spec !== version) {
        json[field][name] = version;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * @param {string} root
 * @param {string} version
 * @returns {Promise<string[]>} the files changed, relative to root (written through @storyforge/store, the single writer)
 */
export async function setVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version like 1.2.3`);
  const pkgs = listPackages(root);
  const names = new Set(pkgs.map((p) => p.json.name));
  const changed = [];
  for (const p of pkgs) {
    const before = JSON.stringify(p.json);
    p.json.version = version;
    repin(p.json, names, version);
    if (JSON.stringify(p.json) !== before) {
      await writeWorkFile(p.file, `${JSON.stringify(p.json, null, 2)}\n`);
      changed.push(path.posix.join(p.dir, 'package.json'));
    }
  }
  const lockFile = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const before = JSON.stringify(lock);
    lock.version = version;
    for (const p of pkgs) {
      const entry = lock.packages?.[p.dir];
      if (!entry) continue;
      entry.version = version;
      repin(entry, names, version);
    }
    if (JSON.stringify(lock) !== before) {
      await writeWorkFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
      changed.push('package-lock.json');
    }
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version || process.argv.length > 3) {
    process.stderr.write('usage: node scripts/version.mjs <x.y.z>\n');
    process.exit(2);
  }
  try {
    const changed = await setVersion(REPO_ROOT, version);
    process.stdout.write(changed.length ? `version ${version}: changed ${changed.join(', ')}\n` : `version ${version}: nothing to change\n`);
  } catch (e) {
    process.stderr.write(`version: ${e instanceof Error ? e.message : e}\n`);
    process.exit(2);
  }
}
