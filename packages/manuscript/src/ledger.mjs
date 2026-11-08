// AI workspace ledgers (M12 W3): a scene's chapter cast (`cast` front-matter list) and the state items of a chapter's "Chapter N (state)" event.
// Both go through the store as one batch with a dry run, are refused when they would add a validation error, and never delete: a cast is replaced as that
// key's own block (nothing else in the scene file changes, the prose is never read for writing), and state items are only ever appended to the event's `state`
// block (retiring a state is a new item that ends it). YAML is never re-serialised.
import { CAST_ROLES } from '@storyforge/format';
import { formatYamlString, formatYamlText } from './frontmatter.mjs';
import { frontOf, prepareCodex, replaceFrontMatterBlock, slugTaken, stale } from './codex.mjs';
import { fail, finish, guarded, prepare, readBytes } from './ops.mjs';
import { SLUG_RE, ulid } from './util.mjs';

/** The state words the ledger writes (knows / learns are the knowledge ledger's). Valued ones need a codex slug as `value` (holder may also be ""). */
export const STATE_KINDS = ['died', 'revived', 'destroyed', 'lost', 'found', 'holder', 'location'];
const VALUED = new Set(['holder', 'location']);
const MAX_ITEMS = 200;
/** Where a scene file gets its `cast` list when it has none. */
const SCENE_CAST_AFTER = ['events', 'plot_threads', 'locations', 'characters', 'pov', 'status'];
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const entryOf = (docs, shared, ref) => [...docs, ...(shared?.docs ?? [])].find((d) => d.kind === 'entry' && !d.archived && (d.fm.id === ref || d.fm.slug === ref));
const chapterSceneIds = (docs, chapter) => docs
  .filter((d) => d.kind === 'scene' && !d.archived && d.fm.chapter === chapter && typeof d.fm.id === 'string')
  .sort((a, b) => (a.fm.act ?? 0) - (b.fm.act ?? 0) || (a.fm.sequence ?? 0) - (b.fm.sequence ?? 0))
  .map((d) => d.fm.id);

/** The slug of a chapter's state event. @param {number} chapter */
export const stateEventSlug = (chapter) => `chapter-${chapter}-state`;
/** The title of a chapter's state event. @param {number} chapter */
export const stateEventTitle = (chapter) => `Chapter ${chapter} (state)`;

// ------------------------------------------------------------------ setSceneCast

/**
 * Replace a scene's `cast` list: [{ entry: <entry id or slug>, role: pov | appears | mentioned }] (at most one pov, an entry once, at most 200). An empty list
 * removes the block. Only the `cast` key of the scene file changes; the body is never touched. An entry that is not a live entry of the book (or its series):
 * REFUSED_UNKNOWN_ENTRY (with the item `index`). `baseSha256`: the scene file as it was read; another file on disk is CONFLICT.
 * @param {string} bookRoot @param {string} sceneId
 * @param {{ cast: { entry: string, role: string }[], baseSha256?: string, dryRun?: boolean }} args
 */
