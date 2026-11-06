// The Plan tab's Synopsis view, pure part: the types, the counts as words, the hunk review of a proposal, and the request builders (M7 API). No React, no fetch.
import { diffLines } from '../editor/line-diff.js';
import { bookUrl } from '../structure/helpers.js';

/** The eight synopsis types, in the order the New synopsis form lists them. */
export const SYNOPSIS_TYPES = [
  { type: 'premise', label: 'Premise' },
  { type: 'logline', label: 'Logline' },
  { type: 'elevator-pitch', label: 'Elevator pitch' },
  { type: 'short', label: 'Short synopsis' },
  { type: 'one-page', label: 'One-page synopsis' },
  { type: 'long', label: 'Long synopsis' },
  { type: 'chapter-treatment', label: 'Chapter treatment' },
  { type: 'custom', label: 'Custom' },
];

/** The words for a type; an unknown type is shown as it is. @param {string} type */
export const typeLabel = (type) => SYNOPSIS_TYPES.find((t) => t.type === type)?.label ?? String(type ?? '');

/** The number of words in a text (runs of non-space characters). @param {string} text */
export const wordCount = (text) => String(text ?? '').match(/\S+/g)?.length ?? 0;

/** "412 of 500 words", or "412 words" (and "1 word") when there is no target. @param {number} words @param {number | null | undefined} target */
export function targetText(words, target) {
  if (typeof target === 'number' && target > 0) return `${words} of ${target} words`;
  return `${words} ${words === 1 ? 'word' : 'words'}`;
}

/**
 * @typedef {{ kind: 'same', lines: string[] } | { kind: 'hunk', id: string, before: string[], after: string[] }} Segment
 */

/**
 * Group the line diff of the current text and a proposal into hunks: a run of changed lines is one hunk (`before` = the current lines, `after` = the proposed lines), and the
 * equal lines between them are kept as context. The final-newline facts applyHunks needs travel with the array as a non-enumerable `trailing`.
 * @param {string} current @param {string} proposed
 * @returns {{ segments: Segment[] }}
 */
export function proposalHunks(current, proposed) {
  /** @type {Segment[]} */
  const segments = [];
  let open = /** @type {Extract<Segment, { kind: 'hunk' }> | null} */ (null);
  let n = 0;
  for (const row of diffLines(current, proposed)) {
    if (row.type === 'same') {
      open = null;
      const last = segments[segments.length - 1];
      if (last?.kind === 'same') last.lines.push(/** @type {string} */ (row.left));
      else segments.push({ kind: 'same', lines: [/** @type {string} */ (row.left)] });
      continue;
    }
    if (!open) {
      open = { kind: 'hunk', id: `h${(n += 1)}`, before: [], after: [] };
      segments.push(open);
    }
    if (row.left !== null) open.before.push(row.left);
    if (row.right !== null) open.after.push(row.right);
  }
  Object.defineProperty(segments, 'trailing', { value: { current: String(current).endsWith('\n'), proposed: String(proposed).endsWith('\n') }, enumerable: false });
  return { segments };
}

/**
 * The text after the author's choices: equal lines kept, and for each hunk its `after` lines when accepted, else its `before` lines. Lines are joined with "\n". Accepting every
 * hunk gives the proposal and accepting none gives the current text (for LF text). The final newline follows the proposal when every hunk is accepted, else the current text.
 * @param {Segment[]} segments from proposalHunks @param {Set<string>} accepted hunk ids
 */
export function applyHunks(segments, accepted) {
  const hunks = segments.filter((s) => s.kind === 'hunk');
  const trailing = /** @type {any} */ (segments).trailing ?? { current: false, proposed: false };
  const lines = [];
  for (const s of segments) {
    if (s.kind === 'same') lines.push(...s.lines);
    else lines.push(...(accepted.has(s.id) ? s.after : s.before));
  }
  const all = hunks.length > 0 && hunks.every((h) => accepted.has(/** @type {any} */ (h).id));
  const newline = all ? trailing.proposed : trailing.current;
  return lines.length === 0 ? '' : `${lines.join('\n')}${newline ? '\n' : ''}`;
}

// ---------------------------------------------------------------- requests

/** GET and POST /api/books/:b/synopses */
export const synopsesUrl = (bookId) => bookUrl(bookId, '/synopses');
/** GET and POST /api/books/:b/synopses/:slug, and with the tails /archive and /restore. */
export const synopsisUrl = (bookId, slug, tail = '') => bookUrl(bookId, `/synopses/${encodeURIComponent(slug)}${tail}`);
/** GET /api/books/:b/synopses/:slug/extract (offline; writes nothing) */
export const extractUrl = (bookId, slug) => synopsisUrl(bookId, slug, '/extract');

/** A target typed in a form as the number to send: a whole number of 1 or more, else null. @param {string | number | null | undefined} text */
export function targetValue(text) {
  const s = String(text ?? '').trim();
  return /^\d+$/.test(s) && Number(s) >= 1 ? Number(s) : null;
}

/** The request that starts a synopsis; an empty name, a missing target and an empty body are left out. @param {string} bookId @param {{ type: string, name?: string, target_words?: number | null, body?: string, dryRun?: boolean }} v */
export function createSynopsisRequest(bookId, { type, name, target_words, body, dryRun }) {
  const label = String(name ?? '').trim();
  return {
    url: synopsesUrl(bookId),
    body: {
      type,
      ...(label !== '' ? { name: label } : {}),
      ...(typeof target_words === 'number' ? { target_words } : {}),
      ...(typeof body === 'string' && body !== '' ? { body } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    },
  };
}

/**
 * The body that changes a synopsis: the given parts plus the sha256 last read. `target_words` and `basis` may be null (clear them).
 * @param {{ sha256: string }} item @param {{ name?: string, target_words?: number | null, body?: string, basis?: string | null, dryRun?: boolean }} patch
 */
export function updateSynopsisBody(item, { name, target_words, body, basis, dryRun } = {}) {
  return {
    ...(name !== undefined ? { name: String(name).trim() } : {}),
    ...(target_words !== undefined ? { target_words } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(basis !== undefined ? { basis } : {}),
    base_sha256: item.sha256,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

/** The request that archives a synopsis. @param {string} bookId @param {string} slug @param {{ dryRun?: boolean }} [opts] */
export const archiveSynopsisRequest = (bookId, slug, { dryRun } = {}) => ({ url: synopsisUrl(bookId, slug, '/archive'), body: dryRun ? { dryRun: true } : {} });
/** The request that restores an archived synopsis. @param {string} bookId @param {string} slug @param {{ dryRun?: boolean }} [opts] */
export const restoreSynopsisRequest = (bookId, slug, { dryRun } = {}) => ({ url: synopsisUrl(bookId, slug, '/restore'), body: dryRun ? { dryRun: true } : {} });

/** True when a refused write means the file changed since it was read (409, `conflict` / `CONFLICT`). */
export const isSynopsisConflict = (status, json) => status === 409 && (json?.error === 'conflict' || json?.code === 'CONFLICT');

/** "3 scenes have no summary" (null when none were skipped). @param {number | null | undefined} skipped */
export const skippedText = (skipped) => (typeof skipped === 'number' && skipped > 0 ? `${skipped} ${skipped === 1 ? 'scene has' : 'scenes have'} no summary` : null);

/** The sentence the Ask AI box starts with. @param {string} type @param {number | null | undefined} target */
export const defaultInstruction = (type, target) =>
  `Rewrite this ${typeLabel(type).toLowerCase()} so it reads well. Keep every plot fact.${typeof target === 'number' && target > 0 ? ` Aim for about ${target} words.` : ''}`;
