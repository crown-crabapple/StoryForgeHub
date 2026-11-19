// EPUB validation in the Export dialog (contract M13-J04 section 5): the words, the grouping of messages, the links to scenes and the requests that start, poll, cancel and
// download a check. The helpers are pure or take `fetchImpl` (and `sleep`) so tests run them without a server or a clock.

const enc = encodeURIComponent;

/** Always shown under the outcome. */
export const LIMITS_SENTENCE = 'EPUBCheck checks the file against the EPUB standard. It does not check editing, full accessibility or whether a store will accept the book.';

/** How often a running check is asked about, in milliseconds. */
export const POLL_MS = 500;

/** The most messages listed on screen; the report holds all of them. */
export const MAX_SHOWN = 200;

/** The outcome in words. Only `passed` and `passed-with-warnings` are ever a pass. `tone` picks the colour class. */
const OUTCOMES = {
  passed: { word: 'Passed', tone: 'good', pass: true },
  'passed-with-warnings': { word: 'Passed with warnings', tone: 'warn', pass: true },
  failed: { word: 'Failed', tone: 'bad', pass: false },
  cancelled: { word: 'Not checked', tone: 'neutral', pass: false },
  'not-checked': { word: 'Not checked', tone: 'neutral', pass: false },
  unavailable: { word: 'Validator unavailable', tone: 'neutral', pass: false },
  error: { word: 'Check could not run', tone: 'bad', pass: false },
};

/**
 * What to show for a validation outcome. An outcome this app does not know is "Check could not run", never a pass.
 * @param {unknown} outcome @returns {{ word: string, tone: string, pass: boolean }}
 */
export const outcomeView = (outcome) => (typeof outcome === 'string' && Object.hasOwn(OUTCOMES, outcome) ? OUTCOMES[/** @type {keyof typeof OUTCOMES} */ (outcome)] : OUTCOMES.error);

const SEVERITIES = [
  { key: 'fatal', label: 'Fatal errors' },
  { key: 'error', label: 'Errors' },
  { key: 'warning', label: 'Warnings' },
  { key: 'info', label: 'Information' },
  { key: 'usage', label: 'Usage notes' },
];

/**
 * The messages grouped by severity, most serious first, at most `limit` listed in all. `hidden` counts the ones left off the screen.
 * @param {any[]} messages @param {number} [limit]
 * @returns {{ groups: { key: string, label: string, items: any[] }[], total: number, hidden: number }}
 */
export function groupMessages(messages, limit = MAX_SHOWN) {
  const list = Array.isArray(messages) ? messages : [];
  const known = new Set(SEVERITIES.map((s) => s.key));
  let room = limit;
  const groups = [];
  for (const s of [...SEVERITIES, { key: '', label: 'Other messages' }]) {
    const all = list.filter((m) => (s.key === '' ? !known.has(m?.severity) : m?.severity === s.key));
    const items = all.slice(0, Math.max(room, 0));
    room -= items.length;
    if (items.length > 0) groups.push({ key: s.key, label: s.label, items });
  }
  return { groups, total: list.length, hidden: list.length - groups.reduce((n, g) => n + g.items.length, 0) };
}

/** Where a message is, in words: "OEBPS/chapter-001.xhtml, line 12, column 4". Empty when EPUBCheck gave no location. @param {any} location */
export function locationText(location) {
  if (!location || typeof location.path !== 'string') return '';
  const parts = [location.path];
  if (Number.isInteger(location.line) && location.line >= 0) parts.push(`line ${location.line}`);
  if (Number.isInteger(location.column) && location.column >= 0) parts.push(`column ${location.column}`);
  return parts.join(', ');
}

/** The address of a scene in the manuscript. @param {string} bookId @param {string} sceneId */
export const sceneHref = (bookId, sceneId) => `/books/${enc(bookId)}?scene=${enc(sceneId)}`;

/**
 * The link for a message that was matched to the manuscript: its scene, else the chapter (its first scene). Null for a message in a file that is no chapter (the package file, the
 * navigation document, the stylesheet). A chapter that has no scene to open gives a label and no address.
 * @param {any} message @param {{ sources?: Record<string, { title?: string, chapterLabel?: string }>, chapters?: Record<string, { chapterLabel?: string, sceneId?: string | null }> }} found @param {string} bookId
 * @returns {{ href: string | null, label: string } | null}
 */
export function sourceLink(message, found, bookId) {
  const sources = found?.sources ?? {};
  const chapters = found?.chapters ?? {};
  if (typeof message?.sceneId === 'string') {
    const s = sources[message.sceneId];
    const label = s?.title ? `Open the scene "${s.title}"${s.chapterLabel ? ` (${s.chapterLabel})` : ''}` : 'Open the scene';
    return { href: sceneHref(bookId, message.sceneId), label };
  }
  if (typeof message?.chapterId === 'string') {
    const c = chapters[message.chapterId];
    const name = c?.chapterLabel ? ` ${c.chapterLabel}` : '';
    if (typeof c?.sceneId === 'string') return { href: sceneHref(bookId, c.sceneId), label: `Open chapter${name}` };
    return { href: null, label: `In chapter${name}` };
  }
  return null;
}

