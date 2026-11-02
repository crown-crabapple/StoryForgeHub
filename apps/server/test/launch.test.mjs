// M06-J03 section 3: packaging. --help lists every command and flag, the library is chosen without --library (the one used last, else a StoryForge folder in the
// home folder), a command that must fail names the flag and the variable, --open starts the system opener on the running app, and the launcher decides
// correctly when to install and build. Every server here runs with its own user config folder (a fresh "home"), never the real one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, copyFixture } from './helpers.mjs';
import { makeHome } from './ai-helpers.mjs';
import { MAIN, killAll, waitFor } from './proc-helpers.mjs';
import { HELP, HELP_COMMANDS } from '../src/help.mjs';
import { openerCommand } from '../src/open-browser.mjs';

after(killAll);

const run = (args, { env = {}, timeout = 30000 } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

/** Start the server with no --library (and the given extra args); resolves { proc, port, output() }. */
async function serve(home, extra = [], env = {}) {
  const child = spawn(process.execPath, [MAIN, '--port', '0', ...extra], { cwd: REPO_ROOT, env: { ...process.env, ...home.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  const m = await Promise.race([
    waitFor(() => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out), { what: 'server readiness line' }),
    exited.then((code) => {
      throw new Error(`server exited early (${code}):\n${out}`);
    }),
  ]);
  const port = Number(m[1]);
  const get = async (p) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Host: `127.0.0.1:${port}` } });
    return { status: r.status, json: await r.json() };
  };
  return {
    port,
    get,
    output: () => out,
    async stop() {
      child.kill();
      await exited;
      child.stdout.destroy();
      child.stderr.destroy();
    },
  };
}

const writeRecent = async (home, paths) => {
  await fs.mkdir(home.configDir, { recursive: true });
  await fs.writeFile(path.join(home.configDir, 'recent.json'), JSON.stringify({ version: 1, paths }));
};

test('--help lists every command and every flag, needs no library and exits 0', async () => {
  const home = await makeHome();
  const r = await run(['--help'], { env: home.env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, HELP);
  for (const c of ['serve', 'rebuild', 'repair', 'continuity', 'export', 'backup', 'restore', 'receipts verify', 'import-legacy']) assert.ok(r.stdout.includes(`  ${c} `), `command ${c}`);
  assert.deepEqual(HELP_COMMANDS, ['serve', 'rebuild', 'repair', 'continuity', 'export', 'backup', 'restore', 'receipts verify', 'import-legacy']);
  for (const f of ['--library', '--port', '--open', '--book', '--json', '--apply', '--format', '--include', '--out', '--force', '--provenance', '--from', '--to', '--help', 'STORYFORGE_LIBRARY', 'STORYFORGE_PORT']) assert.ok(r.stdout.includes(f), `flag ${f}`);
  assert.equal((await run(['-h'], { env: home.env })).stdout, HELP);
  assert.equal((await run(['export', '--help'], { env: home.env })).stdout, HELP);
});

test('a flag the CLI parses is in the help (the three parsers and the help cannot drift apart silently)', async () => {
  const src = (await Promise.all(['main.mjs', 'export-cli.mjs', 'receipts-cli.mjs'].map((f) => fs.readFile(path.join(path.dirname(MAIN), f), 'utf8')))).join('\n');
  const flags = new Set([...src.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(flags.size >= 12, `flags found: ${[...flags]}`);
  for (const f of flags) assert.ok(HELP.includes(f), `${f} is parsed but not in --help`);
});

test('a command that needs a library and has none says which flag and which variable would give one', async () => {
  const home = await makeHome();
  for (const cmd of ['rebuild', 'repair', 'continuity']) {
    const r = await run([cmd], { env: { ...home.env, STORYFORGE_LIBRARY: '' } });
    assert.equal(r.code, 2, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /--library/);
    assert.match(r.stderr, /STORYFORGE_LIBRARY/);
  }
});

test('serve without --library opens the library used last', async () => {
  const home = await makeHome();
  const lib = await copyFixture('valid/salt-orchard');
  await writeRecent(home, [path.resolve(lib)]);
  const s = await serve(home, [], { STORYFORGE_LIBRARY: '' });
  try {
    assert.match(s.output(), /Using the library you used last/);
    assert.equal(path.resolve((await s.get('/api/library')).json.root).toLowerCase(), path.resolve(lib).toLowerCase());
    assert.equal((await s.get('/api/books')).json.length, 1);
  } finally {
    await s.stop();
  }
});

test('serve without --library skips a remembered folder that is gone and takes the next one', async () => {
  const home = await makeHome();
  const lib = await copyFixture('valid/salt-orchard');
  await writeRecent(home, [path.join(home.home, 'deleted-library'), path.resolve(lib)]);
  const s = await serve(home, [], { STORYFORGE_LIBRARY: '' });
  try {
    assert.equal(path.resolve((await s.get('/api/library')).json.root).toLowerCase(), path.resolve(lib).toLowerCase());
  } finally {
    await s.stop();
  }
});

test('first run (no --library, no variable, nothing remembered): a StoryForge folder in the home folder is the library, and the Library is empty', async () => {
  const home = await makeHome();
  const s = await serve(home, [], { STORYFORGE_LIBRARY: '' });
  try {
    const expected = path.join(home.home, 'StoryForge');
    assert.match(s.output(), /No library chosen yet/);
    assert.equal(path.resolve((await s.get('/api/library')).json.root).toLowerCase(), expected.toLowerCase());
    assert.deepEqual((await s.get('/api/books')).json, []);
    assert.ok((await fs.stat(expected)).isDirectory());
    // and it is remembered like any other library
    const recent = (await s.get('/api/library/recent')).json;
    assert.equal(path.resolve(recent[0].path).toLowerCase(), expected.toLowerCase());
  } finally {
    await s.stop();
  }
});

test('--library and STORYFORGE_LIBRARY still win over the library used last', async () => {
  const home = await makeHome();
  const last = await copyFixture('valid/salt-orchard');
  const asked = await copyFixture('valid/salt-orchard');
  await writeRecent(home, [path.resolve(last)]);
  const s = await serve(home, ['--library', asked]);
  try {
    assert.equal(path.resolve((await s.get('/api/library')).json.root).toLowerCase(), path.resolve(asked).toLowerCase());
  } finally {
    await s.stop();
  }
});

test('--open starts the system opener once, on the address the app printed, and prints nothing else about it', async () => {
  const home = await makeHome();
  const lib = await copyFixture('valid/salt-orchard');
  const log = path.join(home.home, 'opened.txt');
  const opener = path.join(home.home, 'opener.mjs');
  await fs.writeFile(opener, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n');\n`);
  const s = await serve(home, ['--library', lib, '--open'], { STORYFORGE_OPENER: JSON.stringify([process.execPath, opener]) });
  try {
    const opened = await waitFor(async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim(), { what: 'the opener to be called' });
    assert.equal(opened, `http://127.0.0.1:${s.port}/`);
    assert.doesNotMatch(s.output(), /could not open a browser/);
  } finally {
    await s.stop();
  }
});

test('--open without an opener that works does not stop the server: it says where to go', async () => {
  const home = await makeHome();
  const lib = await copyFixture('valid/salt-orchard');
  const s = await serve(home, ['--library', lib, '--open'], { STORYFORGE_OPENER: path.join(home.home, 'no-such-program') });
  try {
    await waitFor(() => /could not open a browser; open http:\/\/127\.0\.0\.1:\d+\/ yourself/.test(s.output()), { what: 'the hint' });
    assert.equal((await s.get('/api/health')).status, 200);
  } finally {
    await s.stop();
  }
});

test('the system opener is the right program on each platform and nothing but loopback is ever opened', () => {
  const url = 'http://127.0.0.1:4317/';
  assert.deepEqual(openerCommand(url, { platform: 'win32', env: {} }), { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] });
  assert.deepEqual(openerCommand(url, { platform: 'darwin', env: {} }), { command: 'open', args: [url] });
  assert.deepEqual(openerCommand(url, { platform: 'linux', env: {} }), { command: 'xdg-open', args: [url] });
  assert.deepEqual(openerCommand(url, { platform: 'linux', env: { STORYFORGE_OPENER: 'my-opener' } }), { command: 'my-opener', args: [url] });
  assert.deepEqual(openerCommand(url, { platform: 'linux', env: { STORYFORGE_OPENER: '["node","x.mjs"]' } }), { command: 'node', args: ['x.mjs', url] });
});

// ---- the launchers ----------------------------------------------------------------------------------------------------------------------

const { planSetup, nodeMajor } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'launch.mjs')).href);

