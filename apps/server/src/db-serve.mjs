// `serve --database <url>`: the database is the source of truth and the library folder is its private on-disk copy (H0 section 2.0).
// Startup order matters for crash safety: open + migrate, claim the folder (marker), settle what a crash left half-done on disk (store journal recovery),
// make the folder match the database (database wins), and only then attach the write-through sink, so every later store write goes to the database first.
import path from 'node:path';
import { claimCopy, claimSharedDir, createDocumentStore, materialize, migrate, openDatabase, redactUrl } from '@storyforge/db';
import { validate } from '@storyforge/format';
import { attachDatabase, attachSharedDatabase, detachDatabase, detachSharedDatabase, openStore } from '@storyforge/store';

/** A reason the server must not start in database mode; the message is safe to print (the URL is redacted). */
export class DatabaseStartError extends Error {}

/** The shared-data folder holds files the database has never seen: refuse rather than delete them. */
const SHARED_REFUSAL = (dir, files) =>
  `${dir} holds shared-mode data (${files.join(', ')}) that is not in the database: import it first with \`storyforge db import <library> --shared-data <dir> --write --database <url>\`, or use an empty --shared-data folder`;

const say = (/** @type {string} */ line) => process.stdout.write(`${line}\n`);

/** The store journals of the library folder and of every book in it are settled (openStore runs the recovery pass). @param {string} root */
async function recoverCopy(root) {
  const roots = new Set([root]);
  try {
    for (const b of (await validate(root)).books) roots.add(b.path === '' ? root : path.join(root, ...b.path.split('/')));
  } catch {
    // a folder that cannot be scanned has nothing to recover
  }
  for (const r of roots) await openStore(r);
}

/**
 * @param {{ url: string, libraryId?: string, libraryRoot: string, sharedDir?: string | null, log?: (line: string) => void }} o
 * @returns {Promise<{
 *   db: import('@storyforge/db').Database,
 *   store: ReturnType<typeof createDocumentStore>,
 *   libraryRoot: string,
 *   onOutsideChange: (dir: string, rels: string[]) => Promise<void>,
 *   status: () => Promise<{ kind: string, library_id: string, files: number }>,
 *   close: () => Promise<void>,
 * }>}
 * @throws {DatabaseStartError}
 */
export async function startDatabaseMode({ url, libraryId = 'main', libraryRoot, sharedDir = null, log = say }) {
  const root = path.resolve(libraryRoot);
  const shown = redactUrl(url);
  /** @type {import('@storyforge/db').Database} */
  let db;
  try {
    db = await openDatabase(url);
  } catch (e) {
    throw new DatabaseStartError(`cannot open the database ${shown}: ${redactUrl(e instanceof Error ? e.message : String(e))}`);
  }
  try {
    await migrate(db);
    const store = createDocumentStore(db, libraryId);
    const countFiles = async () => (await store.listFiles()).filter((f) => !f.path.endsWith('/')).length;
    if ((await countFiles()) === 0) {
      throw new DatabaseStartError(`library "${libraryId}" in ${shown} has no files: run \`storyforge db import <folder> --write --database <url>\` first`);
    }
    const claim = await claimCopy({ dir: root, libraryId, database: shown });
    if (!claim.ok) {
      throw new DatabaseStartError(
        claim.code === 'OTHER_LIBRARY'
          ? `${root} is the on-disk copy of library "${String(claim.library_id)}", not "${libraryId}" (use another --library folder, or the matching --library-id)`
          : `${root} already holds files and is not a StoryForge database copy: it would be overwritten from the database. Use an empty folder for --library (a real Markdown library is never touched)`,
      );
    }
    if (sharedDir) {
      const sc = await claimSharedDir({ dir: sharedDir, store });
      if (!sc.ok) throw new DatabaseStartError(SHARED_REFUSAL(sharedDir, sc.files));
    }
    await recoverCopy(root);
    const made = await materialize({ store, dir: root, ...(sharedDir ? { sharedDir } : {}) });
    attachDatabase(root, store);
    if (sharedDir) attachSharedDatabase(sharedDir, store);
    log(`Database ${shown}, library "${libraryId}": ${made.unchanged + made.written} files in ${root} (${made.written} written, ${made.removed} removed)`);

    // An outside change to the copy is never an author edit: the database version is put back before the index or the receipts see it.
    let chain = Promise.resolve();
    /** @param {string} dir @param {string[]} rels */
    const onOutsideChange = (dir, rels) => {
      const run = chain.then(async () => {
        const r = await materialize({ store, dir: root });
        if (r.written + r.removed === 0) return;
        for (const rel of rels) log(`db: outside change to ${dir === '' ? rel : `${dir}/${rel}`} overwritten from the database`);
      });
      chain = run.catch(() => {});
      return run;
    };

    return {
      db,
      store,
      libraryRoot: root,
      onOutsideChange,
      status: async () => ({ kind: db.kind, library_id: libraryId, files: await countFiles() }),
      async close() {
        await chain;
        detachDatabase(root);
        if (sharedDir) detachSharedDatabase(sharedDir);
        await db.close().catch(() => {});
      },
    };
  } catch (e) {
    await db.close().catch(() => {});
    if (e instanceof DatabaseStartError) throw e;
    throw new DatabaseStartError(`database start failed: ${redactUrl(e instanceof Error ? e.message : String(e))}`);
  }
}


/**
 * For the shared-mode CLIs (`shared init`, `shared reset-owner`, `audit verify`) with --database: open and migrate, make `sharedDir` match the database's shared
 * documents (database wins), and attach the shared sink so the command's writes land in the database first. No library files are needed or touched.
 * @param {{ url: string, libraryId?: string, sharedDir: string }} o
 * @returns {Promise<{ close: () => Promise<void> }>}
 * @throws {DatabaseStartError}
 */
export async function openSharedDatabase({ url, libraryId = 'main', sharedDir }) {
  const dir = path.resolve(sharedDir);
  let db;
  try {
    db = await openDatabase(url);
  } catch (e) {
    throw new DatabaseStartError(`cannot open the database ${redactUrl(url)}: ${redactUrl(e instanceof Error ? e.message : String(e))}`);
  }
  try {
    await migrate(db);
    const store = createDocumentStore(db, libraryId);
    await store.ensureLibrary();
    const sc = await claimSharedDir({ dir, store });
    if (!sc.ok) throw new DatabaseStartError(SHARED_REFUSAL(dir, sc.files));
    await materialize({ store, sharedDir: dir });
    attachSharedDatabase(dir, store);
  } catch (e) {
    await db.close().catch(() => {});
    if (e instanceof DatabaseStartError) throw e;
    throw new DatabaseStartError(`database start failed: ${redactUrl(e instanceof Error ? e.message : String(e))}`);
  }
  return {
    async close() {
      detachSharedDatabase(dir);
      await db.close().catch(() => {});
    },
  };
}
