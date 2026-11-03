// Shared-mode settings the owner changes (contract M07-J03): settings.json in the shared-data folder. A file with an unexpected shape stops shared mode
// (SharedDataError); it is never reset.
import { readSharedJson, writeSharedJson } from '@storyforge/store';
import { SharedDataError } from './shared-data.mjs';

const FILE = 'settings.json';

/** @param {unknown} v */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What a PUT may carry: only known keys, each of the right type. Returns the problem, or null. @param {unknown} patch */
export function settingsProblem(patch) {
  if (!isObj(patch)) return 'settings must be a JSON object';
  const o = /** @type {Record<string, unknown>} */ (patch);
  for (const k of Object.keys(o)) if (k !== 'ai_for_members') return `unknown setting: ${k}`;
  if (o.ai_for_members !== undefined && typeof o.ai_for_members !== 'boolean') return 'ai_for_members must be true or false';
  return null;
}

/** @param {string} dir the shared-data folder */
export async function openSettings(dir) {
  const r = await readSharedJson(dir, FILE);
  if (r.state === 'corrupt') throw new SharedDataError(FILE, r.message);
  let value = { version: 1, ai_for_members: false };
  if (r.state === 'ok') {
    const v = r.value;
    if (!isObj(v) || v.version !== 1 || typeof v.ai_for_members !== 'boolean') throw new SharedDataError(FILE, 'unexpected top level');
    value = { version: 1, ai_for_members: v.ai_for_members };
  }
  let queue = Promise.resolve();
  return {
    /** @returns {{ ai_for_members: boolean }} */
    get: () => ({ ai_for_members: value.ai_for_members }),
    /** @param {unknown} patch @returns {Promise<{ ok: true } | { ok: false, message: string }>} */
    async set(patch) {
      const problem = settingsProblem(patch);
      if (problem) return { ok: false, message: problem };
      const next = { ...value, ...(/** @type {object} */ (patch)) };
      const p = queue.then(() => writeSharedJson(dir, FILE, next));
      queue = p.catch(() => {});
      await p;
      value = next;
      return { ok: true };
    },
  };
}
