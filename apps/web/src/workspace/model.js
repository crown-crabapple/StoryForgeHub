// What the AI Workspace tab (M12 W8) reads and sends, worked out from the API answers. Pure: no DOM, no fetch.
//   GET  /api/books/:b/workspace/docs[?path=]  -> { docs, archived } (rows: { path, title, workspace, chapter, locked, sha256, updated_at }) | one doc { ...row, body }
//   POST /api/books/:b/workspace/docs          { path, title?, body, base_sha256? }   (409 LOCKED | CONFLICT)
//   POST /api/books/:b/workspace/docs/lock     { path | prefix, locked }   POST .../archive { path }   POST /api/books/:b/workspace/setup {}
//   GET  /api/books/:b/ledger | cast?chapter= | knowledge?character=&at= | state-events?chapter= | tasks?for=ai | continuity
import { codexHref, sceneHref } from '../codex/model.js';
import { viewHref } from '../planning/model.js';
import { timelineHref } from '../timeline/model.js';

const enc = encodeURIComponent;
const api = (/** @type {string} */ bookId) => `/api/books/${enc(bookId)}`;

/** The sections of the page, in order. */
export const SECTIONS = [
  { key: 'overview', label: 'Overview' },
  { key: 'docs', label: 'Docs' },
  { key: 'state', label: 'Chapter state' },
  { key: 'ledgers', label: 'Ledgers' },
  { key: 'tasks', label: 'AI tasks' },
  { key: 'suggestions', label: 'Suggestions' },
  { key: 'activity', label: 'AI Activity' },
];
/** The four state docs of a chapter, in the order they are shown. */
export const STATE_DOCS = ['situation', 'characters', 'knowledge', 'inventory'];
/** The label development docs carry wherever they are shown. */
export const DEVELOPMENT_LABEL = 'AI proposals — never canon';

/** @param {string} bookId @param {{ section?: string, doc?: string | null, chapter?: number | string | null }} [q] */
export function workspaceHref(bookId, { section = 'overview', doc = null, chapter = null } = {}) {
  const p = new URLSearchParams();
  if (section !== 'overview') p.set('section', section);
  if (doc) p.set('doc', doc);
  if (chapter !== null && chapter !== '') p.set('chapter', String(chapter));
  const qs = p.toString();
  return `/books/${enc(bookId)}/workspace${qs ? `?${qs}` : ''}`;
}
/** @param {string} search the query string @returns {{ section: string, doc: string | null, chapter: number | null }} */
export function parseWorkspaceSearch(search = '') {
  const p = new URLSearchParams(search);
  const section = p.get('section');
  const ch = p.get('chapter');
  return { section: SECTIONS.some((s) => s.key === section) ? /** @type {string} */ (section) : 'overview', doc: p.get('doc') || null, chapter: ch !== null && /^\d{1,6}$/.test(ch) ? Number(ch) : null };
}

export const docsUrl = (/** @type {string} */ bookId) => `${api(bookId)}/workspace/docs`;
export const docUrl = (/** @type {string} */ bookId, /** @type {string} */ addr) => `${docsUrl(bookId)}?path=${enc(addr)}`;
export const ledgerUrl = (/** @type {string} */ bookId) => `${api(bookId)}/ledger`;
export const castUrl = (/** @type {string} */ bookId, /** @type {number | null} */ chapter = null) => `${api(bookId)}/cast${chapter === null ? '' : `?chapter=${chapter}`}`;
export const knowledgeUrl = (/** @type {string} */ bookId, /** @type {string} */ character, /** @type {number | null} */ at = null) => `${api(bookId)}/knowledge?character=${enc(character)}${at === null ? '' : `&at=${at}`}`;
export const stateEventsUrl = (/** @type {string} */ bookId, /** @type {number | null} */ chapter = null) => `${api(bookId)}/state-events${chapter === null ? '' : `?chapter=${chapter}`}`;
export const aiTasksUrl = (/** @type {string} */ bookId) => `${api(bookId)}/tasks?for=ai`;
export const findingsUrl = (/** @type {string} */ bookId) => `${api(bookId)}/continuity`;
export const levelUrl = (/** @type {string} */ bookId) => `/api/preferences?book=${enc(bookId)}`;

/** @param {string} bookId @param {{ path: string, title?: string, body: string, base_sha256?: string | null }} doc */
export const saveDocRequest = (bookId, doc) => ({ method: /** @type {const} */ ('POST'), url: docsUrl(bookId), body: doc });
/** @param {string} bookId @param {{ path?: string, prefix?: string }} target @param {boolean} locked */
export const lockRequest = (bookId, target, locked) => ({ method: /** @type {const} */ ('POST'), url: `${docsUrl(bookId)}/lock`, body: { ...target, locked } });
/** @param {string} bookId @param {string} path */
export const archiveDocRequest = (bookId, path) => ({ method: /** @type {const} */ ('POST'), url: `${docsUrl(bookId)}/archive`, body: { path } });
/** @param {string} bookId */
export const setupRequest = (bookId) => ({ method: /** @type {const} */ ('POST'), url: `${api(bookId)}/workspace/setup`, body: {} });

