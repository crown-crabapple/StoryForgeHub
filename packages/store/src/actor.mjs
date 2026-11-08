// Who is behind a write (M12, AI Activity). The server runs a plugin or AI-connection request inside `runAsActor({ kind, id, name }, ...)`; every batch that
// request makes then records the actor in its journal entry. Nothing else reads it and it never decides what is allowed. Without an actor (the app's own
// writes, a watcher, recovery) the entry has no `actor` key at all, so the journal format stays as it was.
import { AsyncLocalStorage } from 'node:async_hooks';

/** @typedef {{ kind: string, id: string, name: string }} JournalActor */

const store = new AsyncLocalStorage();

/** Run `fn` with `actor` recorded on every store batch it makes. @template T @param {JournalActor | null} actor @param {() => T} fn @returns {T} */
export function runAsActor(actor, fn) {
  return store.run({ actor }, fn);
}

/** The actor of the running request, or null. @returns {JournalActor | null} */
export function currentActor() {
  return store.getStore()?.actor ?? null;
}
