// Plugin access tokens (contract M08-J02 section 2). A token is granted by the author (the owner in shared mode) for one plugin, with the
// permissions and books the author confirmed; only sha256(token) is stored, in plugin-tokens.json of the folder given (the user config folder in
// personal mode, the shared-data folder in shared mode). A token never has a role and never writes prose. Two permissions write files: 'canvas' (planning/canvases/*.canvas)
// and, from M11, 'plan' (the Story Planner files under planning/: links, scene plans, story.md, structures, arcs, relationships, clues, synopses), each only when the author grants it.
import { readSharedJson, writeSharedJson } from '@storyforge/store';
import { SharedDataError } from './shared-data.mjs';
import { hashToken, isTokenShape, newId, newToken } from './tokens.mjs';

export const PLUGIN_PERMISSIONS = Object.freeze(['read', 'propose', 'events', 'canvas', 'plan', 'workspace', 'draft']);
const FILE = 'plugin-tokens.json';
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOK_RE = /^tok_[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isTime = (v) => Number.isInteger(v) && v >= 0;

/**
 * @typedef {{ id: string, plugin: string, permissions: string[], books: 'all' | string[], created: number, last_used: number | null, revoked: boolean }} PluginGrant
 */

/** @param {any} t */
function validRecord(t) {
  return t !== null && typeof t === 'object' && TOK_RE.test(t.id) && HEX64.test(t.token_hash) && typeof t.plugin === 'string' && SLUG_RE.test(t.plugin)
    && Array.isArray(t.permissions) && t.permissions.length > 0 && t.permissions.every((/** @type {string} */ p) => PLUGIN_PERMISSIONS.includes(p))
    && (t.books === 'all' || (Array.isArray(t.books) && t.books.every((/** @type {unknown} */ b) => typeof b === 'string' && SLUG_RE.test(b))))
    && isTime(t.created) && (t.last_used === null || isTime(t.last_used)) && typeof t.revoked === 'boolean';
}

/** A copy without the token hash. @param {any} t @returns {PluginGrant} */
function publicOf(t) {
  return { id: t.id, plugin: t.plugin, permissions: [...t.permissions], books: t.books === 'all' ? 'all' : [...t.books], created: t.created, last_used: t.last_used, revoked: t.revoked };
}

/**
 * Open the plugin tokens kept in `dir`. A damaged file throws SharedDataError (never reset).
 * @param {string} dir @param {{ now?: () => number }} [opts]
 */
export async function openPluginTokens(dir, { now = Date.now } = {}) {
  const r = await readSharedJson(dir, FILE);
  if (r.state === 'corrupt') throw new SharedDataError(FILE, r.message);
  const data = r.state === 'missing' ? { version: 1, tokens: [] } : r.value;
  if (!data || data.version !== 1 || !Array.isArray(data.tokens) || !data.tokens.every(validRecord)) throw new SharedDataError(FILE, 'unexpected content');
  let queue = Promise.resolve();
  const save = () => {
    const value = structuredClone(data);
    const p = queue.then(() => writeSharedJson(dir, FILE, value));
    queue = p.catch(() => {});
    return p;
  };
  /** last_used is saved at most once a minute per token */
  const TOUCH_MS = 60_000;

  return {
    /**
     * Grant a plugin access. The token is returned once and never stored.
     * @param {{ plugin: unknown, permissions: unknown, books: unknown }} p
     * @returns {Promise<{ ok: true, token: string, grant: PluginGrant } | { ok: false, code: string, message: string }>}
     */
    async grant({ plugin, permissions, books }) {
      if (typeof plugin !== 'string' || !SLUG_RE.test(plugin)) return { ok: false, code: 'BAD_ARGS', message: 'plugin must be the plugin slug from its manifest' };
      const perms = Array.isArray(permissions) ? [...new Set(permissions)] : [];
      if (perms.length === 0 || !perms.every((x) => PLUGIN_PERMISSIONS.includes(/** @type {string} */ (x)))) return { ok: false, code: 'BAD_ARGS', message: `permissions must be a non-empty list of ${PLUGIN_PERMISSIONS.join(', ')}` };
      const scope = books === 'all' ? 'all' : Array.isArray(books) && books.length > 0 && books.every((b) => typeof b === 'string' && SLUG_RE.test(b)) ? [...new Set(/** @type {string[]} */ (books))].sort() : null;
      if (scope === null) return { ok: false, code: 'BAD_ARGS', message: 'books must be "all" or a non-empty list of book slugs' };
      const token = newToken();
      const rec = { id: newId('tok'), token_hash: hashToken(token), plugin, permissions: /** @type {string[]} */ (perms).sort(), books: scope, created: now(), last_used: null, revoked: false };
      data.tokens.push(rec);
      await save();
      return { ok: true, token, grant: publicOf(rec) };
    },

    /** @returns {PluginGrant[]} */
    list() {
      return data.tokens.map(publicOf);
    },

    /** @param {string} id */
    async revoke(id) {
      const t = data.tokens.find((x) => x.id === id);
      if (!t) return { ok: false, code: 'NOT_FOUND', message: 'no such token' };
      t.revoked = true;
      await save();
      return { ok: true };
    },

    /**
     * The live grant a bearer token names, or null.
     * @param {unknown} token
     * @returns {Promise<PluginGrant | null>}
     */
    async resolve(token) {
      if (!isTokenShape(token)) return null;
      const h = hashToken(/** @type {string} */ (token));
      const t = data.tokens.find((x) => x.token_hash === h);
      if (!t || t.revoked) return null;
      const n = now();
      if (t.last_used === null || n - t.last_used >= TOUCH_MS) {
        t.last_used = n;
        await save();
      }
      return publicOf(t);
    },

    /**
     * The live grant with this id, or null (unknown or revoked). An OAuth access token (oauth.mjs) names its grant this way; last_used is kept as for a token.
     * @param {unknown} id
     * @returns {Promise<PluginGrant | null>}
     */
    async resolveId(id) {
      const t = typeof id === 'string' ? data.tokens.find((x) => x.id === id) : undefined;
      if (!t || t.revoked) return null;
      const n = now();
      if (t.last_used === null || n - t.last_used >= TOUCH_MS) {
        t.last_used = n;
        await save();
      }
      return publicOf(t);
    },

    flush() {
      return queue;
    },
  };
}
