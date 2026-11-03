// Login sessions (contract M07-J03 section 2): the cookie carries a token; the table keeps only sha256(token). 14 days idle, 30 days absolute.
// Pure state: the caller persists `snapshot()` to sessions.json when `create`, `revoke*` or a `resolve` that touched last_seen say so.
import { hashToken, isTokenShape, newToken } from './tokens.mjs';

export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** last_seen is stored at most this often, so reads do not rewrite sessions.json on every request */
const TOUCH_EVERY_MS = 60 * 1000;

/**
 * @typedef {{ user: string, created: number, last_seen: number, expires: number }} SessionRecord  times in ms since the epoch
 */

/**
 * @param {{ now?: () => number, idleMs?: number, absoluteMs?: number, initial?: Record<string, SessionRecord> }} [opts]
 */
export function createSessionTable({ now = Date.now, idleMs = SESSION_IDLE_MS, absoluteMs = SESSION_ABSOLUTE_MS, initial = {} } = {}) {
  /** @type {Map<string, SessionRecord>} hash -> record */
  const table = new Map(Object.entries(initial));

  /** @param {SessionRecord} s @param {number} t */
  const expired = (s, t) => t >= s.expires || t - s.last_seen >= idleMs;

  return {
    /** @param {string} user @returns {{ token: string, record: SessionRecord }} */
    create(user) {
      const t = now();
      const token = newToken();
      const record = { user, created: t, last_seen: t, expires: t + absoluteMs };
      table.set(hashToken(token), record);
      return { token, record };
    },

    /**
     * The session a cookie token names, or null. A live session's last_seen moves forward (`touched` says whether that needs saving);
     * an expired one is dropped (`touched: true`).
     * @param {unknown} token
     * @returns {{ user: string, hash: string, touched: boolean } | { user: null, touched: boolean }}
     */
    resolve(token) {
      if (!isTokenShape(token)) return { user: null, touched: false };
      const hash = hashToken(/** @type {string} */ (token));
      const s = table.get(hash);
      if (!s) return { user: null, touched: false };
      const t = now();
      if (expired(s, t)) {
        table.delete(hash);
        return { user: null, touched: true };
      }
      const touched = t - s.last_seen >= TOUCH_EVERY_MS;
      if (touched) s.last_seen = t;
      return { user: s.user, hash, touched };
    },

    /** @param {unknown} token @returns {boolean} a session was removed */
    revoke(token) {
      return isTokenShape(token) && table.delete(hashToken(/** @type {string} */ (token)));
    },

    /** Remove every session of `user` (password change, disable, removal). @param {string} user @returns {number} how many */
    revokeUser(user) {
      let n = 0;
      for (const [h, s] of table) {
        if (s.user === user) {
          table.delete(h);
          n++;
        }
      }
      return n;
    },

    /** Drop expired sessions. @returns {number} how many */
    prune() {
      const t = now();
      let n = 0;
      for (const [h, s] of table) {
        if (expired(s, t)) {
          table.delete(h);
          n++;
        }
      }
      return n;
    },

    /** @returns {Record<string, SessionRecord>} a copy for sessions.json */
    snapshot() {
      return Object.fromEntries([...table].map(([h, s]) => [h, { ...s }]));
    },

    get size() {
      return table.size;
    },
  };
}
