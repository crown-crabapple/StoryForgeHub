// CLI entry:
//   node apps/server/src/main.mjs --library <path> [--port <n>]        serve the library
//   node apps/server/src/main.mjs rebuild --library <path>             rebuild every book's index
//   node apps/server/src/main.mjs repair --library <path> [--apply]    print the repair plan; write only with --apply
//   node apps/server/src/main.mjs continuity --library <path> [--book <slug>] [--json]   print continuity findings (read-only, no lock)
//   node apps/server/src/main.mjs export --library <path> --book <slug> --format markdown|docx|epub|pdf --out <file> [--force]
//   node apps/server/src/main.mjs backup --library <path> --book <slug> --out <file.zip> [--provenance] [--force]
//   node apps/server/src/main.mjs restore --from <file.zip> --to <new or empty folder>
//   node apps/server/src/main.mjs import-legacy --dump <dir> [--book <legacy slug>]... --dry-run [--report <file.md>] [--json <file.json>]   print what importing a legacy dump would create (read-only; the import itself is M06-J02)
//   node apps/server/src/main.mjs receipts verify --library <path> --book <slug> [--json]   check the provenance receipts (read-only; exit 1 on integrity problems)
// Exit codes: 0 ok, 1 failed / needs hand repair / continuity errors found, 2 usage or cannot open the library, 3 another instance holds the library.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, LOCK_FILE, acquireLock, createFsRepository, createLibraryHost, loadConfig, releaseLock, releaseLockSync, updateLock } from '@storyforge/core';
import { FILE_COMMANDS, runFileCommand } from './export-cli.mjs';
import { LEGACY_COMMANDS, runLegacyCommand } from './legacy-cli.mjs';
import { runReceiptsCommand } from './receipts-cli.mjs';
import { createServer } from './server.mjs';

const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
const argv = process.argv.slice(2);
const COMMANDS = ['serve', 'rebuild', 'repair', 'continuity', 'receipts', ...LEGACY_COMMANDS, ...FILE_COMMANDS];
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve';
const apply = argv.includes('--apply');

/** @param {string} message @param {number} code */
function fail(message, code) {
  process.stderr.write(`storyforge: ${message}\n`);
  process.exit(code);
}

if (!COMMANDS.includes(command)) fail(`unknown command: ${command} (use serve, rebuild, repair, continuity, receipts, import-legacy, export, backup or restore)`, 2);

// import-legacy --dry-run reads a legacy dump and prints a plan: no library, no lock, no server
if (command === 'import-legacy') process.exit(await runLegacyCommand(argv.slice(1)));

// receipts verify is read-only too: no lock, no server
if (command === 'receipts') process.exit(await runReceiptsCommand(argv.slice(1)));

// export, backup and restore work on files only: no library config, no lock, no server
if (FILE_COMMANDS.includes(command)) process.exit(await runFileCommand(command, argv.slice(1)));

let config;
try {
  config = loadConfig({ argv: argv.slice(command === argv[0] ? 1 : 0), env: process.env });
} catch (e) {
  if (e instanceof ConfigError) fail(e.message, e.exitCode);
  throw e;
}

const lockPath = path.join(config.libraryRoot, LOCK_FILE);
let holdsLock = false;
/** The library host (server mode): after a switch it, not `lockPath`, knows which lock this process holds. */
/** @type {ReturnType<typeof createLibraryHost> | null} */
let host = null;
/** @type {Promise<unknown> | null} */
let releasing = null;

/**
 * Take the library lock or exit 3 naming the instance that has it. Released on exit, whatever the cause.
 * @param {number | null} port
 * @returns {Promise<'held' | 'taken-over'>}
 */
async function takeLock(port) {
  let r;
  try {
    r = await acquireLock(lockPath, { port });
  } catch (e) {
    return fail(`cannot open library ${config.libraryRoot}: ${e instanceof Error ? e.message : e}`, 2);
  }
  if (!r.ok) {
    const h = r.holder;
    const who = h ? `pid ${h.pid}${h.port ? `, port ${h.port}` : ''}${h.hostname ? `, host ${h.hostname}` : ''}` : 'an unreadable lock file';
    return fail(`another StoryForge instance is using ${config.libraryRoot} (${who}). Lock file: ${lockPath}`, 3);
  }
  holdsLock = true;
  // Last resort for any way out of the process; only ever removes a lock that is ours (same pid).
  process.on('exit', () => {
    if (!holdsLock) return;
    if (host) host.releaseSync();
    else releaseLockSync(lockPath);
  });
  return r.lock;
}

