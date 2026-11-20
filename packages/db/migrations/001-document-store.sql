-- H0 §2.0: the Phase 1 document store. Every library file lives here; the database is canonical.

CREATE TABLE library (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A file of the library (path is library-relative, forward slashes). An empty folder is a row with bytes NULL and a path ending in '/'.
CREATE TABLE library_file (
  library_id    text NOT NULL REFERENCES library(id),
  path          text NOT NULL,
  bytes         bytea,
  sha256        text,
  size          integer NOT NULL DEFAULT 0,
  schema        text,
  doc_id        text,
  front_matter  jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    jsonb,
  PRIMARY KEY (library_id, path),
  CHECK ((bytes IS NULL) = (right(path, 1) = '/')),
  CHECK ((bytes IS NULL) = (sha256 IS NULL))
);
CREATE INDEX library_file_doc_id ON library_file (library_id, doc_id) WHERE doc_id IS NOT NULL;
CREATE INDEX library_file_schema ON library_file (library_id, schema) WHERE schema IS NOT NULL;

-- The change log: one row per committed write operation.
CREATE TABLE library_op (
  op_id       text PRIMARY KEY,
  library_id  text NOT NULL REFERENCES library(id),
  op          text NOT NULL,
  args        jsonb,
  actor       jsonb,
  at          timestamptz NOT NULL DEFAULT now(),
  files       jsonb NOT NULL
);
CREATE INDEX library_op_at ON library_op (library_id, at);

-- What each op replaced or removed, so Undo and rollback can put it back.
CREATE TABLE library_trash (
  op_id  text NOT NULL REFERENCES library_op(op_id) ON DELETE CASCADE,
  path   text NOT NULL,
  bytes  bytea NOT NULL,
  PRIMARY KEY (op_id, path)
);

-- Restore points (FORMAT-v1 §9 revisions). book_path is library-relative ('' for a one-book library).
CREATE TABLE scene_revision (
  library_id  text NOT NULL REFERENCES library(id),
  book_path   text NOT NULL,
  scene_id    text NOT NULL,
  file        text NOT NULL,
  bytes       bytea NOT NULL,
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, book_path, scene_id, file)
);

-- Shared-mode JSON files (users.json, members.json, ...) and append-only logs (audit.jsonl).
CREATE TABLE shared_doc (
  library_id  text NOT NULL REFERENCES library(id),
  name        text NOT NULL,
  bytes       bytea NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, name)
);
CREATE TABLE shared_line (
  library_id  text NOT NULL REFERENCES library(id),
  name        text NOT NULL,
  seq         bigint NOT NULL,
  line        text NOT NULL,
  PRIMARY KEY (library_id, name, seq)
);

CREATE TABLE import_receipt (
  id           text PRIMARY KEY,
  library_id   text NOT NULL REFERENCES library(id),
  source_path  text NOT NULL,
  fingerprint  text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now(),
  report       jsonb NOT NULL
);
CREATE INDEX import_receipt_fingerprint ON import_receipt (library_id, fingerprint);