test('launcher: install and build on the first run, and again when package-lock.json is newer than the last install; build alone when only the build is missing; nothing when up to date', () => {
  const ok = { lockTime: 100, installedTime: 200, modules: true, dist: true };
  assert.deepEqual(planSetup(ok), { install: false, build: false });
  assert.deepEqual(planSetup({ ...ok, modules: false, installedTime: null }), { install: true, build: true }, 'first run');
  assert.deepEqual(planSetup({ ...ok, installedTime: null }), { install: true, build: true }, 'node_modules without a record of an install: install once');
  assert.deepEqual(planSetup({ ...ok, lockTime: 300 }), { install: true, build: true }, 'package-lock.json changed after the last install');
  assert.deepEqual(planSetup({ ...ok, dist: false }), { install: false, build: true }, 'build missing');
  assert.equal(nodeMajor('22.11.0'), 22);
  assert.equal(nodeMajor('v20.1.0'), 20);
});

test('launcher: both files exist, check for Node, run scripts/launch.mjs with the arguments, and the Windows one pauses on failure', async () => {
  const cmd = await fs.readFile(path.join(REPO_ROOT, 'StoryForge.cmd'), 'utf8');
  const sh = await fs.readFile(path.join(REPO_ROOT, 'storyforge.sh'), 'utf8');
  assert.match(cmd, /where node/);
  assert.match(cmd, /Node\.js 22 or newer/);
  assert.match(cmd, /node scripts\\launch\.mjs %\*/);
  assert.match(cmd, /pause/);
  assert.match(sh, /^#!\/bin\/sh/);
  assert.match(sh, /command -v node/);
  assert.match(sh, /Node\.js 22 or newer/);
  assert.match(sh, /exec node scripts\/launch\.mjs "\$@"/);
  const launch = await fs.readFile(path.join(REPO_ROOT, 'scripts', 'launch.mjs'), 'utf8');
  assert.match(launch, /'--open'/);
  assert.match(launch, /'ci'/);
  assert.equal(fileURLToPath(new URL('../../../scripts/launch.mjs', import.meta.url)), path.join(REPO_ROOT, 'scripts', 'launch.mjs'));
});
