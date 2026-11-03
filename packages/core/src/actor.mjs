// Who is making the change (M07-J03b, shared mode). The server runs each request inside `runAs(by, ...)`; the receipt, suggestion and comment writers read
// `currentBy()` to say who did it. In personal mode nothing sets it, `currentBy()` is null and no `by` is written. Never used to decide what is allowed:
// that is the server's route policy.
import { AsyncLocalStorage } from 'node:async_hooks';

/** @typedef {{ id?: string, name: string }} By */

const store = new AsyncLocalStorage();

/** Run `fn` with `by` as the actor of every change it makes. @template T @param {By | null} by @param {() => T} fn @returns {T} */
export function runAs(by, fn) {
  return store.run({ by }, fn);
}

/** The actor of the running request, or null (personal mode, a timer, a watcher). @returns {By | null} */
export function currentBy() {
  return store.getStore()?.by ?? null;
}
