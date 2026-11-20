// The one-time Markdown library importer (H0 §5). It reads a library folder (and, optionally, a shared-mode data folder), always builds a
// report, and, only when asked, writes everything into the database in one operation. The source folder is only ever read.
// Sanctioned filesystem reader (see eslint.config.mjs).
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { discover, parseText, validate } from '@storyforge/format';
import { checkPath, derive, sha256 } from './document-store.mjs';

const KEEP_REVISIONS = 4;
const REVISION_FILE_RE = /^\d{8}T\d{6}Z-[a-z]{1,20}(-\d{1,4})?\.md$/;
const SCENE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SCENE_SCHEMA = 'storyforge.scene/v1';
const AUDIT = 'audit.jsonl';

/** @param {string} a @param {string} b */
const join = (a, b) => (a ? `${a}/${b}` : b);

/**
 * Walk the source: library files, empty folders, restore points. Dot-entries are skipped except `.storyforge/revisions/**`; symlinks are never followed.
 * @param {string} root absolute
 * @param {string | null} skipDir absolute folder to leave out (a shared-data folder that sits inside the source)
 */
async function walk(root, skipDir) {
  /** @type {{ path: string, bytes: Buffer }[]} */
  const files = [];
  /** @type {string[]} */
  const dirs = [];
  /** @type {{ bookPath: string, sceneId: string, file: string, bytes: Buffer }[]} */
  const revisionFiles = [];
  /** @type {{ bookPath: string, sceneId: string, entries: any[] | null }[]} */
  const revisionIndexes = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];

  /** @param {string} abs @param {string} rel @returns {Promise<boolean>} true when the folder yielded anything importable */
  async function visit(abs, rel) {
    const entries = (await readdir(abs, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let any = false;
    for (const e of entries) {
      const childRel = join(rel, e.name);
      const childAbs = path.join(abs, e.name);
      if (skipDir && childAbs === skipDir) {
        skipped.push({ path: `${childRel}/`, reason: 'shared-data folder (imported separately)' });
        continue;
      }
      if (e.isSymbolicLink()) {
        skipped.push({ path: childRel, reason: 'symbolic link (never followed)' });
        continue;
      }
      if (e.name.startsWith('.')) {
        if (e.name === '.storyforge' && e.isDirectory()) {
          await visitRevisionsOnly(childAbs, rel);
          skipped.push({ path: `${childRel}/`, reason: 'cache folder (only revisions/ is imported)' });
        } else {
          skipped.push({ path: childRel, reason: 'dot-entry' });
        }
        continue;
      }
      if (e.isDirectory()) {
        if (!checkPath(`${childRel}/`)) {
          skipped.push({ path: `${childRel}/`, reason: 'unsupported folder name' });
          continue;
        }
        if (!(await visit(childAbs, childRel))) dirs.push(`${childRel}/`); // nothing importable inside: an empty-folder marker
        any = true;
      } else if (e.isFile()) {
        if (!checkPath(childRel)) {
          skipped.push({ path: childRel, reason: 'unsupported file name' });
          continue;
        }
        files.push({ path: childRel, bytes: await readFile(childAbs) });
        any = true;
      } else {
        skipped.push({ path: childRel, reason: 'not a regular file' });
      }
    }
    return any;
  }

  /** @param {string} abs the .storyforge folder @param {string} bookPath */
  async function visitRevisionsOnly(abs, bookPath) {
    const revRoot = path.join(abs, 'revisions');
    let st;
    try {
      st = await lstat(revRoot);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    for (const scene of await readdir(revRoot, { withFileTypes: true })) {
      const rel = `${join(bookPath, '.storyforge')}/revisions/${scene.name}`;
      if (!scene.isDirectory() || scene.isSymbolicLink() || !SCENE_ID_RE.test(scene.name)) {
        skipped.push({ path: rel, reason: 'not a restore-point folder' });
        continue;
      }
      for (const f of await readdir(path.join(revRoot, scene.name), { withFileTypes: true })) {
        const fileRel = `${rel}/${f.name}`;
        if (!f.isFile() || f.isSymbolicLink()) {
          skipped.push({ path: fileRel, reason: 'not a regular file' });
        } else if (f.name === 'index.json') {
          let entries = null;
          try {
            const v = JSON.parse((await readFile(path.join(revRoot, scene.name, f.name), 'utf8')));
            if (Array.isArray(v)) entries = v.filter((x) => x && typeof x.file === 'string');
          } catch {
            entries = null;
          }
          revisionIndexes.push({ bookPath, sceneId: scene.name, entries });
        } else if (REVISION_FILE_RE.test(f.name)) {
          revisionFiles.push({ bookPath, sceneId: scene.name, file: f.name, bytes: await readFile(path.join(revRoot, scene.name, f.name)) });
        } else {
          skipped.push({ path: fileRel, reason: 'not a restore-point file name' });
        }
      }
    }
  }

  await visit(root, '');
  return { files, dirs, revisionFiles, revisionIndexes, skipped };
}

/**
 * Shared-mode data: top-level JSON documents and the audit log.
 * @param {string} dir absolute
 */
async function readSharedData(dir) {
  /** @type {{ name: string, bytes: Buffer }[]} */
  const docs = [];
  /** @type {{ name: string, lines: string[], bytes: Buffer }[]} */
  const logs = [];
  /** @type {{ path: string, reason: string }[]} */
  const skipped = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = `shared-data/${e.name}`;
    if (!e.isFile() || e.isSymbolicLink()) {
      skipped.push({ path: rel, reason: 'not a regular file' });
    } else if (e.name === AUDIT) {
      const bytes = await readFile(path.join(dir, e.name));
      const text = bytes.toString('utf8');
      const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
      logs.push({ name: e.name, lines, bytes });
    } else if (e.name.endsWith('.json')) {
      docs.push({ name: e.name, bytes: await readFile(path.join(dir, e.name)) });
    } else {
      skipped.push({ path: rel, reason: 'not a shared-mode data file' });
    }
  }
  return { docs, logs, skipped };
}

/** Newest-first by file name (the name starts with a UTC timestamp). @param {string[]} names */
const newestFirst = (names) => [...names].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

/**
 * Import a Markdown library into the database, or report what importing it would do.
 * @param {{ store: ReturnType<typeof import('./document-store.mjs').createDocumentStore>, source: string, sharedData?: string, dryRun?: boolean, now?: () => Date }} o
 * @returns {Promise<any>}
 */
export async function importLibrary({ store, source, sharedData, dryRun = true, now = () => new Date() }) {
  const root = path.resolve(source);
  const sharedRoot = sharedData ? path.resolve(sharedData) : null;
  const st = await lstat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`not a directory: ${source}`);
  if (sharedRoot && !(await lstat(sharedRoot).catch(() => null))?.isDirectory()) throw new Error(`not a directory: ${sharedData}`);
  const inside = sharedRoot && sharedRoot.startsWith(root + path.sep) ? sharedRoot : null;

  const w = await walk(root, inside);
  const shared = sharedRoot ? await readSharedData(sharedRoot) : { docs: [], logs: [], skipped: [] };

  // restore points: newest 4 per scene by file name
  /** @type {Map<string, typeof w.revisionFiles>} */
  const byScene = new Map();
  for (const r of w.revisionFiles) {
    const k = `${r.bookPath}\0${r.sceneId}`;
    if (!byScene.has(k)) byScene.set(k, []);
    byScene.get(k)?.push(r);
  }
  /** @type {{ bookPath: string, sceneId: string, file: string, bytes: Buffer, meta: any }[]} */
  const keptRevisions = [];
  const revisions = [];
  for (const [k, list] of [...byScene].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [bookPath, sceneId] = k.split('\0');
    const index = w.revisionIndexes.find((i) => i.bookPath === bookPath && i.sceneId === sceneId)?.entries ?? [];
    const keepNames = new Set(newestFirst(list.map((r) => r.file)).slice(0, KEEP_REVISIONS));
    for (const r of list) if (keepNames.has(r.file)) keptRevisions.push({ ...r, meta: index.find((e) => e.file === r.file) ?? null });
    revisions.push({ book: bookPath, scene: sceneId, found: list.length, kept: keepNames.size, kept_files: [...keepNames].sort() });
  }
  keptRevisions.sort((a, b) => (a.bookPath + a.sceneId + a.file < b.bookPath + b.sceneId + b.file ? -1 : 1));

  // fingerprint: sorted `path\0sha256\n` over what will be imported
  const lines = [
    ...w.files.map((f) => [f.path, sha256(f.bytes)]),
    ...keptRevisions.map((r) => [`${join(r.bookPath, '.storyforge')}/revisions/${r.sceneId}/${r.file}`, sha256(r.bytes)]),
    ...shared.docs.map((d) => [`shared-data/${d.name}`, sha256(d.bytes)]),
    ...shared.logs.map((d) => [`shared-data/${d.name}`, sha256(d.bytes)]),
  ]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([p, h]) => `${p}\0${h}\n`);
  const fingerprint = createHash('sha256').update(lines.join('')).digest('hex');

  // schema kinds, books, diagnostics
  const books = await findBooks(root, w.files);
  const bookOf = (p) => books.map((b) => b.path).filter((b) => b === '' || p.startsWith(`${b}/`)).sort((a, b) => b.length - a.length)[0];
  /** @type {Record<string, number>} */
  const kinds = {};
  /** @type {Record<string, number>} */
  const categories = {};
  let totalBytes = 0;
  for (const f of w.files) {
    totalBytes += f.bytes.length;
    const d = derive(f.path, f.bytes);
    if (d.schema) {
      const kind = d.schema.replace(/^storyforge\./, '').replace(/\/v\d+$/, '');
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    const b = bookOf(f.path);
    const within = b === undefined ? f.path : b === '' ? f.path : f.path.slice(b.length + 1);
    const segs = within.split('/');
    const cat = segs.length > 1 ? segs[0] : b === undefined ? '(library root)' : '(book root)';
    categories[cat] = (categories[cat] ?? 0) + 1;
  }
  for (const r of keptRevisions) totalBytes += r.bytes.length;
  for (const d of shared.docs) totalBytes += d.bytes.length;
  for (const d of shared.logs) totalBytes += d.bytes.length;

  const scenes = new Map();
  for (const f of w.files) {
    if (derive(f.path, f.bytes).schema !== SCENE_SCHEMA) continue;
    const b = bookOf(f.path);
    if (b === undefined) continue;
    const c = scenes.get(b) ?? { scenes: 0, archived_scenes: 0 };
    if (f.path.slice(b ? b.length + 1 : 0).startsWith('archive/')) c.archived_scenes++;
    else c.scenes++;
    scenes.set(b, c);
  }

  const validation = await validate(root);
  const diagnostics = {};
  for (const d of validation.diagnostics) {
    const key = d.file ? bookOf(d.file) ?? '(library)' : '(library)';
    const label = key === '' ? '(book)' : key;
    (diagnostics[label] ??= []).push({ code: d.code, severity: d.severity, file: d.file, location: d.location });
  }

  const skipped = [...w.skipped, ...shared.skipped].sort((a, b) => (a.path < b.path ? -1 : 1));
  const report = {
    fingerprint,
    source: root,
    files: w.files.length,
    empty_folders: w.dirs.length,
    total_bytes: totalBytes,
    kinds: sortKeys(kinds),
    categories: sortKeys(categories),
    books: books.map((b) => ({ path: b.path, id: b.id, slug: b.slug, scenes: scenes.get(b.path)?.scenes ?? 0, archived_scenes: scenes.get(b.path)?.archived_scenes ?? 0 })),
    diagnostics,
    revisions: {
      found: revisions.reduce((n, r) => n + r.found, 0),
      kept: keptRevisions.length,
      per_scene: revisions,
    },
    shared_data: {
      documents: shared.docs.map((d) => ({ name: d.name, bytes: d.bytes.length })),
      audit_lines: Object.fromEntries(shared.logs.map((l) => [l.name, l.lines.length])),
    },
    skipped,
  };

  const receipt = await store.findImportReceipt(fingerprint);
  if (receipt) return { ok: true, unchanged: true, ...(dryRun ? { dryRun: true } : {}), report };
  const empty = await store.isEmpty();
  if (dryRun) return { ok: true, dryRun: true, ...(empty ? {} : { blocked: 'NOT_EMPTY' }), report };
  if (!empty) return { ok: false, code: 'NOT_EMPTY', report };

  await store.ensureLibrary();
  const tag = fingerprint.slice(0, 16);
  const result = await store.applyOp({
    opId: `import-${tag}`,
    op: 'import',
    args: { fingerprint, source: root, files: w.files.length },
    actor: { kind: 'import' },
    files: w.files.map((f) => ({ path: f.path, before_sha256: null, bytes: f.bytes })),
    dirs: { add: w.dirs },
  });
  if (!result.ok) return { ok: false, code: result.code, message: /** @type {any} */ (result).message ?? `import failed on ${/** @type {any} */ (result).path ?? 'a file'}`, report };
  for (const r of keptRevisions) await store.putRevision(r.bookPath, r.sceneId, r.file, r.bytes, r.meta);
  for (const d of shared.docs) await store.writeShared(d.name, d.bytes);
  for (const l of shared.logs) for (const line of l.lines) await store.appendSharedLine(l.name, line);
  await store.addImportReceipt({ id: `import-${tag}`, sourcePath: root, fingerprint, report: { ...report, imported_at: now().toISOString() } });
  return { ok: true, imported: true, report };
}

/** The books of a source folder: discovered below it, or the folder itself when it holds a book.md. */
async function findBooks(root, files) {
  const found = files.some((f) => f.path === 'book.md') ? [{ path: '' }] : (await discover(root, 'library', () => {})).books;
  return found
    .map((b) => {
      const f = files.find((x) => x.path === join(b.path, 'book.md'));
      const d = f ? derive0(f) : {};
      return { path: b.path, id: d.id ?? null, slug: d.slug ?? null };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** id and slug from a book.md's front matter */
function derive0(f) {
  try {
    const p = parseText(f.bytes.toString('utf8'));
    return p.status === 'ok' && p.fm ? { id: typeof p.fm.id === 'string' ? p.fm.id : null, slug: typeof p.fm.slug === 'string' ? p.fm.slug : null } : {};
  } catch {
    return {};
  }
}

/** @param {Record<string, number>} o */
const sortKeys = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
