// Timeline-event commands (M04-J04): new event, event fields (title, when, order, date, characters, locations, scenes), archive / restore.
// Every one has a dry run, goes through the store (one batch, one opId), is refused when it would add a validation error, and never deletes.
// `order` is a single plain-number line, so moving an event between two others changes that one line and nothing else (other events are never
// renumbered). A list is replaced as that key's own block; with `twoSided` the scenes' own `events` lists are kept in step (a scene file is
// edited the same way, one block). YAML is never re-serialised, and the event's text (the body) is not touched here.
import { editFrontMatterLine, formatYamlText } from './frontmatter.mjs';
import { flowList, frontOf, prepareCodex, replaceFrontMatterBlock, slugTaken, stale } from './codex.mjs';
import { fail, finish, guarded, readBytes } from './ops.mjs';
import { SLUG_RE, slugify, ulid } from './util.mjs';

const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const isText = (v) => typeof v === 'string' && !CONTROL_RE.test(v);
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SCENE_REF_RE = /^scene_[0-9A-HJKMNP-TV-Z]{26}$/;
/** Where each list goes when the file does not have it yet (after the first of these that exists). */
const LIST_AFTER = { scenes: ['date', 'when', 'order', 'title'], characters: ['scenes', 'date', 'when', 'order'], locations: ['characters', 'scenes', 'date', 'when', 'order'] };
/** Where a scene file gets its `events` list when it has none. */
const SCENE_EVENTS_AFTER = ['plot_threads', 'locations', 'characters', 'pov', 'status'];

const findEvent = (docs, ref, archived = false) => docs.find((d) => d.kind === 'event' && d.archived === archived && (d.fm.id === ref || d.fm.slug === ref || (archived && d.rel === ref))) ?? null;

/** An `order` as the line's text: a finite number with at most 10 decimals, no exponent. Null when it cannot be written plainly. */
export function orderText(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) >= 1e14) return null;
  const rounded = Number(n.toFixed(10));
  const text = String(rounded === 0 ? 0 : rounded);
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

const dateOk = (v) => v === '' || /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(v);
const listOk = (v, re) => Array.isArray(v) && v.length <= 1000 && v.every((x) => typeof x === 'string' && x !== '' && isText(x) && (re ? re.test(x) : true));

// ------------------------------------------------------------------ createEvent

/**
 * New event file planning/timeline/<slug>.md: schema, id, slug, title, order, when, date (only those given) and empty scenes / characters / locations
 * lists, an empty body. `order` defaults to the last live event's order + 10 (10 for the first). A slug used by another entry, thread or event: SLUG_TAKEN.
 * @param {string} bookRoot
 * @param {{ title: string, slug?: string, order?: number, when?: string, date?: string, scenes?: string[], characters?: string[], locations?: string[], dryRun?: boolean }} args
 */
