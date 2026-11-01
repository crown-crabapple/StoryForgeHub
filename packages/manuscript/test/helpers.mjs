// Shared helpers for the @storyforge/manuscript acceptance tests. Not a test file.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../../format/src/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(HERE, '..');
export const CLI = path.join(PKG_ROOT, 'bin', 'sf-manuscript.mjs');
export const FIXTURES = path.resolve(HERE, '../../format/fixtures');

const temps = [];

/** Copy a fixture (path relative to packages/format/fixtures) into a fresh temp dir; returns the copy. */
export function copyFixture(rel) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-'));
  temps.push(base);
  const dest = path.join(base, path.basename(rel));
  fs.cpSync(path.join(FIXTURES, ...rel.split('/')), dest, { recursive: true });
  return dest;
}

/** Remove every temp dir created by copyFixture. Call from `after`. */
export function cleanup() {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(dir, r, out);
    else out.push(r);
  }
  return out;
}

/** Map of relative path (forward slashes) -> sha256 for every file, including .storyforge/. */
export function snapshot(dir) {
  const m = new Map();
  for (const rel of walk(dir).sort()) m.set(rel, sha256(fs.readFileSync(path.join(dir, rel))));
  return m;
}

const TRASH = '.storyforge/trash/';

/** Difference between two snapshots. Trash is ignored unless { trash: true }. */
export function diffSnap(before, after, { trash = false } = {}) {
  const keep = (p) => trash || !p.startsWith(TRASH);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [p, h] of after) {
    if (!keep(p)) continue;
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== h) changed.push(p);
  }
  for (const p of before.keys()) if (keep(p) && !after.has(p)) removed.push(p);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export const NO_DIFF = { added: [], removed: [], changed: [] };

/** Split a file's bytes at the closing front matter `---` line. Returns body Buffer or null. */
export function bodyOf(buf) {
  const s = buf.toString('latin1');
  const m = /^---\r?\n[\s\S]*?\n---\r?(?:\n|$)/.exec(s);
  if (!m) return null;
  return Buffer.from(s.slice(m[0].length), 'latin1');
}

function isSceneFile(buf) {
  const s = buf.toString('latin1');
  const m = /^---\r?\n([\s\S]*?)\n---\r?(?:\n|$)/.exec(s);
  return !!m && /^schema:\s*storyforge\.scene\/v1\s*$/m.test(m[1]);
}

/** Multiset (Map body-sha -> count) of every scene body under manuscript/ (variants included). */
export function bodies(dir) {
  const m = new Map();
  const root = path.join(dir, 'manuscript');
  if (!fs.existsSync(root)) return m;
  for (const rel of walk(root)) {
    if (!rel.endsWith('.md')) continue;
    const buf = fs.readFileSync(path.join(root, rel));
    if (!isSceneFile(buf)) continue;
    const h = sha256(bodyOf(buf));
    m.set(h, (m.get(h) ?? 0) + 1);
  }
  return m;
}

/** Add one body to a multiset copy. */
export function withBody(multiset, bodyText) {
  const m = new Map(multiset);
  const h = sha256(Buffer.from(bodyText, 'utf8'));
  m.set(h, (m.get(h) ?? 0) + 1);
  return m;
}

/** Set of body-sha of every .md file with front matter anywhere under dir (book + .storyforge/trash). */
export function allBodyHashes(dir) {
  const s = new Set();
  for (const rel of walk(dir)) {
    if (!rel.endsWith('.md')) continue;
    const b = bodyOf(fs.readFileSync(path.join(dir, rel)));
    if (b) s.add(sha256(b));
  }
  return s;
}

export async function orderRows(dir) {
  const r = await validate(dir);
  return r.books[0].order;
}

export async function orderIds(dir) {
  return (await orderRows(dir)).map((s) => s.id);
}

export async function errorsOf(dir) {
  return (await validate(dir)).diagnostics.filter((d) => d.severity === 'error' || /^E/.test(d.code));
}

export async function diagnosticsOf(dir) {
  return (await validate(dir)).diagnostics;
}

export const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');
export const exists = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
export function write(dir, rel, text) {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
/** Rewrite a file in the copy with fn(text). */
export function edit(dir, rel, fn) {
  write(dir, rel, fn(read(dir, rel)));
}
export function rename(dir, from, to) {
  const t = path.join(dir, ...to.split('/'));
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.renameSync(path.join(dir, ...from.split('/')), t);
}

/** Write a minimal valid scene into the copy. */
export function addScene(dir, rel, { id, act, chapter, sequence, title = 'Extra', body = 'Extra body.\n' }) {
  write(
    dir,
    rel,
    `---\nschema: storyforge.scene/v1\nid: ${id}\ntitle: ${title}\nact: ${act}\nchapter: ${chapter}\nsequence: ${sequence}\nstatus: drafting\n---\n${body}`,
  );
}

/** Files under .storyforge/trash/ (relative to the trash root's parent = book). */
export function trashFiles(dir) {
  const root = path.join(dir, '.storyforge', 'trash');
  return fs.existsSync(root) ? walk(root).map((r) => `.storyforge/trash/${r}`) : [];
}

// ---- salt-orchard constants, derived from its expected.json -------------------------------
export const SALT = 'valid/salt-orchard';
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'valid', 'salt-orchard', 'expected.json'), 'utf8'));
export const SALT_ORDER = expected.order;
export const [PROLOGUE, ARRIVAL, KEY, FERRY, GRAFTING, LOWTIDE, WALL] = SALT_ORDER;
export const VARIANT = expected.excluded.find((e) => e.reason === 'variant').id;
const A1 = 'manuscript/act-01-low-water';
export const P = {
  PROLOGUE: `${A1}/ch-000-prologue/0010-before-the-tide.md`,
  ARRIVAL: `${A1}/ch-001-the-drowned-rows/0010-arrival.md`,
  KEY: `${A1}/ch-001-the-drowned-rows/0020-the-key.md`,
  FERRY: `${A1}/ch-002-the-grafting/0010-ferry.md`,
  GRAFTING: `${A1}/ch-002-the-grafting/0020-the-grafting.md`,
  LOWTIDE: 'manuscript/act-02-high-water/ch-003-the-wall/0010-low-tide.md',
  WALL: 'manuscript/act-02-high-water/ch-003-the-wall/0020-the-wall.md',
};
export const CH1 = `${A1}/ch-001-the-drowned-rows`;
export const CH2 = `${A1}/ch-002-the-grafting`;
export const CH3 = 'manuscript/act-02-high-water/ch-003-the-wall';
