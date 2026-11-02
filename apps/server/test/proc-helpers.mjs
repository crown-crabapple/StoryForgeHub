// Helpers for tests that run apps/server/src/main.mjs as a real child process.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from './helpers.mjs';

export const MAIN = path.join(REPO_ROOT, 'apps', 'server', 'src', 'main.mjs');
export const LOCK_NAME = '.storyforge-lock';
export const GOOD = { 'content-type': 'application/json', 'x-storyforge': '1' };

/** Poll `fn` until truthy (bounded). */
export async function waitFor(fn, { timeout = 20000, interval = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

const live = new Set();

/** Kill every child still running (call from `after`). */
export async function killAll() {
  await Promise.all([...live].map((p) => p.stop()));
}

function track(child) {
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const proc = {
    child,
    pid: child.pid,
    exited,
    stdout: () => out,
    stderr: () => err,
    output: () => out + err,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      const r = await exited;
      child.stdout.destroy();
      child.stderr.destroy();
      live.delete(proc);
      return r;
    },
  };
  live.add(proc);
  return proc;
}

/** Spawn main.mjs with `args`; does not wait for anything. */
export function spawnMain(args) {
  const child = spawn(process.execPath, [MAIN, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return track(child);
}

/** Start a server on `libraryRoot` (port 0) and resolve once it printed its URL. */
export async function startServer(libraryRoot, extra = []) {
  const proc = spawnMain(['--library', libraryRoot, '--port', '0', ...extra]);
  const ready = waitFor(() => /http:\/\/127\.0\.0\.1:(\d+)\//.exec(proc.stdout()), { timeout: 20000, what: 'server readiness line' });
  const early = proc.exited.then((r) => {
    throw new Error(`server exited before it was ready (${JSON.stringify(r)}):\n${proc.output()}`);
  });
  const m = await Promise.race([ready, early]);
  proc.port = Number(m[1]);
  return proc;
}

/** Run a one-shot CLI command to completion (30 s cap). */
export async function runCli(args) {
  const proc = spawnMain(args);
  const timer = setTimeout(() => proc.child.kill(), 30000);
  const r = await proc.exited;
  clearTimeout(timer);
  const out = { code: r.code, signal: r.signal, stdout: proc.stdout(), stderr: proc.stderr(), output: proc.output() };
  await proc.stop();
  return out;
}

/** A pid that is certainly not alive: a child that has already exited. */
export async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => child.once('exit', r));
  return child.pid;
}

/** Flatten getBook JSON to scenes in reading order. */
export const flatScenes = (book) => book.acts.flatMap((a) => a.chapters.flatMap((c) => c.scenes));
