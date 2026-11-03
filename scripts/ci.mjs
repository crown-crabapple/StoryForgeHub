// npm run ci: the whole CI in one command, the same steps GitHub Actions runs (.github/workflows/ci.yml) and a contributor runs locally.
//   node scripts/ci.mjs [--install] [--skip-audit]
//   --install     run `npm ci` first (the workflow does; locally you usually already have node_modules). Without it the lockfile is only checked for sync.
//   --skip-audit  do not call the npm registry (the audit also skips itself, with a notice, when the registry cannot be reached)
// Steps run in order and stop at the first failure; a table of every step, its result and its time is printed at the end.
// The named groups (format fixtures, atomic write, rebuild, import, export, plugin/webhook, shared-mode proof) are run again as their own `node --test`
// runs over file lists, although `npm test` already ran them, so each shows by name in the table.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkLicenses, checkLockfile } from './checks.mjs';
import { REPO_ROOT } from './workspaces.mjs';

const ISOLATE = path.join(REPO_ROOT, 'scripts', 'test-isolate-config.mjs');

/** Test files of each named group, as globs relative to the repository root. */
export const GROUPS = [
  { name: 'format fixtures', files: ['packages/format/test/valid.test.mjs', 'packages/format/test/invalid.test.mjs', 'packages/format/test/determinism.test.mjs'] },
  { name: 'atomic write', files: ['packages/store/test/*.test.mjs', 'packages/core/test/write.test.mjs', 'packages/core/test/create-book-crash.test.mjs'] },
  { name: 'rebuild', files: ['packages/index/test/rebuild.test.mjs', 'packages/index/test/incremental.test.mjs', 'packages/manuscript/test/rebuild.test.mjs', 'packages/legacy-import/test/rehearsal.test.mjs'] },
  { name: 'import', files: ['packages/legacy-import/test/*.test.mjs', 'apps/server/test/import-legacy-cli.test.mjs'] },
  { name: 'export', files: ['packages/export/test/*.test.mjs', 'apps/server/test/export-routes.test.mjs'] },
  {
    name: 'plugin and webhook',
    files: ['packages/integrations/test/*.test.mjs', 'packages/shared/test/plugin-tokens.test.mjs', 'apps/server/test/plugin-*.test.mjs', 'apps/server/test/webhook-delivery.test.mjs'],
  },
  {
    name: 'shared-mode proof',
    files: ['apps/server/test/m07-proof.test.mjs', 'apps/server/test/shared-mode.test.mjs', 'apps/server/test/shared-collab.test.mjs', 'packages/shared/test/audit.test.mjs'],
  },
];

/** @param {string[]} patterns @returns {string[]} */
export function resolveFiles(patterns) {
  return [...new Set(patterns.flatMap((p) => fs.globSync(p, { cwd: REPO_ROOT })))].map((f) => f.split(path.sep).join('/')).sort();
}

/**
 * Run a command with its output shown (or captured); resolves its exit code.
 * @param {string} cmd @param {string[]} args @param {{ capture?: boolean }} [o]
 * @returns {Promise<{ code: number, output: string }>}
 */
function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const isNpm = cmd === 'npm';
    // npm is a .cmd file on Windows, so it needs a shell; the arguments here are fixed words, never user input
    const child = isNpm
      ? spawn(`npm ${args.join(' ')}`, { cwd: REPO_ROOT, env: process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: true, windowsHide: true })
      : spawn(cmd, args, { cwd: REPO_ROOT, env: process.env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (e) => resolve({ code: 1, output: String(e) }));
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

/** @typedef {{ status: 'ok' | 'skip', note?: string }} Outcome */

/** A step that fails throws; the message is its reason. @param {string[]} files @returns {Promise<Outcome>} */
async function nodeTests(files) {
  const resolved = resolveFiles(files);
  if (resolved.length === 0) throw new Error(`no test files match ${files.join(', ')}`);
  const r = await run(process.execPath, ['--import', ISOLATE, '--test', ...resolved]);
  if (r.code !== 0) throw new Error(`node --test exited ${r.code}`);
  return { status: 'ok', note: `${resolved.length} files` };
}

const NETWORK_FAILURE = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT|EHOSTUNREACH|ENOTCACHED|FETCH_ERROR|audit endpoint returned an error|network|offline/i;

/** @param {{ skipAudit: boolean }} o @returns {Promise<Outcome>} */
async function audit({ skipAudit }) {
  if (skipAudit) return { status: 'skip', note: 'skipped with --skip-audit' };
  const r = await run('npm', ['audit', '--omit=dev', '--audit-level=high'], { capture: true });
  process.stdout.write(r.output);
  if (r.code === 0) return { status: 'ok', note: 'no high or critical advisories in production dependencies' };
  if (NETWORK_FAILURE.test(r.output) && !/\d+ (high|critical)/i.test(r.output)) {
    process.stdout.write('npm audit needs the npm registry and it cannot be reached: skipped.\n');
    return { status: 'skip', note: 'offline: the npm registry could not be reached' };
  }
  throw new Error('npm audit found high or critical advisories in production dependencies');
}

/** The secret scan comes from M08-J03; it is run when its script or test exists. @returns {Promise<Outcome>} */
async function secretScan() {
  const scripts = fs
    .globSync('scripts/**/*secret-scan*.mjs', { cwd: REPO_ROOT })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => !/\.test\.mjs$/.test(f));
  const tests = resolveFiles(['scripts/**/*secret-scan*.test.mjs', 'apps/*/test/*secret-scan*.test.mjs', 'packages/*/test/*secret-scan*.test.mjs', 'test/*secret-scan*.test.mjs']);
  if (scripts.length === 0 && tests.length === 0) {
    process.stdout.write('secret scan: not present yet\n');
    return { status: 'skip', note: 'not present yet' };
  }
  for (const s of scripts) {
    const r = await run(process.execPath, [s]);
    if (r.code !== 0) throw new Error(`${s} exited ${r.code}`);
  }
  if (tests.length) {
    const r = await run(process.execPath, ['--import', ISOLATE, '--test', ...tests]);
    if (r.code !== 0) throw new Error(`secret scan tests exited ${r.code}`);
  }
  return { status: 'ok', note: [...scripts, ...tests].join(', ') };
}