export function setSceneCast(bookRoot, sceneId, args = {}) {
  return guarded(async () => {
    const { cast, baseSha256, dryRun = false } = args ?? {};
    if (typeof sceneId !== 'string') return fail('REFUSED_BAD_ARGS', 'sceneId must be a string');
    if (!Array.isArray(cast) || cast.length > MAX_ITEMS) return fail('REFUSED_BAD_ARGS', `cast must be a list of up to ${MAX_ITEMS} items`, { field: 'cast' });
    if (baseSha256 !== undefined && baseSha256 !== null && (typeof baseSha256 !== 'string' || baseSha256 === '')) return fail('REFUSED_BAD_ARGS', 'base_sha256 must be a string', { field: 'base_sha256' });
    let povs = 0;
    const seen = new Set();
    for (const [i, m] of cast.entries()) {
      if (!isMap(m)) return fail('REFUSED_BAD_ARGS', `cast[${i}] must be an object with entry and role`, { field: `cast[${i}]`, index: i });
      if (typeof m.entry !== 'string' || m.entry.trim() === '' || m.entry.length > 200 || /[\x00-\x1f\x7f]/.test(m.entry)) return fail('REFUSED_BAD_ARGS', `cast[${i}].entry must be an entry id or slug`, { field: `cast[${i}].entry`, index: i });
      if (!CAST_ROLES.includes(m.role)) return fail('REFUSED_BAD_ARGS', `cast[${i}].role must be one of ${CAST_ROLES.join(', ')}`, { field: `cast[${i}].role`, index: i });
      for (const key of Object.keys(m)) if (key !== 'entry' && key !== 'role') return fail('REFUSED_BAD_ARGS', `unknown cast field ${key}; the fields are entry, role`, { field: `cast[${i}].${key}`, index: i });
      if (m.role === 'pov' && ++povs > 1) return fail('REFUSED_BAD_ARGS', 'a scene has at most one pov in its cast', { field: `cast[${i}].role`, index: i });
      if (seen.has(m.entry)) return fail('REFUSED_BAD_ARGS', `${m.entry} is in the cast twice`, { field: `cast[${i}].entry`, index: i });
      seen.add(m.entry);
    }
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const scene = lb.book.order.find((s) => s.id === sceneId);
    if (!scene) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${sceneId} in the book order`);
    for (const [i, m] of cast.entries()) {
      if (!entryOf(lb.docs, lb.shared, m.entry)) return fail('REFUSED_UNKNOWN_ENTRY', `no codex entry ${m.entry}`, { field: `cast[${i}].entry`, index: i, entry: m.entry });
    }
    const before = await readBytes(store, scene.path);
    const changed = stale(before, baseSha256 ?? undefined, scene.path);
    if (changed) return changed;
    let buf = before;
    if (cast.length > 0 || /^cast:/m.test(frontOf(buf))) {
      const lines = cast.length === 0 ? [] : ['cast:', ...cast.flatMap((m) => [`  - entry: ${formatYamlString(m.entry)}`, `    role: ${m.role}`])];
      const r = replaceFrontMatterBlock(buf, 'cast', lines, { after: SCENE_CAST_AFTER });
      if (!r.ok) return fail(r.code, `${scene.path}: ${r.message}`, { file: scene.path, field: 'cast' });
      buf = r.buf;
    }
    const changes = buf.equals(before) ? [] : [{ from: scene.path, to: scene.path, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'setSceneCast', args: { sceneId, cast: cast.length }, changes, dryRun, withDiff: true, extra: { id: sceneId, path: scene.path } });
  });
}

// ------------------------------------------------------------------ recordEventState

/** One state item as it is written: slug, event, value (only the keys the item has, in that order). */
const itemLines = (item, first) => {
  const keys = ['slug', 'event', 'value', ...Object.keys(item).filter((k) => !['slug', 'event', 'value'].includes(k))];
  const out = [];
  for (const k of keys) {
    const v = item[k];
    if (v === undefined || v === null) continue;
    let text;
    if (typeof v === 'string') text = k === 'value' ? formatYamlText(v, { flow: true }) : formatYamlString(v);
    else if (typeof v === 'number' || typeof v === 'boolean') text = String(v);
    else continue;
    out.push(`${out.length === 0 && first ? '  - ' : '    '}${k}: ${text}`);
  }
  return out;
};
const sameItem = (a, b) => a.slug === b.slug && a.event === b.event && (a.value ?? null) === (b.value ?? null);

/**
 * Append state items to the "Chapter N (state)" event (slug chapter-N-state, order N, scenes: the chapter's first scene), creating it when missing. Items are
 * { slug: <character/object entry slug or id>, event: died | revived | destroyed | lost | found | holder | location | learns | knows, value? }: `value` is the fact key for
 * learns / knows (a slug-shaped key), a codex entry slug for holder (or "") and location, and absent for the rest. An item already in the event is not added twice.
 * Existing items are kept as they are; nothing is ever removed (retiring a state is a later item that ends it). The event's text (its body) is not touched.
 * Refusals: REFUSED_BAD_ARGS (with `index`), REFUSED_UNKNOWN_CHAPTER, REFUSED_UNKNOWN_ENTRY (with `index`), SLUG_TAKEN (another entry, thread or event uses chapter-N-state),
 * and ROLLED_BACK when the check after the write finds a new error (e.g. a holder that is not a character).
 * @param {string} bookRoot
 * @param {{ chapter: number, items: { slug: string, event: string, value?: string }[], allowKnowledge?: boolean, dryRun?: boolean }} args
 */
export function recordEventState(bookRoot, args = {}) {
  return guarded(async () => {
    const { chapter, items, allowKnowledge = false, dryRun = false } = args ?? {};
    if (!Number.isInteger(chapter) || chapter < 0 || chapter > 99999) return fail('REFUSED_BAD_ARGS', 'chapter must be a whole number >= 0', { field: 'chapter' });
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) return fail('REFUSED_BAD_ARGS', `items must be a list of 1 to ${MAX_ITEMS} state items`, { field: 'items' });
    const kinds = allowKnowledge ? [...STATE_KINDS, 'learns', 'knows'] : STATE_KINDS;
    for (const [i, m] of items.entries()) {
      const at = (k) => `items[${i}].${k}`;
      if (!isMap(m)) return fail('REFUSED_BAD_ARGS', `items[${i}] must be an object with slug and event`, { field: `items[${i}]`, index: i });
      if (typeof m.slug !== 'string' || m.slug.trim() === '' || m.slug.length > 200 || /[\x00-\x1f\x7f]/.test(m.slug)) return fail('REFUSED_BAD_ARGS', `${at('slug')} must be an entry slug or id`, { field: at('slug'), index: i });
      if (!kinds.includes(m.event)) return fail('REFUSED_BAD_ARGS', `${at('event')} must be one of ${kinds.join(', ')}`, { field: at('event'), index: i });
      for (const key of Object.keys(m)) if (!['slug', 'event', 'value'].includes(key)) return fail('REFUSED_BAD_ARGS', `unknown state field ${key}; the fields are slug, event, value`, { field: at(key), index: i });
      const hasValue = m.value !== undefined && m.value !== null;
      if (m.event === 'learns' || m.event === 'knows') {
        if (typeof m.value !== 'string' || !SLUG_RE.test(m.value) || m.value.length > 60) return fail('REFUSED_BAD_ARGS', `${at('value')} must be a fact key (a-z, 0-9, single hyphens, up to 60 characters)`, { field: at('value'), index: i });
      } else if (VALUED.has(m.event)) {
        if (typeof m.value !== 'string' || (m.value === '' && m.event !== 'holder') || m.value.length > 200 || /[\x00-\x1f\x7f]/.test(m.value)) return fail('REFUSED_BAD_ARGS', `${at('value')} must be a codex entry slug or id${m.event === 'holder' ? ' (or "" for nobody)' : ''}`, { field: at('value'), index: i });
      } else if (hasValue) return fail('REFUSED_BAD_ARGS', `${at('value')}: ${m.event} takes no value`, { field: at('value'), index: i });
    }
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs, shared } = prep;
    const sceneIds = chapterSceneIds(docs, chapter);
    if (sceneIds.length === 0) return fail('REFUSED_UNKNOWN_CHAPTER', `no chapter ${chapter} in the book`, { chapter });
    for (const [i, m] of items.entries()) {
      if (!entryOf(docs, shared, m.slug)) return fail('REFUSED_UNKNOWN_ENTRY', `no codex entry ${m.slug}`, { field: `items[${i}].slug`, index: i, entry: m.slug });
      if (VALUED.has(m.event) && m.value !== '' && !entryOf(docs, shared, m.value)) return fail('REFUSED_UNKNOWN_ENTRY', `no codex entry ${m.value}`, { field: `items[${i}].value`, index: i, entry: m.value });
    }

    const slug = stateEventSlug(chapter);
    const doc = docs.find((d) => d.kind === 'event' && !d.archived && d.fm.slug === slug);
    const existing = doc && Array.isArray(doc.fm.state) ? doc.fm.state.filter(isMap) : [];
    const fresh = [];
    for (const m of items) {
      const item = { slug: m.slug, event: m.event, ...(m.value !== undefined && m.value !== null ? { value: m.value } : {}) };
      if (![...existing, ...fresh].some((x) => sameItem(x, item))) fresh.push(item);
    }
    const stateLines = (list) => ['state:', ...list.flatMap((item) => itemLines(item, true))];
    let changes;
    let extra;
    if (doc) {
      if (fresh.length === 0) {
        return finish({ bookRoot, store, lb, op: 'recordEventState', args: { chapter, items: items.length }, changes: [], dryRun, withDiff: true, extra: { id: doc.fm.id, slug, path: doc.rel, added: 0 } });
      }
      const before = await readBytes(store, doc.rel);
      const rendered = stateLines([...existing, ...fresh]);
      const r = replaceFrontMatterBlock(before, 'state', rendered, { after: ['locations', 'characters', 'scenes', 'date', 'when', 'order'] });
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: 'state' });
      changes = [{ from: doc.rel, to: doc.rel, content: r.buf, before }];
      extra = { id: doc.fm.id, slug, path: doc.rel, added: fresh.length, created: false };
    } else {
      if (slugTaken(docs, slug)) return fail('SLUG_TAKEN', `the slug "${slug}" is already used by another entry, thread or event`, { slug });
      const id = `event_${ulid()}`;
      const to = `planning/timeline/${slug}.md`;
      const text = `---\nschema: storyforge.event/v1\nid: ${id}\nslug: ${slug}\ntitle: ${formatYamlText(stateEventTitle(chapter))}\norder: ${chapter}\nscenes: [${sceneIds[0]}]\n${stateLines(fresh).join('\n')}\n---\n`;
      changes = [{ from: null, to, content: Buffer.from(text, 'utf8'), before: null }];
      extra = { id, slug, path: to, added: fresh.length, created: true };
    }
    return finish({ bookRoot, store, lb, op: 'recordEventState', args: { chapter, items: items.length }, changes, dryRun, withDiff: true, extra });
  });
}
