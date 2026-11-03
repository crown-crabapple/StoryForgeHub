// Checks that need no network, used by ci.mjs and tested on their own: the lockfile is in sync with every package.json, and every
// production dependency is under a licence that can sit inside an AGPL-3.0 program.
import fs from 'node:fs';
import path from 'node:path';
import { listPackages } from './workspaces.mjs';

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * npm ci refuses a lockfile that disagrees with a package.json. This compares them without the network: name, version and the
 * declared dependency maps of the root and every workspace, and that each exact pin has a lock entry with that version.
 * @param {string} root
 * @returns {string[]} problems (empty when in sync)
 */
export function checkLockfile(root) {
  const lockFile = path.join(root, 'package-lock.json');
  if (!fs.existsSync(lockFile)) return ['package-lock.json is missing'];
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const problems = [];
  const names = new Set();
  const pkgs = listPackages(root);
  for (const p of pkgs) names.add(p.json.name);
  for (const p of pkgs) {
    const where = p.dir || 'root';
    const entry = lock.packages?.[p.dir];
    if (!entry) {
      problems.push(`${where}: not in package-lock.json`);
      continue;
    }
    if (entry.version !== p.json.version) problems.push(`${where}: version ${p.json.version} in package.json, ${entry.version} in the lockfile`);
    for (const field of DEP_FIELDS) {
      const want = JSON.stringify(Object.entries(p.json[field] ?? {}).sort());
      const have = JSON.stringify(Object.entries(entry[field] ?? {}).sort());
      if (want !== have) problems.push(`${where}: ${field} differ between package.json and the lockfile`);
    }
    for (const [name, spec] of Object.entries({ ...p.json.dependencies, ...p.json.devDependencies })) {
      if (names.has(name) || !/^\d+\.\d+\.\d+$/.test(spec)) continue;
      const found = lock.packages?.[`${p.dir ? `${p.dir}/` : ''}node_modules/${name}`] ?? lock.packages?.[`node_modules/${name}`];
      if (!found) problems.push(`${where}: ${name} is not in the lockfile`);
      else if (found.version !== spec) problems.push(`${where}: ${name} is pinned to ${spec} but the lockfile has ${found.version}`);
    }
  }
  return problems;
}

/** SPDX identifiers that may be combined with AGPL-3.0: permissive licences, public-domain dedications, and the AGPL/GPL family itself. */
export const LICENSE_ALLOW = new Set([
  'MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense',
  'Python-2.0', 'Zlib', 'CC-BY-4.0',
  'OFL-1.1', // the two @fontsource-variable font packages: an open font licence, allowed for fonts that ship with an application
  'AGPL-3.0-only', 'AGPL-3.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
]);

/** @param {any} pkg @returns {string | null} the SPDX expression the package declares */
function declaredLicense(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && !Array.isArray(l) && typeof l.type === 'string') return l.type;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : x?.type)).filter(Boolean).join(' OR ') || null;
  return null;
}

/** Is an SPDX expression ("MIT", "(MIT OR Apache-2.0)", "A AND B") allowed? OR needs one allowed side, AND needs both. @param {string} expr */
export function licenseAllowed(expr) {
  const flat = expr.replace(/[()]/g, ' ').trim();
  return flat.split(/\s+OR\s+/i).some((alt) => alt.split(/\s+AND\s+/i).every((id) => LICENSE_ALLOW.has(id.trim())));
}

/**
 * Every production dependency in the lockfile (not dev-only, not a workspace link), read from its installed package.json.
 * @param {string} root
 * @returns {{ checked: number, optionalMissing: string[], problems: string[] }}
 */
export function checkLicenses(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const problems = [];
  const optionalMissing = [];
  let checked = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.includes('node_modules/') || entry.link || entry.dev) continue;
    const file = path.join(root, ...key.split('/'), 'package.json');
    if (!fs.existsSync(file)) {
      if (entry.optional || entry.devOptional) optionalMissing.push(key.replace(/^.*node_modules\//, ''));
      else problems.push(`${key}: not installed (run npm ci)`);
      continue;
    }
    checked++;
    const expr = declaredLicense(JSON.parse(fs.readFileSync(file, 'utf8')));
    const name = key.replace(/^.*node_modules\//, '');
    if (!expr) problems.push(`${name}: declares no licence`);
    else if (!licenseAllowed(expr)) problems.push(`${name}: licence "${expr}" is not on the AGPL-3.0 compatible allow-list`);
  }
  return { checked, optionalMissing, problems };
}
