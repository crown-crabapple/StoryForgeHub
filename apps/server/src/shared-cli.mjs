// CLI for shared mode (M07-J03a):
//   shared init --owner <username> [--library <path>] [--shared-data <dir>] [--public-url <url>] [--port <n>]   create the owner and print the one-time setup link
//   shared reset-owner --owner <username> [--library <path>] [--shared-data <dir>] [--public-url <url>] [--port <n>]   lost owner password: clear it and every session of that owner, print a new setup link
//   audit verify [--shared-data <dir> | --library <path>]   check the audit chain (exit 0 intact, 1 broken or truncated, 2 usage)
// and the helpers `serve --shared` uses (default shared-data folder, the folder-inside-the-library check, --host and --public-url checks).
// No filesystem access here: the shared-data files go through @storyforge/shared and @storyforge/store.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ConfigError, LOCK_FILE, acquireLock, releaseLock, resolveConfig } from '@storyforge/core';
import { userConfigDir } from '@storyforge/store';
import { SharedDataError, createAudit, openSharedData } from '@storyforge/shared';

export const SHARED_COMMANDS = ['shared', 'audit'];

/** The only address a personal-mode server may bind to. */
export const PERSONAL_HOST = '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
/** @param {string} host */
export const isLoopbackHost = (host) => LOOPBACK.has(host.toLowerCase());

/** `<user config>/shared/<first 16 hex of sha256(resolved library path)>`: never inside the library, so a book backup never holds accounts. @param {string} libraryRoot */
export function defaultSharedDir(libraryRoot) {
  const hash = createHash('sha256').update(path.resolve(libraryRoot), 'utf8').digest('hex').slice(0, 16);
  return path.join(userConfigDir(), 'shared', hash);
}

/** @param {string} dir @param {string} libraryRoot @returns {string | null} what is wrong with the shared-data folder, if anything */
export function sharedDirProblem(dir, libraryRoot) {
  const rel = path.relative(path.resolve(libraryRoot), path.resolve(dir));
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  return inside ? `the shared data (${path.resolve(dir)}) must not be inside the library (${path.resolve(libraryRoot)}): a book backup would then contain the accounts` : null;
}

