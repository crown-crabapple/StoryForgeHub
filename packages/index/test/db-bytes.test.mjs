// dbBytes: the bytes of an in-memory index, with DatabaseSync#serialize when Node has it and with VACUUM INTO otherwise (Node 22 has no serialize). Both paths must give a
// complete SQLite file whose full-text table still answers.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { dbBytes } from '../src/build.mjs';

function sample() {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2'); CREATE TABLE meta (key TEXT, value TEXT);");
  db.prepare('INSERT INTO fts VALUES (?, ?)').run('scene_1', 'A ferry town with one café');
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('state', 'fresh');
  return db;
}

/** Open bytes as a database file and read it back. @param {Buffer} bytes */
function reopen(bytes) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sf-dbbytes-'));
  try {
    const file = path.join(dir, 'index.sqlite');
    writeFileSync(file, bytes);
    const db = new DatabaseSync(file);
    try {
      return { hits: db.prepare('SELECT id FROM fts WHERE fts MATCH ?').all('"cafe"*').map((r) => r.id), state: db.prepare("SELECT value FROM meta WHERE key = 'state'").get()?.value };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('dbBytes gives a standalone SQLite file whose search still works', () => {
  const db = sample();
  try {
    const bytes = dbBytes(db);
    assert.equal(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');
    assert.deepEqual(reopen(bytes), { hits: ['scene_1'], state: 'fresh' });
  } finally {
    db.close();
  }
});

test('dbBytes falls back to VACUUM INTO when serialize is missing (Node 22)', () => {
  const db = sample();
  try {
    const noSerialize = new Proxy(db, { get: (t, k) => (k === 'serialize' ? undefined : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    const bytes = dbBytes(/** @type {any} */ (noSerialize));
    assert.deepEqual(reopen(bytes), { hits: ['scene_1'], state: 'fresh' });
  } finally {
    db.close();
  }
});
