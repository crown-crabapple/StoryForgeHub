// CLI entry:
//   node apps/server/src/main.mjs --library <path> [--port <n>]        serve the library
//   node apps/server/src/main.mjs rebuild --library <path>             rebuild every book's index
//   node apps/server/src/main.mjs repair --library <path> [--apply]    print the repair plan; write only with --apply
// Exit codes: 0 ok, 1 failed / needs hand repair, 2 usage or cannot open the library, 3 another instance holds the library.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, LOCK_FILE, acquireLock, createFsRepository, loadConfig, releaseLock, releaseLockSync, updateLock } from '@storyforge/core';
import { createServer } from './server.mjs';

const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
const argv = process.argv.slice(2);
const COMMANDS = ['serve', 'rebuild', 'repair'];
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve';
const apply = argv.includes('--apply');

/** @param {string} message @param {number} code */
function fail(message, code) {
  process.stderr.write(`storyforge: ${message}\n`);
  process.exit(code);
}

if (!COMMANDS.includes(command)) fail(`unknown command: ${command} (use serve, rebuild or repair)`, 2);

let config;
try {
  config = loadConfig({ argv: argv.slice(command === argv[0] ? 1 : 0), env: process.env });
} catch (e) {
  if (e instanceof ConfigError) fail(e.message, e.exitCode);
  throw e;
}

const lockPath = path.join(config.libraryRoot, LOCK_FILE);
let holdsLock = false;
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
    if (holdsLock) releaseLockSync(lockPath);
  });
  return r.lock;
}

/** Idempotent; every caller waits for the same release. */
function releaseOwnLock() {
  if (!holdsLock) return Promise.resolve();
  releasing ??= releaseLock(lockPath).catch(() => {});
  return releasing;
}

/** One-shot commands: watching is off, and the process ends when the work is done. */
async function runCli() {
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

  const instance = { pid: process.pid, started_at: new Date().toISOString(), lock };
  const server = createServer({ repository, webRoot, recoverReport, instance });
  server.on('error', (e) => fail(`cannot listen on ${config.host}:${config.port}: ${e.message}`, 1));

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await repository.close().catch(() => {});
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
    repository.ensureIndexes().then(
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
