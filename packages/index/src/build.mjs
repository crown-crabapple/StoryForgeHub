// Build index.sqlite in memory from the Markdown files. Nothing is written here: the caller gets bytes.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadDoc, validate, walkMarkdown } from '@storyforge/format';
import { collectLinks } from './links.mjs';
import { DDL, FORMAT, OBJECT_KINDS, SCHEMA_VERSION, SEARCH_KINDS } from './schema.mjs';
import { foldText, mentionCounter, stripForSearch } from './text.mjs';
import { countWords } from './word-count.mjs';
import { readCounts } from './queries.mjs';

const str = (v) => (typeof v === 'string' ? v : null);
const noop = () => {};

/**
 * Read every .md file of the book. Files whose (size, mtime) match a cache entry are not re-read; files
 * whose sha256 matches are not re-parsed.
 * @param {string} bookRoot
 * @param {Map<string, any>} cache rel -> { size, mtime_ms, sha256, doc, kind, schema, id }
 */
async function readFiles(bookRoot, cache) {
  const rels = await walkMarkdown(bookRoot);
  const seen = new Set(rels);
  for (const rel of [...cache.keys()]) if (!seen.has(rel)) cache.delete(rel);
  const entries = [];
  for (const rel of rels) {
    const abs = path.join(bookRoot, ...rel.split('/'));
    const st = await stat(abs);
    const hit = cache.get(rel);
    if (hit && hit.size === st.size && hit.mtime_ms === st.mtimeMs) {
      entries.push(hit);
      continue;
    }
    const bytes = await readFile(abs);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let entry;
    if (hit && hit.sha256 === sha256) {
      entry = { ...hit, size: st.size, mtime_ms: st.mtimeMs };
    } else {
      const { doc } = await loadDoc(abs, rel, rel, noop);
      entry = {
        rel, size: st.size, mtime_ms: st.mtimeMs, sha256, doc,
        kind: doc?.kind ?? null, schema: str(doc?.fm.schema), id: str(doc?.fm.id),
      };
    }
    cache.set(rel, entry);
    entries.push(entry);
  }
  return entries;
}

/** Read the book's files and validate it: everything a build (normal or reconciling) starts from. */
async function load({ bookRoot, validateRoot, bookPath, cache }) {
  const files = await readFiles(bookRoot, cache);
  const result = await validate(validateRoot);
  const book = result.books.find((b) => b.path === bookPath);
  if (!book) throw Object.assign(new Error(`no book at ${bookPath || '.'}`), { code: 'NOT_A_BOOK' });

  const prefix = bookPath === '' ? '' : `${bookPath}/`;
  const rel = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const diagnostics = result.diagnostics.filter((d) => prefix === '' || d.file.startsWith(prefix)).map((d) => ({ ...d, file: rel(d.file) }));
  return { bookRoot, bookPath, files, book, prefix, rel, diagnostics };
}

/**
 * @param {{ bookRoot: string, validateRoot: string, bookPath: string, cache: Map<string, any> }} p
 *   validateRoot is the folder handed to validate(): the library root, or the book root itself.
 * @returns {Promise<{ bytes: Buffer, counts: object }>}
 */
export async function buildIndex(p) {
  return project(await load(p), {});
}

/** Manuscript-structure errors (E1xx/E2xx on files under manuscript/), as in the manuscript contract rule 5. */
export const structureErrors = (diagnostics) =>
  diagnostics.filter((d) => d.severity === 'error' && /^E[12]\d\d$/.test(d.code) && d.file.startsWith('manuscript/'));

/** The distinct files those errors are on, sorted. */
export const invalidPathsOf = (errs) => [...new Set(errs.map((d) => d.file))].sort();

/**
 * Reconciling build (contract M01-J04 section 2). With no structure errors this is a normal build. With
 * them, the last valid projection (`prev`, an open read-only database) is kept as it is, except for the
 * `files` and `diagnostics` tables and the invalid markers; with no usable `prev`, whatever can be built
 * from the current files is built and marked invalid.
 * @param {{ bookRoot: string, validateRoot: string, bookPath: string, cache: Map<string, any> }} p
 * @param {{ prev: import('node:sqlite').DatabaseSync | null }} o
 * @returns {Promise<{ bytes: Buffer, counts: object, state: 'fresh' | 'invalid', invalid_paths: string[] }>}
 */
export async function buildReconciled(p, { prev }) {
  const ctx = await load(p);
  const errs = structureErrors(ctx.diagnostics);
  if (errs.length === 0) return { ...(await project(ctx, {})), state: 'fresh', invalid_paths: [] };
  const invalidPaths = invalidPathsOf(errs);
  const now = new Date().toISOString();
  if (!prev) {
    const built = await project(ctx, { extraMeta: { state: 'invalid', invalid_since: now, invalid_paths: JSON.stringify(invalidPaths) } });
    return { ...built, state: 'invalid', invalid_paths: invalidPaths };
  }
  const built = keepProjection(ctx, prev, { now, invalidPaths });
  return { ...built, state: 'invalid', invalid_paths: invalidPaths };
}

/** Columns copied unchanged from the last valid projection. */
const KEPT = {
  objects: ['id', 'kind', 'slug', 'title', 'type', 'status', 'path', 'archived'],
  scenes: ['id', 'position', 'act', 'chapter', 'sequence', 'act_label', 'chapter_label', 'title', 'status', 'pov', 'word_count', 'path'],
  excluded: ['id', 'path', 'reason'],
  links: ['src_id', 'src_path', 'location', 'raw', 'target_id', 'target_kind', 'resolution'],
  mentions: ['entry_id', 'scene_id', 'count'],
  fts: ['id', 'kind', 'title', 'body'],
};

