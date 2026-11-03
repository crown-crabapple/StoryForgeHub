// The single writer. Every change to a project file goes through `openStore(root).batch(...)`
// (or one of the single-call wrappers, which are one-call batches).
//
// Batches are deferred: calls on `tx` check their preconditions against disk plus the changes
// already queued, then the whole batch is applied at once under one journal entry. That is what
// makes a batch all-old or all-new after a crash (the journal lists every file up front).
import { watch as fsWatch } from 'node:fs';
import { readdir, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { absOf, atomicWrite, fsyncDir, kindOf, mkdirTracked, moveFile, readOrNull, sha256, tmpOf, writeSynced } from './atomic.mjs';
import { escapesRoot } from './contain.mjs';
import { fault } from './faults.mjs';
import { acquireLock, releaseLock, updateLock } from './instance-lock.mjs';
import { OP_ID_RE, archiveJournal, listJournal, makeOpId, writeJournal } from './journal.mjs';
import { withRootLock } from './lock.mjs';
import { notifyWrite } from './write-hooks.mjs';
import { isOwn, markOwn } from './ownwrites.mjs';
import { recoverRoot, settleEntry } from './recover.mjs';
import { listRevisions, pruneRevisions, readRevision, saveRevision } from './revisions.mjs';
import { copyToTrash, moveToTrash, trashPath } from './trash.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/**
 * Validate a root-relative path. Returns the normalised path or null (-> OUTSIDE_ROOT).
 * @param {unknown} rel
 */
function normRel(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0')) return null;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (segs[0].toLowerCase() === '.storyforge') return null;
  return segs.join('/');
}

const tmpRel = (rel) => {
  const i = rel.lastIndexOf('/');
  const name = rel.slice(i + 1);
  return `${i < 0 ? '' : rel.slice(0, i + 1)}.${name}.sf-tmp`;
};

const META_RE = /^[A-Za-z0-9._-]+$/;

/**
 * @param {string} projectRoot a book root
 * @param {{ recover?: boolean }} [options] `recover: false` skips the recovery pass openStore normally runs
 */
export async function openStore(projectRoot, { recover: doRecover = true } = {}) {
  const root = path.resolve(projectRoot);

  async function runBatch(opName, args, fn, opts = {}) {
    try {
      return await runBatchLocked(opName, args, fn, opts);
    } finally {
      notifyWrite(root);
    }
  }

  async function runBatchLocked(opName, args, fn, opts = {}) {
    return withRootLock(root, async () => {
      const opId = opts.opId && OP_ID_RE.test(opts.opId) ? opts.opId : makeOpId();
      /** rel -> { origSha, origBytes, bytes, dir } : virtual state of every path the batch has looked at */
      const overlay = new Map();
      const changes = [];
      let failure = null;

      async function view(rel) {
        let v = overlay.get(rel);
        if (!v) {
          const kind = await kindOf(absOf(root, rel));
          const bytes = kind === 'file' ? await readOrNull(absOf(root, rel)) : null;
          v = { origSha: bytes ? sha256(bytes) : null, origBytes: bytes, bytes, dir: kind === 'dir' };
          overlay.set(rel, v);
        }
        return v;
      }
      const cur = (v) => ({ bytes: v.bytes, sha256: sha256(v.bytes) });
      const refuse = (r) => {
        failure ??= r;
        return failure;
      };

      /** Shared conflict check for write/move sources. */
      function checkBase(v, baseSha256) {
        if (baseSha256 !== null && typeof baseSha256 !== 'string') return fail('BAD_ARGS', { message: 'baseSha256 must be a hex string or null' });
        if (v.bytes === null) return baseSha256 === null ? null : fail('NOT_FOUND');
        if (baseSha256 === null || sha256(v.bytes) !== baseSha256) return fail('CONFLICT', { current: cur(v) });
        return null;
      }

      const tx = {
        async read(rel) {
          const r = normRel(rel);
          if (!r || (await escapesRoot(root, r))) return null;
          const v = await view(r);
          return v.bytes ? cur(v) : null;
        },
        async create(rel, bytes) {
          if (failure) return failure;
          const r = normRel(rel);
          if (!r || (await escapesRoot(root, r))) return refuse(fail('OUTSIDE_ROOT'));
          if (!Buffer.isBuffer(bytes)) return refuse(fail('BAD_ARGS', { message: 'bytes must be a Buffer' }));
          const v = await view(r);
          if (v.bytes !== null || v.dir) return refuse(fail('EXISTS'));
          v.bytes = bytes;
          v.group ??= changes.length;
          changes.push({ from: null, to: r, before_sha256: null, after_sha256: sha256(bytes) });
          return { ok: true, code: 'OK', sha256: sha256(bytes) };
        },
        async write(rel, bytes, { baseSha256 } = {}) {
          if (failure) return failure;
          const r = normRel(rel);
          if (!r || (await escapesRoot(root, r))) return refuse(fail('OUTSIDE_ROOT'));
          if (!Buffer.isBuffer(bytes)) return refuse(fail('BAD_ARGS', { message: 'bytes must be a Buffer' }));
          if (baseSha256 === undefined) return refuse(fail('BAD_ARGS', { message: 'baseSha256 is required (a hex string, or null for "must not exist")' }));
          const v = await view(r);
          if (v.dir) return refuse(fail('EXISTS'));
          const bad = baseSha256 === null && v.bytes === null ? null : checkBase(v, baseSha256);
          if (bad) return refuse(bad);
          const before = v.bytes ? sha256(v.bytes) : null;
          v.bytes = bytes;
          v.group ??= changes.length;
          changes.push({ from: before === null ? null : r, to: r, before_sha256: before, after_sha256: sha256(bytes) });
          return { ok: true, code: 'OK', sha256: sha256(bytes) };
        },
        async move(fromRel, toRel, { baseSha256, bytes } = {}) {
          if (failure) return failure;
          const from = normRel(fromRel);
          const to = normRel(toRel);
          if (!from || !to || (await escapesRoot(root, from)) || (await escapesRoot(root, to))) return refuse(fail('OUTSIDE_ROOT'));
          if (from === to) return refuse(fail('BAD_ARGS', { message: 'from and to are the same path' }));
          if (bytes !== undefined && !Buffer.isBuffer(bytes)) return refuse(fail('BAD_ARGS', { message: 'bytes must be a Buffer' }));
          if (baseSha256 === undefined) return refuse(fail('BAD_ARGS', { message: 'baseSha256 is required' }));
          const vf = await view(from);
          if (vf.dir || vf.bytes === null) return refuse(fail('NOT_FOUND'));
          const bad = checkBase(vf, baseSha256);
          if (bad) return refuse(bad);
          const vt = await view(to);
          if (vt.bytes !== null || vt.dir) return refuse(fail('EXISTS'));
          const content = bytes ?? vf.bytes;
          const before = sha256(vf.bytes);
          vt.bytes = content;
          vf.bytes = null;
          vt.group ??= changes.length;
          vf.group ??= changes.length;
          changes.push({ from, to, before_sha256: before, after_sha256: sha256(content) });
          return { ok: true, code: 'OK', sha256: sha256(content), path: to };
        },
        /** Remove a file (it moves into the trash, so the operation can be undone). `baseSha256` is required: the file as the caller saw it. */
        async remove(rel, { baseSha256 } = {}) {
          if (failure) return failure;
          const r = normRel(rel);
          if (!r || (await escapesRoot(root, r))) return refuse(fail('OUTSIDE_ROOT'));
          if (baseSha256 === undefined) return refuse(fail('BAD_ARGS', { message: 'baseSha256 is required' }));
          const v = await view(r);
          if (v.dir || v.bytes === null) return refuse(fail('NOT_FOUND'));
          const bad = checkBase(v, baseSha256);
          if (bad) return refuse(bad);
          const before = sha256(v.bytes);
          v.bytes = null;
          v.group ??= changes.length;
          changes.push({ from: r, to: null, before_sha256: before, after_sha256: null });
          return { ok: true, code: 'OK', sha256: null, path: r };
        },
        archive(rel, { baseSha256 } = {}) {
          const r = normRel(rel);
          if (!r) return Promise.resolve(refuse(fail('OUTSIDE_ROOT')));
          return tx.move(r, `archive/${r}`, { baseSha256 });
        },
        restore(archivedRel, { baseSha256 } = {}) {
          const r = normRel(archivedRel);
          if (!r) return Promise.resolve(refuse(fail('OUTSIDE_ROOT')));
          if (!r.startsWith('archive/') || r === 'archive/') return Promise.resolve(refuse(fail('BAD_ARGS', { message: 'not an archived path' })));
          return tx.move(r, r.slice('archive/'.length), { baseSha256 });
        },
      };

      let value;
      try {
        value = await fn(tx);
      } catch (e) {
        return fail('ERROR', { message: String(e?.message ?? e), changes });
      }
      if (failure) return { ...failure, changes };

      // ---- net per-file plan: writes first, then removals
      const planned = [];
      for (const [rel, v] of overlay) {
        const after = v.bytes ? sha256(v.bytes) : null;
        if (after === v.origSha) continue;
        planned.push({ rel, group: v.group ?? 0, before_sha256: v.origSha, after_sha256: after, tmp: v.bytes ? tmpRel(rel) : null, bytes: v.bytes, origBytes: v.origBytes });
      }
      // by the change that produced them; within a change the new file lands before the old one leaves
      planned.sort((a, b) => a.group - b.group || (a.bytes ? 0 : 1) - (b.bytes ? 0 : 1));
      if (planned.length === 0) return { ok: true, code: 'OK', opId: null, changes, value };
      // The watcher must not treat what follows as an external edit (marked now and again when settled).
      const ownRels = planned.flatMap((f) => {
        const out = f.tmp ? [f.rel, f.tmp] : [f.rel];
        for (let d = path.posix.dirname(f.rel); d !== '.'; d = path.posix.dirname(d)) out.push(d); // folders it may create
        return out;
      });
      markOwn(root, ownRels);

      const entry = {
        opId,
        op: opName,
        args: args ?? null,
        at: new Date().toISOString(),
        state: 'pending',
        files: planned.map(({ rel, before_sha256, after_sha256, tmp }) => ({ rel, before_sha256, after_sha256, tmp })),
      };
      const createdDirs = [];
      try {
        // 1. journal (fsync'd) before any project file is touched
        await writeJournal(root, entry);
        await copyToTrash(root, opId, 'op.json', Buffer.from(`${JSON.stringify({ op: opName, args: args ?? null, at: entry.at, changes }, null, 2)}\n`));
        fault('after-journal');
        // 2. trash copies of every current file, 3. every tmp, 4. renames
        for (const f of planned) if (f.origBytes) await copyToTrash(root, opId, f.rel, f.origBytes);
        fault('after-trash');
        for (const f of planned) {
          if (!f.bytes) continue;
          const target = absOf(root, f.rel);
          await mkdirTracked(path.dirname(target), createdDirs);
          await writeSynced(tmpOf(target), f.bytes);
        }
        fault('after-tmp');
        let renamed = false;
        for (const [i, f] of planned.entries()) {
          const target = absOf(root, f.rel);
          // a removal is a rename into the trash
          if (f.bytes) {
            await moveFile(tmpOf(target), target);
            await fsyncDir(path.dirname(target));
          } else {
            await moveToTrash(root, opId, f.rel);
          }
          // the crash point fires once the first change has fully landed
          if (!renamed && (i + 1 === planned.length || planned[i + 1].group !== f.group)) {
            renamed = true;
            fault('after-rename');
          }
        }
        fault('before-done');
        let verified;
        if (typeof opts.verify === 'function') verified = await opts.verify();
        // 5. done
        await writeJournal(root, { ...entry, state: 'done' });
        await archiveJournal(root, opId).catch(() => {}); // cosmetic: the entry is already 'done'
        markOwn(root, ownRels);
        return { ok: true, code: 'OK', opId, changes, value, verified };
      } catch (e) {
        let rollbackErrors;
        try {
          const r = await settleEntry(root, entry, { rollback: true });
          if (r.outcome === 'needsAttention') rollbackErrors = [`${r.files.join(', ')}: ${r.reason}`];
          else await archiveJournal(root, opId);
        } catch (e2) {
          rollbackErrors = [String(e2?.message ?? e2)];
        }
        markOwn(root, ownRels);
        for (const d of [...createdDirs].reverse()) {
          try {
            await rmdir(d);
          } catch {
            // not empty or already gone
          }
        }
        return fail('ROLLED_BACK', {
          opId,
          changes,
          message: String(e?.message ?? e),
          diagnostics: e?.diagnostics ?? [],
          ...(rollbackErrors ? { rollbackErrors } : {}),
        });
      }
    });
  }

  /** One-call batch; folds the single result into the batch result. */
  async function single(opName, rel, opts, call, extraArgs = {}) {
    const args = { rel, ...extraArgs };
    let result;
    const b = await runBatch(
      opName,
      args,
      async (tx) => {
        result = await call(tx);
      },
      { opId: opts?.opId },
    );
    if (!b.ok) return b;
    return { ...result, opId: b.opId };
  }

  const store = {
    root,
    /** Report from the recovery pass openStore ran (null if skipped). */
    recovered: null,

    async read(rel) {
      const r = normRel(rel);
      if (!r || (await escapesRoot(root, r))) return null;
      const bytes = await readOrNull(absOf(root, r));
      return bytes ? { bytes, sha256: sha256(bytes) } : null;
    },
    /** True if a file or folder exists at `rel` (read-only helper). */
    async exists(rel) {
      const r = normRel(rel);
      return r && !(await escapesRoot(root, r)) ? (await kindOf(absOf(root, r))) !== null : false;
    },
    /** Bytes of a trashed copy (`.storyforge/trash/<opId>/<rel>`, `rel` may be 'op.json'), or null (read-only helper). */
    async readTrash(opId, rel) {
      if (typeof opId !== 'string' || !OP_ID_RE.test(opId)) return null;
      const r = normRel(rel);
      return r ? readOrNull(trashPath(root, opId, r)) : null;
    },
    /** Entries of a folder, or [] (read-only helper). `rel` '' is the root. */
    async list(rel = '') {
      const r = rel === '' ? '' : normRel(rel);
      if (r === null || (await escapesRoot(root, r))) return [];
      try {
        const entries = await readdir(r === '' ? root : absOf(root, r), { withFileTypes: true });
        return entries.filter((e) => !(r === '' && e.name === '.storyforge')).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
      } catch {
        return [];
      }
    },
    /** Derived-data files under .storyforge/ (e.g. the disposable index); atomic, not journaled. */
    async readMeta(name) {
      if (!META_RE.test(name) || name.startsWith('.') || (await escapesRoot(root, `.storyforge/${name}`))) return null;
      return readOrNull(path.join(root, '.storyforge', name));
    },
    async writeMeta(name, bytes) {
      if (!META_RE.test(name) || name.startsWith('.') || !Buffer.isBuffer(bytes) || (await escapesRoot(root, `.storyforge/${name}`))) {
        return fail('OUTSIDE_ROOT');
      }
      return withRootLock(root, async () => {
        await atomicWrite(path.join(root, '.storyforge', name), bytes);
        return { ok: true, code: 'OK', sha256: sha256(bytes) };
      });
    },

    /**
     * Local revision snapshots (.storyforge/revisions/<scene-id>/, FORMAT-v1 section 9). Atomic, not journaled, never deleted.
     * `listRevisions(sceneId)`: entries newest first (null for an unusable id). `readRevision(sceneId, file)`: bytes or null.
     * `saveRevision(sceneId, bytes, { reason, at?, label?, words? })`: `{ ok, stored, entry }`; identical to the newest snapshot: `stored: false`.
     * `pruneRevisions(sceneId, files)`: moves the files into the trash (`.storyforge/trash/<opId>/revisions/<scene-id>/`) and drops their index entries.
     */
    listRevisions: (sceneId) => listRevisions(root, sceneId),
    readRevision: (sceneId, file) => readRevision(root, sceneId, file),
    saveRevision: (sceneId, bytes, meta) => withRootLock(root, () => saveRevision(root, sceneId, bytes, meta)),
    pruneRevisions: (sceneId, files) => withRootLock(root, () => pruneRevisions(root, sceneId, files)),

    create: (rel, bytes, opts) => single('create', rel, opts, (tx) => tx.create(rel, bytes)),
    write: (rel, bytes, opts) => single('write', rel, opts, (tx) => tx.write(rel, bytes, { baseSha256: opts?.baseSha256 })),
    move: (from, to, opts) => single('move', from, opts, (tx) => tx.move(from, to, { baseSha256: opts?.baseSha256, bytes: opts?.bytes }), { to }),
    archive: (rel, opts) => single('archive', rel, opts, (tx) => tx.archive(rel, { baseSha256: opts?.baseSha256 })),
    restore: (rel, opts) => single('restore', rel, opts, (tx) => tx.restore(rel, { baseSha256: opts?.baseSha256 })),

    /**
     * @param {string} opName
     * @param {object} args recorded in the journal and trash/<opId>/op.json
     * @param {(tx: object) => Promise<any>} fn
     * @param {{ verify?: () => Promise<any> }} [opts] `verify` runs after every file is in place;
     *   if it throws, the whole batch is undone from the trash and the result is ROLLED_BACK.
     */
    batch: (opName, args, fn, opts) => runBatch(opName, args, fn, { verify: opts?.verify }),

    /**
     * Watch the root for changes made by anyone (the app's own writes are flagged `own`). Never keeps the
     * process alive. `onEvent({ rel, eventType, own })`: `rel` is root-relative with forward slashes, or null
     * when the platform did not say which file. `onError` gets watcher failures (the watcher is then dead).
     * @param {(e: { rel: string | null, eventType: string, own: boolean }) => void} onEvent
     * @param {{ recursive?: boolean, onError?: (err: Error) => void }} [opts]
     * @returns {{ close(): void }}
     */
    watch(onEvent, { recursive = true, onError } = {}) {
      const w = fsWatch(root, { recursive, persistent: false }, (eventType, filename) => {
        const rel = filename == null ? null : String(filename).split(path.sep).join('/');
        onEvent({ rel, eventType, own: rel !== null && isOwn(root, rel) });
      });
      w.on('error', (err) => {
        try {
          w.close();
        } catch {
          // already closed
        }
        onError?.(err);
      });
      return { close: () => w.close() };
    },

    /** Single-instance lock helpers (the lock file lives outside any book, so `absPath` is absolute). */
    acquireLock: (absPath, info) => acquireLock(absPath, info),
    releaseLock: (absPath, info) => releaseLock(absPath, info),
    updateLock: (absPath, patch) => updateLock(absPath, patch),

    recover: async () => {
      const report = await withRootLock(root, () => recoverRoot(root));
      if (report.completed.length || report.rolledBack.length || report.needsAttention.length) notifyWrite(root);
      return report;
    },
    journal: () => listJournal(root),
  };

  if (doRecover) store.recovered = await store.recover();
  return store;
}
