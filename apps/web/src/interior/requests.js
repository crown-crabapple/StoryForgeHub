// The Book interior page (contract M13-J05 section 6): the addresses, the settings and their checks, the words, and the requests that save the layout, make a snapshot and ask for the
// fingerprint. The helpers are pure or take `fetchImpl`, so tests run them without a server or a browser.

const enc = encodeURIComponent;

/** Saving waits this long after the last change. */
export const DEBOUNCE_MS = 800;
/** How often the page asks whether the preview is out of date, while it is visible. */
export const POLL_MS = 5000;
/** How long the frame may take to lay the pages out before the page says it failed. */
export const LAYOUT_TIMEOUT_MS = 180000;

/** Shown on the page at all times. */
export const EXPERIMENTAL_NOTE = 'Experimental. A preview of a printed interior; not print-ready, not checked by any printer or store, and no PDF/X.';

/** The layout the server starts from (the same values as the book format's defaults); the page shows the book's effective settings over these. */
export const DEFAULT_LAYOUT = Object.freeze({
  version: 1,
  template: 'novel',
  trim: '6x9',
  font: 'literata',
  fontSize: 11,
  lineHeight: 1.35,
  margins: Object.freeze({ inside: 0.75, outside: 0.5, top: 0.6, bottom: 0.6 }),
  chapterStart: 'right',
  sceneBreak: 'asterisks',
  runningHeads: true,
  pageNumbers: true,
  frontMatter: Object.freeze({ copyright: '', dedication: '' }),
  backMatter: Object.freeze({ aboutAuthor: '' }),
});

export const TRIMS = [
  { key: '6x9', label: '6 x 9 inches' },
  { key: '5.5x8.5', label: '5.5 x 8.5 inches' },
];
export const FONTS = [
  { key: 'literata', label: 'Literata (serif)' },
  { key: 'inter', label: 'Inter (sans-serif)' },
];
export const CHAPTER_STARTS = [
  { key: 'right', label: 'On a right-hand page' },
  { key: 'any', label: 'On the next page' },
];
export const SCENE_BREAKS = [
  { key: 'asterisks', label: 'Asterisks' },
  { key: 'ornament', label: 'Ornament' },
  { key: 'blank', label: 'Blank line' },
];
export const MARGINS = [
  { key: 'inside', label: 'Inside margin (spine side)' },
  { key: 'outside', label: 'Outside margin' },
  { key: 'top', label: 'Top margin' },
  { key: 'bottom', label: 'Bottom margin' },
];
/** Longest text of each text setting, in characters. */
export const TEXT_LIMITS = Object.freeze({ copyright: 2000, dedication: 1000, aboutAuthor: 4000 });

/** The addresses of one book's interior routes. @param {string} bookId */
export const interiorUrls = (bookId) => {
  const base = `/api/books/${enc(bookId)}/interior`;
  return {
    layout: `${base}/layout`,
    snapshots: `${base}/snapshots`,
    fingerprint: `${base}/fingerprint`,
    preview: (/** @type {string} */ snapshotId) => `${base}/snapshots/${enc(snapshotId)}/preview.html`,
    preferences: `/api/preferences?book=${enc(bookId)}`,
  };
};

/** The address of the page. @param {string} bookId */
export const interiorPath = (bookId) => `/books/${enc(bookId)}/interior`;

/** The address of a scene in the manuscript. @param {string} bookId @param {string} sceneId */
export const sceneHref = (bookId, sceneId) => `/books/${enc(bookId)}?scene=${enc(sceneId)}`;

const isMap = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The layout to show: the book's effective `interior` (from GET /api/preferences?book=) over the defaults, group by group.
 * @param {any} prefs @returns {Record<string, any>}
 */
export function layoutOf(prefs) {
  const given = isMap(prefs?.effective?.interior) ? prefs.effective.interior : {};
  const out = { ...DEFAULT_LAYOUT, ...given };
  for (const k of ['margins', 'frontMatter', 'backMatter']) out[k] = { ...(/** @type {any} */ (DEFAULT_LAYOUT)[k]), ...(isMap(given[k]) ? given[k] : {}) };
  return out;
}

