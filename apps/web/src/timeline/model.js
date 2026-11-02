// The Timeline's projections (M04-J04). Pure: the page fetches GET /api/books/:b/timeline and these functions turn it into what is drawn.
//
// Two orders: STORY TIME (chronological: `order`, then id) and BOOK ORDER (narrative: the lowest manuscript position among the event's live scenes).
// An event's scenes are the union of its `scenes` list and every scene whose `events` names it (the server already joined both sides); a scene that is
// archived, a variant or missing has no position. "Told early / late" is information only: event E is told early when its narrative position is before an
// event that happens earlier in story time, and told late when its position is after an event that happens later in story time.

const enc = encodeURIComponent;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** /books/:id/timeline with the optional ?event= (the event to show first) and ?order=book. @param {string} bookId @param {{ event?: string | null, order?: string | null }} [q] */
export function timelineHref(bookId, { event = null, order = null } = {}) {
  const p = new URLSearchParams();
  if (event) p.set('event', event);
  if (order && order !== 'story') p.set('order', order);
  const qs = p.toString();
  return `/books/${enc(bookId)}/timeline${qs ? `?${qs}` : ''}`;
}

/** @param {string} search the query string of the URL @returns {{ event: string | null, order: 'story' | 'book' }} */
export function parseTimelineSearch(search = '') {
  const p = new URLSearchParams(search);
  return { event: p.get('event') || null, order: p.get('order') === 'book' ? 'book' : 'story' };
}

/** Chronological order: `order`, then id; an event without a valid order goes last. */
export const byStoryTime = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || cmp(a.id, b.id) || 0;

/** The lowest manuscript position among the event's live scenes, or null (the event is not in the book yet). @param {{ scenes?: { state: string, position: number | null }[] }} event */
export function narrativePosition(event) {
  let lowest = null;
  for (const s of event.scenes ?? []) {
    if (s.state === 'live' && typeof s.position === 'number' && (lowest === null || s.position < lowest)) lowest = s.position;
  }
  return lowest;
}

/** "Chapter 2" of the scene the event is told in first (the scene at its narrative position), or null. */
function firstScene(event) {
  const live = (event.scenes ?? []).filter((s) => s.state === 'live' && typeof s.position === 'number');
  live.sort((a, b) => a.position - b.position);
  return live[0] ?? null;
}

/**
 * Everything the page needs, computed once.
 * @param {any} data GET /timeline
 * @returns {{
 *   events: any[], story: { when: string | null, events: any[] }[], book: { placed: any[], unplaced: any[] }, unordered: any[],
 *   points: { id: string, title: string, x: number, y: number }[], maxPosition: number, maxRank: number,
 *   problems: any[], byId: Map<string, any>, filters: { characters: { slug: string, name: string }[], locations: { slug: string, name: string }[], threads: { slug: string, title: string }[] },
 * }}
 */
export function buildTimeline(data) {
  const raw = [...(data?.events ?? [])].sort(byStoryTime);
  const orders = [...new Set(raw.filter((e) => e.order !== null).map((e) => e.order))];
  const rankOf = new Map(orders.map((o, i) => [o, i + 1]));
  const events = raw.map((e) => ({ ...e, position: narrativePosition(e), rank: e.order === null ? null : rankOf.get(e.order) }));
  // told early / late: an inversion between story time and book order
  const placed = events.filter((e) => e.position !== null && e.order !== null);
  for (const e of events) {
    e.told_early = e.position !== null && e.order !== null && placed.some((f) => f !== e && f.order < e.order && e.position < f.position);
    e.told_late = e.position !== null && e.order !== null && placed.some((f) => f !== e && f.order > e.order && e.position > f.position);
    const first = firstScene(e);
    e.chapter_label = first?.chapter_label ?? null;
  }
  const byId = new Map(events.map((e) => [e.id, e]));
  // story time: consecutive events with the same `when` label share a heading
  const story = [];
  for (const e of events.filter((x) => x.order !== null)) {
    const when = e.when && e.when.trim() !== '' ? e.when : null;
    const last = story[story.length - 1];
    if (last && last.when === when) last.events.push(e);
    else story.push({ when, events: [e] });
  }
  const unordered = events.filter((e) => e.order === null);
  // book order: by narrative position, then story time; the events not in the book yet in their own group
  const inBook = events.filter((e) => e.position !== null).sort((a, b) => a.position - b.position || byStoryTime(a, b));
  const unplaced = events.filter((e) => e.position === null).sort(byStoryTime);
  const points = placed.map((e) => ({ id: e.id, title: e.title ?? e.slug ?? e.id, x: e.position, y: e.rank }));
  const nameOf = (e) => ({ slug: e.slug, name: e.name ?? e.slug });
  const used = (key) => new Set(events.flatMap((e) => e[key]));
  const entries = data?.entries ?? [];
  const entryFor = (ref) => entries.find((x) => x.slug === ref || x.id === ref);
  const pick = (key) => {
    const seen = new Set();
    const out = [];
    for (const ref of used(key)) {
      const en = entryFor(ref);
      const slug = en?.slug ?? ref;
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(nameOf({ slug, name: en?.name }));
    }
    return out.sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()));
  };
  return {
    events,
    story,
    book: { placed: inBook, unplaced },
    unordered,
    points,
    maxPosition: Math.max(1, ...points.map((p) => p.x)),
    maxRank: Math.max(1, ...points.map((p) => p.y)),
    problems: timelineProblems(data, events),
    byId,
    filters: {
      characters: pick('characters'),
      locations: pick('locations'),
      threads: (data?.threads ?? []).map((t) => ({ slug: t.slug ?? t.id, title: t.title ?? t.slug ?? t.id })).sort((a, b) => cmp(a.title.toLowerCase(), b.title.toLowerCase())),
    },
  };
}

