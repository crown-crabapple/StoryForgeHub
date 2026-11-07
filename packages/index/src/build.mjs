// Build index.sqlite in memory from the Markdown files. Nothing is written here: the caller gets bytes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractLinks, isFile, loadDoc, validate, walkMarkdown, walkSharedMarkdown } from '@storyforge/format';
import { withScratchFile } from '@storyforge/store';
import { bookFacts } from './book-facts.mjs';
import { buildGraph, mentionRows } from './graph.mjs';
import { DDL, FORMAT, OBJECT_KINDS, SCHEMA_VERSION, SEARCH_KINDS } from './schema.mjs';
import { stripForSearch } from './text.mjs';
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
  const context = await readContext(validateRoot, bookPath, book);
  const shared = await readSharedFiles(validateRoot, bookPath, book);
  return { bookRoot, bookPath, files, shared, book, prefix, rel, diagnostics, result, ...context };
}

/**
 * The series files a book's index depends on (the shared world under the series' codex/ and archive/), as rows for `shared_files`:
 * paths relative to the book root (`../codex/...`). Empty for a book outside a series or one validated on its own.
 */
async function readSharedFiles(validateRoot, bookPath, book) {
  const segs = bookPath === '' ? [] : bookPath.split('/');
  if (!book.series || segs.length < 2) return [];
  const seriesDir = path.join(validateRoot, ...segs.slice(0, -1));
  const out = [];
  for (const rel of await walkSharedMarkdown(seriesDir)) {
    const abs = path.join(seriesDir, ...rel.split('/'));
    const [bytes, st] = await Promise.all([readFile(abs), stat(abs)]);
    out.push({ rel: `../${rel}`, sha256: createHash('sha256').update(bytes).digest('hex'), size: st.size, mtime_ms: st.mtimeMs });
  }
  return out;
}

/** Front matter of the book's series.md and of library.md (null when there is none), for the book's display facts. */
async function readContext(validateRoot, bookPath, book) {
  const fmOf = async (file, rel) => {
    if (!(await isFile(file))) return null;
    const { doc } = await loadDoc(file, rel, rel, noop);
    return doc?.fm ?? null;
  };
  const segs = bookPath === '' ? [] : bookPath.split('/');
  const seriesFm = book.series && segs.length > 0 ? await fmOf(path.join(validateRoot, ...segs.slice(0, -1), 'series.md'), 'series.md') : null;
  const rootIsLibrary = bookPath !== '' && !(await isFile(path.join(validateRoot, 'series.md')));
  const libraryFm = rootIsLibrary ? await fmOf(path.join(validateRoot, 'library.md'), 'library.md') : null;
  return { seriesFm, libraryFm };
}

/** The index meta rows for a book's display facts (strings only; lists are JSON). */
function factsMeta(facts) {
  const m = { facts: '1', genre: JSON.stringify(facts.genre), blurb: facts.blurb, archived: facts.archived ? '1' : '0' };
  for (const k of ['subtitle', 'pen_name', 'pen_name_display', 'language', 'series_title', 'cover_color', 'cover']) {
    if (facts[k] !== null) m[k] = facts[k];
  }
  if (facts.word_target !== null) m.word_target = String(facts.word_target);
  return m;
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
  graph: ['from_id', 'to_id', 'kind', 'rel', 'label', 'src_path', 'location', 'count'],
  world_nodes: ['id', 'kind', 'type', 'title', 'owner', 'series_id', 'book_id', 'external', 'path'],
  fts: ['id', 'kind', 'title', 'body'],
};

/**
 * The bytes of an in-memory database. DatabaseSync#serialize exists only in newer Node releases (not in Node 22, which the engines field allows), so without it
 * the database is copied with VACUUM INTO to a private temporary file, read back and removed. Both give a complete, standalone SQLite file.
 * @param {DatabaseSync} db
 * @returns {Buffer}
 */
