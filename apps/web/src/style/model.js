// The Style checks page and panel (M13-J03 sections 6, 8 and 9), pure parts: rule words, addresses, scope, grouping and the dismissal fingerprint.
// Nothing here talks to the server; the views do that.

const enc = encodeURIComponent;

/** The six rules, in the order the page lists them: id, the words an author reads, the finding category and whether it is advice only. */
export const STYLE_RULES = Object.freeze([
  { id: 'preferred-terms', label: 'Preferred terms', category: 'terminology', advisory: false },
  { id: 'repeated-words', label: 'Repeated words', category: 'repetition', advisory: false },
  { id: 'punctuation', label: 'Punctuation style', category: 'punctuation', advisory: false },
  { id: 'repeated-phrases', label: 'Repeated phrases', category: 'repetition', advisory: true },
  { id: 'long-paragraphs', label: 'Long paragraphs', category: 'rhythm', advisory: true },
  { id: 'isolated-lines', label: 'Run of short lines', category: 'rhythm', advisory: true },
]);
export const RULE_LABEL = Object.freeze(Object.fromEntries(STYLE_RULES.map((r) => [r.id, r.label])));
export const CATEGORY_LABEL = Object.freeze({ terminology: 'Terminology', repetition: 'Repetition', punctuation: 'Punctuation', rhythm: 'Rhythm' });

/** @param {string} ruleId */
export const ruleLabel = (ruleId) => RULE_LABEL[ruleId] ?? ruleId;
/** @param {string} category */
export const categoryLabel = (category) => CATEGORY_LABEL[category] ?? category;

/** @param {number} n @param {string} one @param {string} many */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- addresses

/** `?group=` of the page: 'rule' (default) or 'chapter'. @param {string} [search] @returns {'rule' | 'chapter'} */
export function parseGroup(search = '') {
  return new URLSearchParams(search).get('group') === 'chapter' ? 'chapter' : 'rule';
}

/** The Style checks page. @param {string} bookId @param {{ group?: 'rule' | 'chapter' | null }} [opts] */
export function styleHref(bookId, { group = null } = {}) {
  return `/books/${enc(bookId)}/style${group === 'chapter' ? '?group=chapter' : ''}`;
}

/** The scene in the editor with the range selected. @param {string} bookId @param {string} sceneId @param {number} from @param {number} to */
export const openHref = (bookId, sceneId, from, to) => `/books/${enc(bookId)}?scene=${enc(sceneId)}&at=${from}-${to}`;

/** `?at=<from>-<to>` of the editor address: the range to select when the scene opens, or null. @param {string} [search] @returns {{ from: number, to: number } | null} */
export function parseAt(search = '') {
  const m = /^(\d{1,9})-(\d{1,9})$/.exec(new URLSearchParams(search).get('at') ?? '');
  return m && Number(m[2]) >= Number(m[1]) ? { from: Number(m[1]), to: Number(m[2]) } : null;
}

// ---------------------------------------------------------------- scope

/** @typedef {{ kind: 'manuscript' | 'chapter' | 'scenes', chapterKey: string | null, ids: string[] }} ScopeChoice */

/**
 * The chapters of the book (GET /api/books/:b) as the scope pickers need them: `key` is "act:chapter".
 * @param {any} book @returns {{ key: string, act: number, chapter: number, label: string, scenes: { id: string, title: string }[] }[]}
 */
export function chaptersOf(book) {
  const out = [];
  for (const a of Array.isArray(book?.acts) ? book.acts : []) {
    for (const c of Array.isArray(a.chapters) ? a.chapters : []) {
      out.push({
        key: `${a.act}:${c.chapter}`,
        act: a.act,
        chapter: c.chapter,
        label: c.title ? `${c.label}: ${c.title}` : String(c.label ?? `Chapter ${c.chapter}`),
        scenes: (Array.isArray(c.scenes) ? c.scenes : []).map((s) => ({ id: s.id, title: s.title || 'Untitled scene' })),
      });
    }
  }
  return out;
}

