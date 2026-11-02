// In-process, per-root serialisation of every mutating store call (and recovery), so a recovery
// pass in this process can never observe another operation's journal entry mid-flight.
import path from 'node:path';

/** @type {Map<string, Promise<unknown>>} */
const tails = new Map();

/**
 * @template T
 * @param {string} root
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withRootLock(root, fn) {
  const key = path.resolve(root);
  const prev = tails.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return next;
}
