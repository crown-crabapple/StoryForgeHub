// What the Codex page shows, worked out from the API answers. Pure: no DOM, no fetch.
//
// An entry is one element of GET /api/books/:b/codex/entries (`entries`):
//   { id, slug, type, name, status, role, aliases, fields, image, image_url, first_appearance, path, archived, updated_at,
//     sections: [{ heading, text, markdown? }], appears_in: [{ scene_id, title, position, rel, kind }],
//     related: [{ id, name, as, direction }], problems: [{ code, severity, location, message }] }
// `chapters` is the other half of that answer: [{ chapter, label, scene_ids }] in manuscript order.

import { hasLabel, inScope } from '../world/model.js';

export const BUILTIN_TYPES = ['character', 'location', 'faction', 'object', 'lore'];

export const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'seed', label: 'Seed' },
  { key: 'sketch', label: 'Sketch' },
  { key: 'canon', label: 'Canon' },
  { key: 'review', label: 'Needs review' },
];

export const SORTS = [
  { key: 'name', label: 'Name' },
  { key: 'scenes', label: 'Most scenes' },
  { key: 'recent', label: 'Recently changed' },
];

export const ENTRY_STATUSES = ['seed', 'sketch', 'canon'];

const BLURB_MAX = 120;
const MARKS = /\p{M}+/gu;

// ---------------------------------------------------------------- URLs

/** /books/:id/codex with the optional ?type= and ?entry= of the page. @param {string} bookId @param {{ type?: string | null, entry?: string | null }} [q] */
export function codexHref(bookId, { type = null, entry = null } = {}) {
  const p = new URLSearchParams();
  if (type) p.set('type', type);
  if (entry) p.set('entry', entry);
  const qs = p.toString();
  return `/books/${encodeURIComponent(bookId)}/codex${qs ? `?${qs}` : ''}`;
}

/** /books/:id/places: the Codex filtered to locations, with the optional ?entry= of the page (M04-J04). @param {string} bookId @param {{ entry?: string | null }} [q] */
export function placesHref(bookId, { entry = null } = {}) {
  return `/books/${encodeURIComponent(bookId)}/places${entry ? `?entry=${encodeURIComponent(entry)}` : ''}`;
}

/** The scene in the manuscript. @param {string} bookId @param {string} sceneId */
export const sceneHref = (bookId, sceneId) => `/books/${encodeURIComponent(bookId)}?scene=${encodeURIComponent(sceneId)}`;

/** @param {string} search the query string of the URL @returns {{ type: string | null, entry: string | null }} */
export function parseCodexSearch(search = '') {
  const p = new URLSearchParams(search);
  const type = p.get('type');
  const entry = p.get('entry');
  return { type: type && type.trim() !== '' ? type : null, entry: entry && entry.trim() !== '' ? entry : null };
}

// ---------------------------------------------------------------- one entry

/** The letter in the avatar circle. @param {string | null | undefined} name */
export function initialOf(name) {
  const s = (name ?? '').trim();
  return s === '' ? '?' : (Array.from(s)[0] ?? '?').toUpperCase();
}

/** Short chapter name: Ch 3 (Prologue for chapter 0). @param {number} n */
export const chapterShort = (n) => (n === 0 ? 'Prologue' : `Ch ${n}`);

/**
 * The one-line blurb of a card: the first sentence of the first `##` section, at most 120 characters (cut with an ellipsis).
 * @param {{ heading?: string, text?: string }[] | null | undefined} sections
 */
export function blurbOf(sections) {
  const text = (sections?.[0]?.text ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  const m = /^.*?[.!?](?=\s|$)/.exec(text);
  const sentence = m ? m[0] : text;
  return sentence.length <= BLURB_MAX ? sentence : `${sentence.slice(0, BLURB_MAX - 1).trimEnd()}…`;
}

/**
 * The scenes an entry appears in, one row per scene (an explicit row wins over a mention), explicit rows first, each group in manuscript order.
 * @param {{ scene_id: string, title?: string, position?: number, rel?: string, kind: string }[] | null | undefined} rows
 */
export function sceneRows(rows) {
  /** @type {Map<string, any>} */
  const byScene = new Map();
  for (const r of rows ?? []) {
    const have = byScene.get(r.scene_id);
    if (!have || (have.kind !== 'explicit' && r.kind === 'explicit')) byScene.set(r.scene_id, r);
  }
  return [...byScene.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'explicit' ? -1 : 1) || (a.position ?? 0) - (b.position ?? 0));
}