/**
 * The Problems panel, in this order per event: the diagnostics on its file (E301 broken scene or entry references, E102 bad date, warnings ...), a file that can no longer be
 * read (the last good version is shown), no valid `order`, scenes that are archived (not counted in the book), then "not in the book yet" for an event with no live scene.
 * @param {any} data GET /timeline @param {any[]} [events] the events of buildTimeline (computed here when absent)
 * @returns {{ kind: 'diagnostic' | 'unreadable' | 'no-order' | 'archived-scene' | 'unplaced', severity: 'error' | 'warning' | 'info', code: string | null, event_id: string, slug: string | null, title: string, path: string, location: string, message: string }[]}
 */
export function timelineProblems(data, events) {
  const list = events ?? buildTimeline(data).events;
  const out = [];
  for (const e of list) {
    const base = { event_id: e.id, slug: e.slug, title: e.title ?? e.slug ?? e.id, path: e.path };
    for (const p of e.problems ?? []) {
      out.push({ ...base, kind: e.stale ? 'unreadable' : 'diagnostic', severity: p.severity ?? 'error', code: p.code, location: p.location ?? '', message: e.stale ? `${p.code}: ${p.message} Showing the last valid version.` : p.message });
    }
    if (e.order === null && !e.stale) out.push({ ...base, kind: 'no-order', severity: 'error', code: 'E102', location: 'order', message: 'The order is missing or not a number, so the event is not placed in story time.' });
    const archived = (e.scenes ?? []).filter((s) => s.state === 'archived');
    if (archived.length > 0) {
      out.push({ ...base, kind: 'archived-scene', severity: 'warning', code: 'W303', location: 'scenes', message: `${archived.length === 1 ? 'A scene' : `${archived.length} scenes`} of this event ${archived.length === 1 ? 'is' : 'are'} archived: ${archived.map((s) => s.title ?? s.id).join(', ')}.` });
    }
    if (e.position === null && !e.stale) out.push({ ...base, kind: 'unplaced', severity: 'info', code: null, location: '', message: 'Not in the book yet: none of its scenes is in the manuscript.' });
  }
  for (const u of data?.unreadable ?? []) {
    if (list.some((e) => e.path === u.path)) continue;
    out.push({ kind: 'unreadable', severity: 'error', code: u.code, event_id: '', slug: null, title: u.path, path: u.path, location: '', message: `${u.code}: ${u.message}` });
  }
  return out;
}

/**
 * Filter events. `filters`: { character, location, thread } (slugs or ''), `unplacedOnly`, `hasProblems`. A thread keeps the events one of whose live scenes is in that
 * thread's setup, develop or payoff list.
 * @param {any[]} events events of buildTimeline @param {{ character?: string, location?: string, thread?: string, unplacedOnly?: boolean, hasProblems?: boolean }} filters
 * @param {any} data GET /timeline @param {any[]} problems timelineProblems()
 */
export function filterEvents(events, filters, data, problems = []) {
  const entries = data?.entries ?? [];
  const sameEntry = (ref, slug) => {
    if (ref === slug) return true;
    const en = entries.find((x) => x.slug === slug);
    return Boolean(en && ref === en.id);
  };
  const thread = filters.thread ? (data?.threads ?? []).find((t) => t.slug === filters.thread || t.id === filters.thread) : null;
  const inThread = thread ? new Set([...thread.setup, ...thread.develop, ...thread.payoff]) : null;
  const withProblems = new Set(problems.map((p) => p.event_id));
  return events.filter((e) => {
    if (filters.character && !e.characters.some((c) => sameEntry(c, filters.character))) return false;
    if (filters.location && !e.locations.some((c) => sameEntry(c, filters.location))) return false;
    if (inThread && !e.scenes.some((s) => s.state === 'live' && inThread.has(s.id))) return false;
    if (filters.unplacedOnly && e.position !== null) return false;
    if (filters.hasProblems && !withProblems.has(e.id)) return false;
    return true;
  });
}

