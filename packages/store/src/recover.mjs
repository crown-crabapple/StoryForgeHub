// Recovery: settle journal entries that are still `pending` (see the M01-J02 contract table).
// Never deletes a file; writes a project file only to restore a trashed copy.
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { absOf, atomicWrite, kindOf, moveFile, readOrNull, sha256 } from './atomic.mjs';
import { listJournal, writeJournal } from './journal.mjs';
import { moveAbsToTrash, trashDir, trashPath } from './trash.mjs';

const diskSha = async (root, rel) => {
  const bytes = await readOrNull(absOf(root, rel));
  return bytes ? sha256(bytes) : null;
};

/**
 * Settle one pending entry.
 * `rollback: true` (used by the writer after a failure) undoes even a fully applied entry.
 * @returns {Promise<{ outcome: 'completed'|'rolledBack'|'needsAttention', files: string[], reason?: string }>}
 */
export async function settleEntry(root, entry, { rollback = false } = {}) {
  const { opId } = entry;
  const status = [];
  for (const f of entry.files) {
    const actual = await diskSha(root, f.rel);
    if (actual === f.after_sha256) status.push('done');
    else if (actual === f.before_sha256) status.push('notdone');
    else status.push(rollback ? 'done' : 'attention'); // an in-process rollback undoes whatever is there
  }
  const stuck = entry.files.filter((_, i) => status[i] === 'attention').map((f) => f.rel);
  if (stuck.length) {
    return { outcome: 'needsAttention', files: stuck, reason: 'file matches neither the old nor the new version' };
  }

  // Leftover tmp files go to the trash (never deleted).
  for (const f of entry.files) {
    if (!f.tmp) continue;
    const tmpAbs = absOf(root, f.tmp);
    if ((await kindOf(tmpAbs)) === 'file') await moveAbsToTrash(root, opId, tmpAbs, f.rel, 'unfinished');
  }

  const done = entry.files.filter((_, i) => status[i] === 'done');
  let outcome;
  if (done.length === entry.files.length && !rollback) {
    outcome = 'completed';
  } else {
    if (done.length > 0) {
      // Check every trashed copy first so a failure cannot leave a half-restored entry.
      for (const f of done) {
        if (f.before_sha256 === null) continue;
        const saved = await readOrNull(trashPath(root, opId, f.rel));
        if (!saved || sha256(saved) !== f.before_sha256) {
          return { outcome: 'needsAttention', files: [f.rel], reason: 'trashed copy is missing or does not match' };
        }
      }
      for (const f of [...done].reverse()) {
        const target = absOf(root, f.rel);
        if ((await kindOf(target)) === 'file') {
          // keep the bytes that are there before they are replaced or parked
          const parked = trashPath(root, opId, f.rel, 'rolled-back');
          await mkdir(path.dirname(parked), { recursive: true });
          await copyFile(target, parked);
        }
        if (f.before_sha256 === null) {
          if ((await kindOf(target)) === 'file') await moveAbsToTrash(root, opId, target, f.rel, 'rolled-back');
        } else {
          const saved = await readOrNull(trashPath(root, opId, f.rel));
          await atomicWrite(target, /** @type {Buffer} */ (saved));
        }
      }
    }
    outcome = 'rolledBack';
  }
  await writeJournal(root, { ...entry, state: outcome, settled_at: new Date().toISOString() });
  return { outcome, files: entry.files.map((f) => f.rel) };
}

/** A staged folder goes to the trash (never deleted): trash/<name>/<sub>. */
async function stagedToTrash(root, name, stagingAbs, sub) {
  const dest = path.join(trashDir(root, name), sub);
  await mkdir(path.dirname(dest), { recursive: true });
  await moveFile(stagingAbs, dest);
}

/**
 * Settle a pending createTree entry. A staged folder that is still there means the rename never happened:
 * it goes to the trash. No staged folder but the target in place means the rename landed before the crash.
 * @returns {Promise<{ outcome: 'completed'|'rolledBack', files: string[] }>}
 */
async function settleTree(root, entry) {
  const staging = absOf(root, entry.tree.staging);
  let outcome;
  if ((await kindOf(staging)) === 'dir') {
    await stagedToTrash(root, entry.opId, staging, 'staged');
    outcome = 'rolledBack';
  } else {
    outcome = (await kindOf(absOf(root, entry.tree.target))) === 'dir' ? 'completed' : 'rolledBack';
  }
  await writeJournal(root, { ...entry, state: outcome, settled_at: new Date().toISOString() });
  return { outcome, files: [entry.tree.target] };
}

/** Staging folders no journal entry accounts for (e.g. a crash before the entry was written) go to the trash. */
async function sweepStaging(root, report) {
  let names;
  try {
    names = await readdir(path.join(root, '.storyforge', 'staging'));
  } catch {
    return;
  }
  for (const name of names) {
    const abs = path.join(root, '.storyforge', 'staging', name);
    if (name.startsWith('.') || (await kindOf(abs)) !== 'dir') continue;
    await stagedToTrash(root, name, abs, 'staged');
    report.rolledBack.push({ opId: name, op: 'createTree', files: [] });
  }
}

/**
 * @param {string} root
 * @returns {Promise<{ completed: object[], rolledBack: object[], needsAttention: object[] }>}
 */
export async function recoverRoot(root) {
  const report = { completed: [], rolledBack: [], needsAttention: [] };
  for (const entry of await listJournal(root, { live: true })) {
    if (entry.state === 'corrupt') {
      report.needsAttention.push({ opId: entry.opId, op: null, files: [], reason: 'journal entry is unreadable' });
      continue;
    }
    if (entry.state !== 'pending') continue;
    let r;
    try {
      r = entry.op === 'createTree' && entry.tree ? await settleTree(root, entry) : await settleEntry(root, entry);
    } catch (e) {
      r = { outcome: 'needsAttention', files: entry.files.map((f) => f.rel), reason: String(e?.message ?? e) };
    }
    const item = { opId: entry.opId, op: entry.op, files: r.files };
    if (r.outcome === 'needsAttention') report.needsAttention.push({ ...item, reason: r.reason });
    else report[r.outcome].push(item);
  }
  try {
    await sweepStaging(root, report);
  } catch (e) {
    report.needsAttention.push({ opId: null, op: 'createTree', files: [], reason: String(/** @type {any} */ (e)?.message ?? e) });
  }
  return report;
}
