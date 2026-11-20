// CLI: node apps/server/src/main.mjs db migrate|status|import|export --database <url> [--library-id <id>] ...   (Phase 1, H0 section 5)
//      db migrate                                          apply the database migrations
//      db status                                           applied and pending migrations, file count, the last change-log entries
//      db import <folder> [--shared-data <dir>] [--write]  report what importing a Markdown library would do (default), or import it (--write)
//      db export <out> [--shared-out <dir>]                write the library (and the shared-mode documents) to a new or empty folder
// The database URL is never printed with its password. Exit codes: 0 ok, 1 failed or refused, 2 usage.
import { createDocumentStore, exportLibrary, importLibrary, listMigrations, migrate, openDatabase, redactUrl } from '@storyforge/db';

const SUBCOMMANDS = ['migrate', 'status', 'import', 'export'];
const VALUE_FLAGS = ['--database', '--library-id', '--shared-data', '--shared-out'];
const BOOL_FLAGS = ['--write'];

/** @param {string[]} argv @returns {{ values: Record<string, string>, flags: Set<string>, positional: string[] }} */
function parse(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.includes(name)) {
      if (eq > 0) values[name] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values[name] = argv[++i];
      else throw new Error(`${name} needs a value`);
    } else if (BOOL_FLAGS.includes(a)) {
      flags.add(a);
    } else if (a.startsWith('--')) {
      throw new Error(`unknown argument: ${a}`);
    } else {
      positional.push(a);
    }
  }
  return { values, flags, positional };
}

/** @param {Record<string, number>} o */
const table = (o) => Object.entries(o).map(([k, v]) => `    ${k.padEnd(24)} ${v}`);

/** The import report as plain text. @param {any} r */
export function formatReport(r) {
  const out = [];
  out.push(`source        ${r.source}`);
  out.push(`fingerprint   ${r.fingerprint}`);
  out.push(`files         ${r.files} (${r.total_bytes} bytes), ${r.empty_folders} empty folders`);
  out.push('', 'documents by kind');
  out.push(...table(r.kinds));
  out.push('', 'files by category');
  out.push(...table(r.categories));
  out.push('', 'books');
  for (const b of r.books) out.push(`    ${b.path || '(root)'}  ${b.id ?? '(no id)'}  scenes ${b.scenes}, archived scenes ${b.archived_scenes}`);
  out.push('', 'validation (errors do not block the import)');
  const keys = Object.keys(r.diagnostics);
  if (keys.length === 0) out.push('    no diagnostics');
  for (const k of keys) {
    out.push(`    ${k}`);
    for (const d of r.diagnostics[k]) out.push(`      ${d.code} ${d.severity ?? ''} ${d.file}${d.location ? ` (${d.location})` : ''}`);
  }
  out.push('', `restore points: ${r.revisions.found} found, ${r.revisions.kept} kept (newest 4 per scene)`);
  for (const s of r.revisions.per_scene) out.push(`    ${s.book || '(root)'} ${s.scene}: ${s.found} found, ${s.kept} kept`);
  out.push('', 'shared data');
  if (r.shared_data.documents.length === 0 && Object.keys(r.shared_data.audit_lines).length === 0) out.push('    none');
  for (const d of r.shared_data.documents) out.push(`    ${d.name} (${d.bytes} bytes)`);
  for (const [n, c] of Object.entries(r.shared_data.audit_lines)) out.push(`    ${n}: ${c} lines`);
  out.push('', `skipped (${r.skipped.length})`);
  for (const s of r.skipped) out.push(`    ${s.path}  ${s.reason}`);
  return out.join('\n');
}

/**
 * @param {string[]} argv arguments after `db`
 * @returns {Promise<number>} the exit code
 */