/** Names for an event's participants: the entry's name when the book has it, else the slug as written. @param {string[]} refs @param {{ id: string, slug: string | null, name: string | null }[]} entries */
export const namesOf = (refs, entries) => refs.map((r) => entries.find((x) => x.slug === r || x.id === r)?.name ?? r);

/** The events a scene belongs to, from both sides (for the editor rail): [{ id, slug, title, when, order }] in story time. @param {any} data GET /timeline @param {string} sceneId */
export function eventsForScene(data, sceneId) {
  return [...(data?.events ?? [])]
    .filter((e) => !e.stale && e.scenes.some((s) => s.id === sceneId))
    .sort(byStoryTime)
    .map((e) => ({ id: e.id, slug: e.slug, title: e.title ?? e.slug ?? e.id, when: e.when, order: e.order }));
}

// ---------------------------------------------------------------- `order` values

const round = (n) => Number(n.toFixed(6));

/**
 * The `order` for an event dropped between two others: the midpoint of their orders (decimals allowed). The first place is the first event's order minus 10,
 * the last place the last event's order plus 10. Nothing else is renumbered, ever. `others`: the events in story time WITHOUT the moved one; `index`: the place
 * among them (0 = first). Returns { ok: true, order } or { ok: false, reason: 'no-room' } when two neighbours are too close for a distinct number.
 * @param {{ order: number | null }[]} others @param {number} index
 */
export function midpointOrder(others, index) {
  const prev = index > 0 ? others[index - 1] : null;
  const next = index < others.length ? others[index] : null;
  if (!prev && !next) return { ok: true, order: 10 };
  if (!prev) return { ok: true, order: round(next.order - 10) };
  if (!next) return { ok: true, order: round(prev.order + 10) };
  const order = round((prev.order + next.order) / 2);
  if (prev.order !== next.order && (order <= prev.order || order >= next.order)) return { ok: false, reason: 'no-room' };
  return { ok: true, order };
}

/**
 * The order change for dragging `movedId` to the place `index` among the other events (story time), or null when it would stay where it is.
 * @param {any[]} sorted the events with a valid order, in story time @param {string} movedId @param {number} index
 * @returns {{ ok: true, order: number } | { ok: false, reason: string } | null}
 */
export function reorderTo(sorted, movedId, index) {
  const moved = sorted.find((e) => e.id === movedId);
  if (!moved) return null;
  const others = sorted.filter((e) => e.id !== movedId);
  const at = Math.max(0, Math.min(others.length, index));
  const result = midpointOrder(others, at);
  if (!result.ok) return result;
  const here = sorted.indexOf(moved);
  if (at === here || result.order === moved.order) return null;
  return result;
}

/** Alt+Up / Alt+Down: move one place. `dir` -1 or 1. Null at the ends. @param {any[]} sorted @param {string} movedId @param {-1 | 1} dir */
export function reorderByStep(sorted, movedId, dir) {
  const at = sorted.findIndex((e) => e.id === movedId);
  if (at < 0) return null;
  const target = at + dir;
  if (target < 0 || target >= sorted.length) return null;
  return reorderTo(sorted, movedId, target);
}

/**
 * The default `order` of a new event: after the selected event (halfway to the next one, or +10 at the end), or last + 10 (10 for the first event).
 * @param {any[]} sorted events with a valid order, in story time @param {string | null} [afterId]
 */
export function defaultOrder(sorted, afterId = null) {
  if (sorted.length === 0) return 10;
  const at = afterId ? sorted.findIndex((e) => e.id === afterId) : -1;
  if (at < 0) return round(sorted[sorted.length - 1].order + 10);
  const next = sorted[at + 1];
  if (!next || next.order <= sorted[at].order) return round(sorted[at].order + 10);
  return round((sorted[at].order + next.order) / 2);
}

/** "150", "125.5": an order as the line shows it. @param {number | null} order */
export const orderLabel = (order) => (order === null ? 'no order' : String(round(order)));

/** The date shown next to `when`: "1998-07-21" as written, or nothing. @param {{ when?: string | null, date?: string | null }} e */
export const whenLabel = (e) => [e.when, e.date].filter((x) => typeof x === 'string' && x.trim() !== '').join(' · ');

/** Participants as short text for the card's tooltip. @param {{ name: string }[]} names */
export const joinNames = (names) => names.join(', ');
