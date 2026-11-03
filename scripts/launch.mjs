// What StoryForge.cmd and storyforge.sh run (M06-J03): check Node, install and build on the first run (or when package-lock.json changed), then start the
// server with --open. Everything after the launcher's own name goes to the server (for example --library D:\Books or --port 5000).
// Written to start on any Node that can read an ES module, so the version check can speak before anything newer is used.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIN_NODE = 22;
const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => fileURLToPath(new URL(p, import.meta.url));
// npm rewrites node_modules/.package-lock.json at the end of every install, so it says when the last install finished
const INSTALLED = at('../node_modules/.package-lock.json');
const LOCK = at('../package-lock.json');
const DIST = at('../apps/web/dist/index.html');
// the web app's source entry; a release zip ships the built app (apps/web/dist) without it, so a release never builds and installs only what runs
const WEB_SOURCE = at('../apps/web/index.html');

/**
 * What the launcher has to do before it can start the server. Pure, so a test can check the decision.
 * `lockTime`: when package-lock.json last changed; `installedTime`: when the last install finished (null when there was none). Times in ms.
 * `source`: the web app's source is here (a checkout); false in a release, which ships the built app and cannot rebuild it.
 * @param {{ lockTime: number, installedTime: number | null, modules: boolean, dist: boolean, source?: boolean }} s
 * @returns {{ install: boolean, build: boolean, release: boolean }}
 */
export function planSetup({ lockTime, installedTime, modules, dist, source = true }) {
  const install = !modules || installedTime === null || lockTime > installedTime;
  if (!source) return { install, build: false, release: true };
  return { install, build: install || !dist, release: false };
}

/** The plan for the copy of StoryForge this file is in (a test imports an unzipped release's copy to check what its launcher will do). */
export function currentPlan() {
  return planSetup({
    lockTime: statSync(LOCK).mtimeMs,
    installedTime: existsSync(INSTALLED) ? statSync(INSTALLED).mtimeMs : null,
    modules: existsSync(fileURLToPath(new URL('../node_modules', import.meta.url))),
    dist: existsSync(DIST),
    source: existsSync(WEB_SOURCE),
  });
}

/** Major version of a Node version string like "22.11.0". @param {string} v */
export const nodeMajor = (v) => Number(String(v).replace(/^v/, '').split('.')[0]);

function run(command, args) {
  const r = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  return r.status ?? 1;
}

function main() {
  if (nodeMajor(process.versions.node) < MIN_NODE) {
    console.error(`StoryForge needs Node.js ${MIN_NODE} or newer; this is ${process.versions.node}. Install a current version from https://nodejs.org and run this again.`);
    return 1;
  }
  const plan = currentPlan();
  if (plan.release && !existsSync(DIST)) {
    console.error('StoryForge: this copy has no built app (apps/web/dist is missing). Unpack the release zip again, or use a source checkout and run npm run build.');
    return 1;
  }
  if (plan.install) {
    console.log('StoryForge: installing what it needs (first run, or the dependency list changed). This needs the internet once and can take a few minutes.');
    if (run('npm', plan.release ? ['ci', '--omit=dev'] : ['ci']) !== 0) {
      console.error('StoryForge: "npm ci" failed. Check the messages above (is the internet reachable?) and run this again.');
      return 1;
    }
  }
  if (plan.build) {
    console.log('StoryForge: building the app...');
    if (run('npm', ['run', 'build']) !== 0) {
      console.error('StoryForge: the build failed. Check the messages above and run this again.');
      return 1;
    }
  }
  const server = spawnSync(process.execPath, [at('../apps/server/src/main.mjs'), '--open', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
  return server.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