function keepProjection({ files, diagnostics }, prev, { now, invalidPaths }) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(DDL);
    db.exec('BEGIN');
    const oldMeta = new Map(prev.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    const meta = new Map(oldMeta);
    meta.set('state', 'invalid');
    meta.set('invalid_since', oldMeta.get('state') === 'invalid' && oldMeta.get('invalid_since') ? oldMeta.get('invalid_since') : now);
    meta.set('invalid_paths', JSON.stringify(invalidPaths));
    const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of meta) insMeta.run(k, v);

    const insFile = db.prepare('INSERT INTO files (path, sha256, size, mtime_ms, kind, schema, id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of files) insFile.run(f.rel, f.sha256, f.size, f.mtime_ms, f.kind, f.schema, f.id);

    for (const [table, cols] of Object.entries(KEPT)) {
      const ins = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of prev.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY rowid`).all()) ins.run(...cols.map((c) => row[c]));
    }

    const insDiag = db.prepare('INSERT INTO diagnostics (code, severity, file, location, message) VALUES (?, ?, ?, ?, ?)');
    for (const d of diagnostics) insDiag.run(d.code, d.severity, d.file, d.location, d.message);

    db.exec('COMMIT');
    const counts = readCounts(db);
    const u8 = db.serialize();
    return { bytes: Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength), counts };
  } finally {
    db.close();
  }
}

/** Build the projection from an already loaded book. `extraMeta` entries are added to `meta`. */
async function project({ bookRoot, bookPath, files, book, rel, diagnostics }, { extraMeta = {} }) {

  const docs = files.map((f) => f.doc).filter((d) => d && d.kind);
  const docByRel = new Map(docs.map((d) => [d.rel, d]));
  const bookDoc = docByRel.get('book.md');
  const bookDir = path.join(bookRoot);
  const links = await collectLinks(docs, bookDir);

  const db = new DatabaseSync(':memory:');
  try {
    db.exec(DDL);
    db.exec('BEGIN');

    const meta = {
      schema_version: String(SCHEMA_VERSION),
      built_at: new Date().toISOString(),
      format: FORMAT,
      book_path: bookPath,
      ...extraMeta,
    };
    if (book.id) meta.book_id = book.id;
    if (book.slug) meta.book_slug = book.slug;
    if (book.title !== null) meta.book_title = book.title;
    if (str(bookDoc?.fm.status)) meta.book_status = bookDoc.fm.status;
    if (book.series) meta.series = book.series;
    const sn = bookDoc?.fm.series_number;
    if (typeof sn === 'number' && Number.isFinite(sn)) meta.series_number = String(sn);
    const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) insMeta.run(k, v);

    const insFile = db.prepare('INSERT INTO files (path, sha256, size, mtime_ms, kind, schema, id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of files) insFile.run(f.rel, f.sha256, f.size, f.mtime_ms, f.kind, f.schema, f.id);

    const insObject = db.prepare('INSERT OR IGNORE INTO objects (id, kind, slug, title, type, status, path, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const titleOf = (d) => str(d.fm.title) ?? str(d.fm.name);
    for (const d of docs) {
      if (!OBJECT_KINDS.includes(d.kind) || typeof d.fm.id !== 'string') continue;
      insObject.run(d.fm.id, d.kind, str(d.fm.slug), titleOf(d), str(d.fm.type), str(d.fm.status), d.rel, d.archived ? 1 : 0);
    }

    const insScene = db.prepare(
      'INSERT INTO scenes (id, position, act, chapter, sequence, act_label, chapter_label, title, status, pov, word_count, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const sceneText = [];
    for (const s of book.order) {
      const p = rel(s.path);
      const doc = docByRel.get(p);
      const fm = doc?.fm ?? {};
      insScene.run(s.id, s.position, s.act, s.chapter, s.sequence, s.act_label, s.chapter_label, s.title, str(fm.status), str(fm.pov), countWords(doc?.body ?? ''), p);
      sceneText.push({ id: s.id, text: foldText(stripForSearch(doc?.body ?? '')) });
    }

    const insExcluded = db.prepare('INSERT INTO excluded (id, path, reason) VALUES (?, ?, ?)');
    for (const e of book.excluded) insExcluded.run(e.id, rel(e.path), e.reason);

    const insLink = db.prepare('INSERT INTO links (src_id, src_path, location, raw, target_id, target_kind, resolution) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const l of links) insLink.run(l.src_id, l.src_path, l.location, l.raw, l.target_id, l.target_kind, l.resolution);

    const insMention = db.prepare('INSERT INTO mentions (entry_id, scene_id, count) VALUES (?, ?, ?)');
    for (const d of docs) {
      if (d.kind !== 'entry' || typeof d.fm.id !== 'string') continue;
      const count = mentionCounter([d.fm.name, ...(Array.isArray(d.fm.aliases) ? d.fm.aliases : [])]);
      if (!count) continue;
      for (const s of sceneText) {
        const n = count(s.text);
        if (n > 0) insMention.run(d.fm.id, s.id, n);
      }
    }

    const insDiag = db.prepare('INSERT INTO diagnostics (code, severity, file, location, message) VALUES (?, ?, ?, ?, ?)');
    for (const d of diagnostics) insDiag.run(d.code, d.severity, d.file, d.location, d.message);

    const insFts = db.prepare('INSERT INTO fts (id, kind, title, body) VALUES (?, ?, ?, ?)');
    for (const d of docs) {
      if (!SEARCH_KINDS.includes(d.kind) || typeof d.fm.id !== 'string') continue;
      insFts.run(d.fm.id, d.kind, titleOf(d) ?? '', stripForSearch(d.body));
    }

    db.exec('COMMIT');
    const counts = readCounts(db);
    const u8 = db.serialize();
    return { bytes: Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength), counts };
  } finally {
    db.close();
  }
}
