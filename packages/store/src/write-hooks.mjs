// Write notifications: the one choke point through which every project-file write the app makes is announced.
// Listeners (e.g. core's per-library validate cache) get the absolute root the write touched, after it completed (success or failure).
import path from 'node:path';

/** @type {Set<(root: string) => void>} */
const listeners = new Set();

/**
 * Be told after every completed write (a batch, a recover, a restored tree).
 * @param {(root: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onWrite(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @param {string} root absolute or relative path of the root the write touched */
export function notifyWrite(root) {
  const abs = path.resolve(root);
  for (const fn of [...listeners]) {
    try {
      fn(abs);
    } catch {
      // a listener must never break a write
    }
  }
}