/** A number typed in a field: a number, or NaN when it is not one. @param {unknown} v */
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);

/**
 * What is wrong with the settings as typed (the numbers may still be text). Each problem names its field. Nothing is saved while any exists.
 * @param {Record<string, any>} layout @returns {{ field: string, message: string }[]}
 */
export function layoutProblems(layout) {
  /** @type {{ field: string, message: string }[]} */
  const out = [];
  const size = num(layout.fontSize);
  if (!(size >= 9 && size <= 14) || !Number.isInteger(size * 2)) out.push({ field: 'fontSize', message: 'Font size must be from 9 to 14 points, in whole or half points.' });
  const lh = num(layout.lineHeight);
  if (!(lh >= 1.1 && lh <= 1.8)) out.push({ field: 'lineHeight', message: 'Line spacing must be from 1.1 to 1.8.' });
  for (const m of MARGINS) {
    const v = num(layout.margins?.[m.key]);
    if (!(v >= 0.25 && v <= 1.5)) out.push({ field: `margin-${m.key}`, message: `${m.label.replace(/ \(.*\)/, '')} must be from 0.25 to 1.5 inches.` });
  }
  return out;
}

/** The layout with its typed numbers made numbers (call only when layoutProblems is empty). @param {Record<string, any>} layout */
export function normalised(layout) {
  return {
    ...layout,
    fontSize: num(layout.fontSize),
    lineHeight: num(layout.lineHeight),
    margins: Object.fromEntries(MARGINS.map((m) => [m.key, num(layout.margins?.[m.key])])),
  };
}

/** The keys of `layout` that differ from `saved`, as a patch for the layout route. Groups are sent whole. @param {Record<string, any>} layout @param {Record<string, any>} saved */
export function patchOf(layout, saved) {
  const next = normalised(layout);
  return Object.fromEntries(Object.keys(next).filter((k) => k !== 'version' && JSON.stringify(next[k]) !== JSON.stringify(saved[k])).map((k) => [k, next[k]]));
}

/** @param {number} status @param {any} json @param {string} what */
export function explainFailure(status, json, what) {
  if (status === 0) return 'StoryForge could not be reached. Try again in a moment.';
  if (status === 404) return 'That book is not in the library any more.';
  if (status === 403) return `${what} is not allowed from this page.`;
  if (status === 400 && typeof json?.message === 'string') return json.message;
  if (status === 501) return 'This build of StoryForge cannot lay out a book interior.';
  if (status === 500 && json?.error === 'export_failed') return 'The book could not be prepared for the preview. Nothing in your book was changed.';
  return `${what} did not work (${status}). Nothing in your book was changed.`;
}

