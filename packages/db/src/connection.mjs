// The one place StoryForge talks to a database server (ADR 0004). `openDatabase(url)` returns the same small interface for:
//   postgres://… / postgresql://…   a PostgreSQL server (production), through `pg`
//   pglite:memory                   an in-process PostgreSQL in memory (tests)
//   pglite:<folder>                 an in-process PostgreSQL kept in a folder (local dev, a single writer)
// Every caller uses `query` and `transaction`; nothing else in the repo imports `pg` or `@electric-sql/pglite`.

/**
 * @typedef {{ rows: any[], rowCount: number }} QueryResult
 * @typedef {{ query: (text: string, params?: any[]) => Promise<QueryResult> }} Queryable
 * @typedef {Queryable & {
 *   kind: 'pg' | 'pglite',
 *   transaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>,
 *   close: () => Promise<void>,
 * }} Database
 */

/** A one-at-a-time lock: transactions on one Database never interleave (PGlite has one connection; pg gets one too, for simple, predictable ordering). */
function mutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}

/** Hide credentials in a URL before it appears in an error or a log. @param {string} url */
export function redactUrl(url) {
  return String(url).replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:***@');
}

/**
 * @param {string} url
 * @returns {Promise<Database>}
 */
export async function openDatabase(url) {
  if (typeof url !== 'string' || url === '') throw new Error('a database URL is required (postgres://…, pglite:memory or pglite:<folder>)');
  const serial = mutex();

  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const where = url.slice('pglite:'.length);
    const pg = where === 'memory' ? new PGlite() : new PGlite(where);
    await pg.waitReady;
    const query = async (text, params = []) => {
      const r = await pg.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    };
    return {
      kind: 'pglite',
      query: (text, params) => serial(() => query(text, params)),
      transaction: (fn) =>
        serial(() =>
          pg.transaction(async (t) => {
            const tq = { query: async (text, params = []) => {
              const r = await t.query(text, params);
              return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
            } };
            return fn(tq);
          }),
        ),
      close: () => pg.close(),
    };
  }

  if (/^postgres(ql)?:\/\//.test(url)) {
    const { default: pgModule } = await import('pg');
    const pool = new pgModule.Pool({ connectionString: url, max: 4 });
    // fail fast on a bad URL or an unreachable server, with the password hidden
    try {
      const c = await pool.connect();
      c.release();
    } catch (e) {
      await pool.end().catch(() => {});
      throw new Error(`cannot connect to ${redactUrl(url)}: ${e?.message ?? e}`, { cause: e });
    }
    return {
      kind: 'pg',
      query: (text, params = []) => pool.query(text, params).then((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 })),
      transaction: (fn) =>
        serial(async () => {
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            const value = await fn({ query: (text, params = []) => c.query(text, params).then((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 })) });
            await c.query('COMMIT');
            return value;
          } catch (e) {
            await c.query('ROLLBACK').catch(() => {});
            throw e;
          } finally {
            c.release();
          }
        }),
      close: () => pool.end(),
    };
  }

  throw new Error(`unsupported database URL ${redactUrl(url)} (use postgres://…, pglite:memory or pglite:<folder>)`);
}
