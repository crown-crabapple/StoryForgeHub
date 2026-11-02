// Provider profiles, their locality and their credentials (M05-J04 contract section 2).
// Everything lives in the USER config folder (never in a book, a record, a backup or an export), in one file: ai.json.
// The key is write-only: publicProfile() is the only shape that leaves this module toward the browser, and it carries `hasKey` only.
import { randomBytes } from 'node:crypto';
import { readUserConfig, userConfigDir, writeUserConfig } from '@storyforge/store';
import { LOOPBACK_HOSTS } from './transport.mjs';

export const CONFIG_FILE = 'ai.json';
export const DEFAULT_CONTEXT_BUDGET = 8000;
export const KEY_STORAGES = ['none', 'session', 'config'];

/** @typedef {{ id: string, name: string, kind: 'openai-compatible', baseUrl: string, model: string, temperature?: number, maxTokens?: number, contextBudget: number, keyStorage: 'none' | 'session' | 'config', createdAt: string }} Profile */

const fail = (code, message) => ({ ok: false, code, message });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/** Locality is derived from the base URL host, never chosen: localhost, 127.0.0.1 and [::1] are local; everything else is cloud. @param {string} baseUrl @returns {'local' | 'cloud'} */
export function localityOf(baseUrl) {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname) ? 'local' : 'cloud';
  } catch {
    return 'cloud';
  }
}

/** The host shown in confirmations. @param {string} baseUrl */
export function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

/**
 * Check and normalise a base URL: http(s) only, no credentials / query / fragment, trailing slashes dropped; `http:` only to a local host.
 * @param {unknown} raw @returns {{ ok: true, baseUrl: string } | { ok: false, code: string, message: string }}
 */
export function normaliseBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 500) return fail('BAD_ARGS', 'baseUrl is required (for example http://localhost:11434/v1)');
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return fail('BAD_ARGS', 'baseUrl is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('BAD_ARGS', 'baseUrl must start with http:// or https://');
  if (u.username !== '' || u.password !== '') return fail('BAD_ARGS', 'baseUrl must not contain a user name or password');
  if (u.search !== '' || u.hash !== '') return fail('BAD_ARGS', 'baseUrl must not contain a query or fragment');
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(u.hostname)) {
    return fail('INSECURE_URL', 'a cloud provider must use https:; http: is only allowed for localhost, 127.0.0.1 and [::1]');
  }
  return { ok: true, baseUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/** What the browser may see of a profile: never the key. @param {Profile} p @param {boolean} hasKey */
export function publicProfile(p, hasKey) {
  return { ...p, locality: localityOf(p.baseUrl), host: hostOf(p.baseUrl), hasKey };
}

/**
 * Validate the fields of a profile. `existing` (an update) supplies what the input leaves out.
 * @param {any} input @param {Profile | null} existing
 * @returns {{ ok: true, value: Omit<Profile, 'id' | 'createdAt'>, apiKey: string | undefined, clearKey: boolean } | { ok: false, code: string, message: string }}
 */
export function validateProfileInput(input, existing = null) {
  if (!isObject(input)) return fail('BAD_ARGS', 'body must be a JSON object');
  const merged = { ...(existing ?? {}), ...input };
  const name = typeof merged.name === 'string' ? merged.name.trim() : '';
  if (name === '' || name.length > 80 || CONTROL_RE.test(name)) return fail('BAD_ARGS', 'name is required (up to 80 characters)');
  if (merged.kind !== undefined && merged.kind !== 'openai-compatible') return fail('BAD_ARGS', "kind must be 'openai-compatible'");
  const url = normaliseBaseUrl(merged.baseUrl);
  if (!url.ok) return url;
  const model = typeof merged.model === 'string' ? merged.model.trim() : '';
  if (model === '' || model.length > 200 || CONTROL_RE.test(model)) return fail('BAD_ARGS', 'model is required (up to 200 characters)');
  /** @type {any} */
  const value = { name, kind: 'openai-compatible', baseUrl: url.baseUrl, model };
  if (merged.temperature !== undefined && merged.temperature !== null) {
    if (typeof merged.temperature !== 'number' || !Number.isFinite(merged.temperature) || merged.temperature < 0 || merged.temperature > 2) return fail('BAD_ARGS', 'temperature must be a number from 0 to 2');
    value.temperature = merged.temperature;
  }
  if (merged.maxTokens !== undefined && merged.maxTokens !== null) {
    if (!Number.isInteger(merged.maxTokens) || merged.maxTokens < 1 || merged.maxTokens > 1_000_000) return fail('BAD_ARGS', 'maxTokens must be a whole number from 1 to 1000000');
    value.maxTokens = merged.maxTokens;
  }
  const budget = merged.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  if (!Number.isInteger(budget) || budget < 200 || budget > 2_000_000) return fail('BAD_ARGS', 'contextBudget must be a whole number of tokens from 200 to 2000000');
  value.contextBudget = budget;

  const apiKey = input.apiKey;
  if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== 'string' || apiKey.length > 2000 || CONTROL_RE.test(apiKey))) return fail('BAD_ARGS', 'apiKey must be text');
  const newKey = typeof apiKey === 'string' && apiKey !== '' ? apiKey : undefined;
  const clearKey = apiKey === '' || apiKey === null;
  const storage = input.keyStorage ?? (newKey !== undefined ? (existing && existing.keyStorage !== 'none' ? existing.keyStorage : 'session') : (existing?.keyStorage ?? 'none'));
  if (!KEY_STORAGES.includes(storage)) return fail('BAD_ARGS', `keyStorage must be one of: ${KEY_STORAGES.join(', ')}`);
  value.keyStorage = storage;
  // keyStorage 'none' means no key is kept anywhere: a key sent with it is dropped, never stored
  return { ok: true, value, apiKey: storage === 'none' ? undefined : newKey, clearKey };
}