export function dbBytes(db) {
  const d = /** @type {any} */ (db);
  if (typeof d.serialize === 'function') {
    const u8 = d.serialize();
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  return withScratchFile('index.sqlite', (file) => {
    db.prepare('VACUUM INTO ?').run(file);
    return readFileSync(file);
  });
}

function keepProjection({ files, shared, diagnostics, seriesFm, libraryFm }, prev, { now, invalidPaths }) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(DDL);
    db.exec('BEGIN');
    const oldMeta = new Map(prev.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    const meta = new Map(oldMeta);
    meta.set('state', 'invalid');
    meta.set('invalid_since', oldMeta.get('state') === 'invalid' && oldMeta.get('invalid_since') ? oldMeta.get('invalid_since') : now);
    meta.set('invalid_paths', JSON.stringify(invalidPaths));
    // display facts come from book.md / series.md / library.md, not from the manuscript structure: always current
    for (const k of ['facts', 'genre', 'blurb', 'archived', 'subtitle', 'pen_name', 'pen_name_display', 'language', 'series_title', 'cover_color', 'cover', 'word_target']) meta.delete(k);
    const bookDoc = files.find((f) => f.rel === 'book.md')?.doc;
    if (bookDoc?.kind) for (const [k, v] of Object.entries(factsMeta(bookFacts({ fm: bookDoc.fm, body: bookDoc.body, seriesFm, libraryFm })))) meta.set(k, v);
    const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of meta) insMeta.run(k, v);

    const insFile = db.prepare('INSERT INTO files (path, sha256, size, mtime_ms, kind, schema, id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of files) insFile.run(f.rel, f.sha256, f.size, f.mtime_ms, f.kind, f.schema, f.id);
    const insShared = db.prepare('INSERT INTO shared_files (path, sha256, size, mtime_ms) VALUES (?, ?, ?, ?)');
    for (const f of shared) insShared.run(f.rel, f.sha256, f.size, f.mtime_ms);

    for (const [table, cols] of Object.entries(KEPT)) {
      const ins = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
      for (const row of prev.prepare(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY rowid`).all()) ins.run(...cols.map((c) => row[c]));
    }

    const insDiag = db.prepare('INSERT INTO diagnostics (code, severity, file, location, message) VALUES (?, ?, ?, ?, ?)');
    for (const d of diagnostics) insDiag.run(d.code, d.severity, d.file, d.location, d.message);

    db.exec('COMMIT');
    const counts = readCounts(db);
    return { bytes: dbBytes(db), counts };
  } finally {
    db.close();
  }
}

/** Build the projection from an already loaded book. `extraMeta` entries are added to `meta`. */
async function project({ bookPath, files, shared, book, rel, diagnostics, result, seriesFm, libraryFm }, { extraMeta = {} }) {
  const docs = files.map((f) => f.doc).filter((d) => d && d.kind);
  const docByRel = new Map(docs.map((d) => [d.rel, d]));
  const bookDoc = docByRel.get('book.md');
  const links = extractLinks(result, bookPath);

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
    if (bookDoc) Object.assign(meta, factsMeta(bookFacts({ fm: bookDoc.fm, body: bookDoc.body, seriesFm, libraryFm })));
    const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) insMeta.run(k, v);

    const insFile = db.prepare('INSERT INTO files (path, sha256, size, mtime_ms, kind, schema, id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of files) insFile.run(f.rel, f.sha256, f.size, f.mtime_ms, f.kind, f.schema, f.id);
    const insShared = db.prepare('INSERT INTO shared_files (path, sha256, size, mtime_ms) VALUES (?, ?, ?, ?)');
    for (const f of shared) insShared.run(f.rel, f.sha256, f.size, f.mtime_ms);

    const insObject = db.prepare('INSERT OR IGNORE INTO objects (id, kind, slug, title, type, status, path, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const titleOf = (d) => str(d.fm.title) ?? str(d.fm.name);
    for (const d of docs) {
      if (!OBJECT_KINDS.includes(d.kind) || typeof d.fm.id !== 'string') continue;
      insObject.run(d.fm.id, d.kind, str(d.fm.slug), titleOf(d), str(d.fm.type), str(d.fm.status), d.rel, d.archived ? 1 : 0);
    }

    const insScene = db.prepare(
      'INSERT INTO scenes (id, position, act, chapter, sequence, act_label, chapter_label, title, status, pov, word_count, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const s of book.order) {
      const p = rel(s.path);
      const doc = docByRel.get(p);
      const fm = doc?.fm ?? {};
      insScene.run(s.id, s.position, s.act, s.chapter, s.sequence, s.act_label, s.chapter_label, s.title, str(fm.status), str(fm.pov), countWords(doc?.body ?? ''), p);
    }

    const insExcluded = db.prepare('INSERT INTO excluded (id, path, reason) VALUES (?, ?, ?)');
    for (const e of book.excluded) insExcluded.run(e.id, rel(e.path), e.reason);

    const insLink = db.prepare('INSERT INTO links (src_id, src_path, location, raw, target_id, target_kind, resolution) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const l of links) insLink.run(l.src_id, l.src_path, l.location, l.raw, l.target_id, l.target_kind, l.resolution);

    const mentions = mentionRows(docs, book.order, rel);
    const insMention = db.prepare('INSERT INTO mentions (entry_id, scene_id, count) VALUES (?, ?, ?)');
    for (const m of mentions) insMention.run(m.entry_id, m.scene_id, m.count);

    const insEdge = db.prepare('INSERT INTO graph (from_id, to_id, kind, rel, label, src_path, location, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const graph = buildGraph(result, mentions, bookPath);
    const insNode = db.prepare('INSERT INTO world_nodes (id, kind, type, title, owner, series_id, book_id, external, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const n of graph.nodes) {
      if (n.owner) insNode.run(n.id, n.kind, n.type, n.name, n.owner, n.series_id ?? null, n.book_id ?? null, n.external ? 1 : 0, n.path ?? '');
    }
    for (const e of graph.edges) {
      insEdge.run(e.from, e.to, e.kind, e.rel, e.label ?? null, e.source.path, e.source.location, e.count ?? null);
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
    return { bytes: dbBytes(db), counts };
  } finally {
    db.close();
  }
}
