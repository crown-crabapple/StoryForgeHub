// Failed-login limits (contract M07-J03 section 2): at most `max` failures per key in a sliding window. In memory only; bounded in size.

/**
 * @param {{ max: number, windowMs: number, now?: () => number, maxKeys?: number }} opts
 */
export function createLimiter({ max, windowMs, now = Date.now, maxKeys = 10_000 }) {
  /** @type {Map<string, number[]>} key -> failure times, oldest first */
  const hits = new Map();

  /** @param {string} key @param {number} t */
  function recent(key, t) {
    const list = hits.get(key);
    if (!list) return [];
    while (list.length > 0 && t - list[0] >= windowMs) list.shift();
    if (list.length === 0) hits.delete(key);
    return list;
  }

  return {
    /** @param {string} key @returns {boolean} another attempt is refused right now */
    blocked(key) {
      return recent(key, now()).length >= max;
    },
    /** Record one failure. @param {string} key */
    fail(key) {
      const t = now();
      const list = recent(key, t);
      if (list.length === 0) {
        if (hits.size >= maxKeys) hits.delete(/** @type {string} */ (hits.keys().next().value)); // forget the oldest key
        hits.set(key, list);
      }
      list.push(t);
    },
    /** A success clears the key. @param {string} key */
    clear(key) {
      hits.delete(key);
    },
  };
}