/** Idempotent; every caller waits for the same release. */
function releaseOwnLock() {
  if (!holdsLock) return Promise.resolve();
  releasing ??= (host ? host.close() : releaseLock(lockPath)).catch(() => {});
  return releasing;
}

/** Value of `--name <value>` or `--name=<value>` in the arguments, if given. @param {string} name */
function flagValue(name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fail(`${name} needs a value`, 2);
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

/** One line per source: where the evidence is and what it says. @param {any} s @param {string} prefix */
const sourceLine = (s, prefix) => `    ${s.role}: ${prefix}${s.file}:${s.line} (${s.location}) ${s.heading}: ${s.excerpt}
`;

/**
 * Continuity findings, plain text or --json. Read-only: no library lock and no index. Exit 1 when any error-severity finding remains.
 */
async function runContinuity() {
  const repository = createFsRepository(config.libraryRoot, { watch: false, pollMs: 0 });
  try {
    const slug = flagValue('--book');
    let books;
    try {
      books = (await repository.continuityBooks()).filter((b) => slug === undefined || b.slug === slug);
    } catch (e) {
      return fail(`cannot open library ${config.libraryRoot}: ${e instanceof Error ? e.message : e}`, 2);
    }
    if (books.length === 0) return fail(slug === undefined ? `no book found in ${config.libraryRoot}` : `no book with slug ${slug} in ${config.libraryRoot}`, 2);
    const results = [];
    for (const b of books) results.push({ ...b, ...(await repository.getContinuity(b.id)) });
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ books: results }, null, 2)}
`);
    } else {
      for (const r of results) {
        const prefix = r.path ? `${r.path}/` : '';
        const label = r.title ?? r.slug ?? (r.path || '.');
        process.stdout.write(`${label}: ${r.findings.length} continuity finding${r.findings.length === 1 ? '' : 's'}
`);
        for (const f of r.findings) {
          process.stdout.write(`  [${f.severity}] ${f.rule} ${f.title} (${f.fingerprint})
    ${f.message}
`);
          for (const s of f.sources) process.stdout.write(sourceLine(s, prefix));
        }
        if (r.suppressed.length) process.stdout.write(`  ${r.suppressed.length} suppressed by exceptions
`);
        for (const x of r.stale_exceptions) process.stdout.write(`  stale exception ${prefix}${x.file} (${x.fingerprint}) matches no current finding
`);
        for (const f of r.skipped) process.stdout.write(`  skipped ${prefix}${f} (cannot be read; see the validator)
`);
      }
    }
    process.exitCode = results.some((r) => r.findings.some((f) => f.severity === 'error')) ? 1 : 0;
  } catch (e) {
    process.stderr.write(`storyforge: continuity failed: ${e instanceof Error ? e.message : e}