export async function runDbCommand(argv) {
  const say = (s) => process.stdout.write(`${s}\n`);
  const complain = (s) => process.stderr.write(`storyforge: ${s}\n`);
  const sub = argv[0];
  if (!SUBCOMMANDS.includes(sub)) {
    complain(`db needs one of ${SUBCOMMANDS.join(', ')}`);
    return 2;
  }
  let args;
  try {
    args = parse(argv.slice(1));
  } catch (e) {
    complain(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const { values, flags, positional } = args;
  const url = values['--database'] ?? process.env.STORYFORGE_DATABASE;
  if (!url) {
    complain('db needs --database <url> (postgres://, pglite:memory or pglite:<folder>)');
    return 2;
  }
  const wantPositional = sub === 'import' || sub === 'export' ? 1 : 0;
  if (positional.length !== wantPositional) {
    complain(sub === 'import' ? 'db import needs <folder>' : sub === 'export' ? 'db export needs <out>' : `db ${sub} takes no folder`);
    return 2;
  }
  if (sub !== 'import' && (flags.has('--write') || values['--shared-data'])) {
    complain('--write and --shared-data only apply to db import');
    return 2;
  }
  if (sub !== 'export' && values['--shared-out']) {
    complain('--shared-out only applies to db export');
    return 2;
  }

  let db;
  try {
    db = await openDatabase(url);
  } catch (e) {
    complain(redactUrl(e instanceof Error ? e.message : String(e)));
    return 1;
  }
  try {
    const store = createDocumentStore(db, values['--library-id'] ?? 'main');
    const hasTable = async (name) => (await db.query('SELECT to_regclass($1) AS t', [`public.${name}`])).rows[0]?.t != null;

    if (sub === 'migrate') {
      const applied = await migrate(db);
      say(`database ${redactUrl(url)}`);
      say(applied.length ? `applied ${applied.length}: ${applied.join(', ')}` : 'nothing to apply: the database is up to date');
      return 0;
    }

    if (sub === 'status') {
      say(`database     ${redactUrl(url)}`);
      say(`library id   ${store.libraryId}`);
      const done = (await hasTable('schema_migrations')) ? (await db.query('SELECT name, applied_at FROM schema_migrations ORDER BY name')).rows : [];
      const doneNames = new Set(done.map((r) => r.name));
      say('migrations');
      for (const r of done) say(`  applied  ${r.name}  ${new Date(r.applied_at).toISOString()}`);
      for (const m of await listMigrations()) if (!doneNames.has(m.name)) say(`  pending  ${m.name}`);
      if (await hasTable('library_file')) {
        const files = await store.listFiles();
        say(`files        ${files.filter((f) => !f.path.endsWith('/')).length} (${files.filter((f) => f.path.endsWith('/')).length} empty folders)`);
        const ops = await store.listOps({ limit: 5 });
        say(ops.length ? 'last operations' : 'last operations: none');
        for (const o of ops) say(`  ${new Date(o.at).toISOString()}  ${o.op}  ${o.op_id}  (${(o.files ?? []).length} files)`);
      } else {
        say('files        (not migrated yet: run "db migrate")');
      }
      return 0;
    }

    if (sub === 'import') {
      const write = flags.has('--write');
      /** @type {any} */
      let target = store;
      if (!(await hasTable('library_file'))) {
        if (write) {
          complain('the database has no tables yet: run "db migrate" first');
          return 1;
        }
        // a dry run writes nothing, not even the schema: report against an empty library
        target = { findImportReceipt: async () => null, isEmpty: async () => true };
      }
      const r = await importLibrary({ store: target, source: positional[0], sharedData: values['--shared-data'], dryRun: !write });
      say(formatReport(r.report));
      say('');
      if (r.unchanged) {
        say('This exact folder was already imported. Nothing was changed.');
        return 0;
      }
      if (r.ok === false) {
        complain(r.code === 'NOT_EMPTY' ? 'refused: the library already holds files and this folder is different from the one imported before' : `import failed: ${r.code} ${r.message ?? ''}`);
        return 1;
      }
      if (r.dryRun) say(r.blocked ? 'Dry run only. A real import would be refused: the library is not empty.' : 'Dry run only: nothing was written. Run again with --write to import.');
      else say(`Imported ${r.report.files} files into library "${store.libraryId}".`);
      return 0;
    }

    // export
    if (!(await hasTable('library_file'))) {
      complain('the database has no tables yet: run "db migrate" first');
      return 1;
    }
    const r = await exportLibrary({ store, out: positional[0], sharedOut: values['--shared-out'] });
    if (!r.ok) {
      complain(`refused: ${r.path} exists and is not empty`);
      return 1;
    }
    say(`exported ${r.files} files, ${r.empty_folders} empty folders and ${r.revisions} restore points to ${positional[0]}${values['--shared-out'] ? `; ${r.shared_documents} shared documents to ${values['--shared-out']}` : ''}`);
    return 0;
  } catch (e) {
    complain(`db ${sub} failed: ${redactUrl(e instanceof Error ? e.message : String(e))}`);
    return 1;
  } finally {
    await db.close().catch(() => {});
  }
}