/** Is the address a development doc (an AI proposal)? @param {string} addr */
export const isDevelopment = (addr) => addr.startsWith('development/');
/** state/chapter-NN/<name> @param {number} chapter @param {string} name */
export const stateAddress = (chapter, name) => `state/chapter-${String(chapter).padStart(2, '0')}/${name}`;
/** state/chapter-NN, what "Lock chapter state" locks. @param {number} chapter */
export const statePrefix = (chapter) => `state/chapter-${String(chapter).padStart(2, '0')}`;

/** The docs shown in the Docs list, split: workspace/* and development/*. @param {{ docs?: any[] } | null | undefined} list */
export function groupDocs(list) {
  const docs = list?.docs ?? [];
  return { workspace: docs.filter((d) => d.path.startsWith('workspace/')), development: docs.filter((d) => isDevelopment(d.path)) };
}
/** The starter docs the book does not have yet (the Set up workspace button shows while this is not empty). @param {{ docs?: any[] } | null | undefined} list */
export const missingStarters = (list) => ['workspace/book', 'workspace/style'].filter((a) => !(list?.docs ?? []).some((d) => d.path === a));

/** The chapter numbers that have scenes or state docs, ascending. @param {any[] | null | undefined} cast the /cast answer @param {{ docs?: any[] } | null | undefined} list */
export function chapterNumbers(cast, list) {
  const set = new Set();
  for (const s of cast ?? []) if (Number.isInteger(s.chapter)) set.add(s.chapter);
  for (const d of list?.docs ?? []) if (d.workspace === 'state' && Number.isInteger(d.chapter)) set.add(d.chapter);
  return [...set].sort((a, b) => a - b);
}

/** The ids of threads a TH2 (promise overdue) finding names. @param {{ findings?: any[] } | null | undefined} result @returns {Set<string>} */
export function overdueThreadIds(result) {
  const ids = new Set();
  for (const f of result?.findings ?? []) if (f.rule === 'TH2') for (const s of f.sources ?? []) if (s.kind === 'thread' && s.id) ids.add(s.id);
  return ids;
}

/** "2, 5" or "none" from chapter numbers. @param {number[] | undefined} chapters */
export const chaptersText = (chapters) => (chapters && chapters.length > 0 ? chapters.join(', ') : 'none');

/** Where a thread is edited: the Threads view of the Plan page. @param {string} bookId @param {string} id */
export const threadHref = (bookId, id) => viewHref(bookId, 'threads', { thread: id });
/** A codex entry. @param {string} bookId @param {string} id */
export const entryHref = (bookId, id) => codexHref(bookId, { entry: id });

/** The refusal of a workspace write, in words the author can act on. @param {number} status @param {any} json */
export function explainWorkspaceFailure(status, json) {
  if (json?.code === 'LOCKED') return 'This doc is locked. Unlock it first to change it.';
  if (json?.code === 'CONFLICT') return 'The doc changed since you opened it; nothing was written. Reload it and try again.';
  if (status === 0) return 'The server could not be reached.';
  if (status === 403) return 'The server refused the request.';
  if (status === 404) return 'That doc is not there any more. Reload the page.';
  return json?.message ?? `The change was not made (${json?.code ?? status}).`;
}

/** What kind of thing a suggestion targets, in words. @type {Record<string, string>} */
export const TARGET_KIND_LABEL = { scene: 'Scene', entry: 'Codex entry', thread: 'Thread', event: 'Event' };

/** Where the target of a suggestion is opened (null when it is gone or has no page). @param {string} bookId @param {{ target?: string, target_kind?: string | null, target_missing?: boolean }} s */
export function suggestionTargetHref(bookId, s) {
  if (!s.target || s.target_missing) return null;
  switch (s.target_kind) {
    case 'scene':
      return sceneHref(bookId, s.target);
    case 'entry':
      return entryHref(bookId, s.target);
    case 'thread':
      return threadHref(bookId, s.target);
    case 'event':
      return timelineHref(bookId, { event: s.target });
    default:
      return null;
  }
}

/** "3 suggestions waiting for you" / "1 suggestion waiting for you". @param {number} n */
export const waitingText = (n) => `${n} ${n === 1 ? 'suggestion' : 'suggestions'} waiting for you`;
