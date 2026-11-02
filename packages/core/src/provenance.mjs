// The provenance hook (M05-J04 contract section 4). Every AI send, apply and discard reports an event here.
// A no-op in this job: M05-J07 implements the recording. The only observer is the test seam __hooks.onProvenance.
import { __hooks } from './hooks.mjs';

/**
 * @typedef {{ kind: 'ai.proposal' | 'ai.apply' | 'ai.discard' | 'ai.chat', bookId: string, sceneId?: string, contextSha256: string,
 *   provider: { name: string, model: string, locality: 'local' | 'cloud' }, settings: { temperature: number | null, maxTokens: number | null },
 *   before?: string, after?: string, range?: { from: number, to: number } }} ProvenanceEvent
 */

/** @param {ProvenanceEvent} event */
export function recordProvenance(event) {
  __hooks.onProvenance?.(event);
}
