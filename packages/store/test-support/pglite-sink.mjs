// Test mode (STORYFORGE_TEST_DB=pglite): one in-memory PGlite document store per process, attached to the filesystem root of every store, so every
// write the existing suites make goes through the database first. Test-only; production code never imports this.
//
// Tests build fixtures on disk behind the store's back, so before each database write this adapter "adopts" any path whose disk content the
// database has not seen (an `adopt` op). After each successful write it checks the database and the disk hold the same bytes.
//
// Paths: the store hands this adapter library-relative paths measured from the filesystem root (`Users/x/book/a.md`); inside the database
// they carry the drive letter in front (`C/Users/x/book/a.md`; no prefix on POSIX).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachDatabase } from '../src/sink.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => (b ? createHash('sha256').update(b).digest('hex') : null);

const readOrNull = (file) => {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR' || e?.code === 'EISDIR') return null;
    throw e;
  }
};

/** Every regular file under `dir` as registry-relative paths, skipping `.storyforge` and tmp files. */
function walkFiles(dir, prefix, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.storyforge' || e.name.endsWith('.sf-tmp')) continue;
    if (e.isDirectory()) walkFiles(path.join(dir, e.name), `${prefix}${e.name}/`, out);
    else if (e.isFile()) out.push(`${prefix}${e.name}`);
  }
  return out;
}

/** @param {any} docs a document store @param {string} driveRoot e.g. `C:\` or `/` */
function adapterFor(docs, driveRoot) {
  const letter = driveRoot.match(/^([A-Za-z]):/)?.[1].toUpperCase() ?? '';
  const pfx = (p) => (letter ? (p === '' ? letter : `${letter}/${p}`) : p); // registry-relative -> database path
  const abs = (p) => path.join(driveRoot, ...p.split('/').filter(Boolean));
  const strip = (dbPath) => (letter ? (dbPath.startsWith(`${letter}/`) ? dbPath.slice(letter.length + 1) : null) : dbPath);
  const mapFiles = (files) => files.map((f) => ({ ...f, path: pfx(f.path) }));
  const mapDirs = (d) => (d ? { add: (d.add ?? []).map(pfx), remove: (d.remove ?? []).map(pfx) } : undefined);

  /** Make the database agree with the disk where the caller's base says the disk is right and the database has not seen it. */
  async function adopt(opId, entries) {
    const files = [];
    for (const { p, before } of entries) {
      const row = await docs.readFile(pfx(p));
      const dbSha = row?.sha256 ?? null;
      if (dbSha === before) continue;
      const disk = readOrNull(abs(p));
      if (sha(disk) !== before) continue; // the disk disagrees with the caller too: a genuine conflict, left for applyOp to report
      files.push({ path: pfx(p), before_sha256: dbSha, bytes: disk });
    }
    if (files.length) {
      const r = await docs.applyOp({ opId: `${opId}-adopt`, op: 'adopt', args: null, actor: null, files });
      if (!r.ok) throw new Error(`test database could not adopt ${files.map((f) => f.path).join(', ')}: ${r.code}`);
    }
  }

  return {
    async applyOp(change) {
      await adopt(change.opId, change.files.map((f) => ({ p: f.path, before: f.before_sha256 })));
      const r = await docs.applyOp({ ...change, files: mapFiles(change.files), dirs: mapDirs(change.dirs) });
      return r.ok || r.code !== 'CONFLICT' ? r : { ...r, path: strip(r.path) ?? r.path };
    },
    /** With `{ prefix }` (a registry-relative folder path ending '/'), first adopts everything on disk under it. */
    async listFiles(o) {
      if (o?.prefix) {
        const dbPrefix = pfx(o.prefix);
        const known = (await docs.listFiles()).filter((r) => r.path.startsWith(dbPrefix) && !r.path.endsWith('/'));
        const entries = new Map();
        for (const p of walkFiles(abs(o.prefix), o.prefix)) entries.set(p, readOrNull(abs(p)));
        for (const r of known) {
          const p = strip(r.path);
          if (p !== null && !entries.has(p)) entries.set(p, null); // gone from disk behind the store's back
        }
        const files = [];
        for (const [p, bytes] of entries) {
          const row = known.find((r) => r.path === pfx(p));
          if ((row?.sha256 ?? null) === sha(bytes)) continue;
          files.push({ path: pfx(p), before_sha256: row?.sha256 ?? null, bytes });
        }
        if (files.length) {
          const r = await docs.applyOp({ opId: `adopt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, op: 'adopt', args: null, actor: null, files });
          if (!r.ok) throw new Error(`test database could not adopt ${o.prefix}: ${r.code}`);
        }
      }
      return (await docs.listFiles()).flatMap((r) => {
        const p = strip(r.path);
        return p === null ? [] : [{ ...r, path: p }];
      });
    },
    readFile: (p) => docs.readFile(pfx(p)),
    putRevision: (bookPath, sceneId, file, bytes, meta) => docs.putRevision(pfx(bookPath), sceneId, file, bytes, meta),
    deleteRevisions: (bookPath, sceneId, files) => docs.deleteRevisions(pfx(bookPath), sceneId, files),
    /** After a write is fully on disk: the database and the disk must hold identical bytes. */
    async afterDisk({ op, paths }) {
      for (const p of paths) {
        if (p.endsWith('/')) continue; // folder markers
        const row = await docs.readFile(pfx(p));
        const disk = readOrNull(abs(p));
        const same = row === null ? disk === null : disk !== null && Buffer.compare(row.bytes, disk) === 0;
        if (!same) {
          throw new Error(`STORYFORGE_TEST_DB: after ${op}, database and disk differ at ${abs(p)} (database ${row ? row.sha256 : 'absent'}, disk ${sha(disk) ?? 'absent'})`);
        }
      }
    },
  };
}

/** Open the in-memory database and attach it to the filesystem root of the temp folder, the working folder and the repo. */
export async function attachTestDatabase() {
  const { openDatabase, migrate, createDocumentStore } = await import('@storyforge/db');
  const db = await openDatabase('pglite:memory');
  await migrate(db);
  const docs = createDocumentStore(db, 'test-library');
  await docs.ensureLibrary();
  const roots = new Set([os.tmpdir(), process.cwd(), path.resolve(here, '../../..')].map((p) => path.parse(path.resolve(p)).root));
  for (const root of roots) attachDatabase(root, adapterFor(docs, root));
  return { db, docs };
}
