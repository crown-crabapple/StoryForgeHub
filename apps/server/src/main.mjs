// CLI entry:
//   node apps/server/src/main.mjs [--library <path>] [--port <n>] [--profile <name>] [--open]   serve the library (without --library: the last one used, else a StoryForge folder in the home folder)
//   node apps/server/src/main.mjs --help                                lists every command and flag (help.mjs)
//   node apps/server/src/main.mjs serve --shared [--shared-data <dir>] [--host <addr>] [--public-url <https://...>]   optional shared mode: accounts, roles, invites, share links, audit (M07-J03a)
//   node apps/server/src/main.mjs shared init --owner <username> [--library <path>] [--shared-data <dir>] [--public-url <url>]   create the owner and print the one-time setup link
//   node apps/server/src/main.mjs audit verify [--shared-data <dir> | --library <path>]   check the shared-mode audit chain (exit 1 when broken or truncated)
//   node apps/server/src/main.mjs rebuild --library <path>             rebuild every book's index
//   node apps/server/src/main.mjs repair --library <path> [--apply]    print the repair plan; write only with --apply
//   node apps/server/src/main.mjs continuity --library <path> [--book <slug>] [--json]   print continuity findings (read-only, no lock)
//   node apps/server/src/main.mjs export --library <path> --book <slug> --format markdown|docx|epub|pdf --out <file> [--force]
//   node apps/server/src/main.mjs backup --library <path> --book <slug> --out <file.zip> [--provenance] [--force]
//   node apps/server/src/main.mjs restore --from <file.zip> --to <new or empty folder>
//   node apps/server/src/main.mjs import-legacy --dump <dir> [--book <legacy slug>]... --dry-run [--report <file.md>] [--json <file.json>]   print what importing a legacy dump would create (read-only)
//   node apps/server/src/main.mjs import-legacy --dump <dir> [--book <legacy slug>]... --into <new library folder> [--report <file.md>] [--json <file.json>]   import into a NEW folder, validate, reconcile against the dump (M06-J02)
//   node apps/server/src/main.mjs import-legacy --dump <dir> --reconcile <library folder> [--report <file.md>] [--json <file.json>]   check an imported library against the dump (read-only)
//   node apps/server/src/main.mjs import-legacy --compare <library A> <library B>   are two imports byte-identical? (read-only)
//   node apps/server/src/main.mjs receipts verify --library <path> --book <slug> [--json]   check the provenance receipts (read-only; exit 1 on integrity problems)
// Exit codes: 0 ok, 1 failed / needs hand repair / continuity errors found, 2 usage or cannot open the library, 3 another instance holds the library.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, LOCK_FILE, acquireLock, createFsRepository, createLibraryHost, releaseLock, releaseLockSync, resolveConfig, updateLock, writeNewTree } from '@storyforge/core';
import { FILE_COMMANDS, runFileCommand } from './export-cli.mjs';
import { HELP } from './help.mjs';
import { openBrowser } from './open-browser.mjs';
import { LEGACY_COMMANDS, runLegacyCommand } from './legacy-cli.mjs';
import { profileNameFrom } from './preferences.mjs';
import { runReceiptsCommand } from './receipts-cli.mjs';
import { createServer } from './server.mjs';
import { createSharedGate } from './shared-gate.mjs';
import { PERSONAL_HOST, SHARED_COMMANDS, defaultSharedDir, isLoopbackHost, parsePublicUrl, runSharedCommand, sharedDirProblem } from './shared-cli.mjs';
import { SharedDataError, createAudit, openSettings, openSharedData } from '@storyforge/shared';

const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
const argv = process.argv.slice(2);
const COMMANDS = ['serve', 'rebuild', 'repair', 'continuity', 'receipts', ...SHARED_COMMANDS, ...LEGACY_COMMANDS, ...FILE_COMMANDS];
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve';
const apply = argv.includes('--apply');

/** @param {string} message @param {number} code */
function fail(message, code) {
  process.stderr.write(`storyforge: ${message}\n`);
  process.exit(code);
}

if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}
if (!COMMANDS.includes(command)) fail(`unknown command: ${command} (use serve, rebuild, repair, continuity, receipts, shared, audit, import-legacy, export, backup or restore; --help lists them all)`, 2);

// import-legacy reads a legacy dump (and writes only a NEW folder with --into): no library config, no lock, no server
if (command === 'import-legacy') process.exit(await runLegacyCommand(argv.slice(1)));

// receipts verify is read-only too: no lock, no server
if (command === 'receipts') process.exit(await runReceiptsCommand(argv.slice(1)));

// shared init and audit verify work on the shared-data files only: no lock, no server
if (SHARED_COMMANDS.includes(command)) process.exit(await runSharedCommand(/** @type {'shared' | 'audit'} */ (command), argv.slice(1)));

// export, backup and restore work on files only: no library config, no lock, no server
if (FILE_COMMANDS.includes(command)) process.exit(await runFileCommand(command, argv.slice(1)));

