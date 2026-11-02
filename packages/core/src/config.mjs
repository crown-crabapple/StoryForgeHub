// Runtime configuration for the server. Host is always loopback in this version.
import os from 'node:os';
import path from 'node:path';
import { readUserConfig } from '@storyforge/store';
import { folderExists } from './fs-repository.mjs';

export const DEFAULT_PORT = 4317;
export const HOST = '127.0.0.1';
/** The single-instance lock file, in the library root. */
export const LOCK_FILE = '.storyforge-lock';

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    /** process exit code the CLI should use */
    this.exitCode = 2;
  }
}

/**
 * Value of `--name <value>` or `--name=<value>`; the last occurrence wins.
 * @param {string[]} argv
 * @param {string} name
 * @returns {string | undefined}
 */
function argValue(argv, name) {
  let found;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new ConfigError(`${name} needs a value`);
      found = argv[i + 1];
      i++;
    } else if (a.startsWith(`${name}=`)) {
      found = a.slice(name.length + 1);
    }
  }
  return found;
}

/**
 * @param {{ argv?: string[], env?: Record<string, string | undefined> }} [input]
 *   argv: command-line arguments (flags are found wherever they appear).
 * @returns {{ libraryRoot: string, host: '127.0.0.1', port: number }}
 */
export function loadConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const library = argValue(argv, '--library') || env.STORYFORGE_LIBRARY || '';
  if (!library) {
    throw new ConfigError('no library given: pass --library <path> or set STORYFORGE_LIBRARY');
  }
  const rawPort = argValue(argv, '--port') ?? env.STORYFORGE_PORT;
  let port = DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
      throw new ConfigError(`invalid port: ${rawPort}`);
    }
    port = Number(rawPort);
  }
  return { libraryRoot: path.resolve(library), host: HOST, port };
}

/** The folder StoryForge opens when nothing else says which library to use (the first run): a StoryForge folder in the user's home. */
export const defaultLibraryRoot = () => path.join(os.homedir(), 'StoryForge');

/**
 * Like loadConfig, but a missing library is not an error where there is a better answer (M06-J03). Order: --library, STORYFORGE_LIBRARY, the library used last
 * (recent.json in the user config folder, newest first, the first folder that still exists), then, with `fallback: 'default'`, a StoryForge folder in the home folder
 * (the caller creates it). With `fallback: 'none'` (commands that change files) the last library is still used, but nothing is invented: the error names the flag and the variable.
 * @param {{ argv?: string[], env?: Record<string, string | undefined>, fallback?: 'default' | 'none' }} [input]
 * @returns {Promise<{ libraryRoot: string, host: '127.0.0.1', port: number, source: 'flag' | 'env' | 'recent' | 'default' }>}
 */
export async function resolveConfig({ argv = process.argv.slice(2), env = process.env, fallback = 'none' } = {}) {
  const given = argValue(argv, '--library') || env.STORYFORGE_LIBRARY || '';
  if (given) return { ...loadConfig({ argv, env }), source: argValue(argv, '--library') ? 'flag' : 'env' };
  const recent = await readUserConfig('recent.json');
  const list = Array.isArray(recent?.paths) ? recent.paths.filter((p) => typeof p === 'string' && path.isAbsolute(p)) : [];
  for (const p of list) {
    if (await folderExists(p)) return { ...loadConfig({ argv: [...argv, '--library', p], env }), source: 'recent' };
  }
  if (fallback === 'default') return { ...loadConfig({ argv: [...argv, '--library', defaultLibraryRoot()], env }), source: 'default' };
  throw new ConfigError('no library given: pass --library <path>, set STORYFORGE_LIBRARY, or start StoryForge once and open a library so it is remembered');
}
