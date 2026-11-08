// The chapter context pack (M12 W6, story-skills `context`): everything an AI needs before it writes chapter N, trimmed to a character budget. This file is the pure
// assembly step: it takes what the repository gathered (see fs-context.mjs) and decides what fits. Nothing here reads a file.

export const DEFAULT_BUDGET = 24000;
export const MIN_BUDGET = 500;
export const MAX_BUDGET = 200000;
/** How much of the previous chapter's last scene goes into the pack. */
export const TAIL_CHARS = 1500;

/** The sections in priority order: when the budget runs out, the last ones are cut first. `text`: the section's items carry a long string that may be shortened. */
export const SECTIONS = [
  { key: 'workspace', text: 'body' },
  { key: 'story', text: 'text' },
  { key: 'scene_plans' },
  { key: 'cast' },
  { key: 'knowledge' },
  { key: 'open_ledger' },
  { key: 'state_events' },
  { key: 'state_docs', text: 'body' },
  { key: 'previous_tail', tail: true },
  { key: 'continuity' },
];

const size = (/** @type {unknown} */ v) => JSON.stringify(v).length;
/** Room taken by `"key":` and the comma around a section value. */
const keyCost = (/** @type {string} */ key) => key.length + 4;
/** What an empty section still takes: `[]` (or `null` for the tail) and its key. */
const emptyCost = (/** @type {{ key: string, tail?: boolean }} */ sec) => (sec.tail ? 4 : 2) + keyCost(sec.key);

/** @param {unknown} v @param {number} [fallback] @returns {number} a whole budget in characters, clamped; the default when v is not a usable number */
export function normalizeBudget(v, fallback = DEFAULT_BUDGET) {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, Math.floor(n)));
}

/** The longest start (or, with `fromEnd`, end) of `text` whose JSON form takes at most `max` characters. @param {string} text @param {number} max @param {boolean} [fromEnd] */
function sliceJson(text, max, fromEnd = false) {
  const part = (/** @type {number} */ n) => (fromEnd ? text.slice(text.length - n) : text.slice(0, n));
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(part(mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return part(lo);
}

/**
 * Fit a list of items into `room` characters: whole items while they fit, then (for a section with a `text` key) the next item with its text cut short, then stop.
 * @param {any[]} items @param {number} room @param {string | undefined} textKey
 * @returns {{ items: any[], cut: boolean }}
 */
function fitList(items, room, textKey) {
  /** @type {any[]} */
  const out = [];
  let used = 2; // [ ]
  for (const item of items) {
    const s = size(item) + 1;
    if (used + s <= room) {
      out.push(item);
      used += s;
      continue;
    }
    if (textKey && typeof item?.[textKey] === 'string') {
      const spare = room - used - 1 - size({ ...item, [textKey]: '' }) - 1; // the comma, the item without its text, the ellipsis
      if (spare >= 40) out.push({ ...item, [textKey]: `${sliceJson(item[textKey], spare + 2).trimEnd()}…` });
    }
    return { items: out, cut: true };
  }
  return { items: out, cut: false };
}

/**
 * Assemble the pack.
 * @param {{
 *   chapter: number, budget?: number,
 *   workspace?: { path: string, title: string, body: string }[],
 *   story?: Record<string, string | null>,
 *   scene_plans?: any[], cast?: any[], knowledge?: any[], open_ledger?: any[], state_events?: any[],
 *   state_docs?: { path: string, title: string, body: string }[],
 *   previous_tail?: string | null, continuity?: any[],
 * }} input what the repository gathered, each section already in the order it should be kept
 * @returns {Record<string, any>} { chapter, budget, chars, <sections>, truncated: [section keys that were cut or left out] }; the sections together take at most `budget` characters
 */
export function assembleContext(input) {
  const budget = normalizeBudget(input.budget);
  let room = budget;
  /** @type {string[]} */
  const truncated = [];
  /** @type {Record<string, any>} */
  const out = { chapter: input.chapter, budget };
  SECTIONS.forEach((sec, i) => {
    const { key } = sec;
    const reserved = SECTIONS.slice(i + 1).reduce((n, s) => n + emptyCost(s), 0); // every later section keeps at least its empty form
    // strict priority: once a section had to be cut, the sections after it are left out (named in truncated when they had content), so a higher section is never starved by a lower one
    const avail = truncated.length > 0 ? 0 : Math.max(0, room - reserved - keyCost(key));
    const raw = /** @type {any} */ (input)[key];
    if (key === 'story') {
      const entries = Object.entries(raw ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== '').map(([field, text]) => ({ field, text }));
      // the story is one object; fit its fields as a list of { field, text } (a little larger than the object, so the object always fits) and fold them back
      const fit = fitList(entries, avail, 'text');
      out.story = Object.fromEntries(fit.items.map((e) => [e.field, e.text]));
      if (fit.cut) truncated.push(key);
    } else if (sec.tail) {
      const text = typeof raw === 'string' ? raw : '';
      out[key] = text === '' ? null : sliceJson(text, avail, true) || null;
      if (text !== '' && (out[key] ?? '').length < text.length) truncated.push(key);
    } else {
      const fit = fitList(Array.isArray(raw) ? raw : [], avail, sec.text);
      out[key] = fit.items;
      if (fit.cut) truncated.push(key);
    }
    room -= size(out[key]) + keyCost(key);
  });
  out.truncated = truncated;
  out.chars = budget - room;
  return out;
}

/** The last `max` characters of a scene body, starting at a paragraph or sentence break when one is near. @param {string} body @param {number} [max] */
export function tailOf(body, max = TAIL_CHARS) {
  const text = body.replace(/\r\n/g, '\n').trim();
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const para = cut.indexOf('\n\n');
  if (para >= 0 && para < max / 3) return cut.slice(para + 2).trim();
  const sentence = /[.!?]["')\]]?\s+/.exec(cut);
  if (sentence && sentence.index < max / 4) return cut.slice(sentence.index + sentence[0].length).trim();
  return cut.trim();
}
