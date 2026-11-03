// Helpers for the M07-J04 acceptance tests (not a test file). Everything talks to a real server process (main.mjs) over HTTP; profiles are chosen with
// `--profile` or STORYFORGE_PROFILE exactly as a person would.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOK, GOOD, makeHome, send } from './ai-helpers.mjs';
import { REPO_ROOT, copyFixture } from './helpers.mjs';
import { MAIN, waitFor } from './proc-helpers.mjs';

export { BOOK, GOOD, makeHome };
export const SCENE = 'scene_01S50000000000000000000002';
export const KEY_SCENE = 'scene_01S50000000000000000000003';
export const MAREN = 'maren-hollis';
export const ID_A = 'note_01S5000000000000000000000A';
export const ID_B = 'note_01S5000000000000000000000B';
export const ID_C = 'note_01S5000000000000000000000C';

const live = new Set();
export async function stopAll() {
  await Promise.all([...live].map((p) => p.stop()));
}

const fileUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/').replace(/^\/+/, '')}`).href;

/**
 * Start main.mjs on `library`. `args` are extra command-line arguments (for example ['--profile', 'a']); `env` extra environment (STORYFORGE_PROFILE).
 * `net: true` preloads the network recorder (see ai-net-preload.mjs); `app.netCalls()` lists what the server called out to.
 */
export async function start({ library, home, args = [], env = {}, net = false }) {
  const netLog = path.join(home.home, `net-${process.hrtime.bigint()}.jsonl`);
  const argv = [];
  if (net) argv.push('--import', fileUrl(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ai-net-preload.mjs')));
  argv.push(MAIN, '--library', library, '--port', '0', ...args);
  const child = spawn(process.execPath, argv, { cwd: REPO_ROOT, env: { ...process.env, ...home.env, SF_NET_LOG: netLog, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const app = {
    child,
    output: () => out,
    exited,
    async netCalls() {
      try {
        return (await fs.readFile(netLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      child.stdout.destroy();
      child.stderr.destroy();
      live.delete(app);
    },
  };
  live.add(app);
  const m = await Promise.race([
    waitFor(() => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out), { what: 'server readiness line' }),
    exited.then((r) => {
      throw new Error(`server exited early (${JSON.stringify(r)}):\n${out}`);
    }),
  ]);
  app.port = Number(m[1]);
  app.get = (p) => send(app.port, 'GET', p);
  app.post = (p, body) => send(app.port, 'POST', p, body);
  app.put = (p, body) => send(app.port, 'PUT', p, body);
  app.del = (p) => send(app.port, 'DELETE', p);
  return app;
}

/** Run main.mjs to the end (no server): for the exit code of a bad flag. */
export function runMain(args, { home, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...home.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** A copy of the salt-orchard fixture as a single-book root. */
export const freshBook = () => copyFixture('valid/salt-orchard');

/**
 * A library root holding library.md (with `preferences` YAML lines, already indented under `preferences:`) and the salt-orchard book in a folder.
 * @param {string} [libraryPreferences] e.g. "  modules:\n    ai: false\n"
 * @returns {Promise<string>} the library root
 */
export async function projectLibrary(libraryPreferences = '') {
  const book = await copyFixture('valid/salt-orchard');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-j04-lib-'));
  await fs.cp(book, path.join(root, 'salt-orchard'), { recursive: true });
  const prefs = libraryPreferences ? `preferences:\n${libraryPreferences}` : '';
  await fs.writeFile(path.join(root, 'library.md'), `---\nschema: storyforge.library/v1\nid: lib_01S5000000000000000000000A\ntitle: Test library\n${prefs}---\n`);
  return root;
}

/** Put a `preferences:` block into a book's book.md (before the closing ---). @param {string} bookDir @param {string} yamlLines */
export async function setBookPreferences(bookDir, yamlLines) {
  const file = path.join(bookDir, 'book.md');
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n');
  const close = lines.indexOf('---', 1);
  lines.splice(close, 0, `preferences:\n${yamlLines}`.replace(/\n$/, ''));
  await fs.writeFile(file, lines.join('\n'));
}

/** Write a prompt file under <library>/_prompts/. @param {string} libraryRoot @param {string} rel e.g. 'tighten.md' or 'workflows/polish.md' @param {string} text */
export async function writePrompt(libraryRoot, rel, text) {
  const file = path.join(libraryRoot, '_prompts', ...rel.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

/** The text of a prompt component file. */
export function promptFile({ id = ID_A, slug = 'tighten-dialogue', name = 'Tighten dialogue', inputs = '[selection, scene, pov-entry]', task = 'rewrite', body = "Rewrite the selected dialogue so each line does one job. Keep {{pov-entry.name}}'s voice.\n", schema = 'storyforge.prompt/v1' } = {}) {
  return `---\nschema: ${schema}\nid: ${id}\nslug: ${slug}\nname: ${name}\ninputs: ${inputs}\ntask: ${task}\n---\n${body}`;
}

export function workflowFile({ id = ID_C, slug = 'polish', name = 'Polish', steps = '[tighten-dialogue, summarise]' } = {}) {
  return `---\nschema: storyforge.prompt-workflow/v1\nid: ${id}\nslug: ${slug}\nname: ${name}\nsteps: ${steps}\n---\n`;
}

/** Every file under `dir` (relative, forward slashes), skipping `.storyforge/`. */
export async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name === '.storyforge') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  }
  await walk(dir);
  return out.sort();
}

/** The bytes of the scene file `rel` under `root`. */
export const readFile = (root, rel) => fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
