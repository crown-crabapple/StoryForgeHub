// Per-user app settings (not author data): a small JSON file in the user's config folder.
//   Windows: %APPDATA%\StoryForge\<name>        elsewhere: $XDG_CONFIG_HOME/storyforge/<name>, else ~/.config/storyforge/<name>
// The environment variables are read on every call so tests can point them at a temp folder.
import { readFile, readdir, unlink } from 'node:fs/promises';
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

// ---- Profiles (M07-J04): per-machine appearance settings, `<config>/profiles/<name>.json`, next to recent.json. Not author data.

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
/** The profile used when none is named. */
export const DEFAULT_PROFILE = 'default';

/** Is this a usable profile name (lower-case letters, digits, hyphen, underscore; at most 40 characters)? @param {unknown} name */
export const isProfileName = (name) => typeof name === 'string' && PROFILE_RE.test(name);

const profileFile = (name) => path.join(userConfigDir(), 'profiles', `${name}.json`);

/**
 * Read a profile; null when it does not exist yet or is not valid JSON.
 * @param {string} name @returns {Promise<Record<string, any> | null>}
 */
export async function readProfile(name) {
  if (!isProfileName(name)) return null;
  try {
    const v = JSON.parse(await readFile(profileFile(name), 'utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Atomically replace a profile.
 * @param {string} name @param {Record<string, any>} json
 * @returns {Promise<{ ok: true, code: 'OK', path: string } | { ok: false, code: 'BAD_ARGS', message: string }>}
 */
export async function writeProfile(name, json) {
  if (!isProfileName(name)) return { ok: false, code: 'BAD_ARGS', message: 'a profile name is lower-case letters, digits, hyphen or underscore (at most 40 characters)' };
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { ok: false, code: 'BAD_ARGS', message: 'a profile is a JSON object' };
  const dir = userConfigDir();
  const file = profileFile(name);
  await withRootLock(dir, () => atomicWrite(file, Buffer.from(`${JSON.stringify(json, null, 2)}\n`, 'utf8')));
  return { ok: true, code: 'OK', path: file };
}

/** The names of the saved profiles, sorted. @returns {Promise<string[]>} */
export async function listProfiles() {
  try {
    const names = (await readdir(path.join(userConfigDir(), 'profiles'))).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
    return names.filter(isProfileName).sort();
  } catch {
    return [];
  }
}

/** Delete a saved profile (the default one cannot be deleted, only reset by saving it empty). @param {string} name @returns {Promise<boolean>} */
export async function deleteProfile(name) {
  if (!isProfileName(name) || name === DEFAULT_PROFILE) return false;
  try {
    await unlink(profileFile(name));
    return true;
  } catch {
    return false;
  }
}
