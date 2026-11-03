// Provider profiles, their locality and their credentials (M05-J04 contract section 2).
// Everything lives in the USER config folder (never in a book, a record, a backup or an export), in one file: ai.json.
// The key is write-only: publicProfile() is the only shape that leaves this module toward the browser, and it carries `hasKey` only.
import { randomBytes } from 'node:crypto';
import { readUserConfig, userConfigDir, writeUserConfig } from '@storyforge/store';
import { createKeystore } from './keystore.mjs';
import { LOOPBACK_HOSTS } from './transport.mjs';

export const CONFIG_FILE = 'ai.json';
export const DEFAULT_CONTEXT_BUDGET = 8000;
/** 'secure' (M08-J03): the key lives in the key store (DPAPI, keychain, Secret Service or an encrypted file), never in ai.json. */
export const KEY_STORAGES = ['none', 'session', 'config', 'secure'];
export const CHAT_KIND = 'openai-compatible';
/** M08-J03: an image provider (POST {base}/images/generations) for cover drafts. */
export const IMAGE_KIND = 'openai-compatible-images';
export const KINDS = [CHAT_KIND, IMAGE_KIND];

/** @typedef {{ id: string, name: string, kind: 'openai-compatible' | 'openai-compatible-images', baseUrl: string, model: string, temperature?: number, maxTokens?: number, contextBudget: number, keyStorage: 'none' | 'session' | 'config' | 'secure', createdAt: string }} Profile */

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
  return { ...p, locality: localityOf(p.baseUrl), host: hostOf(p.baseUrl), hasKey, storage: p.keyStorage };
}

/**
 * Validate the fields of a profile. `existing` (an update) supplies what the input leaves out. `defaultStorage`: where a new key goes when the author does not say.
 * @param {any} input @param {Profile | null} existing @param {'session' | 'secure'} [defaultStorage]
 * @returns {{ ok: true, value: Omit<Profile, 'id' | 'createdAt'>, apiKey: string | undefined, clearKey: boolean } | { ok: false, code: string, message: string }}
 */
export function validateProfileInput(input, existing = null, defaultStorage = 'secure') {
  if (!isObject(input)) return fail('BAD_ARGS', 'body must be a JSON object');
  const merged = { ...(existing ?? {}), ...input };
  const name = typeof merged.name === 'string' ? merged.name.trim() : '';
  if (name === '' || name.length > 80 || CONTROL_RE.test(name)) return fail('BAD_ARGS', 'name is required (up to 80 characters)');
  if (merged.kind !== undefined && !KINDS.includes(merged.kind)) return fail('BAD_ARGS', `kind must be one of: ${KINDS.join(', ')}`);
  const url = normaliseBaseUrl(merged.baseUrl);
  if (!url.ok) return url;
  const model = typeof merged.model === 'string' ? merged.model.trim() : '';
  if (model === '' || model.length > 200 || CONTROL_RE.test(model)) return fail('BAD_ARGS', 'model is required (up to 200 characters)');
  /** @type {any} */
  const value = { name, kind: merged.kind ?? CHAT_KIND, baseUrl: url.baseUrl, model };
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
  const storage = input.keyStorage ?? (newKey !== undefined ? (existing && existing.keyStorage !== 'none' ? existing.keyStorage : defaultStorage) : (existing?.keyStorage ?? 'none'));
  if (!KEY_STORAGES.includes(storage)) return fail('BAD_ARGS', `keyStorage must be one of: ${KEY_STORAGES.join(', ')}`);
  value.keyStorage = storage;
  // keyStorage 'none' means no key is kept anywhere: a key sent with it is dropped, never stored
  return { ok: true, value, apiKey: storage === 'none' ? undefined : newKey, clearKey };
}

const newId = () => `prof_${randomBytes(6).toString('hex')}`;
/** The key store's id for a profile's key. */
const secretId = (profileId) => `ai.${String(profileId).toLowerCase().replace(/[^a-z0-9._:-]/g, '-')}`;
/** "leave the stored key where it is" */
const KEEP = Symbol('keep');

