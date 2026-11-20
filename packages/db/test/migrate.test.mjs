import assert from 'node:assert/strict';
import test from 'node:test';
import { listMigrations, migrate, openDatabase, splitSql } from '../src/index.mjs';

const tables = async (db) => (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")).rows.map((r) => r.table_name);

test('migrations apply once, in order; a second run applies none', async () => {
  const db = await openDatabase('pglite:memory');
  try {
    const all = (await listMigrations()).map((m) => m.name);
    assert.ok(all.length >= 1);
    assert.deepEqual(await migrate(db), all);
    assert.deepEqual(await migrate(db), []);
    const rows = (await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    assert.deepEqual(rows, all);
    assert.ok((await tables(db)).includes('library_file'));
  } finally {
    await db.close();
  }
});

test('a failing migration rolls back whole: no table, no schema_migrations row; earlier ones stay', async () => {
  const db = await openDatabase('pglite:memory');
  try {
    const migrations = [
      { name: '001-ok.sql', sql: 'CREATE TABLE kept (id int);' },
      { name: '002-bad.sql', sql: 'CREATE TABLE half (id int);\nINSERT INTO half VALUES (1);\nSELECT * FROM does_not_exist;' },
    ];
    await assert.rejects(() => migrate(db, { migrations }), /002-bad\.sql failed and was rolled back/);
    const t = await tables(db);
    assert.ok(t.includes('kept'));
    assert.ok(!t.includes('half'));
    assert.deepEqual((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name), ['001-ok.sql']);
    // fixing the migration lets the run continue from where it stopped
    assert.deepEqual(await migrate(db, { migrations: [migrations[0], { name: '002-bad.sql', sql: 'CREATE TABLE half (id int);' }] }), ['002-bad.sql']);
  } finally {
    await db.close();
  }
});

test('splitSql: splits on a semicolon at the end of a line, drops comments and blank lines', () => {
  assert.deepEqual(splitSql('-- a comment\nCREATE TABLE a (\n  id int -- trailing\n);\n\nCREATE INDEX i ON a (id);\n'), ['CREATE TABLE a (\n  id int \n)', 'CREATE INDEX i ON a (id)']);
  assert.deepEqual(splitSql(''), []);
  assert.deepEqual(splitSql('SELECT 1'), ['SELECT 1']);
  assert.deepEqual(splitSql('SELECT 1; SELECT 2;'), ['SELECT 1; SELECT 2']); // only a semicolon at the end of a line splits
});
