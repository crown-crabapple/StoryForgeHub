import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, '../../format/fixtures');
export const REPO_ROOT = path.resolve(here, '../../..');

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Copy a fixture (e.g. 'valid/salt-orchard') into a fresh temp dir; returns its path. */
export async function copyFixture(rel) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-store-'));
  const dest = path.join(base, path.basename(rel));
  await fs.cp(path.join(FIXTURES, rel), dest, { recursive: true });
  return dest;
}

/** Every file under root (relative, forward slashes) -> sha256. Directories are not listed. */
export async function snapshot(root) {
  const out = {};
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) await walk(full);
      else out[rel] = sha256(await fs.readFile(full));
    }
  }
  await walk(root);
  return out;
}

/** Read a file, or null when absent. */
export async function readOrNull(file) {
  try {
    return await fs.readFile(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Relative paths of `.sf-tmp` files anywhere outside `.storyforge/trash`. */
export async function strayTmp(root) {
  const snap = await snapshot(root);
  return Object.keys(snap).filter((r) => r.endsWith('.sf-tmp') && !r.startsWith('.storyforge/trash/'));
}

const bufEq = (a, b) => (a === null || b === null ? a === b : Buffer.compare(a, b) === 0);

/**
 * Compare the disk to two expected states (object rel -> Buffer|null).
 * @returns {Promise<'old'|'new'|'mixed'>}  'old'/'new' only if EVERY file matches that state exactly.
 */
export async function classify(root, oldMap, newMap) {
  let isOld = true;
  let isNew = true;
  for (const rel of Object.keys(oldMap)) {
    const cur = await readOrNull(path.join(root, rel));
    if (!bufEq(cur, oldMap[rel])) isOld = false;
    if (!bufEq(cur, newMap[rel])) isNew = false;
  }
  return isOld ? 'old' : isNew ? 'new' : 'mixed';
}

/**
 * The operations exercised by the crash and throw matrices. Each plan has the files it touches,
 * the bytes of the new state, and `run(store)` which performs the op through the store.
 */
export const OPS = {
  create: {
    rels: ['drafts/new/crash-new.md'],
    newBytes: { 'drafts/new/crash-new.md': Buffer.from('# created by crash test\n') },
    async run(store) {
      return store.create('drafts/new/crash-new.md', Buffer.from('# created by crash test\n'));
    },
  },
  write: {
    rels: ['research/tidal-ranges.md'],
    newBytes: { 'research/tidal-ranges.md': Buffer.from('REPLACED tidal ranges\n') },
    async run(store) {
      const cur = await store.read('research/tidal-ranges.md');
      return store.write('research/tidal-ranges.md', Buffer.from('REPLACED tidal ranges\n'), { baseSha256: cur.sha256 });
    },
  },
  move: {
    rels: ['research/tidal-ranges.md', 'research/tides-moved.md'],
    newBytes: 'MOVE', // from -> null, to -> old bytes of from
    async run(store) {
      const cur = await store.read('research/tidal-ranges.md');
      return store.move('research/tidal-ranges.md', 'research/tides-moved.md', { baseSha256: cur.sha256 });
    },
  },
  batch: {
    rels: ['codex/lore/saltmarks.md', 'codex/objects/ferry-bell.md', 'codex/locations/port-aldine.md'],
    newBytes: {
      'codex/lore/saltmarks.md': Buffer.from('BATCH one\n'),
      'codex/objects/ferry-bell.md': Buffer.from('BATCH two\n'),
      'codex/locations/port-aldine.md': Buffer.from('BATCH three\n'),
    },
    async run(store) {
      const rels = OPS.batch.rels;
      return store.batch('crash-batch', {}, async (tx) => {
        for (const rel of rels) {
          const cur = await tx.read(rel);
          const r = await tx.write(rel, OPS.batch.newBytes[rel], { baseSha256: cur.sha256 });
          if (r && r.ok === false) return r;
        }
      });
    },
  },
};

/** Build { old, neu } maps for an op against the current (pre-op) disk state of root. */
export async function expectedStates(root, opName) {
  const plan = OPS[opName];
  const old = {};
  for (const rel of plan.rels) old[rel] = await readOrNull(path.join(root, rel));
  const neu =
    plan.newBytes === 'MOVE'
      ? { [plan.rels[0]]: null, [plan.rels[1]]: old[plan.rels[0]] }
      : { ...plan.newBytes };
  return { old, neu };
}

export const FAULT_POINTS = ['after-journal', 'after-trash', 'after-tmp', 'after-rename', 'before-done'];
