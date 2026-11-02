// Narrative state derived from timeline events (FORMAT-v1 6.2 `state` items). Pure; reads only the model.
// Only events with a narrative chapter (placed by a scene) before the target chapter take part; an unplaced
// event has no position in the story and is left out.

/** @typedef {import('./model.mjs').Model} Model */

/**
 * @typedef {{ slug: string, event: string, value: string, chapter: number, note: string, when: string, order: number }} StateItem
 */

const whenOf = (e) => {
  const w = e.fm.when;
  if (typeof w === 'string' && w.trim() !== '') return w.trim();
  const d = e.fm.date;
  if (typeof d === 'string' && d.trim() !== '') return d.trim();
  return `order ${e.fm.order}`;
};

/**
 * Events whose narrative chapter satisfies `keep`, in story-time order, with their state items.
 * @param {Model} model @param {(chapter: number) => boolean} keep
 * @returns {{ ev: import('@storyforge/format').Doc, chapter: number, when: string, items: StateItem[] }[]}
 */
export function placedEvents(model, keep) {
  const out = [];
  for (const ev of model.events) {
    const chapter = model.narrativeChapter(ev);
    if (chapter === null || !keep(chapter)) continue;
    const items = [];
    for (const raw of Array.isArray(ev.fm.state) ? ev.fm.state : []) {
      if (!raw || typeof raw !== 'object' || typeof raw.slug !== 'string' || typeof raw.event !== 'string') continue;
      items.push({
        slug: raw.slug,
        event: raw.event,
        value: typeof raw.value === 'string' ? raw.value : '',
        chapter,
        note: String(ev.fm.title ?? ''),
        when: whenOf(ev),
        order: ev.fm.order,
      });
    }
    out.push({ ev, chapter, when: whenOf(ev), items });
  }
  return out;
}

/**
 * Everything derived from the events before chapter n.
 * @param {Model} model @param {number} n
 */
export function deriveState(model, n) {
  const events = placedEvents(model, (c) => c < n);
  /** @type {Map<string, {dead: boolean, location: string|null}>} */
  const characters = new Map();
  /** @type {Map<string, {holder: string|null, location: string|null, lost: boolean, destroyed: boolean}>} */
  const things = new Map();
  /** @type {Map<string, {fact: string, chapter: number}[]>} */
  const knowledge = new Map();

  const thing = (slug) => {
    if (!things.has(slug)) things.set(slug, { holder: null, location: null, lost: false, destroyed: false });
    return things.get(slug);
  };
  const person = (slug) => {
    if (!characters.has(slug)) characters.set(slug, { dead: false, location: null });
    return characters.get(slug);
  };

  for (const { items } of events) {
    for (const it of items) {
      switch (it.event) {
        case 'died': person(it.slug).dead = true; break;
        case 'revived': person(it.slug).dead = false; break;
        case 'destroyed': thing(it.slug).destroyed = true; break;
        case 'lost': thing(it.slug).lost = true; break;
        case 'found': thing(it.slug).lost = false; break;
        case 'holder': thing(it.slug).holder = it.value === '' ? null : it.value; break;
        case 'location':
          if (model.find(it.slug, ['entry'])?.fm.type === 'character') person(it.slug).location = it.value;
          else thing(it.slug).location = it.value;
          break;
        case 'learns': {
          if (!knowledge.has(it.slug)) knowledge.set(it.slug, []);
          const list = knowledge.get(it.slug);
          if (!list.some((f) => f.fact === it.value)) list.push({ fact: it.value, chapter: it.chapter });
          break;
        }
        default: break;
      }
    }
  }
  return { events, characters, things, knowledge };
}