/** The POST /scans scope for the author's choice, or null while the choice names nothing yet. @param {ScopeChoice} choice @param {ReturnType<typeof chaptersOf>} chapters */
export function scopeBody(choice, chapters) {
  if (choice.kind === 'manuscript') return { kind: 'manuscript' };
  if (choice.kind === 'chapter') {
    const ch = chapters.find((c) => c.key === choice.chapterKey);
    return ch ? { kind: 'chapter', act: ch.act, chapter: ch.chapter } : null;
  }
  return choice.ids.length > 0 ? { kind: 'scenes', ids: [...choice.ids] } : null;
}

// ---------------------------------------------------------------- results

/** "12 of 48 scenes". @param {number} done @param {number} total */
export const progressText = (done, total) => `${done} of ${total} ${total === 1 ? 'scene' : 'scenes'}`;

/** A repeated-phrases finding with an occurrence in another scene is the "Across scenes" kind. @param {any} f */
export const isAcrossScenes = (f) => f?.ruleId === 'repeated-phrases' && Array.isArray(f.related) && f.related.some((r) => r.sceneId !== f.sceneId);

/**
 * "Chapter label" and the scene title for a finding, from the scan's `chapters` map.
 * @param {Record<string, { chapterLabel?: string, title?: string }> | undefined} chapters @param {string} sceneId
 */
export function placeOf(chapters, sceneId) {
  const c = chapters?.[sceneId];
  return { chapter: c?.chapterLabel ?? null, scene: c?.title || 'Untitled scene' };
}

/**
 * The findings in groups: `by` 'rule' (the rule order of STYLE_RULES) or 'chapter' (book order). Within a group by chapter and position. Empty groups are left out.
 * @param {any[]} findings @param {Record<string, { act?: number, chapter?: number, chapterLabel?: string }> | undefined} chapters @param {'rule' | 'chapter'} by
 * @returns {{ key: string, label: string, items: any[] }[]}
 */
export function groupFindings(findings, chapters, by) {
  const pos = (f) => chapters?.[f.sceneId] ?? {};
  const order = (a, b) => (pos(a).act ?? 0) - (pos(b).act ?? 0) || (pos(a).chapter ?? 0) - (pos(b).chapter ?? 0) || a.range.from - b.range.from;
  /** @type {Map<string, { key: string, label: string, items: any[], sort: number[] }>} */
  const groups = new Map();
  for (const f of findings) {
    let key;
    let label;
    let sort;
    if (by === 'chapter') {
      const p = pos(f);
      key = `${p.act ?? 0}:${p.chapter ?? 0}`;
      label = p.chapterLabel ?? 'Other scenes';
      sort = [p.act ?? 0, p.chapter ?? 0];
    } else {
      key = f.ruleId;
      label = ruleLabel(f.ruleId);
      const i = STYLE_RULES.findIndex((r) => r.id === f.ruleId);
      sort = [i < 0 ? STYLE_RULES.length : i, 0];
    }
    if (!groups.has(key)) groups.set(key, { key, label, items: [], sort });
    groups.get(key).items.push(f);
  }
  return [...groups.values()]
    .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1])
    .map((g) => ({ key: g.key, label: g.label, items: [...g.items].sort(order) }));
}

// ---------------------------------------------------------------- dismissal fingerprint

const CONTEXT_CHARS = 24;

/**
 * The fingerprint of a style finding, as the server computes it (`sty-` + the first 16 hex of SHA-256 over JSON [ruleId, sceneId, original, before, after]; before and after are up
 * to 24 characters of body text either side of the range). Used when a finding did not arrive with its `fingerprint`. `body` is the text the finding was found in, with LF line breaks.
 * @param {{ ruleId: string, sceneId: string, original: string, range: { from: number, to: number }, fingerprint?: string }} finding @param {string} body
 * @returns {Promise<string>}
 */
export async function styleFingerprint(finding, body) {
  if (typeof finding.fingerprint === 'string' && /^sty-[0-9a-f]{16}$/.test(finding.fingerprint)) return finding.fingerprint;
  const { from, to } = finding.range;
  const before = body.slice(Math.max(0, from - CONTEXT_CHARS), from);
  const after = body.slice(to, to + CONTEXT_CHARS);
  const bytes = new TextEncoder().encode(JSON.stringify([finding.ruleId, finding.sceneId, finding.original, before, after]));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return `sty-${[...digest].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)}`;
}
