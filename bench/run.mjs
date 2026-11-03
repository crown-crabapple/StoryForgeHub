// `npm run bench` (M08-J04 contract section 4): generate the S, M, L and XL synthetic fixtures into a temp folder, measure what a writer waits for, and write
// bench/results/<date>-<machine-hash>.json plus a table in docs/performance.md. Median of 5 runs each, by default.
//
//   npm run bench                         all four fixtures, 5 runs each, results file + docs/performance.md
//   npm run bench -- --fixtures S,M       only these
//   npm run bench -- --reps 3             fewer runs (a quick look; the committed numbers use 5)
//   npm run bench -- --budget-min 15      stop starting new runs of a fixture after this many minutes (default 15); what finished is recorded
//   npm run bench -- --no-doc             do not append to docs/performance.md
//   npm run bench -- --out <dir>          write the JSON there instead of bench/results
//
// Nothing here reads or writes a user's library: every fixture is generated under the OS temp folder and deleted afterwards.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFsRepository } from '../packages/core/src/index.mjs';
import { createBackup, exportBook, restoreBackup } from '../packages/export/src/index.mjs';
import { validate } from '../packages/format/src/index.mjs';
import { openIndex } from '../packages/index/src/index.mjs';
import { openStore } from '../packages/store/src/index.mjs';
import { FIXTURE_NAMES, MAKERS, measureSize } from './fixtures.mjs';
import { appendRun } from './report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');


function parseArgs(argv) {
  const a = { fixtures: [...FIXTURE_NAMES], reps: 5, budgetMin: 15, doc: true, out: path.join(here, 'results'), keep: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--fixtures') a.fixtures = argv[++i].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (k === '--reps') a.reps = Math.max(1, Number.parseInt(argv[++i], 10) || 5);
    else if (k === '--budget-min') a.budgetMin = Number(argv[++i]) || 15;
    else if (k === '--no-doc') a.doc = false;
    else if (k === '--out') a.out = path.resolve(argv[++i]);
    else if (k === '--keep') a.keep = true;
    else throw new Error(`unknown option ${k}`);
  }
  for (const f of a.fixtures) if (!FIXTURE_NAMES.includes(f)) throw new Error(`unknown fixture ${f} (use ${FIXTURE_NAMES.join(', ')})`);
  return a;
}