const newId = () => `prof_${randomBytes(6).toString('hex')}`;

/**
 * The AI settings service of one server process: profiles and per-book choices in the user config file, session keys in memory only.
 * `read` / `write` are the user-config functions (replaceable in tests of this package).
 * @param {{ read?: typeof readUserConfig, write?: typeof writeUserConfig, now?: () => Date }} [deps]
 */
export function createAiSettings({ read = readUserConfig, write = writeUserConfig, now = () => new Date() } = {}) {
  /** Keys that live in server memory only (`keyStorage: 'session'`): gone when the process ends. @type {Map<string, string>} */
  const sessionKeys = new Map();
  /** Serialises read-modify-write so two requests cannot lose each other's change. */
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  };

  async function load() {
    const raw = await read(CONFIG_FILE);
    const data = isObject(raw) ? raw : {};
    return {
      profiles: Array.isArray(data.profiles) ? data.profiles.filter((p) => isObject(p) && typeof p.id === 'string') : [],
      bookProfiles: isObject(data.bookProfiles) ? { ...data.bookProfiles } : {},
      recordBooks: isObject(data.recordBooks) ? { ...data.recordBooks } : {},
      keys: isObject(data.keys) ? { ...data.keys } : {},
    };
  }
  async function save(d) {
    const out = { version: 1, profiles: d.profiles, bookProfiles: d.bookProfiles, recordBooks: d.recordBooks, ...(Object.keys(d.keys).length > 0 ? { keys: d.keys } : {}) };
    const r = await write(CONFIG_FILE, out);
    if (!r.ok) throw new Error(r.message ?? 'the AI settings could not be saved');
  }

  const keyOf = (d, p) => (p.keyStorage === 'config' ? (typeof d.keys[p.id] === 'string' ? d.keys[p.id] : null) : p.keyStorage === 'session' ? (sessionKeys.get(p.id) ?? null) : null);
  const hasKeyOf = (d, p) => keyOf(d, p) !== null;

  /** Put `apiKey` where `storage` says, and remove it from the other place. */
  function placeKey(d, id, storage, apiKey) {
    delete d.keys[id];
    sessionKeys.delete(id);
    if (apiKey === undefined || apiKey === null) return;
    if (storage === 'config') d.keys[id] = apiKey;
    else if (storage === 'session') sessionKeys.set(id, apiKey);
  }

  return {
    /** Where the settings (and any key saved in plain text) are stored. */
    configPath() {
      const dir = userConfigDir();
      return `${dir}${dir.includes('\\') ? '\\' : '/'}${CONFIG_FILE}`;
    },

    /** @returns {Promise<ReturnType<typeof publicProfile>[]>} */
    async list() {
      const d = await load();
      return d.profiles.map((p) => publicProfile(p, hasKeyOf(d, p)));
    },

    /** @param {string} id @returns {Promise<Profile | null>} */
    async get(id) {
      const d = await load();
      return d.profiles.find((p) => p.id === id) ?? null;
    },

    /** The key of a profile, for the one place that sends it (the Authorization header). Never leaves the server. @param {Profile} profile @returns {Promise<string | null>} */
    async keyFor(profile) {
      return keyOf(await load(), profile);
    },

    /** Every key the process knows (for redaction). @returns {Promise<string[]>} */
    async allKeys() {
      const d = await load();
      return [...Object.values(d.keys), ...sessionKeys.values()].filter((k) => typeof k === 'string');
    },

    /** @param {any} input */
    create(input) {
      return exclusive(async () => {
        const v = validateProfileInput(input, null);
        if (!v.ok) return v;
        const d = await load();
        const profile = { id: newId(), ...v.value, createdAt: now().toISOString() };
        d.profiles.push(profile);
        placeKey(d, profile.id, profile.keyStorage, v.apiKey);
        await save(d);
        return { ok: true, profile: publicProfile(profile, hasKeyOf(d, profile)) };
      });
    },

    /** @param {string} id @param {any} input */
    update(id, input) {
      return exclusive(async () => {
        const d = await load();
        const at = d.profiles.findIndex((p) => p.id === id);
        if (at < 0) return fail('NOT_FOUND', 'no such profile');
        const old = d.profiles[at];
        const v = validateProfileInput(input, old);
        if (!v.ok) return v;
        const oldKey = keyOf(d, old);
        // A saved key is only ever sent to the host it was entered for: a new host needs the key typed again.
        const sameHost = hostOf(old.baseUrl) === hostOf(v.value.baseUrl);
        const keep = v.clearKey || v.value.keyStorage === 'none' || !sameHost ? null : oldKey;
        const profile = { id: old.id, ...v.value, createdAt: old.createdAt };
        d.profiles[at] = profile;
        placeKey(d, id, profile.keyStorage, v.apiKey ?? keep ?? undefined);
        await save(d);
        return { ok: true, profile: publicProfile(profile, hasKeyOf(d, profile)) };
      });
    },

    /** @param {string} id */
    remove(id) {
      return exclusive(async () => {
        const d = await load();
        if (!d.profiles.some((p) => p.id === id)) return fail('NOT_FOUND', 'no such profile');
        d.profiles = d.profiles.filter((p) => p.id !== id);
        for (const [book, pid] of Object.entries(d.bookProfiles)) if (pid === id) delete d.bookProfiles[book];
        placeKey(d, id, 'none', undefined);
        await save(d);
        return { ok: true };
      });
    },

    /** The active profile of a book (null: AI is off for it). @param {string} bookId @returns {Promise<Profile | null>} */
    async activeProfile(bookId) {
      const d = await load();
      const id = d.bookProfiles[bookId];
      return typeof id === 'string' ? (d.profiles.find((p) => p.id === id) ?? null) : null;
    },

    /** @param {string} bookId @param {string | null} profileId */
    setBookProfile(bookId, profileId) {
      return exclusive(async () => {
        const d = await load();
        if (profileId === null) delete d.bookProfiles[bookId];
        else {
          if (!d.profiles.some((p) => p.id === profileId)) return fail('NOT_FOUND', 'no such profile');
          d.bookProfiles[bookId] = profileId;
        }
        await save(d);
        return { ok: true };
      });
    },

    /** Whether chat / rewrite records are saved in this book (default off). @param {string} bookId */
    async recordsOn(bookId) {
      return (await load()).recordBooks[bookId] === true;
    },

    /** @param {string} bookId @param {boolean} on */
    setRecords(bookId, on) {
      return exclusive(async () => {
        const d = await load();
        if (on) d.recordBooks[bookId] = true;
        else delete d.recordBooks[bookId];
        await save(d);
        return { ok: true };
      });
    },
  };
}