const WRITE_HEADERS = { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' };
const defaultFetch = (/** @type {any[]} */ ...a) => /** @type {any} */ (globalThis.fetch)(...a);

/** @param {string} url @param {RequestInit} init @param {typeof fetch} fetchImpl */
async function call(url, init, fetchImpl) {
  try {
    const res = await fetchImpl(url, init);
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

/** Save changed settings. @param {string} bookId @param {Record<string, any>} patch @param {typeof fetch} [fetchImpl] @returns {Promise<{ ok: true } | { ok: false, message: string }>} */
export async function saveLayout(bookId, patch, fetchImpl = defaultFetch) {
  const r = await call(interiorUrls(bookId).layout, { method: 'POST', headers: WRITE_HEADERS, body: JSON.stringify(patch) }, fetchImpl);
  return r.status === 200 ? { ok: true } : { ok: false, message: explainFailure(r.status, r.json, 'Saving the settings') };
}

/** Lay the book out now (a snapshot on the server). @param {string} bookId @param {typeof fetch} [fetchImpl] @returns {Promise<{ ok: true, snapshotId: string, fingerprint: string, report: any } | { ok: false, message: string }>} */
export async function createSnapshot(bookId, fetchImpl = defaultFetch) {
  const r = await call(interiorUrls(bookId).snapshots, { method: 'POST', headers: WRITE_HEADERS, body: '{}' }, fetchImpl);
  if (r.status === 201 && typeof r.json?.snapshotId === 'string') return { ok: true, snapshotId: r.json.snapshotId, fingerprint: String(r.json.fingerprint), report: r.json.report ?? {} };
  return { ok: false, message: explainFailure(r.status, r.json, 'Preparing the preview') };
}

/** The fingerprint of the book as it is now, or null when it cannot be read. @param {string} bookId @param {typeof fetch} [fetchImpl] @returns {Promise<string | null>} */
export async function readFingerprint(bookId, fetchImpl = defaultFetch) {
  const r = await call(interiorUrls(bookId).fingerprint, { headers: { accept: 'application/json' } }, fetchImpl);
  return r.status === 200 && typeof r.json?.fingerprint === 'string' ? r.json.fingerprint : null;
}

/** The message of the preview page, if this event is one: from the frame's own window and from this origin only. @param {{ origin: string, source: unknown, data: any }} event @param {unknown} frameWindow @param {string} origin */
export function summaryFrom(event, frameWindow, origin) {
  if (!frameWindow || event.source !== frameWindow || event.origin !== origin) return null;
  const d = event.data;
  if (!isMap(d) || d.type !== 'storyforge-interior' || (d.state !== 'done' && d.state !== 'failed')) return null;
  return {
    state: /** @type {'done' | 'failed'} */ (d.state),
    pages: Number.isInteger(d.pages) ? d.pages : 0,
    ms: Number.isFinite(d.ms) ? d.ms : 0,
    message: typeof d.message === 'string' ? d.message : '',
    problems: Array.isArray(d.problems) ? d.problems.filter((p) => isMap(p) && typeof p.kind === 'string').map((p) => ({ kind: String(p.kind), page: Number.isInteger(p.page) ? p.page : null, message: typeof p.message === 'string' ? p.message : '' })) : [],
  };
}

/** The status line. @param {{ phase: string, summary: { pages: number, ms: number, message: string } | null, error: string | null }} s */
export function statusLine({ phase, summary, error }) {
  if (phase === 'loading') return 'Loading…';
  if (phase === 'idle') return 'Choose Refresh preview to lay the book out.';
  if (phase === 'creating') return 'Preparing the book…';
  if (phase === 'failed') return `Layout failed: ${summary?.message || error || 'unknown reason'}`;
  if (phase === 'done' && summary) return `${summary.pages} ${summary.pages === 1 ? 'page' : 'pages'} in ${(summary.ms / 1000).toFixed(1)} s`;
  return 'Laying out pages…';
}

const PROBLEM_GROUPS = [
  { key: 'clipped', kinds: ['clipped'], label: 'Clipped text', note: 'The text on these pages is taller than the page area.' },
  { key: 'strandedHeading', kinds: ['strandedHeading'], label: 'Stranded headings', note: 'A heading is the last thing on these pages.' },
  { key: 'widowOrphan', kinds: ['widow', 'orphan'], label: 'Widows and orphans, for review', note: 'A single line of a paragraph is alone at the top or the bottom of these pages. The preview lists them; it does not prevent them.' },
  { key: 'missingText', kinds: ['missingText'], label: 'Missing or repeated text', note: 'The text of the laid-out pages differs from the text of the book.' },
];

/** The problems the preview page found, grouped for the Report panel, each with its page numbers. @param {{ kind: string, page: number | null, message: string }[]} problems */
export function problemGroups(problems) {
  const list = Array.isArray(problems) ? problems : [];
  return PROBLEM_GROUPS.map((g) => {
    const items = list.filter((p) => g.kinds.includes(p.kind));
    const pages = [...new Set(items.map((p) => p.page).filter((p) => p !== null))].sort((a, b) => a - b);
    return { key: g.key, label: g.label, note: g.note, items, pages };
  }).filter((g) => g.items.length > 0);
}

/** The words for a kind of Markdown the prototype flattens or drops. */
export const UNSUPPORTED_LABELS = { image: 'Images', table: 'Tables', footnote: 'Footnotes', list: 'Lists', blockquote: 'Block quotes', code: 'Code' };

/** "U+4E2D" for a code point. @param {number} cp */
export const codePointText = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
