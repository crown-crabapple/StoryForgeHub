// createTree: put a whole new folder (a book) into a library in one step, or not at all.
//   1. journal the op (state pending), then write every file into .storyforge/staging/<opId>/ (each fsync'd)
//   2. validate the staged folder as a book root: it must have zero diagnostics
//   3. rename the staged folder to its place (an atomic directory rename); refuse if the place appeared meanwhile
// Anything that goes wrong moves the staged folder to .storyforge/trash/<opId>/ (nothing is deleted).
// A crash leaves a pending journal entry; recovery (recover.mjs) moves a leftover staged folder to the trash.
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { validate } from '@storyforge/format';
import { absOf, fsyncDir, kindOf, moveFile, sha256, writeSynced } from './atomic.mjs';
import { currentActor } from './actor.mjs';
import { escapesRoot } from './contain.mjs';
import { fault } from './faults.mjs';
import { archiveJournal, makeOpId, writeJournal } from './journal.mjs';
import { withRootLock } from './lock.mjs';
import { sinkFor } from './sink.mjs';
import { trashDir } from './trash.mjs';

const fail = (code, extra = {}) => ({ ok: false, code, ...extra });

/** A forward-slash relative path with no empty, `.` or `..` parts, or null. */
function cleanRel(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0')) return null;
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return segs.join('/');
}

/** Library-relative folder markers ('a/b/') for every empty folder under `dir`. */
async function emptyFolders(dir, prefix) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 0 && prefix !== '') out.push(`${prefix}/`);
  for (const e of entries) if (e.isDirectory()) out.push(...(await emptyFolders(path.join(dir, e.name), prefix === '' ? e.name : `${prefix}/${e.name}`)));
  return out;
}

/**
 * @param {string} libraryRoot absolute library folder
 * @param {string} relDir where the new folder goes, library-relative with forward slashes (e.g. `north-road` or `series/north-road`)
 * @param {Map<string, Buffer>} files folder-relative path -> bytes (the shape renderTemplate returns)
 * @returns {Promise<{ ok: true, code: 'OK', opId: string, path: string } | { ok: false, code: string, [k: string]: any }>}
 *   Failure codes: BAD_ARGS, OUTSIDE_ROOT, NO_PARENT, FOLDER_EXISTS, TEMPLATE_INVALID (with `diagnostics`), ROLLED_BACK.
 *   After a failure the library has no new folder; the staged files, if any, are in `.storyforge/trash/<opId>/`.
 */
