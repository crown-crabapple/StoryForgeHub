// Timeline (spec 6.2): chronological order and narrative position of events.

/**
 * @param {import('./load.mjs').Doc[]} docs documents of one book
 * @param {Map<import('./load.mjs').Doc, Set<import('./load.mjs').Doc>>} eventScenes
 * @param {Map<import('./load.mjs').Doc, number>} positions scene doc -> 1-based position in the order
 */
export function buildTimeline(docs, eventScenes, positions) {
  const events = docs.filter(
    (d) => d.kind === 'event' && !d.archived && typeof d.fm.slug === 'string' &&
      typeof d.fm.order === 'number' && Number.isFinite(d.fm.order),
  );
  events.sort((a, b) => a.fm.order - b.fm.order || cmp(String(a.fm.id), String(b.fm.id)));
  return events.map((e) => {
    let lowest = null;
    for (const s of eventScenes.get(e) ?? []) {
      const p = positions.get(s);
      if (p !== undefined && (lowest === null || p < lowest)) lowest = p;
    }
    return { slug: e.fm.slug, order: e.fm.order, narrative_position: lowest };
  });
}

/** @param {string} a @param {string} b */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