/**
 * @param {{ install: boolean, skipAudit: boolean }} flags
 * @returns {{ name: string, run: () => Promise<Outcome> }[]}
 */
export function buildSteps({ install, skipAudit }) {
  /** @type {{ name: string, run: () => Promise<Outcome> }[]} */
  const steps = [];
  /** @param {string} name @param {string[]} args @param {string} [note] */
  const npmStep = (name, args, note) =>
    steps.push({
      name,
      run: async () => {
        const r = await run('npm', args);
        if (r.code !== 0) throw new Error(`npm ${args.join(' ')} exited ${r.code}`);
        return { status: 'ok', note };
      },
    });
  if (install) npmStep('install (npm ci)', ['ci'], 'dependencies installed from the lockfile');
  steps.push({
    name: 'lockfile in sync',
    run: async () => {
      const problems = checkLockfile(REPO_ROOT);
      if (problems.length) throw new Error(`package-lock.json is out of sync:\n  ${problems.join('\n  ')}`);
      return { status: 'ok', note: install ? 'checked after npm ci' : 'checked (use --install to run npm ci)' };
    },
  });
  npmStep('build', ['run', 'build']);
  npmStep('lint', ['run', 'lint'], 'includes the network-boundary rules');
  npmStep('test', ['test']);
  npmStep('test:large', ['run', 'test:large']);
  for (const g of GROUPS) steps.push({ name: `group: ${g.name}`, run: () => nodeTests(g.files) });
  // the smoke test is a test file (apps/server/test/ui-smoke.test.mjs) so it also runs in npm test and cleans up after itself
  steps.push({ name: 'UI smoke', run: () => nodeTests(['apps/server/test/ui-smoke.test.mjs']) });
  steps.push({ name: 'security: npm audit', run: () => audit({ skipAudit }) });
  steps.push({
    name: 'security: licences',
    run: async () => {
      const r = checkLicenses(REPO_ROOT);
      if (r.problems.length) throw new Error(`production dependency licences:\n  ${r.problems.join('\n  ')}`);
      return { status: 'ok', note: `${r.checked} production packages, all on the AGPL-3.0 compatible allow-list` };
    },
  });
  steps.push({ name: 'security: secret scan', run: secretScan });
  steps.push({ name: 'security: network boundary', run: async () => ({ status: 'ok', note: 'enforced by the lint step above (no outbound network code outside the two transport files)' }) });
  steps.push({
    name: 'release build',
    run: async () => {
      const r = await run('npm', ['run', 'release:build']);
      if (r.code !== 0) throw new Error(`npm run release:build exited ${r.code}`);
      return { status: 'ok', note: 'dist/storyforge-<version>.zip and .sha256' };
    },
  });
  return steps;
}

/** @param {{ name: string, result: string, seconds: number, note?: string }[]} rows */
function printTable(rows) {
  const nw = Math.max(4, ...rows.map((r) => r.name.length));
  const line = (a, b, c, d) => `${a.padEnd(nw)}  ${b.padEnd(6)}  ${c.padStart(7)}  ${d}`;
  const out = ['', line('step', 'result', 'seconds', 'note'), line('-'.repeat(nw), '------', '-------', '----')];
  for (const r of rows) out.push(line(r.name, r.result, r.seconds.toFixed(1), r.note ?? ''));
  process.stdout.write(`${out.join('\n')}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const known = new Set(['--install', '--skip-audit']);
  const bad = args.filter((a) => !known.has(a));
  if (bad.length) {
    process.stderr.write(`ci: unknown argument ${bad.join(' ')} (use --install, --skip-audit)\n`);
    process.exit(2);
  }
  const steps = buildSteps({ install: args.includes('--install'), skipAudit: args.includes('--skip-audit') });
  const rows = [];
  let failed = false;
  for (const step of steps) {
    process.stdout.write(`\n=== ${step.name} ===\n`);
    const t0 = Date.now();
    try {
      const o = await step.run();
      rows.push({ name: step.name, result: o.status === 'ok' ? 'ok' : 'skip', seconds: (Date.now() - t0) / 1000, note: o.note });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stdout.write(`${msg}\n`);
      rows.push({ name: step.name, result: 'FAIL', seconds: (Date.now() - t0) / 1000, note: msg.split('\n')[0] });
      failed = true;
      break;
    }
  }
  printTable(rows);
  process.stdout.write(failed ? '\nci: FAILED (stopped at the first failure)\n' : `\nci: passed (${rows.filter((r) => r.result === 'skip').length} skipped, see notes)\n`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
