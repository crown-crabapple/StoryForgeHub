// Helpers for the M08-J01 tests (not a test file): run deploy/entrypoint.mjs the way the container does, on temp folders standing in for /library, /config and
// /shared-data, with the host overridden to 127.0.0.1 (no test binds another address). Everything talks to the server over loopback HTTP.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, copyFixture } from './helpers.mjs';
import { waitFor } from './proc-helpers.mjs';

export const ENTRY = path.join(REPO_ROOT, 'deploy', 'entrypoint.mjs');
export const PRELOAD_URL = new URL(`file:///${path.join(REPO_ROOT, 'apps', 'server', 'test', 'ai-net-preload.mjs').replace(/\\/g, '/')}`).href;
export const tokenOf = (text) => /#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1];

/** A copy of salt-orchard as the library, plus empty folders for the shared data and the user config. */
export async function makeDirs() {
  const library = await copyFixture('valid/salt-orchard');
  const shared = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-shared-'));
  const config = await fs.mkdtemp(path.join(os.tmpdir(), 'sf-deploy-config-'));
  return { library, shared, config };
}

/** The environment the container sets (image ENV plus compose env_file), with temp folders and host 127.0.0.1. `extra` wins. */
export function containerEnv(dirs, extra = {}) {
  return {
    ...process.env,
    STORYFORGE_MODE: 'shared',
    STORYFORGE_HOST: '127.0.0.1',
    STORYFORGE_PORT: '0',
    STORYFORGE_LIBRARY: dirs.library,
    STORYFORGE_SHARED_DATA: dirs.shared,
    XDG_CONFIG_HOME: dirs.config,
    APPDATA: dirs.config,
    ...extra,
  };
}

const live = new Set();

/** Stop the whole process tree (the entrypoint starts the server as a child; a plain kill on Windows would leave it running). */
function stopTree(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { stdio: 'ignore' });
  else entry.child.kill('SIGTERM');
}

/** Stop every entrypoint a test started (call from `after`). */
export async function stopEntries() {
  await Promise.all([...live].map((e) => e.stop()));
}

/** Spawn a process (the entrypoint by default) and track its output. */
export function spawnTracked(env, args = [ENTRY], nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, ...args], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const entry = {
    child,
    exited,
    stdout: () => out,
    stderr: () => err,
    output: () => out + err,
    async stop() {
      stopTree(entry);
      const r = await exited;
      child.stdout.destroy();
      child.stderr.destroy();
      live.delete(entry);
      return r;
    },
  };
  live.add(entry);
  return entry;
}

/** Start the entrypoint and resolve once the server printed its address (`entry.port`). */
export async function startEntry(env) {
  const entry = spawnTracked(env);
  const early = entry.exited.then((r) => {
    throw new Error(`the entrypoint exited before the server was ready (${JSON.stringify(r)}):\n${entry.output()}`);
  });
  const m = await Promise.race([waitFor(() => /StoryForge serving [^\n]*\nhttp:\/\/127\.0\.0\.1:(\d+)\//.exec(entry.stdout()), { what: 'the "StoryForge serving" line (the setup link also names 127.0.0.1)' }), early]);
  entry.port = Number(m[1]);
  return entry;
}

/** Run the entrypoint to its end (for the refusals); 30 s cap. */
export async function runEntry(env) {
  const entry = spawnTracked(env);
  const timer = setTimeout(() => stopTree(entry), 30000);
  const r = await entry.exited;
  clearTimeout(timer);
  const out = { code: r.code, stdout: entry.stdout(), stderr: entry.stderr(), output: entry.output() };
  await entry.stop();
  return out;
}
