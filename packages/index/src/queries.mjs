// Read-only query helpers over an open index database. Rows are returned as plain objects.
import path from 'node:path';
import { SEARCH_KINDS } from './schema.mjs';
import { ftsQuery } from './text.mjs';

const plain = (rows) => rows.map((r) => ({ ...r }));

/** @param {import('node:sqlite').DatabaseSync} db */
export function readCounts(db) {
  const one = (sql, ...params) => /** @type {any} */ (db.prepare(sql).get(...params)).n;
  const kind = (k) => one('SELECT COUNT(*) AS n FROM objects WHERE kind = ? AND archived = 0', k);
  return {
    scenes: one('SELECT COUNT(*) AS n FROM scenes'),
    entries: kind('entry'),
    threads: kind('thread'),
    events: kind('event'),
    links: one('SELECT COUNT(*) AS n FROM links'),
    broken_links: one("SELECT COUNT(*) AS n FROM links WHERE resolution = 'broken'"),
    words: one('SELECT COALESCE(SUM(word_count), 0) AS n FROM scenes'),
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function makeQueries(db) {
  const all = (sql, ...params) => plain(db.prepare(sql).all(...params));
  const meta = () => new Map(all('SELECT key, value FROM meta').map((r) => [r.key, r.value]));

  return {
    bookId() {
      return meta().get('book_id') ?? null;
    },

    bookSummary() {
      const m = meta();
      const agg = /** @type {any} */ (db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(word_count), 0) AS w FROM scenes').get());
      const sev = (s) => /** @type {any} */ (db.prepare('SELECT COUNT(*) AS n FROM diagnostics WHERE severity = ?').get(s)).n;
      return {
        id: m.get('book_id') ?? null,
        slug: m.get('book_slug') ?? null,
        title: m.get('book_title') ?? null,
        series: m.get('series') ?? null,
        series_number: m.has('series_number') ? Number(m.get('series_number')) : null,
        status: m.get('book_status') ?? null,
        path: m.get('book_path') ?? '',
        scene_count: agg.n,
        word_count: agg.w,
        error_count: sev('error'),
        warning_count: sev('warning'),
      };
    },

    scenes() {
      return all('SELECT id, title, position, act, chapter, sequence, status, pov, word_count, path FROM scenes ORDER BY position');
    },

    excluded() {
      return all('SELECT id, path, reason FROM excluded ORDER BY rowid');
    },

    /** Chapters in manuscript order, each with its act: [{ act, act_label, chapter, label, title }]. */
    chapters() {
      const out = [];
      const seen = new Set();
      const titleStmt = db.prepare('SELECT title FROM objects WHERE path = ?');
      for (const s of all('SELECT act, act_label, chapter, chapter_label, path FROM scenes ORDER BY position')) {
        const key = `${s.act}/${s.chapter}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dir = path.posix.dirname(s.path);
        let title = null;
        if (path.posix.basename(dir).startsWith('ch-')) {
          const row = /** @type {any} */ (titleStmt.get(`${dir}/chapter.md`));
          title = row ? row.title : null;
        }
        out.push({ act: s.act, act_label: s.act_label, chapter: s.chapter, label: s.chapter_label, title });
      }
      return out;
    },

    links({ srcId, targetId, resolution } = {}) {
      const where = [];
      const params = [];
      if (srcId !== undefined) { where.push('src_id = ?'); params.push(srcId); }
      if (targetId !== undefined) { where.push('target_id = ?'); params.push(targetId); }
      if (resolution !== undefined) { where.push('resolution = ?'); params.push(resolution); }
      return all(
        `SELECT src_id, src_path, location, raw, target_id, target_kind, resolution FROM links${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`,
        ...params,
      );
    },

    /** Link rows that point at `id`, plus the linking object's kind and title when it has one. */
    backlinks(id) {
      return all(
        `SELECT l.src_id AS src_id, l.src_path AS src_path, o.kind AS src_kind, o.title AS src_title,
                l.location AS location, l.raw AS raw, l.target_id AS target_id, l.target_kind AS target_kind,
                l.resolution AS resolution
         FROM links l LEFT JOIN objects o ON o.id = l.src_id
         WHERE l.target_id = ? ORDER BY l.rowid`,
        id,
      );
    },

    mentions({ entryId, sceneId } = {}) {
      const where = [];
      const params = [];
      if (entryId !== undefined) { where.push('entry_id = ?'); params.push(entryId); }
      if (sceneId !== undefined) { where.push('scene_id = ?'); params.push(sceneId); }
      return all(`SELECT entry_id, scene_id, count FROM mentions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`, ...params);
    },

    diagnostics() {
      return all('SELECT code, severity, file, location, message FROM diagnostics ORDER BY rowid');
    },

    counts() {
      return readCounts(db);
    },

    /**
     * Full-text search. `q` is what the author typed: it becomes quoted prefix terms, never FTS syntax.
     * @param {string} q
     * @param {{ kinds?: string[], limit?: number }} [opts]
     */
    search(q, { kinds, limit = 20 } = {}) {
      const match = ftsQuery(q);
      if (match === '') return [];
      const n = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 20));
      const wanted = kinds ? kinds.filter((k) => SEARCH_KINDS.includes(k)) : null;
      if (wanted && wanted.length === 0) return [];
      const rows = all(
        `SELECT fts.id AS id, fts.kind AS kind, fts.title AS title, o.path AS path,
                snippet(fts, -1, '', '', '…', 16) AS snippet
         FROM fts LEFT JOIN objects o ON o.id = fts.id
         WHERE fts MATCH ?${wanted ? ` AND fts.kind IN (${wanted.map(() => '?').join(', ')})` : ''}
         ORDER BY bm25(fts, 0.0, 0.0, 4.0, 1.0), fts.rowid
         LIMIT ?`,
        match,
        ...(wanted ?? []),
        n,
      );
      return rows.map((r) => ({ ...r, snippet: String(r.snippet ?? '').replace(/\s+/g, ' ').trim() }));
    },
  };
}
