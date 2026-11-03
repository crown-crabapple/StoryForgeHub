// The shared-mode identity store (contract M07-J03 sections 2-4): users, members and roles, sessions, invitations, read-only shares and the
// owner's one-time setup link. Everything lives in the shared-data folder (never inside a library), read and written through @storyforge/store.
// Every secret is stored only as sha256(token); passwords only as scrypt records. A file that does not have the expected shape stops shared mode
// (SharedDataError) instead of being reset.
import { readSharedJson, writeSharedJson } from '@storyforge/store';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.mjs';
import { createLimiter } from './ratelimit.mjs';
import { createSessionTable } from './sessions.mjs';
import { hashToken, isTokenShape, newId, newToken } from './tokens.mjs';

export const ROLES = Object.freeze(['owner', 'editor', 'reviewer', 'viewer']);
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const DAY = 24 * 60 * 60 * 1000;
export const INVITE_DEFAULT_MS = 7 * DAY;
export const INVITE_MAX_MS = 30 * DAY;
export const SHARE_MAX_MS = 90 * DAY;
export const SETUP_MS = 30 * 60 * 1000;
const SHARE_SCOPES = new Set(['read', 'export']);
const HEX64 = /^[0-9a-f]{64}$/;
const ID_RE = (p) => new RegExp(`^${p}_[0-9A-HJKMNP-TV-Z]{26}$`);
const USR = ID_RE('usr');
const INV = ID_RE('inv');
const SHR = ID_RE('shr');
const BOOK = /^book_[0-9A-HJKMNP-TV-Z]{26}$/;

