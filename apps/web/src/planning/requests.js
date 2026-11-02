// The write requests the Board, Outline, Threads and Matrix send, and how a refusal is put into words. Pure: nothing is sent here.
// A request is { method: 'POST', url, body }; callers send it with `dryRun: true` first when a preview is wanted, then for real.
import { explainFailure } from '../structure/helpers.js';
import { explainCodexFailure } from '../codex/requests.js';

const enc = encodeURIComponent;
const base = (bookId) => `/api/books/${enc(bookId)}`;

/** @param {string} bookId @param {string} sceneId @param {{ title?: string, summary?: string, status?: string, pov?: string }} patch only what changed */
export const sceneFieldsRequest = (bookId, sceneId, patch) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/scenes/${enc(sceneId)}/fields`, body: patch });

/**
 * A new card: a scene with status outline, after `after` (a scene id; null = the start of the chapter).
 * @param {string} bookId @param {{ chapter: number, act: number, after: string | null, title: string, slug: string, summary?: string }} c
 */
export const newCardRequest = (bookId, { chapter, act, after, title, slug, summary = '' }) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/scenes`,
  body: { chapter, act, after, title, slug, body: '', status: 'outline', ...(summary.trim() !== '' ? { summary: summary.trim() } : {}) },
});

/** @param {string} bookId @param {{ title: string, slug?: string, kind: string, status?: string }} t */
export const newThreadRequest = (bookId, { title, slug, kind, status = 'planned' }) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/threads`,
  body: { title, ...(slug ? { slug } : {}), kind, status },
});

/** The thread's state: one front-matter line. @param {string} bookId @param {{ id: string, sha256: string | null }} thread @param {string} status */
export const threadStateRequest = (bookId, thread, status) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/threads/${enc(thread.id)}/fields`,
  body: { status, ...(thread.sha256 ? { base_sha256: thread.sha256 } : {}) },
});

/**
 * Add a scene to (or remove it from) one of the thread's lists. `list`: 'setup' | 'develop' | 'payoff'. The server changes the file's own list, so
 * an item written by hand that nothing resolves is kept.
 * @param {string} bookId @param {{ id: string, sha256: string | null }} thread @param {string} list @param {string} sceneId @param {boolean} present true = add
 */
export const threadListRequest = (bookId, thread, list, sceneId, present) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/threads/${enc(thread.id)}/fields`,
  body: { [present ? 'add' : 'remove']: { [list]: [sceneId] }, ...(thread.sha256 ? { base_sha256: thread.sha256 } : {}) },
});

/** The thread's characters (codex slugs), replaced as a whole. @param {string} bookId @param {{ id: string, sha256: string | null }} thread @param {string[]} characters */
export const threadCharactersRequest = (bookId, thread, characters) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/threads/${enc(thread.id)}/fields`,
  body: { characters, ...(thread.sha256 ? { base_sha256: thread.sha256 } : {}) },
});

/** GET <this> is the thread with its `body` and `sha256`; PUT <this>/body saves the text. @param {string} bookId @param {string} threadId */
export const threadUrl = (bookId, threadId) => `${base(bookId)}/threads/${enc(threadId)}`;

/** The refusal of a thread write, in words the author can act on. @param {number} status @param {any} json */
export function explainPlanningFailure(status, json) {
  switch (json?.code) {
    case 'SLUG_TAKEN':
      return 'That slug is already used by another entry, thread or event. Choose a different one.';
    case 'REFUSED_UNKNOWN_THREAD':
      return 'That thread is not there any more. Reload the page.';
    case 'REFUSED_UNKNOWN_SCENE':
      return 'That scene is not in the book any more. Reload the page.';
    default:
      break;
  }
  if (typeof json?.code === 'string' && (json.code.startsWith('REFUSED_UNSIMPLE') || json.code === 'ROLLED_BACK' || status === 409)) return explainCodexFailure(status, json);
  return explainFailure(status, json);
}
