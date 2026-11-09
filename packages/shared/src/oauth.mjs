// OAuth 2.1 for the MCP service (claude.ai and ChatGPT connectors): registered clients (RFC 7591 dynamic registration), one-time authorization codes with
// PKCE (S256 only), and access and refresh tokens. Kept in oauth.json beside plugin-tokens.json (the user config folder in personal mode, the shared-data folder in
// shared mode; never a library). Only sha256 of every secret is stored: client secrets, access tokens and refresh tokens. Codes live in memory only (10 minutes).
//
// An OAuth token never carries rights of its own. Each one points at a plugin grant (plugin-tokens.json, an `mcp-<name>` AI connection made when the owner
// approved the client), and the server resolves that grant on every request: its books and permissions apply, and revoking the connection in Settings ends
// every token of it at once.
import crypto from 'node:crypto';
import { readSharedJson, writeSharedJson } from '@storyforge/store';
import { SharedDataError } from './shared-data.mjs';
import { hashToken, newToken } from './tokens.mjs';

const FILE = 'oauth.json';
export const ACCESS_TTL_MS = 60 * 60 * 1000; // one hour
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, renewed at each refresh
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_CLIENTS = 200;
export const AUTH_METHODS = Object.freeze(['none', 'client_secret_post', 'client_secret_basic']);

