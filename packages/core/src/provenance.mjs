// The provenance hook (M05-J04 contract section 4). Every AI send, apply and discard reports an event here; M05-J06 adds check.report and
// suggestion.create / suggestion.accept / suggestion.decline (shapes below).
// A no-op in this job: M05-J07 implements the recording. The only observer is the test seam __hooks.onProvenance.
import { __hooks } from './hooks.mjs';

/**
 * @typedef {{ kind: 'ai.proposal' | 'ai.apply' | 'ai.discard' | 'ai.chat', bookId: string, sceneId?: string, contextSha256: string,
 *   provider: { name: string, model: string, locality: 'local' | 'cloud' }, settings: { temperature: number | null, maxTokens: number | null },
 *   before?: string, after?: string, range?: { from: number, to: number } }
 *   | { kind: 'check.report', bookId: string, sceneId: string, scene: string, at: string, summary: { total: number, errors: number, warnings: number, infos: number, diagnostics: number, continuity: number } }
 *   | { kind: 'suggestion.create', bookId: string, suggestionId: string, target: string, source: string, mode: string, path: string, hunkIds: string[], base_sha256: string, after_sha256: string, ai?: object }
 *   | { kind: 'suggestion.accept' | 'suggestion.decline', bookId: string, suggestionId: string, hunkIds: string[], target: string, before_sha256: string | null, after_sha256: string | null, diff: string }} ProvenanceEvent
 */

/** @param {ProvenanceEvent} event */
export function recordProvenance(event) {
  __hooks.onProvenance?.(event);
}