export async function createTree(libraryRoot, relDir, files) {
  const root = path.resolve(libraryRoot);
  const rel = cleanRel(relDir);
  if (!rel || rel.split('/')[0].toLowerCase() === '.storyforge' || (await escapesRoot(root, rel))) return fail('OUTSIDE_ROOT');
  if (!(files instanceof Map) || files.size === 0) return fail('BAD_ARGS', { message: 'files must be a non-empty Map of path -> Buffer' });
  for (const [f, bytes] of files) if (!cleanRel(f) || !Buffer.isBuffer(bytes)) return fail('BAD_ARGS', { message: `bad file entry: ${f}` });

  return withRootLock(root, async () => {
    const target = absOf(root, rel);
    if ((await kindOf(target)) !== null) return fail('FOLDER_EXISTS');
    if ((await kindOf(path.dirname(target))) !== 'dir') return fail('NO_PARENT');

    const opId = makeOpId();
    const stagingRel = `.storyforge/staging/${opId}`;
    const staging = absOf(root, stagingRel);
    const entry = { opId, op: 'createTree', args: { rel }, at: new Date().toISOString(), state: 'pending', files: [], tree: { target: rel, staging: stagingRel } };
    await writeJournal(root, entry);

    /** Staged folder to the trash; the journal entry is settled and archived. */
    async function giveUp() {
      if ((await kindOf(staging)) === 'dir') {
        const dest = path.join(trashDir(root, opId), 'failed');
        await mkdir(path.dirname(dest), { recursive: true });
        await moveFile(staging, dest);
      }
      await writeJournal(root, { ...entry, state: 'rolledBack', settled_at: new Date().toISOString() });
      await archiveJournal(root, opId);
    }

    const covered = sinkFor(root);
    const treeOp = (op, opArgs, fileList, dirs) => ({ opId: op === 'createTree' ? opId : `${opId}-rb`, op, args: opArgs, actor: currentActor() ?? null, files: fileList, dirs });
    let dbFiles = [];
    let dbDirs = [];
    let dbApplied = false;
    let done;
    try {
      await mkdir(staging, { recursive: true });
      for (const [f, bytes] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const dest = path.join(staging, ...f.split('/'));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeSynced(dest, bytes);
      }
      await fsyncDir(staging);
      const { diagnostics } = await validate(staging);
      if (diagnostics.length > 0) {
        await giveUp();
        return fail('TEMPLATE_INVALID', { opId, diagnostics });
      }
      fault('before-tree-rename');
      if ((await kindOf(target)) !== null) {
        await giveUp();
        return fail('FOLDER_EXISTS', { opId });
      }
      if (covered) {
        // Database first: the new folder's files (and its empty folders) in one transaction, then the rename.
        dbFiles = [...files].map(([f, bytes]) => ({ path: covered.lib(`${rel}/${f}`), before_sha256: null, bytes }));
        dbDirs = (await emptyFolders(staging, '')).map((d) => covered.lib(`${rel}/${d}`));
        const r = await covered.sink.applyOp(treeOp('createTree', { rel }, dbFiles, { add: dbDirs }));
        if (!r?.ok) {
          await giveUp();
          return r?.code === 'CONFLICT' ? fail('FOLDER_EXISTS', { opId }) : fail('ROLLED_BACK', { opId, message: `database write refused: ${r?.code ?? 'unknown'}` });
        }
        dbApplied = true;
      }
      await moveFile(staging, target);
      await fsyncDir(path.dirname(target));
      await writeJournal(root, { ...entry, state: 'done' });
      await archiveJournal(root, opId).catch(() => {}); // cosmetic: the entry is already 'done'
      done = { ok: true, code: 'OK', opId, path: rel };
    } catch (e) {
      let rollbackErrors;
      try {
        await giveUp();
      } catch (e2) {
        rollbackErrors = [String(/** @type {any} */ (e2)?.message ?? e2)];
      }
      if (dbApplied) {
        try {
          const r = await covered.sink.applyOp(
            treeOp('rollback', { undoes: opId }, dbFiles.map((f) => ({ path: f.path, before_sha256: sha256(f.bytes), bytes: null })), { remove: dbDirs }),
          );
          if (!r?.ok) (rollbackErrors ??= []).push(`database undo refused: ${r?.code ?? 'unknown'}`);
        } catch (e3) {
          (rollbackErrors ??= []).push(`database undo failed: ${String(/** @type {any} */ (e3)?.message ?? e3)}`);
        }
      }
      return fail('ROLLED_BACK', { opId, message: String(/** @type {any} */ (e)?.message ?? e), ...(rollbackErrors ? { rollbackErrors } : {}) });
    }
    await covered?.sink.afterDisk?.({ opId, op: 'createTree', paths: [...dbFiles.map((f) => f.path), ...dbDirs] });
    return done;
  });
}

/**
 * moveTree: move a whole existing folder (a book) to a new place inside the same library, in one step.
 * The move is a single directory rename, so the folder is either all at the old place or all at the new one.
 *   1. journal the op (state pending) under the library lock and the folder's own lock
 *   2. rename the folder; refuse if the new place appeared meanwhile
 *   3. journal state done
 * A crash leaves a pending journal entry; recovery (recover.mjs) settles it by looking where the folder is.
 * @param {string} libraryRoot absolute library folder
 * @param {string} fromRel the folder to move, library-relative with forward slashes
 * @param {string} toRel where it goes, library-relative with forward slashes; its parent must exist
 * @param {{ before?: (fromAbs: string) => Promise<void> }} [hooks] `before` runs inside the locks just before the
 *   rename (the caller releases file watches there); if it throws, nothing moves.
 * @returns {Promise<{ ok: true, code: 'OK', opId: string, path: string } | { ok: false, code: string, [k: string]: any }>}
 *   Failure codes: BAD_ARGS, OUTSIDE_ROOT, NO_SUCH_FOLDER, NO_PARENT, FOLDER_EXISTS, ROLLED_BACK.
 *   After a failure the folder is still at its old place.
 */