export class SharedDataError extends Error {
  /** @param {string} file @param {string} message */
  constructor(file, message) {
    super(`${file}: ${message}`);
    this.code = 'SHARED_DATA_CORRUPT';
    this.file = file;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTime = (v) => Number.isInteger(v) && v >= 0;
const hasControl = (/** @type {string} */ v) => [...v].some((ch) => ch.charCodeAt(0) < 0x20);
const isName = (v) => typeof v === 'string' && v.trim() !== '' && v.length <= 80 && !hasControl(v);
/** A copy of a stored record without its token hash (what callers may see). @param {any} rec */
function withoutHash(rec) {
  const pub = { ...rec };
  delete pub.token_hash;
  return pub;
}

/** @param {string} file @param {any} v @param {(v: any) => boolean} ok @param {string} what */
function check(file, v, ok, what) {
  if (!ok(v)) throw new SharedDataError(file, `unexpected ${what}`);
}

/** The files, their empty value and their shape check. */
const FILES = {
  'users.json': {
    empty: () => ({ version: 1, users: [] }),
    check(f, v) {
      check(f, v, (x) => isObj(x) && x.version === 1 && Array.isArray(x.users), 'top level');
      const names = new Set();
      for (const u of v.users) {
        check(f, u, (x) => isObj(x) && USR.test(x.id) && USERNAME_RE.test(x.username) && isName(x.display_name) && isTime(x.created) && typeof x.disabled === 'boolean', 'user');
        check(f, u.pw, (x) => x === null || isObj(x), 'password record'); // null: not set yet (setup or invite pending)
        check(f, u.username, (x) => !names.has(x), 'duplicate username');
        names.add(u.username);
      }
    },
  },
  'members.json': {
    empty: () => ({ version: 1, members: [] }),
    check(f, v) {
      check(f, v, (x) => isObj(x) && x.version === 1 && Array.isArray(x.members), 'top level');
      const seen = new Set();
      for (const m of v.members) {
        check(f, m, (x) => isObj(x) && USR.test(x.user) && ROLES.includes(x.role) && !seen.has(x.user), 'member');
        seen.add(m.user);
      }
    },
  },
  'sessions.json': {
    empty: () => ({ version: 1, sessions: {} }),
    check(f, v) {
      check(f, v, (x) => isObj(x) && x.version === 1 && isObj(x.sessions), 'top level');
      for (const [h, s] of Object.entries(v.sessions)) {
        check(f, h, (x) => HEX64.test(x), 'session key');
        check(f, s, (x) => isObj(x) && USR.test(x.user) && isTime(x.created) && isTime(x.last_seen) && isTime(x.expires), 'session');
      }
    },
  },
  'invites.json': {
    empty: () => ({ version: 1, invites: [] }),
    check(f, v) {
      check(f, v, (x) => isObj(x) && x.version === 1 && Array.isArray(x.invites), 'top level');
      for (const i of v.invites) {
        check(f, i, (x) => isObj(x) && INV.test(x.id) && HEX64.test(x.token_hash) && ROLES.includes(x.role) && x.role !== 'owner' && isTime(x.created) && isTime(x.expires)
          && USR.test(x.by) && (x.used === null || USR.test(x.used)) && typeof x.revoked === 'boolean', 'invite');
      }
    },
  },
  'shares.json': {
    empty: () => ({ version: 1, shares: [] }),
    check(f, v) {
      check(f, v, (x) => isObj(x) && x.version === 1 && Array.isArray(x.shares), 'top level');
      for (const s of v.shares) {
        check(f, s, (x) => isObj(x) && SHR.test(x.id) && HEX64.test(x.token_hash) && BOOK.test(x.book) && Array.isArray(x.scope) && x.scope.length > 0
          && x.scope.every((/** @type {string} */ c) => SHARE_SCOPES.has(c)) && x.scope.includes('read') && isTime(x.created) && isTime(x.expires) && USR.test(x.by) && typeof x.revoked === 'boolean', 'share');
      }
    },
  },
  'setup.json': {
    empty: () => ({ version: 1, setup: null }),
    check(f, v) {
      check(f, v, (x) => isObj(x) && x.version === 1, 'top level');
      check(f, v.setup, (x) => x === null || (isObj(x) && USR.test(x.user) && HEX64.test(x.token_hash) && isTime(x.expires)), 'setup');
    },
  },
};

/**
 * @typedef {{ kind: 'user', id: string, username: string, display_name: string, role: string } | { kind: 'share', id: string, book: string, scope: string[] }} Principal
 */

/**
 * Open (load and check) the shared data in `dir`. Throws SharedDataError when a file is damaged.
 * @param {string} dir
 * @param {{ now?: () => number }} [opts]
 */
export async function openSharedData(dir, { now = Date.now } = {}) {
  /** @type {Record<string, any>} */
  const data = {};
  for (const [name, spec] of Object.entries(FILES)) {
    const r = await readSharedJson(dir, name);
    if (r.state === 'corrupt') throw new SharedDataError(name, r.message);
    data[name] = r.state === 'missing' ? spec.empty() : r.value;
    spec.check(name, data[name]);
  }
  const sessions = createSessionTable({ now, initial: data['sessions.json'].sessions });
  const byName = createLimiter({ max: 5, windowMs: 15 * 60 * 1000, now });
  const byAddress = createLimiter({ max: 20, windowMs: 15 * 60 * 1000, now });

  /** invite ids and user names being taken by an acceptInvite that is still hashing */
  const claiming = new Set();
  const claimedNames = new Set();

  // writes are serialised so two requests never interleave a read-modify-write of one file
  let queue = Promise.resolve();
  /** @param {string} name */
  function save(name) {
    if (name === 'sessions.json') data[name] = { version: 1, sessions: sessions.snapshot() };
    const value = structuredClone(data[name]);
    const p = queue.then(() => writeSharedJson(dir, name, value));
    queue = p.catch(() => {});
    return p;
  }

  const users = () => /** @type {any[]} */ (data['users.json'].users);
  const members = () => /** @type {any[]} */ (data['members.json'].members);
  const userById = (id) => users().find((u) => u.id === id) ?? null;
  const userByName = (name) => (typeof name === 'string' ? (users().find((u) => u.username === name.toLowerCase()) ?? null) : null);
  const roleOf = (id) => members().find((m) => m.user === id)?.role ?? null;
  const owners = () => members().filter((m) => m.role === 'owner' && !userById(m.user)?.disabled);

  /** @param {any} u @returns {Principal | null} */
  function principalOf(u) {
    const role = u && !u.disabled ? roleOf(u.id) : null;
    return role ? { kind: 'user', id: u.id, username: u.username, display_name: u.display_name, role } : null;
  }

  /** @param {string} username @param {string} display_name @returns {string | null} */
  function newUserProblem(username, display_name) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return 'user name must be 3-32 characters: a-z, 0-9, dot, underscore or hyphen, starting with a letter or digit';
    if (userByName(username)) return 'that user name is taken';
    if (!isName(display_name)) return 'display name must be 1-80 characters';
    return null;
  }

  /** @param {number | undefined} requested @param {number} dflt @param {number} max */
  const lifetime = (requested, dflt, max) => (requested === undefined ? dflt : Number.isInteger(requested) && requested > 0 && requested <= max ? requested : null);

  return {
    dir,
    ROLES,

    /** No owner exists yet (shared mode cannot be used until `shared init` ran and the owner finished setup). */
    get needsOwner() {
      return owners().filter((m) => userById(m.user)?.pw).length === 0;
    },

    // ---------- owner setup (shared init) ----------

    /**
     * Create the owner account (no password yet) and a one-time setup token, valid 30 minutes. Refused when an owner already exists.
     * @param {string} username @param {string} [display_name]
     * @returns {Promise<{ ok: true, token: string, expires: number } | { ok: false, code: string, message: string }>}
     */
    async initOwner(username, display_name = username) {
      if (owners().length > 0) return { ok: false, code: 'EXISTS', message: 'this shared data already has an owner' };
      const problem = newUserProblem(username, display_name);
      if (problem) return { ok: false, code: 'BAD_ARGS', message: problem };
      const user = { id: newId('usr'), username, display_name, pw: null, created: now(), disabled: false };
      users().push(user);
      members().push({ user: user.id, role: 'owner' });
      const token = newToken();
      data['setup.json'].setup = { user: user.id, token_hash: hashToken(token), expires: now() + SETUP_MS };
      await save('users.json');
      await save('members.json');
      await save('setup.json');
      return { ok: true, token, expires: data['setup.json'].setup.expires };
    },

    /**
     * Finish owner setup: set the password with the setup token (single use).
     * @param {unknown} token @param {unknown} password
     * @returns {Promise<{ ok: true, user: Principal } | { ok: false, code: string, message: string }>}
     */
    async completeSetup(token, password) {
      const s = data['setup.json'].setup;
      if (!s || !isTokenShape(token) || hashToken(/** @type {string} */ (token)) !== s.token_hash || now() >= s.expires) return { ok: false, code: 'GONE', message: 'this setup link is not valid any more' };
      const u = userById(s.user);
      if (!u) return { ok: false, code: 'GONE', message: 'this setup link is not valid any more' };
      const problem = passwordProblem(password, u.username);
      if (problem) return { ok: false, code: 'BAD_ARGS', message: problem };
      data['setup.json'].setup = null; // claimed before the slow hash, so a second request with the same link fails
      u.pw = await hashPassword(/** @type {string} */ (password));
      await save('users.json');
      await save('setup.json');
      return { ok: true, user: /** @type {Principal} */ (principalOf(u)) };
    },

    // ---------- login sessions ----------

    /**
     * @param {unknown} username @param {unknown} password @param {string} address the remote address
     * @returns {Promise<{ ok: true, token: string, user: Principal } | { ok: false, code: 'BAD_LOGIN' | 'RATE_LIMITED' }>}
     */
    async login(username, password, address) {
      const nameKey = typeof username === 'string' ? username.toLowerCase().slice(0, 64) : '';
      if (byName.blocked(nameKey) || byAddress.blocked(address)) return { ok: false, code: 'RATE_LIMITED' };
      const u = userByName(nameKey);
      const good = await verifyPassword(password, u?.pw ?? null); // always runs scrypt once, known user or not
      const who = good ? principalOf(u) : null;
      if (!who) {
        byName.fail(nameKey);
        byAddress.fail(address);
        return { ok: false, code: 'BAD_LOGIN' };
      }
      byName.clear(nameKey);
      const { token } = sessions.create(who.id);
      await save('sessions.json');
      return { ok: true, token, user: who };
    },

    /**
     * Who a session cookie belongs to, or null (unknown, expired, user disabled or no longer a member).
     * @param {unknown} token @returns {Promise<Principal | null>}
     */
    async resolveSession(token) {
      const r = sessions.resolve(token);
      if (r.touched) await save('sessions.json');
      if (!r.user) return null;
      return principalOf(userById(r.user));
    },

    /** @param {unknown} token */
    async logout(token) {
      if (sessions.revoke(token)) await save('sessions.json');
    },

    /**
     * Change a password (the user's own, with the current one). Ends every session of that user; the caller logs them in again.
     * @param {string} userId @param {unknown} current @param {unknown} next
     * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
     */
    async changePassword(userId, current, next) {
      const u = userById(userId);
      if (!u || !(await verifyPassword(current, u.pw))) return { ok: false, code: 'BAD_LOGIN', message: 'the current password is wrong' };
      const problem = passwordProblem(next, u.username);
      if (problem) return { ok: false, code: 'BAD_ARGS', message: problem };
      u.pw = await hashPassword(/** @type {string} */ (next));
      sessions.revokeUser(u.id);
      await save('users.json');
      await save('sessions.json');
      return { ok: true };
    },

    // ---------- members and roles (owner only; the caller checks the role) ----------

    listMembers() {
      return members().map((m) => {
        const u = userById(m.user);
        return { user: m.user, username: u?.username ?? null, display_name: u?.display_name ?? null, role: m.role, disabled: u?.disabled ?? true };
      });
    },

    /**
     * @param {string} userId @param {unknown} role
     * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string }>}
     */
    async setRole(userId, role) {
      const m = members().find((x) => x.user === userId);
      if (!m) return { ok: false, code: 'NOT_FOUND', message: 'no such member' };
      if (typeof role !== 'string' || !ROLES.includes(role)) return { ok: false, code: 'BAD_ARGS', message: `role must be one of ${ROLES.join(', ')}` };
      if (m.role === 'owner' && role !== 'owner' && owners().length <= 1) return { ok: false, code: 'LAST_OWNER', message: 'the last owner cannot be demoted' };
      m.role = role;
      await save('members.json');
      return { ok: true };
    },

    /** Remove a member: the account is disabled and every session ends. @param {string} userId */
    async removeMember(userId) {
      const i = members().findIndex((x) => x.user === userId);
      if (i < 0) return { ok: false, code: 'NOT_FOUND', message: 'no such member' };
      if (members()[i].role === 'owner' && owners().length <= 1) return { ok: false, code: 'LAST_OWNER', message: 'the last owner cannot be removed' };
      members().splice(i, 1);
      const u = userById(userId);
      if (u) u.disabled = true;
      sessions.revokeUser(userId);
      await save('members.json');
      await save('users.json');
      await save('sessions.json');
      return { ok: true };
    },

    // ---------- invitations ----------

    /**
     * @param {{ role: unknown, expiresMs?: number, by: string }} p
     * @returns {Promise<{ ok: true, token: string, invite: any } | { ok: false, code: string, message: string }>}
     */
    async createInvite({ role, expiresMs, by }) {
      if (typeof role !== 'string' || !ROLES.includes(role) || role === 'owner') return { ok: false, code: 'BAD_ARGS', message: 'role must be editor, reviewer or viewer' };
      const life = lifetime(expiresMs, INVITE_DEFAULT_MS, INVITE_MAX_MS);
      if (life === null) return { ok: false, code: 'BAD_ARGS', message: 'an invite lasts at most 30 days' };
      const token = newToken();
      const invite = { id: newId('inv'), token_hash: hashToken(token), role, created: now(), expires: now() + life, by, used: null, revoked: false };
      data['invites.json'].invites.push(invite);
      await save('invites.json');
      return { ok: true, token, invite: withoutHash(invite) };
    },

    listInvites() {
      return data['invites.json'].invites.map((i) => ({ ...withoutHash(i), live: !i.revoked && !i.used && now() < i.expires }));
    },

    /** @param {string} id */
    async revokeInvite(id) {
      const i = data['invites.json'].invites.find((x) => x.id === id);
      if (!i) return { ok: false, code: 'NOT_FOUND', message: 'no such invite' };
      i.revoked = true;
      await save('invites.json');
      return { ok: true };
    },

    /**
     * What a still-usable invite token grants (for the accept page), or null.
     * @param {unknown} token
     */
    peekInvite(token) {
      if (!isTokenShape(token)) return null;
      const h = hashToken(/** @type {string} */ (token));
      const i = data['invites.json'].invites.find((x) => x.token_hash === h);
      return i && !i.revoked && !i.used && now() < i.expires ? { role: i.role, expires: i.expires } : null;
    },

    /**
     * Accept an invite: create the account and membership. Single use.
     * @param {unknown} token @param {{ username: unknown, display_name: unknown, password: unknown }} p
     * @returns {Promise<{ ok: true, user: Principal } | { ok: false, code: string, message: string }>}
     */
    async acceptInvite(token, { username, display_name, password }) {
      const h = isTokenShape(token) ? hashToken(/** @type {string} */ (token)) : '';
      const inv = data['invites.json'].invites.find((x) => x.token_hash === h);
      if (!inv || inv.revoked || inv.used || claiming.has(inv.id) || now() >= inv.expires) return { ok: false, code: 'GONE', message: 'this invite is not valid any more' };
      const name = typeof username === 'string' ? username.toLowerCase() : '';
      const shown = typeof display_name === 'string' && display_name.trim() !== '' ? display_name.trim() : name;
      const problem = newUserProblem(name, shown) ?? (claimedNames.has(name) ? 'that user name is taken' : null) ?? passwordProblem(password, name);
      if (problem) return { ok: false, code: 'BAD_ARGS', message: problem };
      // claim the invite and the name before the slow hash, so a second request cannot use either meanwhile
      claiming.add(inv.id);
      claimedNames.add(name);
      let pw;
      try {
        pw = await hashPassword(/** @type {string} */ (password));
      } finally {
        claiming.delete(inv.id);
        claimedNames.delete(name);
      }
      const user = { id: newId('usr'), username: name, display_name: shown, pw, created: now(), disabled: false };
      inv.used = user.id;
      users().push(user);
      members().push({ user: user.id, role: inv.role });
      await save('invites.json');
      await save('users.json');
      await save('members.json');
      return { ok: true, user: /** @type {Principal} */ (principalOf(user)) };
    },

    // ---------- read-only shares ----------

    /**
     * @param {{ book: unknown, scope: unknown, expiresMs: unknown, by: string }} p
     * @returns {Promise<{ ok: true, token: string, share: any } | { ok: false, code: string, message: string }>}
     */
    async createShare({ book, scope, expiresMs, by }) {
      if (typeof book !== 'string' || !BOOK.test(book)) return { ok: false, code: 'BAD_ARGS', message: 'book must be a book id' };
      const sc = Array.isArray(scope) ? [...new Set(scope)] : null;
      if (!sc || !sc.includes('read') || !sc.every((c) => SHARE_SCOPES.has(c))) return { ok: false, code: 'BAD_ARGS', message: 'scope must be ["read"] or ["read","export"]' };
      if (!(Number.isInteger(expiresMs) && /** @type {number} */ (expiresMs) > 0 && /** @type {number} */ (expiresMs) <= SHARE_MAX_MS)) return { ok: false, code: 'BAD_ARGS', message: 'a share needs an expiry of at most 90 days' };
      const token = newToken();
      const share = { id: newId('shr'), token_hash: hashToken(token), book, scope: sc.sort(), created: now(), expires: now() + /** @type {number} */ (expiresMs), by, revoked: false };
      data['shares.json'].shares.push(share);
      await save('shares.json');
      return { ok: true, token, share: withoutHash(share) };
    },

    listShares() {
      return data['shares.json'].shares.map((x) => ({ ...withoutHash(x), live: !x.revoked && now() < x.expires }));
    },

    /** @param {string} id */
    async revokeShare(id) {
      const s = data['shares.json'].shares.find((x) => x.id === id);
      if (!s) return { ok: false, code: 'NOT_FOUND', message: 'no such share' };
      s.revoked = true;
      await save('shares.json');
      return { ok: true };
    },

    /** The share a share cookie names, if it is still live. @param {unknown} token @returns {Principal | null} */
    resolveShare(token) {
      if (!isTokenShape(token)) return null;
      const h = hashToken(/** @type {string} */ (token));
      const s = data['shares.json'].shares.find((x) => x.token_hash === h);
      if (!s || s.revoked || now() >= s.expires) return null;
      return { kind: 'share', id: s.id, book: s.book, scope: [...s.scope] };
    },

    /** Drop expired sessions (call now and then). */
    async prune() {
      if (sessions.prune() > 0) await save('sessions.json');
    },

    /** Resolves when every queued write has finished. */
    flush() {
      return queue;
    },
  };
}
