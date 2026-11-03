// The provenance hook (M05-J04 contract section 4) and, since M05-J07, the receipt writer behind it. Every AI send, apply and discard reports an event here;
// M05-J06 adds check.report and suggestion.create / suggestion.accept / suggestion.decline (shapes below). The test seam __hooks.onProvenance still sees every event.
// Receipts are written by the receipt engine (receipts.mjs): events that ride along with a file write (a suggestion decision, an AI apply, an Undo, a publish) are
// staged in that write's own store batch by the code that makes the change, and are only announced here (`notifyProvenance`).
import { __hooks } from './hooks.mjs';
import { createReceiptEngine } from './receipts.mjs';

/**
 * @typedef {{ kind: 'ai.proposal' | 'ai.apply' | 'ai.discard' | 'ai.chat', bookId: string, sceneId?: string, contextSha256: string,
 *   provider: { name: string, model: string, locality: 'local' | 'cloud' }, settings: { temperature: number | null, maxTokens: number | null },
 *   before?: string, after?: string, range?: { from: number, to: number },
 *   promptSha256?: string, fullPrompt?: string, files?: string[] }
 *   | { kind: 'check.report', bookId: string, sceneId: string, scene: string, at: string, summary: { total: number, errors: number, warnings: number, infos: number, diagnostics: number, continuity: number } }
 *   | { kind: 'suggestion.create', bookId: string, suggestionId: string, target: string, source: string, mode: string, path: string, hunkIds: string[], base_sha256: string, after_sha256: string, ai?: object }
 *   | { kind: 'suggestion.accept' | 'suggestion.decline', bookId: string, suggestionId: string, hunkIds: string[], target: string, before_sha256: string | null, after_sha256: string | null, diff: string }
 *   | { kind: 'ai.generation', bookId: string, chapter?: number, draft?: string, draft_sha256?: string, text?: string,
 *     asset?: { id: string, path: string, sha256: string }, provider?: { name: string, model: string, locality: 'local' | 'cloud' }, promptSha256?: string }
 *   | { kind: 'publish', bookId: string, sceneId: string, target: string, path: string, before_sha256: string, after_sha256: string, from_sha256?: string, from_body_sha256?: string }} ProvenanceEvent
 */

/** Receipt engines of the repositories open in this process, oldest first (see registerReceiptEngine). */
const engines = [];

/** @param {ReturnType<typeof import('./receipts.mjs').createReceiptEngine>} engine */
export function registerReceiptEngine(engine) {
  engines.push(engine);
  if (engines.length > 16) engines.shift();
  return () => {
    const i = engines.indexOf(engine);
    if (i >= 0) engines.splice(i, 1);
  };
}

/** Announce an event to the test seam only (its receipt, if any, was staged by the change itself). @param {ProvenanceEvent} event */
export function notifyProvenance(event) {
  __hooks.onProvenance?.(event);
}

/**
 * Report an event and write its receipt. `ctx.engine` + `ctx.bookRoot` say where; without them the newest open repository whose library has `event.bookId` is used.
 * Without any repository nothing is written (the seam still sees the event).
 * @param {ProvenanceEvent} event
 * @param {{ engine?: ReturnType<typeof import('./receipts.mjs').createReceiptEngine>, bookRoot?: string }} [ctx]
 */
export async function recordProvenance(event, ctx = {}) {
  __hooks.onProvenance?.(event);
  if (ctx.engine) return ctx.engine.record(event, ctx.bookRoot ? { bookRoot: ctx.bookRoot } : {});
  if (ctx.bookRoot) {
    const engine = engines.at(-1) ?? createReceiptEngine({ root: ctx.bookRoot });
    return engine.record(event, { bookRoot: ctx.bookRoot });
  }
  for (const engine of [...engines].reverse()) {
    const found = await engine.findBook(event.bookId).catch(() => null);
    if (found) return engine.record(event);
  }
  return null;
}

/** The adapter's callback (packages/claude-book `run(argv, { provenance })`): record an event for the book folder `bookRoot`, with no repository open. */
export function recordProvenanceAt(bookRoot, event) {
  return recordProvenance(event, { bookRoot });
}

/** The adapter's `publish --confirm` write: the scene and its receipts in one store batch. Same result shape as a store write. */
export function publishWithReceipt(bookRoot, args) {
  const engine = engines.at(-1) ?? createReceiptEngine({ root: bookRoot });
  return engine.publishWithReceipt(bookRoot, args);
}
