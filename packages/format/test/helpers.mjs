// Shared helpers for the format tests. Contains no tests itself.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG = path.resolve(HERE, '..');
export const FIXTURES = path.join(PKG, 'fixtures');
export const VALID = path.join(FIXTURES, 'valid');
export const INVALID = path.join(FIXTURES, 'invalid');
export const BIN = path.join(PKG, 'bin', 'sf-validate.mjs');

export function listDirs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function readExpected(caseDir) {
  return JSON.parse(fs.readFileSync(path.join(caseDir, 'expected.json'), 'utf8'));
}

/** Identity of a diagnostic for comparison: message is deliberately not compared. */
export const keyOf = (d) => `${d.code} | ${d.file} | ${d.location}`;
export const keysOf = (diags) => diags.map(keyOf).sort();

export const SEVERITY_BY_LETTER = { E: 'error', W: 'warning', I: 'info' };

/** All files below dir (dotfiles included), forward-slash relative paths, sorted. */
export function walkFiles(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(dir, r));
    else out.push(r);
  }
  return out.sort();
}

/** path -> sha256 of every file under dir. */
export function hashTree(dir) {
  const h = {};
  for (const rel of walkFiles(dir)) {
    h[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
  }
  return h;
}

function naturalCompare(a, b) {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (/^\d/.test(x) && /^\d/.test(y)) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}
/** CONTRACT ordering: file, then location (natural), then code. */
export function compareDiagnostics(a, b) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  const l = naturalCompare(a.location, b.location);
  if (l !== 0) return l;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

export const ALL_FIXTURE_ROOTS = () => [
  ...listDirs(VALID).map((n) => path.join(VALID, n)),
  ...listDirs(INVALID).map((n) => path.join(INVALID, n)),
];