/** Scenes where the entry is linked explicitly (the "N scenes" of a card). @param {{ appears_in?: any[] }} entry */
export const explicitScenes = (entry) => sceneRows(entry.appears_in).filter((r) => r.kind === 'explicit');

/** `${n} scene(s)` @param {number} n */
export const scenesLabel = (n) => `${n} ${n === 1 ? 'scene' : 'scenes'}`;

/** The chapter number a scene is in, or null. @param {{ chapter: number, scene_ids?: string[] }[] | null | undefined} chapters @param {string} sceneId */
export function chapterOfScene(chapters, sceneId) {
  return (chapters ?? []).find((c) => (c.scene_ids ?? []).includes(sceneId))?.chapter ?? null;
}

/**
 * "First seen": the chapter of `first_appearance`, else of the earliest explicit scene. { chapter, label: 'Ch 1' } or null.
 * @param {{ first_appearance?: string | null, appears_in?: any[] }} entry @param {{ chapter: number, scene_ids?: string[] }[]} chapters
 */
export function firstSeen(entry, chapters) {
  let chapter = entry.first_appearance ? chapterOfScene(chapters, entry.first_appearance) : null;
  if (chapter === null) {
    const first = explicitScenes(entry)[0];
    chapter = first ? chapterOfScene(chapters, first.scene_id) : null;
  }
  return chapter === null ? null : { chapter, label: chapterShort(chapter) };
}

/** An entry needs review when it has an error or warning, or its status is seed. @param {{ status?: string | null, problems?: { severity: string }[] }} entry */
export const needsReview = (entry) => entry.status === 'seed' || (entry.problems ?? []).some((p) => p.severity === 'error' || p.severity === 'warning');

/** "canon" reads "Canon". @param {string | null | undefined} status */
export const statusLabel = (status) => (status ? status.charAt(0).toUpperCase() + status.slice(1) : 'No status');

/** What the card says under the name: the `role` field, else the type. @param {{ role?: string | null, type?: string | null }} entry @param {{ type: string, name: string }[]} [types] */
export function roleLabel(entry, types = []) {
  if (entry.role) return entry.role;
  const t = types.find((x) => x.type === entry.type);
  return t?.name ?? (entry.type ? entry.type.charAt(0).toUpperCase() + entry.type.slice(1) : '');
}

