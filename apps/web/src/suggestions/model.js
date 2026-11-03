// Pure projections for the Suggestions UI (M05-J06): labels, grouping, the word-level view of a hunk, and the requests. No network here.
import { wordDiff } from '../ai/diff.js';

const enc = encodeURIComponent;

export const SOURCE_LABEL = { ai: 'AI', 'claude-book': 'Claude-Book', author: 'Author', reviewer: 'Reviewer', plugin: 'Plugin' };
export const STATUS_LABEL = { pending: 'Pending', accepted: 'Accepted', declined: 'Declined', partial: 'Partly decided' };

/** @param {string} source */
export const sourceLabelOf = (source) => SOURCE_LABEL[source] ?? source;

/** "Provider · model · Local" for the `ai` block of an AI suggestion (null when there is none). @param {{ provider?: string, model?: string, locality?: string } | null | undefined} ai */
export function providerLine(ai) {
  if (!ai) return null;
  const where = ai.locality === 'local' ? 'Local' : ai.locality === 'cloud' ? 'Cloud' : null;
  return [ai.provider, ai.model, where].filter(Boolean).join(' · ') || null;
}

/** Pending (a hunk still waits) and decided suggestions of a list. @param {{ pending: number }[]} list */
export function splitSuggestions(list) {
  return { open: list.filter((s) => s.pending > 0), decided: list.filter((s) => s.pending === 0) };
}

/** Suggestions grouped by the file they would change, in first-seen order. @param {any[]} list @returns {{ key: string, title: string, items: any[] }[]} */
export function groupByTarget(list) {
  const groups = new Map();
  for (const s of list) {
    const key = s.target || s.target_path || s.id;
    if (!groups.has(key)) groups.set(key, { key, title: s.target_title ?? (s.target_path || 'New file'), items: [] });
    groups.get(key).items.push(s);
  }
  return [...groups.values()];
}

/** "2 accepted, 1 declined" for a decided suggestion (what happened to each hunk). @param {{ hunks: { status: string }[] }} s */
export function outcomeText(s) {
  const n = (status) => s.hunks.filter((h) => h.status === status).length;
  const parts = [];
  if (n('accepted')) parts.push(`${n('accepted')} accepted`);
  if (n('declined')) parts.push(`${n('declined')} declined`);
  if (n('pending')) parts.push(`${n('pending')} pending`);
  return parts.join(', ');
}

/** "Line 17" / "Lines 17-19" / "Before line 3" (a pure insertion into an empty file is "New text"). @param {{ line: number, lines: number }} h */
export function lineRange(h) {
  if (h.lines === 0) return 'New text';
  return h.lines === 1 ? `Line ${h.line}` : `Lines ${h.line}–${h.line + h.lines - 1}`;
}

/**
 * The two columns of a hunk with the words that differ marked: `before` = the original with removed words (`del`), `after` = the proposal with added words (`add`).
 * @param {{ originalLines: string[], newLines: string[] }} h
 * @returns {{ before: { type: 'same' | 'del', text: string }[], after: { type: 'same' | 'add', text: string }[] }}
 */
export function hunkSides(h) {
  const parts = wordDiff(h.originalLines.join('\n'), h.newLines.join('\n'));
  return {
    before: /** @type {any} */ (parts.filter((p) => p.type !== 'add')),
    after: /** @type {any} */ (parts.filter((p) => p.type !== 'del')),
  };
}

// ------------------------------------------------------------------ requests

/** GET: suggestions of a book, optionally for one target id and/or 'open' | 'decided'. @param {string} bookId @param {{ target?: string, state?: 'open' | 'decided' }} [q] */
export function suggestionsUrl(bookId, { target, state } = {}) {
  const q = [target ? `target=${enc(target)}` : '', state ? `state=${state}` : ''].filter(Boolean).join('&');
  return `/api/books/${enc(bookId)}/suggestions${q ? `?${q}` : ''}`;
}

/** GET: one suggestion with the text of its hunks. @param {string} bookId @param {string} id */
export const suggestionUrl = (bookId, id) => `/api/books/${enc(bookId)}/suggestions/${enc(id)}`;

/** POST: accept or decline one hunk, or (no `hunkId`) every pending hunk. @param {string} bookId @param {string} id @param {'accept' | 'decline'} decision @param {string} [hunkId] */
export const decideRequest = (bookId, id, decision, hunkId) => ({
  method: /** @type {const} */ ('POST'),
  url: `/api/books/${enc(bookId)}/suggestions/${enc(id)}${hunkId ? `/hunks/${enc(hunkId)}` : ''}`,
  body: { decision },
});

/** POST: the read-only report on one scene. @param {string} bookId @param {string} sceneId */
export const checkRequest = (bookId, sceneId) => ({ method: /** @type {const} */ ('POST'), url: `/api/books/${enc(bookId)}/check`, body: { sceneId } });

/** The refusal of a suggestion write, in words the author can act on. @param {number} status @param {any} json */
export function explainSuggestionFailure(status, json) {
  switch (json?.code ?? json?.error) {
    case 'SUGGESTION_STALE':
      return 'The lines this change was made for have changed or moved, so it was not applied. Nothing was written. Decline it, or ask for a new suggestion.';
    case 'ALREADY_DECIDED':
      return 'That part was already decided. Reload to see the current state.';
    case 'TARGET_MISSING':
      return 'The file this suggestion is for is no longer part of the book.';
    case 'ROLLED_BACK':
      return `${json?.message ?? 'The change would have broken the book'}; nothing was changed.`;
    case 'NO_CHANGE':
      return 'The proposal is the same as the text.';
    default:
      if (status === 0) return 'The server could not be reached.';
      if (status === 404) return 'That suggestion is not there any more. Reload the page.';
      return json?.message ?? `The change was not made (${json?.code ?? status}).`;
  }
}

/** Where a check finding opens: the scene (or other file) at its line. @param {string} bookId @param {{ file: string, line: number | null }} f @param {{ id: string, path: string }} scene */
export function checkOpenHref(bookId, f, scene) {
  if (f.file === scene.path) return `/books/${enc(bookId)}?scene=${enc(scene.id)}`;
  return `/books/${enc(bookId)}?file=${enc(f.file)}${f.line ? `&line=${f.line}` : ''}`;
}
