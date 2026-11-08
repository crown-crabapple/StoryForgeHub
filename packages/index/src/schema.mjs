// Table definitions for index.sqlite. Bump SCHEMA_VERSION when anything here changes: an index with
// a different version is treated as stale and rebuilt from the files.

export const SCHEMA_VERSION = 4; // 4: scenes.origin (M12 W6); 2: graph table (M04-J01); 3: world_nodes (series shared entries, cross-book targets) and shared_files (M07-J01)
export const FORMAT = 'storyforge-format/1';
export const INDEX_FILE = 'index.sqlite';

/** Kinds that get a row in `objects`. */
export const OBJECT_KINDS = ['scene', 'entry', 'thread', 'event', 'chapter', 'act', 'doc', 'research', 'source', 'book'];
/** Kinds whose bodies are searchable. */
export const SEARCH_KINDS = ['scene', 'entry', 'thread', 'event', 'doc', 'research'];

export const DDL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (
  path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
  kind TEXT, schema TEXT, id TEXT
);
CREATE TABLE objects (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, slug TEXT, title TEXT, type TEXT, status TEXT,
  path TEXT NOT NULL, archived INTEGER NOT NULL
);
CREATE TABLE scenes (
  id TEXT NOT NULL, position INTEGER NOT NULL, act INTEGER, chapter INTEGER, sequence INTEGER,
  act_label TEXT, chapter_label TEXT, title TEXT, status TEXT, pov TEXT, word_count INTEGER NOT NULL, path TEXT NOT NULL, origin TEXT
);
CREATE INDEX scenes_id ON scenes (id);
CREATE TABLE excluded (id TEXT, path TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE links (
  src_id TEXT, src_path TEXT NOT NULL, location TEXT NOT NULL, raw TEXT NOT NULL,
  target_id TEXT, target_kind TEXT, resolution TEXT NOT NULL
);
CREATE INDEX links_target ON links (target_id);
CREATE INDEX links_src ON links (src_id);
CREATE TABLE mentions (entry_id TEXT NOT NULL, scene_id TEXT NOT NULL, count INTEGER NOT NULL);
CREATE TABLE graph (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, rel TEXT NOT NULL, label TEXT,
  src_path TEXT NOT NULL, location TEXT NOT NULL, count INTEGER
);
CREATE INDEX graph_from ON graph (from_id);
CREATE INDEX graph_to ON graph (to_id);
-- graph nodes that are not this book's own documents: the series' shared entries (owner 'series', path relative to the library root)
-- and cross-book targets (external = 1: only id, kind, title and path of the other book's object)
CREATE TABLE world_nodes (
  id TEXT NOT NULL, kind TEXT NOT NULL, type TEXT, title TEXT, owner TEXT NOT NULL, series_id TEXT, book_id TEXT,
  external INTEGER NOT NULL, path TEXT NOT NULL
);
-- the series files this book's index was built from (path relative to the book root, e.g. ../codex/characters/x.md)
CREATE TABLE shared_files (path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL);
CREATE TABLE diagnostics (
  code TEXT NOT NULL, severity TEXT NOT NULL, file TEXT NOT NULL, location TEXT NOT NULL, message TEXT NOT NULL
);
CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, kind UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2');
`;

/** Tables compared by tests and by "refresh equals rebuild" (everything but meta.built_at). */
export const TABLES = ['files', 'objects', 'scenes', 'excluded', 'links', 'mentions', 'graph', 'world_nodes', 'shared_files', 'diagnostics'];
