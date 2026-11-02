// Applies a list of changes through the single writer (@storyforge/store): one batch = one opId,
// one journal entry, one trash folder; post-validation and rollback (contract rules 3, 4, 6).
import { loadBook, newErrors } from './book.mjs';
import { unifiedDiff } from './diff.mjs';
import { sha256 } from './util.mjs';

/** Test seam: `afterWrite(book, changes)` runs after files are written, before verification. */
export const __testHooks = { afterWrite: undefined };

/**
 * @typedef {{from:string|null, to:string, content:Buffer, before:Buffer|null}} Change
 *   from === null: file created; from === to: edited in place; otherwise moved (and maybe edited).
 */

/** Public shape of a change; `diff: true` adds a unified diff string per file (dry-run previews). */
export function publicChanges(changes, { diff = false } = {}) {
  return changes.map((c) => ({
    from: c.from,
    to: c.to,
    before_sha256: c.before ? sha256(c.before) : null,
    after_sha256: c.content ? sha256(c.content) : null,
    ...(diff ? { diff: unifiedDiff(c.from, c.to ?? c.from, c.before ? c.before.toString('utf8') : '', c.content ? c.content.toString('utf8') : '') } : {}),
  }));
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

/**
 * Apply changes with trash + verification + rollback.
 * @param {{store:any, bookRoot:string, root:string, op:string, args:object, changes:Change[], beforeDiagnostics:object[], stage?:(tx:any, changes:Change[]) => Promise<void>}} p
 */
export async function commit({ store, bookRoot, op, args, changes, beforeDiagnostics, stage }) {
  const pub = publicChanges(changes);
  const ordered = orderChanges(changes);
  if (!ordered) {
    return { ok: false, code: 'REFUSED_PATH_TAKEN', changes: pub, message: 'cyclic path dependency between changes' };
  }

  let after;
  const res = await store.batch(
    op,
    args,
    async (tx) => {
      for (const c of ordered) {
        let r;
        if (c.to === null) r = await tx.remove(c.from, { baseSha256: sha256(c.before) }); // a removal (Undo of a created exception file)
        else if (c.from === null) r = await tx.create(c.to, c.content);
        else if (c.from === c.to) r = await tx.write(c.to, c.content, { baseSha256: sha256(c.before) });
        else r = await tx.move(c.from, c.to, { baseSha256: sha256(c.before), bytes: c.content });
        if (!r.ok) return r;
      }
      // M05-J07: the caller's receipts ride in this batch (target change and receipt land together or not at all); a receipt problem never blocks the change
      if (typeof stage === 'function') {
        try {
          await stage(tx, ordered);
        } catch {
          // advisory
        }
      }
      return null;
    },
    {
      verify: async () => {
        if (typeof __testHooks.afterWrite === 'function') await __testHooks.afterWrite(bookRoot, pub);
        after = await loadBook(bookRoot);
        if ('error' in after) throw new Error(after.error.message);
        const fresh = newErrors(beforeDiagnostics, after.diagnostics);
        if (fresh.length) {
          const err = new Error('post-write validation found new errors');
          err.diagnostics = fresh;
          throw err;
        }
      },
    },
  );

  if (res.ok) {
    return { ok: true, code: 'OK', changes: pub, opId: res.opId, diagnostics: (after?.diagnostics ?? beforeDiagnostics).filter((d) => d.severity !== 'info') };
  }
  if (res.code === 'ROLLED_BACK') {
    return {
      ok: false,
      code: 'ROLLED_BACK',
      changes: pub,
      opId: res.opId,
      message: res.message,
      diagnostics: res.diagnostics ?? [],
      ...(res.rollbackErrors ? { rollbackErrors: res.rollbackErrors } : {}),
    };
  }
  // Nothing was written: a target appeared, or a source changed on disk since it was read.
  const code = res.code === 'EXISTS' ? 'REFUSED_PATH_TAKEN' : res.code;
  return { ok: false, code, changes: pub, message: res.message ?? `store refused the change (${res.code})` };
}
