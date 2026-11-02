// Atomic writes, trash, op.json, post-validation and rollback (contract rules 3, 4, 6).
import { copyFile, mkdir, open, readFile, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadBook, newErrors } from './book.mjs';
import { makeOpId, sha256 } from './util.mjs';

/** Test seam: `afterWrite(book, changes)` runs after files are written, before verification. */
export const __testHooks = { afterWrite: undefined };

/**
 * @typedef {{from:string|null, to:string, content:Buffer, before:Buffer|null}} Change
 *   from === null: file created; from === to: edited in place; otherwise moved (and maybe edited).
 */

const abs = (root, rel) => path.join(root, ...rel.split('/'));

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Public shape of a change. */
export function publicChanges(changes) {
  return changes.map((c) => ({
    from: c.from,
    to: c.to,
    before_sha256: c.before ? sha256(c.before) : null,
    after_sha256: sha256(c.content),
  }));
}

/** Write `<dir>/.<name>.sf-tmp`, fsync, rename over the target. Returns dirs it created. */
export async function atomicWrite(target, content) {
  const created = [];
  const dir = path.dirname(target);
  const missing = [];
  for (let d = dir; !(await exists(d)); d = path.dirname(d)) missing.unshift(d);
  await mkdir(dir, { recursive: true });
  created.push(...missing);
  const tmp = path.join(dir, `.${path.basename(target)}.sf-tmp`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, target);
  return created;
}

/**
 * Order changes so that no change overwrites a path another change still has to vacate.
 * Returns null if impossible (a cycle).
 */
export function orderChanges(changes) {
  const pending = [...changes];
  const ordered = [];
  while (pending.length) {
    const i = pending.findIndex((c) => !pending.some((o) => o !== c && o.from === c.to));
    if (i < 0) return null;
    ordered.push(...pending.splice(i, 1));
  }
  return ordered;
}

async function copyInto(srcAbs, destAbs) {
  await mkdir(path.dirname(destAbs), { recursive: true });
  await copyFile(srcAbs, destAbs);
}

/**
 * Apply changes with trash + verification + rollback.
 * @param {{bookRoot:string, root:string, op:string, args:object, changes:Change[], beforeDiagnostics:object[]}} p
 */
export async function commit({ bookRoot, root, op, args, changes, beforeDiagnostics }) {
  const opId = makeOpId();
  const trashDir = path.join(root, '.storyforge', 'trash', opId);
  const pub = publicChanges(changes);
  const ordered = orderChanges(changes);
  if (!ordered) {
    return { ok: false, code: 'REFUSED_PATH_TAKEN', changes: pub, message: 'cyclic path dependency between changes' };
  }

  await atomicWrite(
    path.join(trashDir, 'op.json'),
    Buffer.from(`${JSON.stringify({ op, args, at: new Date().toISOString(), changes: pub }, null, 2)}\n`),
  );

  const applied = [];
  const createdDirs = [];
  try {
    for (const c of ordered) {
      applied.push({ c, wrote: false });
      const state = applied[applied.length - 1];
      const toAbs = abs(root, c.to);
      if (c.from !== null && c.from === c.to) await copyInto(toAbs, path.join(trashDir, ...c.from.split('/')));
      createdDirs.push(...(await atomicWrite(toAbs, c.content)));
      state.wrote = true;
      if (c.from !== null && c.from !== c.to) {
        const trashed = path.join(trashDir, ...c.from.split('/'));
        await mkdir(path.dirname(trashed), { recursive: true });
        await rename(abs(root, c.from), trashed);
      }
    }
    if (typeof __testHooks.afterWrite === 'function') await __testHooks.afterWrite(bookRoot, pub);
    const after = await loadBook(bookRoot);
    if ('error' in after) throw new Error(after.error.message);
    const fresh = newErrors(beforeDiagnostics, after.diagnostics);
    if (fresh.length) {
      const err = new Error('post-write validation found new errors');
      err.diagnostics = fresh;
      throw err;
    }
    return { ok: true, code: 'OK', changes: pub, opId, diagnostics: after.diagnostics.filter((d) => d.severity !== 'info') };
  } catch (e) {
    const rollbackErrors = await rollback(root, trashDir, applied, createdDirs);
    return {
      ok: false,
      code: 'ROLLED_BACK',
      changes: pub,
      opId,
      message: String(e?.message ?? e),
      diagnostics: e?.diagnostics ?? [],
      ...(rollbackErrors.length ? { rollbackErrors } : {}),
    };
  }
}

async function rollback(root, trashDir, applied, createdDirs) {
  const errors = [];
  for (const { c, wrote } of [...applied].reverse()) {
    try {
      const toAbs = abs(root, c.to);
      if (c.from === c.to) {
        const saved = path.join(trashDir, ...c.from.split('/'));
        if (await exists(saved)) await atomicWrite(toAbs, await readFile(saved));
        continue;
      }
      if (wrote && (await exists(toAbs))) {
        const parked = path.join(trashDir, 'rolled-back', ...c.to.split('/'));
        await mkdir(path.dirname(parked), { recursive: true });
        await rename(toAbs, parked);
      }
      if (c.from !== null) {
        const saved = path.join(trashDir, ...c.from.split('/'));
        if (await exists(saved)) await atomicWrite(abs(root, c.from), await readFile(saved));
      }
    } catch (e) {
      errors.push(`${c.to}: ${e?.message ?? e}`);
    }
  }
  for (const d of [...createdDirs].reverse()) {
    try {
      await rmdir(d);
    } catch {
      // not empty or already gone; leave it
    }
  }
  return errors;
}