export function createEvent(bookRoot, args = {}) {
  return guarded(async () => {
    const { title, slug: given, order, when, date, scenes = [], characters = [], locations = [], dryRun = false } = args ?? {};
    if (!isText(title) || title.trim() === '' || title.length > 300) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters (max 300)');
    const slug = given !== undefined && given !== null && given !== '' ? given : slugify(title);
    if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 60) {
      return fail('REFUSED_BAD_ARGS', given ? 'slug must be lower-case letters, digits and single hyphens (1-60 characters)' : 'the title has no letters or digits to make a slug from; give a slug');
    }
    if (order !== undefined && orderText(order) === null) return fail('REFUSED_BAD_ARGS', 'order must be a finite number');
    if (when !== undefined && (!isText(when) || when.length > 200)) return fail('REFUSED_BAD_ARGS', 'when must be text without control characters (max 200)');
    if (date !== undefined && !(typeof date === 'string' && dateOk(date))) return fail('REFUSED_BAD_ARGS', 'date must be "" or YYYY, YYYY-MM or YYYY-MM-DD');
    if (!listOk(scenes, SCENE_REF_RE)) return fail('REFUSED_BAD_ARGS', 'scenes must be a list of scene ids');
    if (!listOk(characters) || !listOk(locations)) return fail('REFUSED_BAD_ARGS', 'characters and locations must be lists of codex slugs or ids');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    if (slugTaken(docs, slug)) return fail('SLUG_TAKEN', `the slug "${slug}" is already used by another entry, thread or event`, { slug });
    const bad = unknownRefs(docs, { scenes, characters, locations });
    if (bad) return bad;

    const live = docs.filter((d) => d.kind === 'event' && !d.archived && typeof d.fm.order === 'number' && Number.isFinite(d.fm.order));
    const at = order ?? (live.length === 0 ? 10 : Math.max(...live.map((d) => d.fm.order)) + 10);
    const id = `event_${ulid()}`;
    const to = `planning/timeline/${slug}.md`;
    const q = (v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
    const text =
      `---\nschema: storyforge.event/v1\nid: ${id}\nslug: ${formatYamlText(slug)}\ntitle: ${formatYamlText(title)}\norder: ${orderText(at)}\n` +
      `${when !== undefined && when !== '' ? `when: ${q(when)}\n` : ''}${date !== undefined && date !== '' ? `date: ${q(date)}\n` : ''}` +
      `${flowList('scenes', scenes)[0]}\n${flowList('characters', characters)[0]}\n${flowList('locations', locations)[0]}\n---\n`;
    const changes = [{ from: null, to, content: Buffer.from(text, 'utf8'), before: null }];
    return finish({ bookRoot, store, lb, op: 'createEvent', args: { title, slug, order: at }, changes, dryRun, withDiff: true, extra: { id, slug, order: Number(orderText(at)), path: to } });
  });
}