/** @param {string} text @returns {{ ok: true, url: string } | { ok: false, message: string }} a public URL reduced to its origin */
export function parsePublicUrl(text) {
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, message: `--public-url is not a URL: ${text}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: '--public-url must start with https:// (or http:// for a trial on a trusted network)' };
  return { ok: true, url: u.origin };
}

/**
 * Value of `--name <value>` / `--name=<value>` in `argv`; flags it does not know are reported by the caller.
 * @param {string[]} argv @param {string[]} known value flags @returns {{ values: Record<string, string> } | { error: string }}
 */
function parseFlags(argv, known) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!known.includes(name)) return { error: `unknown argument: ${a}` };
    if (eq > 0) values[name] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) values[name] = argv[++i];
    else return { error: `${name} needs a value` };
  }
  return { values };
}

/**
 * @param {string} dir the shared-data folder
 * @returns {Promise<number>} exit code
 */
async function verifyAudit(dir) {
  const r = await createAudit(dir).verify();
  if (r.ok) {
    process.stdout.write(r.lines === 0 ? `audit: no events recorded yet (${dir})\n` : `audit: ${r.lines} line${r.lines === 1 ? '' : 's'}, the chain is intact\n`);
    return 0;
  }
  process.stderr.write(`${r.message}\n`);
  return 1;
}

/**
 * @param {'shared' | 'audit'} command
 * @param {string[]} argv arguments after the command
 * @returns {Promise<number>} the exit code
 */
export async function runSharedCommand(command, argv) {
  const complain = (/** @type {string} */ s) => process.stderr.write(`storyforge: ${s}\n`);
  const [sub, ...rest] = argv;
  if (!(command === 'shared' ? ['init', 'reset-owner'] : ['verify']).includes(/** @type {string} */ (sub))) {
    complain(command === 'shared' ? 'usage: shared init|reset-owner --owner <username> [--library <path>] [--shared-data <dir>] [--public-url <url>]' : 'usage: audit verify [--shared-data <dir> | --library <path>]');
    return 2;
  }
  const parsed = parseFlags(rest, ['--owner', '--library', '--shared-data', '--public-url', '--port']);
  if ('error' in parsed) {
    complain(parsed.error);
    return 2;
  }
  const v = parsed.values;
  if (command === 'shared' && !v['--owner']) {
    complain(`shared ${sub} needs --owner <username>`);
    return 2;
  }
  let dir = v['--shared-data'] ? path.resolve(v['--shared-data']) : null;
  let port = 4317;
  /** @type {string | null} */
  let libraryRoot = null;
  if (!dir || command === 'shared') {
    // the library names the default shared-data folder (and the port in the setup link)
    let config;
    try {
      config = await resolveConfig({ argv: [...(v['--library'] ? ['--library', v['--library']] : []), ...(v['--port'] ? ['--port', v['--port']] : [])], env: process.env, fallback: 'none' });
    } catch (e) {
      if (e instanceof ConfigError) {
        if (!dir) {
          complain(e.message);
          return e.exitCode;
        }
      } else throw e;
    }
    if (config) {
      port = config.port;
      libraryRoot = config.libraryRoot;
      dir ??= defaultSharedDir(config.libraryRoot);
      const problem = sharedDirProblem(dir, config.libraryRoot);
      if (problem) {
        complain(problem);
        return 2;
      }
    }
  }
  if (!dir) {
    complain('no shared-data folder: pass --shared-data <dir> or --library <path>');
    return 2;
  }

  if (command === 'audit') return verifyAudit(dir);

  let base = `http://127.0.0.1:${port}`;
  if (v['--public-url']) {
    const pub = parsePublicUrl(v['--public-url']);
    if (!pub.ok) {
      complain(pub.message);
      return 2;
    }
    base = pub.url;
  }
  if (sub === 'reset-owner' && !libraryRoot) {
    // without the library there is no lock to hold, and a running server would overwrite what this command writes
    complain('shared reset-owner needs the library it serves (--library <path> or STORYFORGE_LIBRARY) so that it can make sure the server is stopped');
    return 2;
  }
  // a running server keeps the shared data in memory and would overwrite what this command writes: hold the library lock while we change it
  const lockPath = libraryRoot ? path.join(libraryRoot, LOCK_FILE) : null;
  if (lockPath) {
    const lock = await acquireLock(lockPath, { port: null });
    if (!lock.ok) {
      complain(`StoryForge is running on this library; stop it first, then run shared ${sub} again. Lock file: ${lockPath}`);
      return 3;
    }
  }
  try {
    const data = await openSharedData(dir);
    if (sub === 'reset-owner') {
      const owner = /** @type {string} */ (v['--owner']);
      const reset = await data.resetOwner(owner);
      if (!reset.ok) {
        complain(`${reset.message} (${owner}); nothing was changed`);
        return 1;
      }
      await createAudit(dir).append({ actor: 'system', event: 'owner.reset', target: owner });
      process.stdout.write(`Owner "${owner}" has no password now and is signed out everywhere.
Open this link within 30 minutes to choose a new password (it works once):
${base}/setup#token=${reset.token}
`);
      return 0;
    }
    const r = await data.initOwner(/** @type {string} */ (v['--owner']));
    if (!r.ok) {
      complain(r.message);
      return r.code === 'BAD_ARGS' ? 2 : 1;
    }
    const audit = createAudit(dir);
    await audit.append({ actor: 'system', event: r.reissued ? 'owner.setup-reissued' : 'owner.init', target: v['--owner'] });
    process.stdout.write(`${r.reissued ? 'New setup link for' : 'Owner'} "${v['--owner']}"${r.reissued ? '' : ` created in ${dir}`}\nOpen this link within 30 minutes to choose a password (it works once):\n${base}/setup#token=${r.token}\n`);
    return 0;
  } catch (e) {
    if (e instanceof SharedDataError) {
      complain(`the shared data cannot be used: ${e.message} (nothing was changed; fix or move the file)`);
      return 2;
    }
    throw e;
  } finally {
    if (lockPath) await releaseLock(lockPath).catch(() => {});
  }
}