/** The machine the numbers came from: node, OS, CPU model and RAM. The hash (of CPU, OS, RAM and core count; never the host name) names the results file. */
export function machineInfo() {
  const cpus = os.cpus();
  const info = { node: process.version, os: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`, cpu: cpus[0]?.model?.trim() ?? 'unknown', cores: cpus.length, ram_mb: Math.round(os.totalmem() / 1024 / 1024) };
  const hash = createHash('sha256').update(`${info.cpu}|${info.os}|${info.cores}|${info.ram_mb}`).digest('hex').slice(0, 8);
  return { ...info, hash };
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (n) => Math.round(n * 10) / 10;

/**
 * Time `fn` `reps` times. Stops starting runs after `deadline`; an error stops the operation and is recorded. `setup(rep)` runs before each timed run, untimed.
 * @returns {Promise<{ status: 'ok' | 'partial' | 'error' | 'not_run', runs_ms: number[], median_ms: number | null, note?: string }>}
 */
async function operation(fn, { reps, deadline, setup = null, after = null }) {
  const runs = [];
  for (let i = 0; i < reps; i++) {
    if (Date.now() > deadline) return { status: runs.length ? 'partial' : 'not_run', runs_ms: runs, median_ms: runs.length ? median(runs) : null, note: 'time budget used up' };
    try {
      const ctx = setup ? await setup(i) : undefined;
      const t = performance.now();
      await fn(i, ctx);
      runs.push(round(performance.now() - t));
    } catch (e) {
      return { status: 'error', runs_ms: runs, median_ms: runs.length ? median(runs) : null, note: String(e?.message ?? e).slice(0, 300) };
    } finally {
      await after?.(); // a repository opened for this run is closed before the next one starts: its file watchers must not load the machine while the next run is timed
    }
  }
  return { status: 'ok', runs_ms: runs, median_ms: median(runs) };
}

/** One fixture, every operation. */
async function benchFixture(fx, { reps, budgetMin, log }) {
  const deadline = Date.now() + budgetMin * 60_000;
  const ops = {};
  const run = async (key, fn, opts = {}) => {
    const t = Date.now();
    ops[key] = await operation(fn, { reps, deadline, ...opts });
    log(`  ${key.padEnd(20)} ${ops[key].status === 'ok' || ops[key].status === 'partial' ? `${ops[key].median_ms} ms` : ops[key].status}${ops[key].note ? ` (${ops[key].note})` : ''}  [${Math.round((Date.now() - t) / 1000)} s]`);
  };
  const repoOpts = {}; // the real watcher is on, as in the app: it is what keeps the read cache live (validate-cache.mjs)
  const newRepo = () => {
    const r = createFsRepository(fx.root, repoOpts);
    opened.push(r);
    return r;
  };
  const bookId = fx.bookId;
  // warm = the repository has answered before and its file watcher is live, so the read cache holds (validate-cache.mjs keeps a result only while the watcher delivers events)
  const warmed = (ask) => async () => {
    const r = newRepo();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await ask(r);
    await ask(r);
    return r;
  };

  await run('validate_library', async () => {
    const v = await validate(fx.root);
    if (v.diagnostics.some((d) => d.severity === 'error')) throw new Error(`the fixture has errors: ${v.diagnostics.find((d) => d.severity === 'error').code}`);
  });

  // ---- reading through the repository (a new repository is "cold": its validate cache is empty; the OS file cache is not dropped)
  await run('library_open_cold', async (_i, repo) => void (await repo.listBooks()), { setup: async () => newRepo(), after: closeAll });
  await closeAll();
  await run('library_open_warm', async (_i, repo) => void (await repo.listBooks()), { setup: warmed((r) => r.listBooks()), after: closeAll });
  await closeAll();
  await run('book_open_cold', async (_i, repo) => void (await repo.getBook(bookId)), { setup: async () => newRepo(), after: closeAll });
  await closeAll();
  await run('book_open_warm', async (_i, repo) => void (await repo.getBook(bookId)), { setup: warmed((r) => r.getBook(bookId)), after: closeAll });
  await closeAll();

  const warm = newRepo();
  try {
    await new Promise((resolve) => setTimeout(resolve, 400)); // let the watcher go live
    await warm.getBook(bookId);
    await warm.getBook(bookId);
    const pickScene = (i) => fx.sceneIds[Math.floor(fx.sceneIds.length / 2) + i] ?? fx.sceneIds[i % fx.sceneIds.length];
    await warm.getScene(bookId, pickScene(0)); // the first read of any scene fills the caches
    await run('scene_open_warm', async (i) => void (await warm.getScene(bookId, pickScene(i + 1))));
    await warm.rebuildIndex(bookId); // the search runs on a fresh index
    await run('search_book', async () => {
      const hits = await warm.search(fx.searchTerm, { bookId });
      if (!Array.isArray(hits) || hits.length === 0) throw new Error(`the search for "${fx.searchTerm}" found nothing`);
    });
  } catch (e) {
    for (const k of ['scene_open_warm', 'search_book']) ops[k] ??= { status: 'error', runs_ms: [], median_ms: null, note: String(e?.message ?? e).slice(0, 300) };
  } finally {
    await closeAll();
  }

  // ---- the index, directly: full rebuild, and the incremental reconcile after outside edits
  try {
    const store = await openStore(fx.bookRoot, { recover: false });
    const idx = openIndex(fx.bookRoot, { store, libraryRoot: fx.root });
    await run('index_rebuild', async () => {
      const r = await idx.rebuild();
      if (!r?.ok) throw new Error('the rebuild failed');
    });
    const edit = (count, rep) => {
      const n = Math.min(count, fx.scenePaths.length);
      for (let k = 0; k < n; k++) {
        const file = path.join(fx.bookRoot, ...fx.scenePaths[(k * 7 + rep) % fx.scenePaths.length].split('/'));
        fs.appendFileSync(file, `\nAn outside edit, number ${rep}.\n`);
      }
      return n;
    };
    await run('reconcile_1_edit', async () => void (await idx.reconcile()), { setup: async (i) => edit(1, i + 1) });
    await run('reconcile_50_edits', async () => void (await idx.reconcile()), { setup: async (i) => edit(50, i + 100) });
    ops.reconcile_50_edits.note ??= fx.scenePaths.length < 50 ? `the fixture has only ${fx.scenePaths.length} scenes, so that many files were edited` : undefined;
    if (ops.reconcile_50_edits.note === undefined) delete ops.reconcile_50_edits.note;
  } catch (e) {
    for (const k of ['index_rebuild', 'reconcile_1_edit', 'reconcile_50_edits']) ops[k] ??= { status: 'error', runs_ms: [], median_ms: null, note: String(e?.message ?? e).slice(0, 300) };
  }

  // ---- exports, backup and restore of the first book
  const sizes = {};
  for (const fmt of ['markdown', 'docx', 'epub', 'pdf']) {
    await run(`export_${fmt}`, async () => {
      const out = await exportBook(fx.bookRoot, fmt);
      sizes[fmt] = out.bytes.length;
    });
    if (sizes[fmt]) ops[`export_${fmt}`].bytes = sizes[fmt];
  }
  let backup = null;
  await run('backup', async () => {
    backup = await createBackup(fx.bookRoot);
  });
  if (backup) ops.backup.bytes = backup.bytes.length;
  const targets = [];
  if (backup) {
    await run('restore', async (i) => {
      const target = path.join(os.tmpdir(), `sf-bench-restore-${process.pid}-${i}-${Date.now()}`);
      targets.push(target);
      await restoreBackup(backup.bytes, target);
    });
    for (const t of targets) fs.rmSync(t, { recursive: true, force: true });
  } else {
    ops.restore = { status: 'not_run', runs_ms: [], median_ms: null, note: 'no backup to restore' };
  }
  return ops;
}

/** Repositories opened by a run, closed between operations. @type {any[]} */
const opened = [];
async function closeAll() {
  for (const r of opened.splice(0)) await r.close?.().catch(() => {});
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv);
  const machine = machineInfo();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; // the local date
  const started = Date.now();
  const result = { schema: 'storyforge.bench/v1', date, git: gitCommit(), machine, reps: args.reps, budget_min: args.budgetMin, fixtures: {} };
  log(`StoryForge benchmark: node ${machine.node}, ${machine.os}, ${machine.cpu} x${machine.cores}, ${machine.ram_mb} MB RAM, machine ${machine.hash}`);
  for (const name of args.fixtures) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sf-bench-${name.toLowerCase()}-`));
    try {
      const g0 = Date.now();
      log(`${name}: generating...`);
      const fx = MAKERS[name](dir);
      const generate_ms = Date.now() - g0;
      const size = measureSize(fx.root, fx.bookRoots);
      log(`${name}: ${fx.description} (${size.scenes} scenes in ${size.books} book(s), ${size.words} words, ${size.files} files, generated in ${generate_ms} ms)`);
      const f0 = Date.now();
      const ops = await benchFixture(fx, { reps: args.reps, budgetMin: args.budgetMin, log });
      result.fixtures[name] = { description: fx.description, size, generate_ms, total_ms: Date.now() - f0, operations: ops };
    } finally {
      await closeAll();
      if (!args.keep) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  result.total_ms = Date.now() - started;
  fs.mkdirSync(args.out, { recursive: true });
  const file = path.join(args.out, `${date}-${machine.hash}.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  log(`wrote ${path.relative(repoRoot, file)}`);
  if (args.doc) {
    appendRun(path.join(repoRoot, 'docs', 'performance.md'), result, path.relative(repoRoot, file).split(path.sep).join('/'));
    log('appended the table to docs/performance.md');
  }
  return { result, file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