/** Refuse a scene / entry the book does not have: null when all exist. */
function unknownRefs(docs, { scenes = [], characters = [], locations = [] }) {
  const liveScenes = new Set(docs.filter((d) => d.kind === 'scene' && !d.archived && typeof d.fm.id === 'string').map((d) => d.fm.id));
  const missingScene = scenes.find((id) => !liveScenes.has(id));
  if (missingScene) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${missingScene} in the book`, { scene: missingScene });
  const entries = docs.filter((d) => d.kind === 'entry' && !d.archived);
  const missing = [...characters, ...locations].find((c) => !entries.some((e) => e.fm.slug === c || e.fm.id === c));
  return missing ? fail('REFUSED_UNKNOWN_ENTRY', `no codex entry ${missing}`, { entry: missing }) : null;
}

// ------------------------------------------------------------------ setEventFields

/**
 * Edit an event's front matter. `title`, `when`, `date`, `order`: their own line (`order` a plain number; decimals allowed, rounded to 10 places).
 * `scenes` (scene ids), `characters` and `locations` (codex slugs or ids): that key's block is replaced, nothing else; a key the file lacks is inserted after
 * the previous one (an empty list for a missing key changes nothing). `add` / `remove` ({ scenes?: string[] }) change the file's current `scenes` list instead of
 * replacing it, so an item the author wrote by hand that does not resolve is kept. `twoSided: true` keeps the scenes' own `events` lists in step for every scene
 * added to / removed from the event (the scene file's `events` block is replaced; an unsimple block: REFUSED_UNSIMPLE_FIELD, nothing is written).
 * `baseSha256`: the event file as the author saw it; another file on disk is CONFLICT.
 * @param {string} bookRoot @param {string} ref event id or slug
 * @param {{ title?: string, when?: string, date?: string, order?: number, scenes?: string[], characters?: string[], locations?: string[],
 *   add?: { scenes?: string[] }, remove?: { scenes?: string[] }, twoSided?: boolean, dryRun?: boolean, baseSha256?: string }} args
 */
export function setEventFields(bookRoot, ref, args = {}) {
  return guarded(async () => {
    const { title, when, date, order, scenes, characters, locations, add, remove, twoSided = false, dryRun = false, baseSha256 } = args ?? {};
    if (typeof ref !== 'string' || ref === '') return fail('REFUSED_BAD_ARGS', 'the event must be an id or slug');
    if ([title, when, date, order, scenes, characters, locations, add, remove].every((v) => v === undefined)) return fail('REFUSED_BAD_ARGS', 'nothing to change');
    if (title !== undefined && (!isText(title) || title.trim() === '' || title.length > 300)) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters (max 300)');
    if (when !== undefined && (!isText(when) || when.length > 200)) return fail('REFUSED_BAD_ARGS', 'when must be text without control characters (max 200)');
    if (date !== undefined && !(typeof date === 'string' && dateOk(date))) return fail('REFUSED_BAD_ARGS', 'date must be "" or YYYY, YYYY-MM or YYYY-MM-DD');
    if (order !== undefined && orderText(order) === null) return fail('REFUSED_BAD_ARGS', 'order must be a finite number');
    if (scenes !== undefined && !listOk(scenes, SCENE_REF_RE)) return fail('REFUSED_BAD_ARGS', 'scenes must be a list of scene ids');
    if (characters !== undefined && !listOk(characters)) return fail('REFUSED_BAD_ARGS', 'characters must be a list of codex slugs or ids');
    if (locations !== undefined && !listOk(locations)) return fail('REFUSED_BAD_ARGS', 'locations must be a list of codex slugs or ids');
    for (const [name, delta] of [['add', add], ['remove', remove]]) {
      if (delta === undefined) continue;
      if (!isMap(delta) || Object.keys(delta).some((k) => k !== 'scenes') || !listOk(delta.scenes ?? [], SCENE_REF_RE) || delta.scenes === undefined) {
        return fail('REFUSED_BAD_ARGS', `${name} must be { scenes: [scene ids] }`);
      }
    }
    if (typeof twoSided !== 'boolean') return fail('REFUSED_BAD_ARGS', 'twoSided must be true or false');

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findEvent(docs, ref);
    if (!doc) return fail('REFUSED_UNKNOWN_EVENT', `no event ${ref}`);
    const bad = unknownRefs(docs, { scenes: [...(scenes ?? []), ...(add?.scenes ?? [])], characters: characters ?? [], locations: locations ?? [] });
    if (bad) return bad;

    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    let buf = before;
    const line = (key, value, opts) => {
      if (value === undefined) return null;
      if ((key === 'when' || key === 'date') && value === '' && !new RegExp(`^${key}:`, 'm').test(frontOf(buf))) return null;
      const r = editFrontMatterLine(buf, key, value, opts);
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: r.field });
      buf = r.buf;
      return null;
    };
    for (const badLine of [
      line('title', title, { anchors: ['slug', 'id'], plain: true }),
      line('order', order === undefined ? undefined : orderText(order), { anchors: ['title', 'slug'], number: true }),
      line('when', when, { anchors: ['order', 'title'] }),
      line('date', date, { anchors: ['when', 'order', 'title'] }),
    ]) if (badLine) return badLine;

    const has = (key) => new RegExp(`^${key}:`, 'm').test(frontOf(buf));
    const current = () => (Array.isArray(doc.fm.scenes) ? doc.fm.scenes.filter((x) => typeof x === 'string') : []);
    let nextScenes = scenes;
    if (nextScenes === undefined && (add || remove)) {
      const drop = new Set(remove?.scenes ?? []);
      nextScenes = current().filter((x) => !drop.has(x));
      for (const id of add?.scenes ?? []) if (!nextScenes.includes(id)) nextScenes.push(id);
    }
    const lists = { scenes: nextScenes, characters, locations };
    for (const key of ['scenes', 'characters', 'locations']) {
      let list = lists[key];
      if (list === undefined) continue;
      list = list.filter((x, i) => list.indexOf(x) === i);
      if (list.length === 0 && !has(key)) continue; // an empty list for a key the file does not have changes nothing
      const r = replaceFrontMatterBlock(buf, key, flowList(key, list), { after: LIST_AFTER[key] });
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: key });
      buf = r.buf;
    }
    const changes = buf.equals(before) ? [] : [{ from: doc.rel, to: doc.rel, content: buf, before }];

    if (twoSided && (add?.scenes?.length || remove?.scenes?.length || scenes !== undefined)) {
      const now = new Set(nextScenes ?? []);
      const was = new Set(current());
      const toAdd = [...now].filter((id) => !was.has(id));
      const toRemove = [...was].filter((id) => !now.has(id)).concat((remove?.scenes ?? []).filter((id) => !was.has(id)));
      const names = new Set([doc.fm.slug, doc.fm.id, ...(Array.isArray(doc.fm.previous_slugs) ? doc.fm.previous_slugs : [])].filter((x) => typeof x === 'string'));
      for (const [ids, adding] of [[toAdd, true], [[...new Set(toRemove)], false]]) {
        for (const id of ids) {
          const scene = docs.find((d) => d.kind === 'scene' && !d.archived && d.fm.id === id);
          if (!scene) continue;
          const old = Array.isArray(scene.fm.events) ? scene.fm.events.filter((x) => typeof x === 'string') : [];
          const mentions = old.some((x) => names.has(x));
          if (adding === mentions) continue; // already in step
          const list = adding ? [...old, doc.fm.slug] : old.filter((x) => !names.has(x));
          const sceneBefore = await readBytes(store, scene.rel);
          const r = replaceFrontMatterBlock(sceneBefore, 'events', flowList('events', list), { after: SCENE_EVENTS_AFTER });
          if (!r.ok) return fail(r.code, `${scene.rel}: ${r.message}`, { file: scene.rel, field: 'events' });
          if (r.changed) changes.push({ from: scene.rel, to: scene.rel, content: r.buf, before: sceneBefore });
        }
      }
    }
    return finish({
      bookRoot,
      store,
      lb,
      op: 'setEventFields',
      args: { ref, title, when, date, order, scenes: scenes?.length, characters: characters?.length, locations: locations?.length, add, remove, twoSided },
      changes,
      dryRun,
      withDiff: true,
      extra: { id: doc.fm.id, path: doc.rel },
    });
  });
}

// ------------------------------------------------------------------ archive / restore

/**
 * Move an event to archive/ (never deleted). Scenes that name it keep working; the link then resolves with W303.
 * @param {string} bookRoot @param {string} ref event id or slug @param {{ dryRun?: boolean, baseSha256?: string }} args
 */
export function archiveEvent(bookRoot, ref, args = {}) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (typeof ref !== 'string' || ref === '') return fail('REFUSED_BAD_ARGS', 'the event must be an id or slug');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findEvent(docs, ref);
    if (!doc) return fail('REFUSED_UNKNOWN_EVENT', `no event ${ref}`);
    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    return finish({ bookRoot, store, lb, op: 'archiveEvent', args: { ref }, changes: [{ from: doc.rel, to: `archive/${doc.rel}`, content: before, before }], dryRun, withDiff: true, extra: { id: doc.fm.id, path: `archive/${doc.rel}` } });
  });
}

/**
 * Move an archived event back. A slug now used by a live entry, thread or event: SLUG_TAKEN.
 * @param {string} bookRoot @param {string} ref archived event id, slug or archived path @param {{ dryRun?: boolean, baseSha256?: string }} args
 */
export function restoreEvent(bookRoot, ref, args = {}) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (typeof ref !== 'string' || ref === '') return fail('REFUSED_BAD_ARGS', 'the event must be an id or slug');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findEvent(docs, ref, true);
    if (!doc) return fail('REFUSED_UNKNOWN_EVENT', `no archived event ${ref}`);
    if (typeof doc.fm.slug === 'string' && slugTaken(docs, doc.fm.slug, doc)) {
      return fail('SLUG_TAKEN', `the slug "${doc.fm.slug}" is used by another entry, thread or event now; change that one first`, { slug: doc.fm.slug });
    }
    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    return finish({ bookRoot, store, lb, op: 'restoreEvent', args: { ref }, changes: [{ from: doc.rel, to: doc.rel.slice('archive/'.length), content: before, before }], dryRun, withDiff: true, extra: { id: doc.fm.id, path: doc.rel.slice('archive/'.length) } });
  });
}