`);
    process.exitCode = 1;
  } finally {
    await repository.close();
  }
}

/** One-shot commands: watching is off, and the process ends when the work is done. */
async function runCli() {
  if (command === 'continuity') return runContinuity();
  if (command === 'repair' && !apply) {
    // read-only: no lock needed, nothing written
    const repository = createFsRepository(config.libraryRoot, { watch: false, pollMs: 0 });
    try {
      process.exitCode = printPlans(await repository.repairPlans()) ? 1 : 0;
    } catch (e) {
      fail(`cannot open library ${config.libraryRoot}: ${e instanceof Error ? e.message : e}`, 2);
    } finally {
      await repository.close();
    }
    return;
  }
  await takeLock(null);
  const repository = createFsRepository(config.libraryRoot, { watch: false, pollMs: 0 });
  try {
    if (command === 'rebuild') {
      const r = await repository.rebuildIndex();
      for (const b of r.books) {
        const label = b.path || '.';
        if (!b.ok) process.stdout.write(`${label}: index build failed (${b.code}: ${b.message})\n`);
        else if (b.state === 'invalid') process.stdout.write(`${label}: index rebuilt, but the book has files that cannot be read: ${b.invalid_paths.join(', ')}\n`);
        else process.stdout.write(`${label}: index rebuilt (${b.counts?.scenes ?? 0} scenes)\n`);
      }
      process.exitCode = r.ok && r.books.every((b) => b.state !== 'invalid') ? 0 : 1;
    } else {
      const plans = await repository.repairPlans();
      let hand = printPlans(plans);
      for (const p of plans) {
        if (p.actions.length === 0) continue;
        const res = await repository.applyRepair(p.book_id, p.actions);
        process.stdout.write(`${p.path || '.'}: ${res.code}${res.message ? `: ${res.message}` : ''}\n`);
        for (const c of res.changes ?? []) process.stdout.write(`  ${c.from ?? '(new)'} -> ${c.to}\n`);
        if (!res.ok) hand = true;
      }
      process.exitCode = hand ? 1 : 0;
    }
  } catch (e) {
    process.stderr.write(`storyforge: ${command} failed: ${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  } finally {
    await repository.close();
    await releaseOwnLock();
  }
}

/** Print each book's plan like `sf-manuscript repair`. Returns true if anything needs hand repair. */
function printPlans(plans) {
  let hand = false;
  for (const p of plans) {
    const label = plans.length > 1 || p.path ? `${p.path || '.'}: ` : '';
    if (!p.ok) {
      process.stdout.write(`${label}cannot plan: ${p.code}: ${p.message}\n`);
      hand = true;
      continue;
    }
    for (const a of p.actions) process.stdout.write(a.kind === 'rename' ? `${label}rename ${a.from} -> ${a.to}\n` : `${label}renumber chapter ${a.chapter}\n`);
    for (const d of p.unrepairable) process.stdout.write(`${label}unrepairable ${d.code} ${d.file} ${d.location} (fix this file by hand)\n`);
    if (p.actions.length === 0 && p.unrepairable.length === 0) process.stdout.write(`${label}nothing to repair\n`);
    if (p.unrepairable.length) hand = true;
  }
  if (!apply) process.stdout.write('(plan only: nothing was changed; add --apply to carry it out)\n');
  return hand;
}

async function runServer() {
  const lock = await takeLock(config.port);

  const repository = createFsRepository(config.libraryRoot);
  try {
    await repository.libraryInfo();
  } catch (e) {
    fail(`cannot open library ${config.libraryRoot}: ${e instanceof Error ? e.message : e}`, 2);
  }

  // Settle any operation a crash left half-done before serving; the UI shows what happened.
  let recoverReport;
  try {
    recoverReport = await repository.recover();
  } catch (e) {
    fail(`recovery failed for ${config.libraryRoot}: ${e instanceof Error ? e.message : e}`, 2);
  }

  host = createLibraryHost({ repository, libraryRoot: config.libraryRoot, holdsLock: true, port: config.port });
  await host.remember(config.libraryRoot);

  const instance = { pid: process.pid, started_at: new Date().toISOString(), lock };
  const server = createServer({ host, webRoot, recoverReport, instance });
  server.on('error', (e) => fail(`cannot listen on ${config.host}:${config.port}: ${e.message}`, 1));

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await host?.close().catch(() => {});
    await releaseOwnLock();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('close', () => {
    releaseOwnLock();
  });

  server.listen(config.port, config.host, async () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : config.port;
    // the lock names the port we really got, and does so before anyone is told we are up
    if (port !== config.port) await updateLock(lockPath, { port }).catch(() => {});
    process.stdout.write(`StoryForge serving ${config.libraryRoot}\nhttp://${config.host}:${port}/\n`);
    // Indexes are built after the server is up; reads answer from the files until they are ready.
    host?.repository.ensureIndexes().then(
      (r) => {
        const failed = r.books.filter((b) => !b.ok);
        if (failed.length) process.stderr.write(`storyforge: index build failed for ${failed.map((b) => b.path || '.').join(', ')}\n`);
      },
      (e) => process.stderr.write(`storyforge: index build failed: ${e instanceof Error ? e.message : e}\n`),
    );
  });
}

if (command === 'serve') await runServer();
else await runCli();