/** The addresses of one book's validations. @param {string} bookId */
export const validationUrls = (bookId) => {
  const base = `/api/books/${enc(bookId)}/export/validations`;
  return {
    start: base,
    status: (/** @type {string} */ id) => `${base}/${enc(id)}`,
    cancel: (/** @type {string} */ id) => `${base}/${enc(id)}/cancel`,
    file: (/** @type {string} */ id) => `${base}/${enc(id)}/file`,
    report: (/** @type {string} */ id) => `${base}/${enc(id)}/report`,
  };
};

/** @param {number} status @param {any} json */
export function explainValidationFailure(status, json) {
  if (status === 0) return 'StoryForge could not be reached. Try again in a moment.';
  if (status === 404) return 'That book, or that check, is not there any more.';
  if (status === 403) return 'Checking an EPUB is not allowed from this page.';
  if (status === 409) return 'A check of this book is already running. Wait for it to finish or cancel it.';
  if (status === 400) return 'Those options cannot be checked. Change them and try again.';
  if (status === 500 && json?.error === 'export_failed') return 'The file was built but did not match your manuscript, so it was not checked. Nothing in your book was changed.';
  return `The check could not be started (${status}). Nothing in your book was changed.`;
}

const WRITE_HEADERS = { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' };
const defaultFetch = (/** @type {any[]} */ ...a) => /** @type {any} */ (globalThis.fetch)(...a);

/** One request and its JSON answer: { status, json }, status 0 when nothing answered. @param {string} url @param {RequestInit} init @param {typeof fetch} fetchImpl */
async function call(url, init, fetchImpl) {
  try {
    const res = await fetchImpl(url, init);
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

/**
 * Start checking the EPUB of a book with the options the dialog has.
 * @param {string} bookId @param {{ sceneTitles?: boolean, excludeStatuses?: string[] }} options @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: true, id: string } | { ok: false, message: string }>}
 */
export async function startValidation(bookId, options, fetchImpl = defaultFetch) {
  const body = { sceneTitles: options.sceneTitles === true, excludeStatuses: options.excludeStatuses ?? [], include: 'manuscript' };
  const r = await call(validationUrls(bookId).start, { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify(body) }, fetchImpl);
  if (r.status === 202 && typeof r.json?.validationId === 'string') return { ok: true, id: r.json.validationId };
  return { ok: false, message: explainValidationFailure(r.status, r.json) };
}

/** The status of a check. @param {string} bookId @param {string} id @param {typeof fetch} [fetchImpl] @returns {Promise<{ ok: true, job: any } | { ok: false, message: string }>} */
export async function readValidation(bookId, id, fetchImpl = defaultFetch) {
  const r = await call(validationUrls(bookId).status(id), { headers: { accept: 'application/json' } }, fetchImpl);
  return r.status === 200 && r.json && typeof r.json.state === 'string' ? { ok: true, job: r.json } : { ok: false, message: explainValidationFailure(r.status, r.json) };
}

/** Ask the server to stop a check. @param {string} bookId @param {string} id @param {typeof fetch} [fetchImpl] @returns {Promise<{ ok: boolean }>} */
export async function cancelValidation(bookId, id, fetchImpl = defaultFetch) {
  const r = await call(validationUrls(bookId).cancel(id), { method: 'POST', headers: WRITE_HEADERS, body: '{}' }, fetchImpl);
  return { ok: r.status === 200 };
}

/**
 * Ask about a check every `intervalMs` until it is no longer running. `onUpdate` sees every answer. Stops quietly (null) when `signal` aborts.
 * @param {string} bookId @param {string} id
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, intervalMs?: number, signal?: AbortSignal, onUpdate?: (job: any) => void }} [o]
 * @returns {Promise<{ ok: true, job: any } | { ok: false, message: string } | null>}
 */
export async function pollValidation(bookId, id, { fetchImpl = defaultFetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), intervalMs = POLL_MS, signal, onUpdate } = {}) {
  for (;;) {
    if (signal?.aborted) return null;
    const r = await readValidation(bookId, id, fetchImpl);
    if (signal?.aborted) return null;
    if (!r.ok) return r;
    onUpdate?.(r.job);
    if (r.job.state !== 'running') return r;
    await sleep(intervalMs);
  }
}

/** Remember the "Validate with EPUBCheck" choice for the book (checks.epub.validate). @param {string} bookId @param {boolean} validate @param {typeof fetch} [fetchImpl] @returns {Promise<{ ok: boolean, message?: string }>} */
export async function saveValidateChoice(bookId, validate, fetchImpl = defaultFetch) {
  const r = await call(`/api/books/${enc(bookId)}/checks/epub`, { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify({ validate }) }, fetchImpl);
  if (r.status === 200) return { ok: true };
  return { ok: false, message: r.status === 0 ? 'StoryForge could not be reached, so the choice was not remembered.' : `The choice was not remembered (${r.status}).` };
}

/** The remembered choice from the answer of GET /api/preferences?book=. @param {any} prefs */
export const validateChoiceOf = (prefs) => prefs?.effective?.checks?.epub?.validate === true;

/** The address of the effective preferences of a book. @param {string} bookId */
export const preferencesUrl = (bookId) => `/api/preferences?book=${enc(bookId)}`;