export async function moveTree(libraryRoot, fromRel, toRel, hooks = {}) {
  const root = path.resolve(libraryRoot);
  const from = cleanRel(fromRel);
  const to = cleanRel(toRel);
  if (!from || !to) return fail('BAD_ARGS', { message: 'from and to must be library-relative folder paths' });
  if (from === to || to.startsWith(`${from}/`)) return fail('BAD_ARGS', { message: 'a folder cannot move into itself' });
  for (const rel of [from, to]) {
    if (rel.split('/')[0].toLowerCase() === '.storyforge' || (await escapesRoot(root, rel))) return fail('OUTSIDE_ROOT');
  }

  const fromAbs = absOf(root, from);
  return withRootLock(root, () => withRootLock(fromAbs, async () => {
    const target = absOf(root, to);
    if ((await kindOf(fromAbs)) !== 'dir') return fail('NO_SUCH_FOLDER');
    if ((await kindOf(target)) !== null) return fail('FOLDER_EXISTS');
    if ((await kindOf(path.dirname(target))) !== 'dir') return fail('NO_PARENT');

    const opId = makeOpId();
    const entry = { opId, op: 'moveTree', args: { from, to }, at: new Date().toISOString(), state: 'pending', files: [], move: { from, to } };
    await writeJournal(root, entry);

    /** Nothing moved: the entry is settled as rolled back. */
    async function giveUp() {
      await writeJournal(root, { ...entry, state: 'rolledBack', settled_at: new Date().toISOString() });
      await archiveJournal(root, opId).catch(() => {});
    }

    const covered = sinkFor(root);
    const moveOp = (op, opArgs, fileList, dirs) => ({ opId: op === 'moveTree' ? opId : `${opId}-rb`, op, args: opArgs, actor: currentActor() ?? null, files: fileList, dirs });
    let dbForward = null; // { files, dirs } as applied
    let dbBack = null; // the same change reversed
    let done;
    try {
      if (hooks.before) await hooks.before(fromAbs);
      fault('before-tree-move');
      if ((await kindOf(target)) !== null) {
        await giveUp();
        return fail('FOLDER_EXISTS', { opId });
      }
      if (covered) {
        // Database first: every row under the old folder is removed and re-added under the new one, in one transaction.
        const libFrom = covered.lib(from);
        const libTo = covered.lib(to);
        const rows = (await covered.sink.listFiles({ prefix: `${libFrom}/` })).filter((r) => r.path.startsWith(`${libFrom}/`));
        const moved = (p) => `${libTo}/${p.slice(libFrom.length + 1)}`;
        const fwd = { files: [], dirs: { add: [], remove: [] } };
        const back = { files: [], dirs: { add: [], remove: [] } };
        for (const r of rows) {
          if (r.path.endsWith('/')) {
            fwd.dirs.remove.push(r.path);
            fwd.dirs.add.push(moved(r.path));
            back.dirs.remove.push(moved(r.path));
            back.dirs.add.push(r.path);
            continue;
          }
          const cur = await covered.sink.readFile(r.path);
          if (!cur) continue;
          fwd.files.push({ path: r.path, before_sha256: cur.sha256, bytes: null }, { path: moved(r.path), before_sha256: null, bytes: cur.bytes });
          back.files.push({ path: moved(r.path), before_sha256: cur.sha256, bytes: null }, { path: r.path, before_sha256: null, bytes: cur.bytes });
        }
        const res = await covered.sink.applyOp(moveOp('moveTree', { from, to }, fwd.files, fwd.dirs));
        if (!res?.ok) {
          await giveUp();
          return res?.code === 'CONFLICT' ? fail('FOLDER_EXISTS', { opId }) : fail('ROLLED_BACK', { opId, message: `database write refused: ${res?.code ?? 'unknown'}` });
        }
        dbForward = fwd;
        dbBack = back;
      }
      await moveFile(fromAbs, target);
      await fsyncDir(path.dirname(target));
      await fsyncDir(path.dirname(fromAbs));
      await writeJournal(root, { ...entry, state: 'done' });
      await archiveJournal(root, opId).catch(() => {}); // cosmetic: the entry is already 'done'
      done = { ok: true, code: 'OK', opId, path: to };
    } catch (e) {
      // the rename is atomic: if the folder is at the new place the move happened, whatever threw after it
      if ((await kindOf(target)) === 'dir' && (await kindOf(fromAbs)) === null) {
        await writeJournal(root, { ...entry, state: 'done' });
        await archiveJournal(root, opId).catch(() => {});
        await covered?.sink.afterDisk?.({ opId, op: 'moveTree', paths: dbForward ? dbForward.files.map((x) => x.path) : [] });
        return { ok: true, code: 'OK', opId, path: to };
      }
      let rollbackErrors;
      try {
        await giveUp();
      } catch (e2) {
        rollbackErrors = [String(/** @type {any} */ (e2)?.message ?? e2)];
      }
      if (dbForward) {
        try {
          const r = await covered.sink.applyOp(moveOp('rollback', { undoes: opId }, dbBack.files, dbBack.dirs));
          if (!r?.ok) (rollbackErrors ??= []).push(`database undo refused: ${r?.code ?? 'unknown'}`);
        } catch (e3) {
          (rollbackErrors ??= []).push(`database undo failed: ${String(/** @type {any} */ (e3)?.message ?? e3)}`);
        }
      }
      return fail('ROLLED_BACK', { opId, message: String(/** @type {any} */ (e)?.message ?? e), ...(rollbackErrors ? { rollbackErrors } : {}) });
    }
    await covered?.sink.afterDisk?.({ opId, op: 'moveTree', paths: dbForward ? dbForward.files.map((x) => x.path) : [] });
    return done;
  }));
}