/**
 * The AI settings service of one server process: profiles and per-book choices in the user config file, session keys in memory only, secure keys in the key store.
 * `read` / `write` are the user-config functions (replaceable in tests of this package). `keystore` is the process's key store (default: one in the user config folder).
 * @param {{ read?: typeof readUserConfig, write?: typeof writeUserConfig, now?: () => Date, keystore?: ReturnType<typeof createKeystore> }} [deps]
 */
export function createAiSettings({ read = readUserConfig, write = writeUserConfig, now = () => new Date(), keystore: given } = {}) {
  /** @type {ReturnType<typeof createKeystore> | null} */
  let own = given ?? null;
  /** The key store; made on first use so nothing touches disk before a key is involved. */
  const keystore = () => (own ??= createKeystore({ dir: userConfigDir() }));
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
      bookImageProfiles: isObject(data.bookImageProfiles) ? { ...data.bookImageProfiles } : {},
      recordBooks: isObject(data.recordBooks) ? { ...data.recordBooks } : {},
      usageBooks: isObject(data.usageBooks) ? { ...data.usageBooks } : {},
      keys: isObject(data.keys) ? { ...data.keys } : {},
    };
  }
  async function save(d) {
    const out = {
      version: 1,
      profiles: d.profiles,
      bookProfiles: d.bookProfiles,
      ...(Object.keys(d.bookImageProfiles).length > 0 ? { bookImageProfiles: d.bookImageProfiles } : {}),
      recordBooks: d.recordBooks,
      ...(Object.keys(d.usageBooks).length > 0 ? { usageBooks: d.usageBooks } : {}),
      ...(Object.keys(d.keys).length > 0 ? { keys: d.keys } : {}),
    };
    const r = await write(CONFIG_FILE, out);
    if (!r.ok) throw new Error(r.message ?? 'the AI settings could not be saved');
  }

  /** The key of a profile, or null. A secure key that cannot be unlocked throws KeystoreError('LOCKED'): never an empty key. */
  async function keyOf(d, p) {
    if (p.keyStorage === 'config') return typeof d.keys[p.id] === 'string' ? d.keys[p.id] : null;
    if (p.keyStorage === 'session') return sessionKeys.get(p.id) ?? null;
    if (p.keyStorage === 'secure') return keystore().get(secretId(p.id));
    return null;
  }

  /** Which profiles have a key, without decrypting anything. A damaged key store reads as "unknown" (null). @returns {Promise<Set<string> | null>} */
  async function secureIds() {
    try {
      return new Set(await keystore().ids());
    } catch {
      return null;
    }
  }
  const hasKeyOf = (d, p, secure) => {
    if (p.keyStorage === 'config') return typeof d.keys[p.id] === 'string';
    if (p.keyStorage === 'session') return sessionKeys.has(p.id);
    if (p.keyStorage === 'secure') return secure === null ? true : secure.has(secretId(p.id));
    return false;
  };

  /** Put `apiKey` where `storage` says, and remove it from the other places. `KEEP` leaves it as it is (same storage, same host). */
  async function placeKey(d, id, storage, apiKey, wasSecure) {
    if (apiKey === KEEP) return;
    delete d.keys[id];
    sessionKeys.delete(id);
    if (storage === 'secure' && typeof apiKey === 'string') {
      await keystore().set(secretId(id), apiKey);
      return;
    }
    if (wasSecure) await keystore().remove(secretId(id));
    if (typeof apiKey === 'string') {
      if (storage === 'config') d.keys[id] = apiKey;
      else if (storage === 'session') sessionKeys.set(id, apiKey);
    }
  }

  return {
    /** Where the settings (and any key saved in plain text) are stored. */
    configPath() {
      const dir = userConfigDir();
      return `${dir}${dir.includes('\\') ? '\\' : '/'}${CONFIG_FILE}`;
    },

    /** The key store, for the other secrets (webhook signing secrets). */
    keystore,

    /**
     * What Settings shows about secret storage: the backend in use and, when a stored key cannot be read, why ("cannot unlock stored keys: ...").
     * @returns {Promise<{ backend: string | null, locked: boolean, message: string | null }>}
     */
    async keystoreStatus() {
      /** @type {string | null} */
      let backend = null;
      try {
        backend = await keystore().backend();
        await keystore().ids();
        const d = await load();
        for (const p of d.profiles) {
          if (p.keyStorage === 'secure' && (await secureIds())?.has(secretId(p.id))) await keystore().get(secretId(p.id));
        }
        return { backend, locked: false, message: null };
      } catch (e) {
        return { backend, locked: true, message: e instanceof Error ? e.message : 'cannot unlock stored keys' };
      }
    },

    /** @returns {Promise<ReturnType<typeof publicProfile>[]>} */
    async list() {
      const d = await load();
      const secure = d.profiles.some((p) => p.keyStorage === 'secure') ? await secureIds() : new Set();
      return d.profiles.map((p) => publicProfile(p, hasKeyOf(d, p, secure)));
    },

    /** @param {string} id @returns {Promise<Profile | null>} */
    async get(id) {
      const d = await load();
      return d.profiles.find((p) => p.id === id) ?? null;
    },

    /** Whether a profile has a key (nothing is decrypted). @param {Profile} profile */
    async hasKey(profile) {
      const d = await load();
      return hasKeyOf(d, profile, profile.keyStorage === 'secure' ? await secureIds() : new Set());
    },

    /** The key of a profile, for the one place that sends it (the Authorization header). Never leaves the server. Throws KeystoreError('LOCKED') for a secure key that cannot be read. @param {Profile} profile @returns {Promise<string | null>} */
    async keyFor(profile) {
      return keyOf(await load(), profile);
    },

    /** Every key the process knows (for redaction). A secure key that cannot be read is simply not in the list. @returns {Promise<string[]>} */
    async allKeys() {
      const d = await load();
      const out = [...Object.values(d.keys), ...sessionKeys.values()];
      for (const p of d.profiles) {
        if (p.keyStorage !== 'secure') continue;
        try {
          const k = await keystore().get(secretId(p.id));
          if (k) out.push(k);
        } catch {
          // nothing to redact if it cannot be read
        }
      }
      return out.filter((k) => typeof k === 'string');
    },

    /** @param {any} input */
    create(input) {
      return exclusive(async () => {
        const v = validateProfileInput(input, null);
        if (!v.ok) return v;
        const d = await load();
        const profile = { id: newId(), ...v.value, createdAt: now().toISOString() };
        d.profiles.push(profile);
        await placeKey(d, profile.id, profile.keyStorage, v.apiKey, false);
        await save(d);
        return { ok: true, profile: publicProfile(profile, hasKeyOf(d, profile, await secureIds())) };
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
        // A saved key is only ever sent to the host it was entered for: a new host needs the key typed again.
        const sameHost = hostOf(old.baseUrl) === hostOf(v.value.baseUrl);
        /** @type {string | typeof KEEP | undefined} */
        let carry;
        if (v.apiKey !== undefined) carry = v.apiKey;
        else if (v.clearKey || v.value.keyStorage === 'none' || !sameHost) carry = undefined;
        else if (old.keyStorage === v.value.keyStorage) carry = KEEP;
        else carry = (await keyOf(d, old)) ?? undefined;
        const profile = { id: old.id, ...v.value, createdAt: old.createdAt };
        d.profiles[at] = profile;
        await placeKey(d, id, profile.keyStorage, carry, old.keyStorage === 'secure');
        await save(d);
        return { ok: true, profile: publicProfile(profile, hasKeyOf(d, profile, await secureIds())) };
      });
    },

    /**
     * "Move key to secure storage": a key saved as plain text in ai.json is written to the key store, and only then is the plain copy deleted.
     * @param {string} id
     */
    moveKeyToSecure(id) {
      return exclusive(async () => {
        const d = await load();
        const at = d.profiles.findIndex((p) => p.id === id);
        if (at < 0) return fail('NOT_FOUND', 'no such profile');
        const key = d.keys[id];
        if (d.profiles[at].keyStorage !== 'config' || typeof key !== 'string') return fail('BAD_ARGS', 'only a key saved in the settings file can be moved to secure storage');
        await keystore().set(secretId(id), key);
        delete d.keys[id];
        d.profiles[at] = { ...d.profiles[at], keyStorage: 'secure' };
        await save(d);
        return { ok: true, profile: publicProfile(d.profiles[at], true) };
      });
    },

    /** @param {string} id */
    remove(id) {
      return exclusive(async () => {
        const d = await load();
        const old = d.profiles.find((p) => p.id === id);
        if (!old) return fail('NOT_FOUND', 'no such profile');
        d.profiles = d.profiles.filter((p) => p.id !== id);
        for (const map of [d.bookProfiles, d.bookImageProfiles]) for (const [book, pid] of Object.entries(map)) if (pid === id) delete map[book];
        await placeKey(d, id, 'none', undefined, old.keyStorage === 'secure');
        await save(d);
        return { ok: true };
      });
    },

    /** The active chat profile of a book (null: AI is off for it). @param {string} bookId @returns {Promise<Profile | null>} */
    async activeProfile(bookId) {
      const d = await load();
      const id = d.bookProfiles[bookId];
      return typeof id === 'string' ? (d.profiles.find((p) => p.id === id && p.kind !== IMAGE_KIND) ?? null) : null;
    },

    /** The image profile of a book (null: no cover generation for it). @param {string} bookId @returns {Promise<Profile | null>} */
    async activeImageProfile(bookId) {
      const d = await load();
      const id = d.bookImageProfiles[bookId];
      return typeof id === 'string' ? (d.profiles.find((p) => p.id === id && p.kind === IMAGE_KIND) ?? null) : null;
    },

    /** Choose the profile a book uses; an image profile fills the book's image slot, any other the chat slot. `slot` says which one `null` clears. @param {string} bookId @param {string | null} profileId @param {'chat' | 'image'} [slot] */
    setBookProfile(bookId, profileId, slot = 'chat') {
      return exclusive(async () => {
        const d = await load();
        if (profileId === null) {
          if (slot === 'image') delete d.bookImageProfiles[bookId];
          else delete d.bookProfiles[bookId];
        } else {
          const p = d.profiles.find((x) => x.id === profileId);
          if (!p) return fail('NOT_FOUND', 'no such profile');
          if (p.kind === IMAGE_KIND) d.bookImageProfiles[bookId] = profileId;
          else d.bookProfiles[bookId] = profileId;
        }
        await save(d);
        return { ok: true };
      });
    },

    /** Whether chat / rewrite records are saved in this book (default off). @param {string} bookId */
    async recordsOn(bookId) {
      return (await load()).recordBooks[bookId] === true;
    },

    /** Whether the book's token usage table (activity/ai-usage.md) is kept on its own (default off). @param {string} bookId */
    async usageTracked(bookId) {
      return (await load()).usageBooks[bookId] === true;
    },

    /** Whether a request is counted in activity/ai-usage.md: when records or usage tracking is on for the book. @param {string} bookId */
    async usageOn(bookId) {
      const d = await load();
      return d.recordBooks[bookId] === true || d.usageBooks[bookId] === true;
    },

    /** @param {string} bookId @param {boolean} on */
    setUsage(bookId, on) {
      return exclusive(async () => {
        const d = await load();
        if (on) d.usageBooks[bookId] = true;
        else delete d.usageBooks[bookId];
        await save(d);
        return { ok: true };
      });
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
