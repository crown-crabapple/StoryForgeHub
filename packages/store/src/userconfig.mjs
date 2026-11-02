// Per-user app settings (not author data): a small JSON file in the user's config folder.
//   Windows: %APPDATA%\StoryForge\<name>        elsewhere: $XDG_CONFIG_HOME/storyforge/<name>, else ~/.config/storyforge/<name>
// The environment variables are read on every call so tests can point them at a temp folder.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from './atomic.mjs';
import { withRootLock } from './lock.mjs';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The folder user settings live in. */
export function userConfigDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'StoryForge');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'storyforge');
}

/**
 * Atomically replace a user settings file with `json` (any JSON-serialisable value).
 * @param {string} name file name, e.g. `recent.json`
 * @param {unknown} json
 * @returns {Promise<{ ok: true, code: 'OK', path: string } | { ok: false, code: 'BAD_ARGS', message: string }>}
 */
export async function writeUserConfig(name, json) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, code: 'BAD_ARGS', message: 'bad settings file name' };
  const text = JSON.stringify(json, null, 2);
  if (text === undefined) return { ok: false, code: 'BAD_ARGS', message: 'json is not serialisable' };
  const dir = userConfigDir();
  const file = path.join(dir, name);
  await withRootLock(dir, () => atomicWrite(file, Buffer.from(`${text}\n`, 'utf8')));
  return { ok: true, code: 'OK', path: file };
}

/**
 * Read a user settings file; null if it is missing or is not valid JSON.
 * @param {string} name
 * @returns {Promise<any | null>}
 */
export async function readUserConfig(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  try {
    return JSON.parse(await readFile(path.join(userConfigDir(), name), 'utf8'));
  } catch {
    return null;
  }
}
