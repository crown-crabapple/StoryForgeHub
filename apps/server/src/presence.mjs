// Advisory presence (contract M07-J03 section 7): who has which scene open. In memory only, never written to the library, refreshed by a heartbeat
// (the editor sends one every 20 s) and gone 60 s after the last one. It is only ever shown: nothing here can block or delay a save.

/** The editor's heartbeat interval and how long a heartbeat counts. */
export const HEARTBEAT_MS = 20_000;
export const EXPIRE_MS = 60_000;
/** The most entries kept at once (a guard on memory, far above any real team). */
const MAX_ENTRIES = 2000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** @param {{ now?: () => number }} [opts] `now` is the clock (tests pass a fake one) */
export function createPresence({ now = Date.now } = {}) {
  /** @type {Map<string, { book: string, scene: string, user: string, name: string, at: number }>} */
  const seen = new Map();

  function sweep() {
    const t = now();
    for (const [k, v] of seen) if (t - v.at >= EXPIRE_MS) seen.delete(k);
  }

  return {
    /**
     * A heartbeat: `user` (id and display name) has `scene` of `book` open. `scene: null` says they closed it. Returns false when the ids are not well formed.
     * @param {string} book @param {string | null} scene @param {{ id: string, name: string }} user
     */
    beat(book, scene, user) {
      if (!ID_RE.test(book) || !ID_RE.test(user.id)) return false;
      if (scene === null) {
        for (const [k, v] of seen) if (v.book === book && v.user === user.id) seen.delete(k);
        return true;
      }
      if (typeof scene !== 'string' || !ID_RE.test(scene)) return false;
      sweep();
      const key = `${book}|${scene}|${user.id}`;
      if (!seen.has(key) && seen.size >= MAX_ENTRIES) return false;
      seen.set(key, { book, scene, user: user.id, name: String(user.name).slice(0, 80), at: now() });
      return true;
    },

    /** Who has `scene` open now (a heartbeat in the last 60 s), by name. @param {string} book @param {string} scene @param {string} [except] a user id to leave out */
    who(book, scene, except) {
      sweep();
      const out = [];
      for (const v of seen.values()) if (v.book === book && v.scene === scene && v.user !== except) out.push({ id: v.user, name: v.name, since: new Date(v.at).toISOString() });
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
    },

    /** How many heartbeats are held (after dropping the expired ones). */
    size() {
      sweep();
      return seen.size;
    },
  };
}
