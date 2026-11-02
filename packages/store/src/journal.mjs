// Journal: .storyforge/journal/<opId>.json, one file per op, rewritten atomically per state change.
import crypto from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fsyncDir, moveFile, writeSynced } from './atomic.mjs';
import { trashDir } from './trash.mjs';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const OP_ID_RE = /^\d{8}T\d{9}Z-[0-9A-HJKMNP-TV-Z]{6}$/;

/** `YYYYMMDDTHHMMSSmmmZ-<6 random base32>` */
export function makeOpId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:.]/g, '');
  let suffix = '';
  for (const b of crypto.randomBytes(6)) suffix += CROCKFORD[b % 32];
  return `${stamp}-${suffix}`;
}

export const journalDir = (root) => path.join(root, '.storyforge', 'journal');
const journalFile = (root, opId) => path.join(journalDir(root), `${opId}.json`);

/**
 * @typedef {{ rel: string, before_sha256: string|null, after_sha256: string|null, tmp: string|null }} JournalFile
 * @typedef {{ opId: string, op: string, args: unknown, at: string, state: string, files: JournalFile[] }} JournalEntry
 */

/**
 * Atomically (re)write an entry and fsync it.
 * @param {string} root
 * @param {JournalEntry} entry
 */
export async function writeJournal(root, entry) {
  const dir = journalDir(root);
  await mkdir(dir, { recursive: true });
  const target = journalFile(root, entry.opId);
  const tmp = path.join(dir, `.${entry.opId}.json.sf-tmp`);
  await writeSynced(tmp, Buffer.from(`${JSON.stringify(entry, null, 2)}\n`));
  await moveFile(tmp, target);
  await fsyncDir(dir);
}

/**
 * A finished op's journal entry moves into its trash folder (`trash/<opId>/journal.json`), so the
 * live journal folder only holds ops that still need attention. Nothing is deleted.
 */
export async function archiveJournal(root, opId) {
  const dest = path.join(trashDir(root, opId), 'journal.json');
  await mkdir(path.dirname(dest), { recursive: true });
  await moveFile(journalFile(root, opId), dest);
}

async function readEntry(file, opId) {
  try {
    const entry = JSON.parse(await readFile(file, 'utf8'));
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.files)) throw new Error('bad shape');
    return { ...entry, opId };
  } catch {
    return { opId, state: 'corrupt', files: [] };
  }
}

async function namesOf(dir) {
  try {
    return await readdir(dir);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return [];
    throw e;
  }
}

/** All entries (live and archived), newest first. Unreadable entries appear as `{ opId, state: 'corrupt' }`. */
export async function listJournal(root, { live = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const name of await namesOf(journalDir(root))) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const opId = name.slice(0, -'.json'.length);
    seen.add(opId);
    out.push(await readEntry(path.join(journalDir(root), name), opId));
  }
  if (!live) {
    for (const opId of await namesOf(path.join(root, '.storyforge', 'trash'))) {
      if (seen.has(opId) || !OP_ID_RE.test(opId)) continue;
      const file = path.join(trashDir(root, opId), 'journal.json');
      if ((await namesOf(trashDir(root, opId))).includes('journal.json')) out.push(await readEntry(file, opId));
    }
  }
  return out.sort((a, b) => (a.opId < b.opId ? 1 : a.opId > b.opId ? -1 : 0));
}