let config;
try {
  config = await resolveConfig({ argv: argv.slice(command === argv[0] ? 1 : 0), env: process.env, fallback: command === 'serve' ? 'default' : 'none' });
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

/**
 * Shared mode (M07-J03a): check the flags, open the shared data (a damaged file or a missing owner ends the start with exit 2; nothing is ever reset) and build
 * the request gate. Runs before the library lock is taken or anything is created.
 * @param {string} bindHost
 */
async function prepareShared(bindHost) {
  let publicUrl = null;
  const pu = flagValue('--public-url');
  if (pu !== undefined) {
    const r = parsePublicUrl(pu);
    if (!r.ok) fail(r.message, 2);
    else publicUrl = r.url;
  }
  const dir = path.resolve(flagValue('--shared-data') ?? defaultSharedDir(config.libraryRoot));
  const problem = sharedDirProblem(dir, config.libraryRoot);
  if (problem) fail(problem, 2);
  let data;
  let settings;
  try {
    data = await openSharedData(dir);
    settings = await openSettings(dir);
  } catch (e) {
    if (e instanceof SharedDataError) return fail(`the shared data cannot be used: ${e.message} (nothing was changed; fix or move that file)`, 2);
    throw e;
  }
  if (!data.listMembers().some((m) => m.role === 'owner')) return fail(`shared mode has no owner yet: run \`shared init --owner <name>\` first (shared data: ${dir})`, 2);
  const audit = createAudit(dir);
  const chain = await audit.verify();
  if (!chain.ok) process.stderr.write(`storyforge: warning: ${chain.message} (run \`audit verify\`; the log keeps growing, the damaged line stays)\n`);
  const append = (/** @type {Record<string, unknown>} */ e) => audit.append(/** @type {any} */ (e));
  await append({ actor: 'system', event: 'server.start' });
  if (!isLoopbackHost(bindHost) && !(publicUrl ?? '').startsWith('https:')) {
    process.stderr.write('storyforge: warning: this server can be reached from other computers without TLS. Put it behind a TLS reverse proxy and pass its https address as --public-url; passwords and sessions must not cross a network in the clear.\n');
  }
  const gate = createSharedGate({ data, publicUrl, bindHost, aiForMembers: () => settings.get().ai_for_members, audit: append });
  const timer = setInterval(() => void data.prune().catch(() => {}), 10 * 60 * 1000);
  timer.unref();
  process.stdout.write(`Shared mode: accounts and audit log in ${dir}\n`);
  return { gate, data, settings, audit: append, publicUrl, dir }; // `dir`: plugin tokens and webhook subscriptions are kept there too (M08-J02)
}

async function runServer() {
  const hostFlag = flagValue('--host');
  const shared = argv.includes('--shared');
  if (!shared) {
    for (const f of ['--shared-data', '--public-url']) if (flagValue(f) !== undefined) fail(`${f} only works with --shared`, 2);
    if (hostFlag !== undefined && hostFlag !== PERSONAL_HOST) fail(`--host ${hostFlag} is refused: without --shared StoryForge listens on ${PERSONAL_HOST} only (shared mode adds accounts and roles; see --shared)`, 2);
  }
  const bindHost = shared ? (hostFlag ?? PERSONAL_HOST) : PERSONAL_HOST;
  const sharedState = shared ? await prepareShared(bindHost) : null;
  if (config.source === 'default') {
    // first run: no --library, no variable, no library used before. A StoryForge folder in the home folder holds the first books; Open folder... in the Library switches.
    await writeNewTree(config.libraryRoot, () => []).catch((e) => fail(`cannot create the library folder ${config.libraryRoot}: ${e.message} (pass --library <path> or set STORYFORGE_LIBRARY)`, 2));
    process.stdout.write(`No library chosen yet: using ${config.libraryRoot} (pass --library <path> or use Open folder... in the Library to use another).\n`);
  } else if (config.source === 'recent') {
    process.stdout.write(`Using the library you used last: ${config.libraryRoot}\n`);
  }
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
  let profile;
  try {
    profile = profileNameFrom(argv, process.env); // --profile <name>, else STORYFORGE_PROFILE, else default (M07-J04: appearance and personal module choices, per machine)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2);
  }
  const server = createServer({ host, webRoot, recoverReport, instance, shared: sharedState, profile });
  const shownHost = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
  server.on('error', (e) => fail(`cannot listen on ${bindHost}:${config.port}: ${e.message}`, 1));

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

  server.listen(config.port, bindHost, async () => {
    const addr = server.address();
    const port = addr && typeof addr === 'object' ? addr.port : config.port;
    // the lock names the port we really got, and does so before anyone is told we are up
    if (port !== config.port) await updateLock(lockPath, { port }).catch(() => {});
    process.stdout.write(`StoryForge serving ${config.libraryRoot}\nhttp://${shownHost}:${port}/\n`);
    if (argv.includes('--open') && !(await openBrowser(`http://${shownHost}:${port}/`))) process.stderr.write(`storyforge: could not open a browser; open http://${shownHost}:${port}/ yourself\n`);
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
