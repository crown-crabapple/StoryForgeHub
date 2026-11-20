// Migrations: numbered plain .sql files in packages/db/migrations, applied in name order, each once, each in its own transaction
// together with its schema_migrations row (ADR 0004). There are no down-migrations: going back is a restore from backup.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const NAME_RE = /^\d{3}-[a-z0-9-]+\.sql$/;

/** The migration files, sorted. @param {string} [dir] @returns {Promise<{ name: string, sql: string }[]>} */
export async function listMigrations(dir = MIGRATIONS_DIR) {
  const names = (await readdir(dir)).filter((n) => NAME_RE.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), 'utf8') })));
}

/**
 * Apply every migration not yet applied. Returns the names applied now (in order).
 * A failing migration rolls back on its own and stops the run; the ones before it stay applied.
 * @param {import('./connection.mjs').Database} db
 * @param {{ dir?: string, migrations?: { name: string, sql: string }[] }} [options]
 */
export async function migrate(db, { dir, migrations } = {}) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const all = migrations ?? (await listMigrations(dir));
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied = [];
  for (const m of all) {
    if (done.has(m.name)) continue;
    try {
      await db.transaction(async (tx) => {
        for (const stmt of splitSql(m.sql)) await tx.query(stmt);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [m.name]);
      });
    } catch (e) {
      throw new Error(`migration ${m.name} failed and was rolled back: ${e?.message ?? e}`, { cause: e });
    }
    applied.push(m.name);
  }
  return applied;
}

/**
 * Split a migration file into statements on ';' at the end of a line, outside comments. Migrations are plain DDL; no function
 * bodies or dollar quoting are used (a migration that needs them must be split by hand).
 * @param {string} sql
 */
export function splitSql(sql) {
  const out = [];
  let cur = [];
  for (const raw of sql.split(/\r?\n/)) {
    const line = raw.replace(/--.*$/, '');
    if (!line.trim()) continue;
    cur.push(line);
    if (/;\s*$/.test(line)) {
      out.push(cur.join('\n').replace(/;\s*$/, ''));
      cur = [];
    }
  }
  if (cur.join('').trim()) out.push(cur.join('\n'));
  return out;
}