// prefixes tell the kinds apart (and keep them apart from plugin tokens, which are 43 bare characters)
const ACCESS_PREFIX = 'sfat_';
const REFRESH_PREFIX = 'sfrt_';
const CODE_PREFIX = 'sfac_';
const CLIENT_PREFIX = 'sfc_';
const SECRET_PREFIX = 'sfcs_';
const SECRET_RE = (/** @type {string} */ prefix) => new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
const ACCESS_RE = SECRET_RE(ACCESS_PREFIX);
const REFRESH_RE = SECRET_RE(REFRESH_PREFIX);
const CODE_RE = SECRET_RE(CODE_PREFIX);
const SECRET_SHAPE = SECRET_RE(SECRET_PREFIX);
const CLIENT_RE = /^sfc_[A-Za-z0-9_-]{22}$/;
const TOK_RE = /^tok_[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const isTime = (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;

/** Is this bearer an OAuth access token (by its shape)? @param {unknown} t */
export const isAccessToken = (t) => typeof t === 'string' && ACCESS_RE.test(t);

/** @param {unknown} c */
function validClient(c) {
  return c !== null && typeof c === 'object' && CLIENT_RE.test(c.id) && (c.secret_hash === null || HEX64.test(c.secret_hash)) && typeof c.name === 'string' && c.name.length <= 100
    && Array.isArray(c.redirect_uris) && c.redirect_uris.length > 0 && c.redirect_uris.every((/** @type {unknown} */ u) => typeof u === 'string' && redirectProblem(u) === null)
    && AUTH_METHODS.includes(c.auth_method) && (c.auth_method === 'none') === (c.secret_hash === null) && isTime(c.created);
}

/** @param {unknown} t */
function validToken(t) {
  return t !== null && typeof t === 'object' && HEX64.test(t.hash) && (t.kind === 'access' || t.kind === 'refresh') && CLIENT_RE.test(t.client) && TOK_RE.test(t.grant)
    && isTime(t.created) && isTime(t.expires);
}

/**
 * Why a redirect URI cannot be registered, or null. https anywhere; http only to this computer (a native app's loopback listener, RFC 8252). No fragment, no
 * user name or password in it.
 * @param {string} uri
 */
export function redirectProblem(uri) {
  if (typeof uri !== 'string' || uri.length > 2000) return 'a redirect URI is a string of at most 2000 characters';
  let u;
  try {
    u = new URL(uri);
  } catch {
    return `${uri} is not an absolute URL`;
  }
  if (u.hash !== '' || uri.includes('#')) return 'a redirect URI has no fragment (#)';
  if (u.username !== '' || u.password !== '') return 'a redirect URI has no user name or password';
  const loopback = u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'localhost';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && loopback) return null;
  return 'a redirect URI must be https (or http to 127.0.0.1, [::1] or localhost)';
}

/** sha256 of the verifier, base64url: what S256 compares with the code challenge. @param {string} verifier */
export const s256 = (verifier) => crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** Compare two strings in constant time (for secrets and hashes of the same length). */
function same(/** @type {string} */ a, /** @type {string} */ b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Open the OAuth store kept in `dir`. A damaged file throws SharedDataError (never reset).
 * @param {string} dir @param {{ now?: () => number }} [opts]
 */
export async function openOAuth(dir, { now = Date.now } = {}) {
  const r = await readSharedJson(dir, FILE);
  if (r.state === 'corrupt') throw new SharedDataError(FILE, r.message);
  const data = r.state === 'missing' ? { version: 1, clients: [], tokens: [] } : r.value;
  if (!data || data.version !== 1 || !Array.isArray(data.clients) || !data.clients.every(validClient) || !Array.isArray(data.tokens) || !data.tokens.every(validToken)) {
    throw new SharedDataError(FILE, 'unexpected content');
  }
  let queue = Promise.resolve();
  const save = () => {
    const value = structuredClone(data);
    const p = queue.then(() => writeSharedJson(dir, FILE, value));
    queue = p.catch(() => {});
    return p;
  };
  /** @type {Map<string, { client: string, redirect_uri: string, explicit: boolean, challenge: string, grant: string, resource: string, scope: string, expires: number }>} hash -> code */
  const codes = new Map();

  /** Drop expired tokens (and codes). Returns whether the file changed. */
  const prune = () => {
    const t = now();
    for (const [h, c] of codes) if (c.expires <= t) codes.delete(h);
    const before = data.tokens.length;
    data.tokens = data.tokens.filter((x) => x.expires > t);
    return data.tokens.length !== before;
  };

  /** A new pair for one grant and client: the plain tokens are returned once. @param {string} client @param {string} grant */
  const issuePair = (client, grant) => {
    const t = now();
    const access = ACCESS_PREFIX + newToken();
    const refresh = REFRESH_PREFIX + newToken();
    data.tokens.push({ hash: hashToken(access), kind: 'access', client, grant, created: t, expires: t + ACCESS_TTL_MS });
    data.tokens.push({ hash: hashToken(refresh), kind: 'refresh', client, grant, created: t, expires: t + REFRESH_TTL_MS });
    return { access_token: access, refresh_token: refresh, expires_in: Math.round(ACCESS_TTL_MS / 1000) };
  };

  const store = {
    /**
     * Register a client (RFC 7591). The store is bounded: when it is full, the oldest client with no live token is forgotten; when none can be, it refuses.
     * @param {{ name?: unknown, redirect_uris?: unknown, auth_method?: unknown }} p
     * @returns {Promise<{ ok: true, client: { id: string, name: string, redirect_uris: string[], auth_method: string, created: number }, secret: string | null } | { ok: false, code: string, message: string }>}
     */
    async register({ name, redirect_uris, auth_method = 'none' }) {
      if (!Array.isArray(redirect_uris) || redirect_uris.length === 0 || redirect_uris.length > 10) return { ok: false, code: 'invalid_redirect_uri', message: 'redirect_uris must list 1 to 10 URIs' };
      for (const u of redirect_uris) {
        const problem = redirectProblem(/** @type {string} */ (u));
        if (problem) return { ok: false, code: 'invalid_redirect_uri', message: problem };
      }
      if (!AUTH_METHODS.includes(/** @type {string} */ (auth_method))) return { ok: false, code: 'invalid_client_metadata', message: `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}` };
      const clean = typeof name === 'string' ? [...name].filter((ch) => ch >= ' ' && ch !== '\u007f').join('').trim().slice(0, 100) : '';
      prune();
      if (data.clients.length >= MAX_CLIENTS) {
        const live = new Set(data.tokens.map((x) => x.client));
        const drop = data.clients.findIndex((c) => !live.has(c.id));
        if (drop < 0) return { ok: false, code: 'temporarily_unavailable', message: 'too many registered clients; revoke unused AI connections first' };
        data.clients.splice(drop, 1);
      }
      const secret = auth_method === 'none' ? null : SECRET_PREFIX + newToken();
      const rec = { id: CLIENT_PREFIX + crypto.randomBytes(16).toString('base64url'), secret_hash: secret ? hashToken(secret) : null, name: clean || 'MCP client', redirect_uris: [...new Set(/** @type {string[]} */ (redirect_uris))], auth_method: /** @type {string} */ (auth_method), created: now() };
      data.clients.push(rec);
      await save();
      return { ok: true, client: { id: rec.id, name: rec.name, redirect_uris: [...rec.redirect_uris], auth_method: rec.auth_method, created: rec.created }, secret };
    },

    /** A registered client (without its secret hash), or null. @param {unknown} id */
    client(id) {
      const c = typeof id === 'string' ? data.clients.find((x) => x.id === id) : undefined;
      return c ? { id: c.id, name: c.name, redirect_uris: [...c.redirect_uris], auth_method: c.auth_method, created: c.created } : null;
    },

    /**
     * Authenticate a client at the token or revocation endpoint: a public client sends only its id; a confidential one its secret too, by the method it registered.
     * @param {unknown} id @param {unknown} secret @param {'none' | 'client_secret_post' | 'client_secret_basic'} method how the secret came (none when it did not)
     */
    authenticate(id, secret, method) {
      const c = typeof id === 'string' ? data.clients.find((x) => x.id === id) : undefined;
      if (!c) return null;
      if (c.auth_method === 'none') return method === 'none' ? store.client(c.id) : null;
      if (method !== c.auth_method || typeof secret !== 'string' || !SECRET_SHAPE.test(secret) || !same(hashToken(secret), /** @type {string} */ (c.secret_hash))) return null;
      return store.client(c.id);
    },

    /**
     * A one-time code for an approved request. The plain code is returned once; only its hash is kept, in memory, for CODE_TTL_MS.
     * @param {{ client: string, redirect_uri: string, explicit: boolean, challenge: string, grant: string, resource: string, scope: string }} p
     */
    issueCode(p) {
      if (!CHALLENGE_RE.test(p.challenge)) throw new Error('bad code challenge');
      prune();
      const code = CODE_PREFIX + newToken();
      codes.set(hashToken(code), { ...p, expires: now() + CODE_TTL_MS });
      return code;
    },

    /**
     * Exchange a code: the client, the redirect URI and the PKCE verifier must match, and the code is spent whatever the result.
     * @param {{ code: unknown, client: string, redirect_uri: unknown, verifier: unknown }} p
     * @returns {{ ok: true, grant: string, resource: string, scope: string } | { ok: false, message: string }}
     */
    takeCode({ code, client, redirect_uri, verifier }) {
      if (typeof code !== 'string' || !CODE_RE.test(code)) return { ok: false, message: 'unknown code' };
      const h = hashToken(code);
      const c = codes.get(h);
      codes.delete(h);
      if (!c || c.expires <= now()) return { ok: false, message: 'the code is unknown, used or expired' };
      if (c.client !== client) return { ok: false, message: 'the code was issued to another client' };
      if (redirect_uri !== undefined || c.explicit) {
        if (redirect_uri !== c.redirect_uri) return { ok: false, message: 'redirect_uri does not match the authorization request' };
      }
      if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return { ok: false, message: 'code_verifier is missing or malformed' };
      if (!same(s256(verifier), c.challenge)) return { ok: false, message: 'code_verifier does not match the code challenge' };
      return { ok: true, grant: c.grant, resource: c.resource, scope: c.scope };
    },

    /** Issue the first access and refresh token of a grant. @param {string} client @param {string} grant */
    async issue(client, grant) {
      prune();
      const pair = issuePair(client, grant);
      await save();
      return pair;
    },

    /**
     * Rotate a refresh token: the old one is spent and a new pair is issued. `alive(grant)` says whether the AI connection still exists; when it does not, every
     * token of it is dropped.
     * @param {unknown} token @param {string} client @param {(grant: string) => Promise<boolean>} alive
     * @returns {Promise<{ ok: true, grant: string, pair: ReturnType<typeof issuePair> } | { ok: false, message: string }>}
     */
    async refresh(token, client, alive) {
      if (typeof token !== 'string' || !REFRESH_RE.test(token)) return { ok: false, message: 'unknown refresh token' };
      const h = hashToken(token);
      const at = data.tokens.findIndex((x) => x.kind === 'refresh' && same(x.hash, h));
      const rec = at < 0 ? null : data.tokens[at];
      if (!rec || rec.expires <= now()) return { ok: false, message: 'the refresh token is unknown, used or expired' };
      if (rec.client !== client) return { ok: false, message: 'the refresh token was issued to another client' };
      data.tokens.splice(at, 1);
      if (!(await alive(rec.grant))) {
        data.tokens = data.tokens.filter((x) => x.grant !== rec.grant);
        await save();
        return { ok: false, message: 'the AI connection was revoked' };
      }
      prune();
      const pair = issuePair(client, rec.grant);
      await save();
      return { ok: true, grant: rec.grant, pair };
    },

    /**
     * The grant an access token stands for, or null (unknown, expired or not an access token).
     * @param {unknown} token @returns {{ grant: string, client: string } | null}
     */
    resolveAccess(token) {
      if (!isAccessToken(token)) return null;
      const h = hashToken(/** @type {string} */ (token));
      const rec = data.tokens.find((x) => x.kind === 'access' && x.hash === h);
      if (!rec || rec.expires <= now()) return null;
      return { grant: rec.grant, client: rec.client };
    },

    /**
     * RFC 7009: revoke one token of this client. Revoking a refresh token ends the whole grant for this client (and the caller revokes the AI connection).
     * @param {unknown} token @param {string} client
     * @returns {Promise<{ revoked: 'none' | 'access' | 'refresh', grant?: string }>}
     */
    async revoke(token, client) {
      if (typeof token !== 'string') return { revoked: 'none' };
      const h = hashToken(token);
      const rec = data.tokens.find((x) => x.hash === h && x.client === client);
      if (!rec) return { revoked: 'none' };
      data.tokens = rec.kind === 'refresh' ? data.tokens.filter((x) => !(x.grant === rec.grant && x.client === client)) : data.tokens.filter((x) => x !== rec);
      await save();
      return { revoked: rec.kind, grant: rec.grant };
    },

    /** Drop every token that points at a grant (the AI connection was revoked). @param {string} grant */
    async forgetGrant(grant) {
      const before = data.tokens.length;
      data.tokens = data.tokens.filter((x) => x.grant !== grant);
      for (const [h, c] of codes) if (c.grant === grant) codes.delete(h);
      if (data.tokens.length !== before) await save();
    },

    flush() {
      return queue;
    },
  };
  return store;
}