/** A field value as text. @param {unknown} v */
export function showValue(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(showValue).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** The entry's `fields` as [{ label, value }] in file order (values as text; `raw` keeps the type). @param {Record<string, unknown> | null | undefined} fields */
export const factsOf = (fields) => Object.entries(fields ?? {}).map(([label, value]) => ({ label, value: showValue(value), raw: value }));

// ---------------------------------------------------------------- presence by chapter

/**
 * One bar per chapter: scenes of that chapter where the entry appears explicitly, and (stacked, lighter) where it is only mentioned.
 * @param {any[] | null | undefined} appears the entry's `appears_in` @param {{ chapter: number, label?: string, scene_ids?: string[] }[]} chapters
 * @returns {{ chapter: number, label: string, explicit: number, inferred: number, total: number }[]}
 */
export function presenceByChapter(appears, chapters) {
  const rows = sceneRows(appears);
  return (chapters ?? []).map((c) => {
    const here = rows.filter((r) => (c.scene_ids ?? []).includes(r.scene_id));
    const explicit = here.filter((r) => r.kind === 'explicit').length;
    return { chapter: c.chapter, label: chapterShort(c.chapter), explicit, inferred: here.length - explicit, total: here.length };
  });
}

/** Bars with pixel heights: the tallest chapter is `maxPx` high, a chapter with any scene at least 2px. */
export function barHeights(bars, maxPx = 52) {
  const max = Math.max(1, ...bars.map((b) => b.total));
  return bars.map((b) => {
    const total = b.total === 0 ? 0 : Math.max(2, Math.round((b.total / max) * maxPx));
    const explicit = b.total === 0 ? 0 : Math.round((b.explicit / b.total) * total);
    return { ...b, px: total, explicitPx: explicit, inferredPx: total - explicit };
  });
}

/** The text alternative of the bars: "Maren Hollis appears in 3 scenes in chapter 1, 2 scenes in chapter 2". @param {string} name @param {ReturnType<typeof presenceByChapter>} bars */
export function presenceSummary(name, bars) {
  const part = (n, c) => `${n} ${n === 1 ? 'scene' : 'scenes'} in chapter ${c}`;
  const own = bars.filter((b) => b.explicit > 0).map((b) => part(b.explicit, b.chapter));
  const mentioned = bars.filter((b) => b.inferred > 0).map((b) => part(b.inferred, b.chapter));
  if (own.length === 0 && mentioned.length === 0) return `${name} does not appear in any chapter yet`;
  const head = own.length > 0 ? `${name} appears in ${own.join(', ')}` : `${name} is not linked in any scene`;
  return mentioned.length > 0 ? `${head}; mentioned in ${mentioned.join(', ')}` : head;
}

// ---------------------------------------------------------------- sidebar, filter, sort

/**
 * Sidebar rows: All, one row per type (built-ins first, then custom types A to Z), Archived. `types` is GET /codex/types.
 * @param {{ type: string, name: string, plural: string, builtin?: boolean, count?: number }[]} types @param {{ archived: boolean, type?: string }[]} entries
 * @returns {{ key: string, label: string, count: number, kind: 'all' | 'type' | 'archived' }[]}
 */
export function sidebarRows(types, entries) {
  const live = entries.filter((e) => !e.archived);
  const order = (t) => (BUILTIN_TYPES.includes(t.type) ? BUILTIN_TYPES.indexOf(t.type) : 100);
  const sorted = [...types].sort((a, b) => order(a) - order(b) || (order(a) === 100 ? a.plural.localeCompare(b.plural) : 0));
  return [
    { key: 'all', label: 'All', count: live.length, kind: 'all' },
    ...sorted.map((t) => ({ key: t.type, label: t.plural, count: live.filter((e) => e.type === t.type).length, kind: /** @type {const} */ ('type') })),
    { key: 'archived', label: 'Archived', count: entries.length - live.length, kind: 'archived' },
  ];
}

/** The id of a section tab: `codex-tab-` + the row key, any character outside A-Z a-z 0-9 _ - replaced by '-'. @param {string} key */
export const tabId = (key) => `codex-tab-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;

/**
 * The tab a key press moves to (WAI-ARIA tabs, automatic activation): ArrowRight and ArrowLeft wrap around, Home is the first, End the last.
 * Any other key returns `at`.
 * @param {number} at the focused tab @param {string} key @param {number} count the number of tabs
 */
export function nextTabIndex(at, key, count) {
  if (count <= 0) return at;
  if (key === 'ArrowRight') return (at + 1) % count;
  if (key === 'ArrowLeft') return (at - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return at;
}

/** The heading of the page for the selected sidebar row. @param {string} typeKey @param {{ type: string, plural: string }[]} types */
export function typeTitle(typeKey, types) {
  if (typeKey === 'all') return 'All entries';
  if (typeKey === 'archived') return 'Archived';
  return types.find((t) => t.type === typeKey)?.plural ?? typeKey.charAt(0).toUpperCase() + typeKey.slice(1);
}

/** The sidebar row the page starts on: the first type that has entries, else All. @param {ReturnType<typeof sidebarRows>} rows */
export const defaultTypeKey = (rows) => rows.find((r) => r.kind === 'type' && r.count > 0)?.key ?? 'all';

/** Lower case, no accents, single spaces. @param {string} s */
export const fold = (s) => s.normalize('NFD').replace(MARKS, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Does the query match the entry's name, aliases or field values? An empty query matches. @param {any} entry @param {string} query */
export function matchesQuery(entry, query) {
  const q = fold(query ?? '');
  if (q === '') return true;
  const hay = [entry.name, ...(entry.aliases ?? []), ...Object.values(entry.fields ?? {}).map(showValue)];
  return hay.some((h) => typeof h === 'string' && fold(h).includes(q));
}

/**
 * The entries a view shows: the sidebar row, the status chip and the search. `textIds` (optional Set) are entries the server's full-text
 * search found; they count as matches even when name, aliases and fields do not.
 * `scope` (M07-J01b): 'all', 'book' (this book's own entries) or 'shared' (the series'); `label`: only entries that carry that label ('' = any).
 * @param {any[]} entries
 * @param {{ type?: string, status?: string, query?: string, textIds?: Set<string> | null, scope?: string, label?: string }} f
 */
export function filterEntries(entries, { type = 'all', status = 'all', query = '', textIds = null, scope = 'all', label = '' } = {}) {
  return inScope(entries, scope).filter((e) => {
    if (!hasLabel(e, label)) return false;
    if (type === 'archived' ? !e.archived : e.archived) return false;
    if (type !== 'all' && type !== 'archived' && e.type !== type) return false;
    if (status === 'review' ? !needsReview(e) : status !== 'all' && e.status !== status) return false;
    return matchesQuery(e, query) || Boolean(textIds && query.trim() !== '' && textIds.has(e.id));
  });
}

/** @param {any[]} entries @param {'name' | 'scenes' | 'recent'} sort */
export function sortEntries(entries, sort = 'name') {
  const byName = (a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.id < b.id ? -1 : 1);
  const list = [...entries];
  if (sort === 'scenes') return list.sort((a, b) => explicitScenes(b).length - explicitScenes(a).length || byName(a, b));
  if (sort === 'recent') return list.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || byName(a, b));
  return list.sort(byName);
}

/** "24 entries · 3 need review" @param {any[]} list */
export function headerCounts(list) {
  const review = list.filter(needsReview).length;
  const n = list.length;
  return { count: n, review, text: `${n} ${n === 1 ? 'entry' : 'entries'} · ${review} need review` };
}

/** Index of the card to focus after an arrow key in a grid with `columns` columns; the same index if the key goes nowhere. */
export function nextCardIndex(index, key, columns, total) {
  const cols = Math.max(1, columns);
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[key];
  if (step === undefined) return index;
  const next = index + step;
  return next < 0 || next >= total ? index : next;
}

// ---------------------------------------------------------------- editing helpers

/**
 * The value to send for a field the author typed: unchanged text keeps its original type (34 stays a number), a new plain number is a number.
 * @param {string} text @param {unknown} original
 */
export function coerceFieldValue(text, original) {
  if (original !== undefined && original !== null && typeof original !== 'object' && String(original) === text) return original;
  const t = text.trim();
  if (/^(0|-?[1-9]\d{0,14})(\.\d+)?$/.test(t) && String(Number(t)) === t) return Number(t);
  return text;
}

/** Lines of a textarea as a list: trimmed, empty lines and repeats dropped. @param {string} text */
export const linesOf = (text) => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

/** Lower-case ASCII slug (1-60 chars) from a name, '' if nothing is left. @param {string} text */
export function slugOf(text) {
  return String(text)
    .normalize('NFKD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

/** A type word (a to z only) from a name the author typed: "Magic Item" becomes "magicitem". @param {string} text */
export const typeWordOf = (text) => text.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 40);

/** Do two lists of label names hold the same names (ignoring order and capitals)? @param {string[]} a @param {string[]} b */
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));

/**
 * The body of the fields request: only what changed. `before` / `after`: { name, status, role, aliases, fields: [{ label, value }],
 * related: [{ to, as? }] }.
 */
export function fieldsPatch(before, after) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (after.name !== before.name) patch.name = after.name;
  if (after.status !== before.status) patch.status = after.status;
  if ((after.role ?? '') !== (before.role ?? '')) patch.role = after.role ?? '';
  if (JSON.stringify(after.aliases) !== JSON.stringify(before.aliases ?? [])) patch.aliases = after.aliases;
  const pairsOf = (f) => f.map((p) => [p.label, p.value]);
  if (JSON.stringify(pairsOf(after.fields)) !== JSON.stringify(pairsOf(before.fields ?? []))) patch.fields = after.fields.map((p) => ({ label: p.label, value: p.value }));
  if (JSON.stringify(after.related) !== JSON.stringify(before.related ?? [])) patch.related = after.related;
  if (after.labels !== undefined && !sameSet(after.labels, before.labels ?? [])) patch.labels = after.labels;
  return patch;
}
