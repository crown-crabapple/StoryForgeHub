// Story Planner commands (ADR 0003, M1): causal links (planning/links/<slug>.md) and scene plan sidecars (planning/scene-plans/<scene>.md).
// Every command goes through the store: one batch with a dry run, refused when it would add a validation error, never deleting. Edits are byte edits of
// the front matter (editFrontMatterLine, replaceFrontMatterBlock); YAML is never re-serialised. A scene file is never read for writing or written here.
import { flowList, prepareCodex, replaceFrontMatterBlock, stale as staleBare } from './codex.mjs';
import { editFrontMatterLine, formatYamlText, splitDocument } from './frontmatter.mjs';
import { fail, finish, guarded, readBytes } from './ops.mjs';
import { sceneSlugOf } from './paths.mjs';
import { STRUCTURE_TEMPLATES, templateById } from './structure-templates.mjs';
import { SLUG_RE, sha256, slugify, ulid } from './util.mjs';

/** CONFLICT with the file as it is now ({ sha256, text }), so the author can see what changed (ADR 0003 D05); null when the sha matches. */
const stale = (before, baseSha256, rel) => {
  const r = staleBare(before, baseSha256, rel);
  return r ? { ...r, current: { sha256: sha256(before), text: before.toString('utf8') } } : null;
};

export const LINK_RELATIONS = ['therefore', 'but', 'enables', 'reveals', 'motivates', 'prevents', 'foreshadows', 'pays_off', 'parallel', 'other'];
/** The planning keys of a scene plan, in the order they are written. */
export const PLAN_FIELDS = ['goal', 'opposition', 'conflict', 'turn', 'outcome', 'consequence', 'stakes', 'emotional_start', 'emotional_end', 'purpose'];
export const LINK_DIR = 'planning/links';
export const PLAN_DIR = 'planning/scene-plans';

const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const BODY_BAD_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const isText = (v) => typeof v === 'string' && !CONTROL_RE.test(v);
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const okSlug = (s) => typeof s === 'string' && SLUG_RE.test(s) && s.length <= 60;
const today = () => new Date().toISOString().slice(0, 10);

/** Book-relative path of a live link. @param {string} slug */
export const linkPath = (slug) => `${LINK_DIR}/${slug}.md`;
const stem = (rel) => rel.replace(/[.]md$/, '');

/** `base` cut to `max` characters at a hyphen boundary (a hard cut when there is no hyphen). */
function cutSlug(base, max) {
  if (base.length <= max) return base;
  if (base[max] === '-') return base.slice(0, max);
  const head = base.slice(0, max);
  const i = head.lastIndexOf('-');
  return i > 0 ? head.slice(0, i) : head;
}

/** A name not used by a live or archived file: `base`, then base-2, base-3, ... each cut to fit 60 characters. */
async function freeName(store, base, pathOf) {
  for (let n = 1; n < 10000; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const name = `${cutSlug(base, 60 - suffix.length)}${suffix}`;
    if (!(await store.exists(pathOf(name))) && !(await store.exists(`archive/${pathOf(name)}`))) return name;
  }
  throw new Error('no free file name');
}

const liveScenes = (lb) => new Map(lb.book.order.map((s) => [s.id, s]));
const linkDocs = (docs, archived) => docs.filter((d) => d.kind === 'link' && d.archived === archived);
const sameTriple = (d, from, to, relation) => d.fm.from === from && d.fm.to === to && d.fm.relation === relation;
/** Beats of the live structures, by id: Map(id -> { name, structure: slug }). A beat id is a valid link end only while its structure is live (M5). */
function liveBeats(docs) {
  /** @type {Map<string, { name: string, structure: string }>} */
  const out = new Map();
  for (const d of docs) {
    if (d.kind !== 'structure' || d.archived || !Array.isArray(d.fm.beats)) continue;
    for (const b of d.fm.beats) if (isMap(b) && typeof b.id === 'string' && !out.has(b.id)) out.set(b.id, { name: typeof b.name === 'string' ? b.name : '', structure: typeof d.fm.slug === 'string' ? d.fm.slug : stem(d.rel).split('/').pop() });
  }
  return out;
}
const slugOfDoc = (d) => (typeof d.fm.slug === 'string' ? d.fm.slug : stem(d.rel).split('/').pop());

/** Body text after the front matter: empty, or a blank line and the rationale ending in one line break. */
function bodyText(rationale, eol) {
  if (rationale.trim() === '') return '';
  const text = rationale.replace(/\r\n?|\n/g, eol);
  return `${eol}${text}${text.endsWith(eol) ? '' : eol}`;
}

/** Check from / to / relation shape; a message or null. */
function badLinkArgs({ from, to, relation, rationale }, { partial }) {
  if (from !== undefined || !partial) if (typeof from !== 'string' || from === '' || from.length > 100) return 'from must be a scene id';
  if (to !== undefined || !partial) if (typeof to !== 'string' || to === '' || to.length > 100) return 'to must be a scene id';
  if ((relation !== undefined || !partial) && !LINK_RELATIONS.includes(relation)) return `relation must be one of ${LINK_RELATIONS.join(', ')}`;
  if (rationale !== undefined && (typeof rationale !== 'string' || rationale.length > 20000 || BODY_BAD_RE.test(rationale))) return 'rationale must be text without control characters (max 20000 characters)';
  return null;
}

// ------------------------------------------------------------------ createLink

/**
 * New link file planning/links/<slug>.md: schema, id, slug, from, to, relation, created; the rationale is the body. `from` and `to` must be live scenes or beat ids inside a live structure
 * (REFUSED_UNKNOWN_SCENE, with `field`), not the same scene (REFUSED_SELF_LINK), and no live link may already have the same from, to and relation
 * (REFUSED_DUPLICATE_LINK, with `existing: { slug }`).
 * @param {string} bookRoot @param {{ from: string, to: string, relation: string, rationale?: string, dryRun?: boolean }} args
 */
export function createLink(bookRoot, args = {}) {
  return guarded(async () => {
    const { from, to, relation, rationale = '', dryRun = false } = args ?? {};
    const bad = badLinkArgs({ from, to, relation, rationale }, { partial: false });
    if (bad) return fail('REFUSED_BAD_ARGS', bad);
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const scenes = liveScenes(lb);
    const beats = liveBeats(docs);
    for (const [field, id] of [['from', from], ['to', to]]) {
      if (!scenes.has(id) && !beats.has(id)) return fail('REFUSED_UNKNOWN_SCENE', `${field} ${id} is not a scene or beat of this book`, { field });
    }
    if (from === to) return fail('REFUSED_SELF_LINK', 'a link cannot point from a scene to itself', { field: 'to' });
    const twin = linkDocs(docs, false).find((d) => sameTriple(d, from, to, relation));
    if (twin) return fail('REFUSED_DUPLICATE_LINK', `${twin.rel} already links these scenes with ${relation}`, { existing: { slug: slugOfDoc(twin) } });

    const name = (id) => (scenes.has(id) ? slugify(sceneSlugOf(scenes.get(id).path)) || slugify(scenes.get(id).title ?? '') || 'scene' : slugify(beats.get(id).name) || 'beat');
    const slug = await freeName(store, `${name(from)}-${relation.replace(/_/g, '-')}-${name(to)}`, linkPath);
    const id = `note_${ulid()}`;
    const rel = linkPath(slug);
    const head = `---\nschema: storyforge.link/v1\nid: ${id}\nslug: ${slug}\nfrom: ${from}\nto: ${to}\nrelation: ${relation}\ncreated: ${today()}\n---\n`;
    const content = Buffer.from(head + bodyText(rationale, '\n'), 'utf8');
    const changes = [{ from: null, to: rel, content, before: null }];
    return finish({ bookRoot, store, lb, op: 'createLink', args: { from, to, relation, rationale: `<${rationale.length} chars>`, file: rel }, changes, dryRun, withDiff: true, extra: { id, slug, path: rel } });
  });
}

// ------------------------------------------------------------------ updateLink

/**
 * Change a link's relation, ends or rationale. `baseSha256` (the file the author last saw) is required; another version on disk is CONFLICT and nothing is
 * written. The file name and slug never change. The body is replaced only when `rationale` is given; the front matter bytes are otherwise kept.
 * `from` / `to` are checked as live scenes or beats of a live structure only when they change; the self-link and duplicate checks run when from, to or relation change.
 * @param {string} bookRoot @param {string} slug
 * @param {{ relation?: string, from?: string, to?: string, rationale?: string, baseSha256: string, dryRun?: boolean }} args
 */
export function updateLink(bookRoot, slug, args = {}) {
  return guarded(async () => {
    const { relation, from, to, rationale, baseSha256, dryRun = false } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no link ${slug}`);
    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required');
    if ([relation, from, to, rationale].every((v) => v === undefined)) return fail('REFUSED_BAD_ARGS', 'nothing to change');
    const bad = badLinkArgs({ from, to, relation, rationale }, { partial: true });
    if (bad) return fail('REFUSED_BAD_ARGS', bad);
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const rel = linkPath(slug);
    const doc = linkDocs(docs, false).find((d) => d.rel === rel);
    if (!doc) return fail('NOT_FOUND', `no link ${slug}`);
    const before = await readBytes(store, rel);
    const changed = stale(before, baseSha256, rel);
    if (changed) return changed;

    const next = { from: from ?? doc.fm.from, to: to ?? doc.fm.to, relation: relation ?? doc.fm.relation };
    const scenes = liveScenes(lb);
    const beats = liveBeats(docs);
    for (const [field, id] of [['from', from], ['to', to]]) {
      if (id !== undefined && !scenes.has(id) && !beats.has(id)) return fail('REFUSED_UNKNOWN_SCENE', `${field} ${id} is not a scene or beat of this book`, { field });
    }
    const endsChanged = next.from !== doc.fm.from || next.to !== doc.fm.to || next.relation !== doc.fm.relation;
    if (endsChanged) {
      if (next.from === next.to) return fail('REFUSED_SELF_LINK', 'a link cannot point from a scene to itself', { field: 'to' });
      const twin = linkDocs(docs, false).find((d) => d !== doc && sameTriple(d, next.from, next.to, next.relation));
      if (twin) return fail('REFUSED_DUPLICATE_LINK', `${twin.rel} already links these scenes with ${next.relation}`, { existing: { slug: slugOfDoc(twin) } });
    }

    let buf = before;
    const anchors = { from: ['slug', 'id'], to: ['from', 'slug', 'id'], relation: ['to', 'from', 'slug', 'id'] };
    for (const [key, value] of [['from', from], ['to', to], ['relation', relation]]) {
      if (value === undefined) continue;
      const r = editFrontMatterLine(buf, key, value, { anchors: anchors[key] });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: r.field });
      buf = r.buf;
    }
    if (rationale !== undefined) {
      const parts = splitDocument(buf);
      if (!parts) return fail('REFUSED_UNSIMPLE_FIELD', `${rel}: the file has no closed front matter`, { file: rel, field: 'body' });
      const head = buf.subarray(0, parts.bodyStart);
      buf = Buffer.concat([head, Buffer.from(bodyText(rationale, head.includes('\r\n') ? '\r\n' : '\n'), 'utf8')]);
    }
    const changes = buf.equals(before) ? [] : [{ from: rel, to: rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'updateLink', args: { slug, relation, from, to, rationale: rationale === undefined ? undefined : `<${rationale.length} chars>` }, changes, dryRun, withDiff: true, extra: { id: doc.fm.id, slug, path: rel } });
  });
}

// ------------------------------------------------------------ archive / restore

/** Move a link to archive/planning/links/. @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args */
export function archiveLink(bookRoot, slug, args = {}) {
  return moveLink(bookRoot, slug, args, false);
}

/**
 * Move an archived link back. A live file with that name: REFUSED_PATH_TAKEN; a live link with the same from, to and relation: REFUSED_DUPLICATE_LINK.
 * @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args
 */
export function restoreLink(bookRoot, slug, args = {}) {
  return moveLink(bookRoot, slug, args, true);
}

function moveLink(bookRoot, slug, args, restoring) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no link ${slug}`);
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const live = linkPath(slug);
    const from = restoring ? `archive/${live}` : live;
    const to = restoring ? live : `archive/${live}`;
    if (!(await store.exists(from))) return fail('NOT_FOUND', `no ${restoring ? 'archived ' : ''}link ${slug}`);
    const before = await readBytes(store, from);
    const changed = stale(before, baseSha256, from);
    if (changed) return changed;
    if (restoring) {
      if (await store.exists(live)) return fail('REFUSED_PATH_TAKEN', `a link file ${live} already exists`, { path: live });
      const doc = linkDocs(docs, true).find((d) => d.rel === from);
      const twin = doc ? linkDocs(docs, false).find((d) => sameTriple(d, doc.fm.from, doc.fm.to, doc.fm.relation)) : null;
      if (twin) return fail('REFUSED_DUPLICATE_LINK', `${twin.rel} already links the same scenes with ${doc.fm.relation}`, { existing: { slug: slugOfDoc(twin) } });
    }
    return finish({ bookRoot, store, lb, op: restoring ? 'restoreLink' : 'archiveLink', args: { slug }, changes: [{ from, to, content: before, before }], dryRun, withDiff: false, extra: { slug, path: to } });
  });
}

// ---------------------------------------------------------------- saveScenePlan

/** Anchors for inserting a plan key: the keys before it, nearest first, then `scene`. */
const planAnchors = (key) => [...PLAN_FIELDS.slice(0, PLAN_FIELDS.indexOf(key)).reverse(), 'scene'];

/**
 * Save the planning sidecar of a scene. `fields` holds any of the ten planning keys: a string sets it, `null` or '' removes the key. `characters` is a list of
 * entry slugs (written as a flow list; [] removes the key). No sidecar yet: planning/scene-plans/<scene-slug>.md is created (`baseSha256` must be absent).
 * A sidecar exists: `baseSha256` is required and a different file on disk is CONFLICT. Removal uses replaceFrontMatterBlock with no lines (the key's own lines go).
 * The scene file is never read for writing.
 * @param {string} bookRoot @param {string} sceneId
 * @param {{ fields?: Record<string, string | null>, characters?: string[], baseSha256?: string | null, dryRun?: boolean }} args
 */
export function saveScenePlan(bookRoot, sceneId, args = {}) {
  return guarded(async () => {
    const { fields = {}, characters, baseSha256, dryRun = false } = args ?? {};
    if (typeof sceneId !== 'string' || sceneId === '') return fail('REFUSED_BAD_ARGS', 'the scene must be an id');
    if (!isMap(fields)) return fail('REFUSED_BAD_ARGS', 'fields must be an object');
    for (const [key, value] of Object.entries(fields)) {
      if (!PLAN_FIELDS.includes(key)) return fail('REFUSED_BAD_ARGS', `unknown planning field ${key}; the fields are ${PLAN_FIELDS.join(', ')}`, { field: key });
      if (value !== null && !(isText(value) && value.length <= 2000)) return fail('REFUSED_BAD_ARGS', `${key} must be a single line of text without control characters (max 2000), or null to remove it`, { field: key });
    }
    if (characters !== undefined && (!Array.isArray(characters) || characters.length > 100 || characters.some((c) => !okSlug(c)))) {
      return fail('REFUSED_BAD_ARGS', 'characters must be a list of up to 100 entry slugs');
    }
    if (baseSha256 !== undefined && baseSha256 !== null && typeof baseSha256 !== 'string') return fail('REFUSED_BAD_ARGS', 'base_sha256 must be a string');
    if (Object.keys(fields).length === 0 && characters === undefined) return fail('REFUSED_BAD_ARGS', 'nothing to change');

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const scene = liveScenes(lb).get(sceneId);
    if (!scene) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${sceneId} in the book`, { field: 'scene' });
    if (characters !== undefined && characters.length > 0) {
      const slugs = new Set([...docs, ...(lb.shared?.docs ?? [])].filter((d) => d.kind === 'entry' && !d.archived && typeof d.fm.slug === 'string').map((d) => d.fm.slug));
      const missing = characters.find((c) => !slugs.has(c));
      if (missing !== undefined) return fail('REFUSED_UNKNOWN_ENTRY', `no entry ${missing}`, { field: 'characters', entry: missing });
    }

    const existing = docs
      .filter((d) => d.kind === 'scene-plan' && !d.archived && d.fm.scene === sceneId)
      .sort((a, b) => (stem(a.rel) < stem(b.rel) ? -1 : stem(a.rel) > stem(b.rel) ? 1 : 0))[0];

    if (!existing) {
      if (baseSha256 !== undefined && baseSha256 !== null) return fail('REFUSED_BAD_ARGS', 'this scene has no plan yet, so base_sha256 must be absent');
      const lines = ['---', 'schema: storyforge.scene-plan/v1', `id: note_${ulid()}`, `scene: ${sceneId}`];
      for (const key of PLAN_FIELDS) {
        const v = fields[key];
        if (typeof v === 'string' && v !== '') lines.push(`${key}: ${formatYamlText(v)}`);
      }
      if (characters !== undefined && characters.length > 0) lines.push(...flowList('characters', characters));
      if (lines.length === 4) return fail('REFUSED_BAD_ARGS', 'nothing to save: every value is empty');
      lines.push('---', '');
      const base = slugify(sceneSlugOf(scene.path)) || slugify(scene.title ?? '') || 'scene';
      const slug = await freeName(store, base, (n) => `${PLAN_DIR}/${n}.md`);
      const rel = `${PLAN_DIR}/${slug}.md`;
      const id = /^id: (.*)$/m.exec(lines.join('\n'))[1];
      const changes = [{ from: null, to: rel, content: Buffer.from(lines.join('\n'), 'utf8'), before: null }];
      return finish({ bookRoot, store, lb, op: 'saveScenePlan', args: { sceneId, fields: Object.keys(fields), characters: characters?.length, file: rel }, changes, dryRun, withDiff: true, extra: { id, scene_id: sceneId, path: rel, created: true } });
    }

    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required to change an existing plan');
    const rel = existing.rel;
    const before = await readBytes(store, rel);
    const changed = stale(before, baseSha256, rel);
    if (changed) return changed;
    let buf = before;
    const has = (key) => new RegExp(`^${key}:`, 'm').test(buf.toString('latin1'));
    for (const key of PLAN_FIELDS) {
      if (!Object.hasOwn(fields, key)) continue;
      const v = fields[key];
      const r = v === null || v === '' ? (has(key) ? replaceFrontMatterBlock(buf, key, []) : { ok: true, buf }) : editFrontMatterLine(buf, key, v, { anchors: planAnchors(key), plain: true });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: key });
      buf = r.buf;
    }
    if (characters !== undefined && (characters.length > 0 || has('characters'))) {
      const r = replaceFrontMatterBlock(buf, 'characters', characters.length > 0 ? flowList('characters', characters) : [], { after: [...PLAN_FIELDS].reverse().concat('scene') });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: 'characters' });
      buf = r.buf;
    }
    const changes = buf.equals(before) ? [] : [{ from: rel, to: rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'saveScenePlan', args: { sceneId, fields: Object.keys(fields), characters: characters?.length, file: rel }, changes, dryRun, withDiff: true, extra: { id: existing.fm.id, scene_id: sceneId, path: rel, created: false } });
  });
}

// ---------------------------------------------------------------- saveStoryPlan

/** The planning keys of the story plan, in the order they are written; `protagonist` is an entry slug, `primary_structure` a structure id (M4), the rest are single-line text. */
export const STORY_FIELDS = ['premise', 'logline', 'theme_question', 'central_conflict', 'protagonist_goal', 'stakes', 'protagonist', 'primary_structure'];
export const STORY_PATH = 'planning/story.md';

/** Anchors for inserting a story key: the keys before it, nearest first, then `id`. */
const storyAnchors = (key) => [...STORY_FIELDS.slice(0, STORY_FIELDS.indexOf(key)).reverse(), 'id'];

/**
 * Save the book's story plan, planning/story.md (ADR 0003 M2). `fields` holds any of the eight keys (premise, logline, theme_question, central_conflict,
 * protagonist_goal, stakes, protagonist, primary_structure): a string sets it, `null` or '' removes the key. `protagonist` must be the slug of a live entry (REFUSED_UNKNOWN_ENTRY).
 * `body` (optional, max 20000, may be multi-line) replaces the body and keeps the front matter bytes. No file yet: it is created (`baseSha256` must be absent).
 * A file exists: `baseSha256` is required and a different file on disk is CONFLICT with `current`. book.md and scenes are never read for writing or written.
 * @param {string} bookRoot
 * @param {{ fields?: Record<string, string | null>, body?: string, baseSha256?: string | null, dryRun?: boolean }} args
 */
export function saveStoryPlan(bookRoot, args = {}) {
  return guarded(async () => {
    const { fields = {}, body, baseSha256, dryRun = false } = args ?? {};
    if (!isMap(fields)) return fail('REFUSED_BAD_ARGS', 'fields must be an object');
    for (const [key, value] of Object.entries(fields)) {
      if (!STORY_FIELDS.includes(key)) return fail('REFUSED_BAD_ARGS', `unknown story field ${key}; the fields are ${STORY_FIELDS.join(', ')}`, { field: key });
      if (value !== null && !(isText(value) && value.length <= 2000)) return fail('REFUSED_BAD_ARGS', `${key} must be a single line of text without control characters (max 2000), or null to remove it`, { field: key });
    }
    if (body !== undefined && (typeof body !== 'string' || body.length > 20000 || BODY_BAD_RE.test(body))) return fail('REFUSED_BAD_ARGS', 'body must be text without control characters (max 20000 characters)', { field: 'body' });
    if (baseSha256 !== undefined && baseSha256 !== null && typeof baseSha256 !== 'string') return fail('REFUSED_BAD_ARGS', 'base_sha256 must be a string');
    if (Object.keys(fields).length === 0 && body === undefined) return fail('REFUSED_BAD_ARGS', 'nothing to change');

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const protagonist = fields.protagonist;
    if (typeof protagonist === 'string' && protagonist !== '') {
      const slugs = new Set([...docs, ...(lb.shared?.docs ?? [])].filter((d) => d.kind === 'entry' && !d.archived && typeof d.fm.slug === 'string').map((d) => d.fm.slug));
      if (!okSlug(protagonist) || !slugs.has(protagonist)) return fail('REFUSED_UNKNOWN_ENTRY', `no entry ${protagonist}`, { field: 'protagonist', entry: protagonist });
    }
    const argSummary = { fields: Object.keys(fields), body: body === undefined ? undefined : `<${body.length} chars>`, file: STORY_PATH };

    if (!(await store.exists(STORY_PATH))) {
      if (baseSha256 !== undefined && baseSha256 !== null) return fail('REFUSED_BAD_ARGS', 'the book has no story plan yet, so base_sha256 must be absent');
      const lines = ['---', 'schema: storyforge.story-plan/v1', `id: note_${ulid()}`];
      for (const key of STORY_FIELDS) {
        const v = fields[key];
        if (typeof v === 'string' && v !== '') lines.push(`${key}: ${formatYamlText(v)}`);
      }
      const text = typeof body === 'string' ? bodyText(body, '\n') : '';
      if (lines.length === 3 && text === '') return fail('REFUSED_BAD_ARGS', 'nothing to save: every value is empty');
      lines.push('---', '');
      const id = lines[2].slice(4);
      const content = Buffer.from(lines.join('\n') + text, 'utf8');
      return finish({ bookRoot, store, lb, op: 'saveStoryPlan', args: argSummary, changes: [{ from: null, to: STORY_PATH, content, before: null }], dryRun, withDiff: true, extra: { id, path: STORY_PATH, created: true } });
    }

    const existing = docs.find((d) => d.kind === 'story-plan' && !d.archived && d.rel === STORY_PATH);
    if (!existing) return fail('REFUSED_PATH_TAKEN', `${STORY_PATH} exists but is not a story plan`, { path: STORY_PATH });
    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required to change the story plan');
    const before = await readBytes(store, STORY_PATH);
    const changed = stale(before, baseSha256, STORY_PATH);
    if (changed) return changed;
    let buf = before;
    const has = (key) => new RegExp(`^${key}:`, 'm').test(buf.toString('latin1'));
    for (const key of STORY_FIELDS) {
      if (!Object.hasOwn(fields, key)) continue;
      const v = fields[key];
      const r = v === null || v === '' ? (has(key) ? replaceFrontMatterBlock(buf, key, []) : { ok: true, buf }) : editFrontMatterLine(buf, key, v, { anchors: storyAnchors(key), plain: true });
      if (!r.ok) return fail(r.code, `${STORY_PATH}: ${r.message}`, { file: STORY_PATH, field: key });
      buf = r.buf;
    }
    if (body !== undefined) {
      const parts = splitDocument(buf);
      if (!parts) return fail('REFUSED_UNSIMPLE_FIELD', `${STORY_PATH}: the file has no closed front matter`, { file: STORY_PATH, field: 'body' });
      const head = buf.subarray(0, parts.bodyStart);
      buf = Buffer.concat([head, Buffer.from(bodyText(body, head.includes('\r\n') ? '\r\n' : '\n'), 'utf8')]);
    }
    const changes = buf.equals(before) ? [] : [{ from: STORY_PATH, to: STORY_PATH, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'saveStoryPlan', args: argSummary, changes, dryRun, withDiff: true, extra: { id: existing.fm.id, path: STORY_PATH, created: false } });
  });
}

// ------------------------------------------------------------------ character arcs (ADR 0003 M3)

export const ARC_TYPES = ['positive', 'negative', 'flat', 'custom'];
/** The single-line text keys of an arc, in the order they are written (after arc_type). */
export const ARC_TEXT_FIELDS = ['want', 'need', 'false_belief', 'fear', 'wound', 'start_state', 'end_state'];
/** The text keys of a milestone besides `scene`, in the order they are written. */
export const MILESTONE_FIELDS = ['pressure', 'choice', 'belief_before', 'belief_after', 'cost'];
export const ARC_DIR = 'planning/arcs';
const ARC_KEYS = ['arc_type', ...ARC_TEXT_FIELDS];

/** Book-relative path of a live arc. @param {string} slug */
export const arcPath = (slug) => `${ARC_DIR}/${slug}.md`;
const arcDocs = (docs, archived) => docs.filter((d) => d.kind === 'arc' && d.archived === archived);
const arcSlugOf = (d) => (typeof d.fm.slug === 'string' ? d.fm.slug : stem(d.rel).split('/').pop());
/** Anchors for inserting an arc key: the keys before it, nearest first, then `character`. */
const arcAnchors = (key) => [...ARC_KEYS.slice(0, ARC_KEYS.indexOf(key)).reverse(), 'character', 'slug', 'id'];
const lineText = (v) => isText(v) && v.length <= 2000;

/**
 * New arc file planning/arcs/<slug>.md: schema, id, slug, character, arc_type, then the given fields (want, need, false_belief, fear, wound, start_state,
 * end_state; single line, max 2000). `character` must be the id of a live entry of type character in the book or its series (REFUSED_UNKNOWN_ENTRY; another
 * type: REFUSED_BAD_ARGS). A live arc for that character: REFUSED_DUPLICATE_ARC with `existing: { slug }`. The slug is the entry's slug (-2, -3 on a clash with a
 * live or archived file). No milestones key. The Codex entry is never written.
 * @param {string} bookRoot
 * @param {{ character: string, arc_type?: string | null, fields?: Record<string, string | null>, dryRun?: boolean }} args
 */
export function createArc(bookRoot, args = {}) {
  return guarded(async () => {
    const { character, arc_type: arcType, fields = {}, dryRun = false } = args ?? {};
    if (typeof character !== 'string' || character === '' || character.length > 100) return fail('REFUSED_BAD_ARGS', 'character must be an entry id', { field: 'character' });
    if (arcType !== undefined && arcType !== null && arcType !== '' && !ARC_TYPES.includes(arcType)) return fail('REFUSED_BAD_ARGS', `arc_type must be one of ${ARC_TYPES.join(', ')}`, { field: 'arc_type' });
    if (!isMap(fields)) return fail('REFUSED_BAD_ARGS', 'fields must be an object');
    for (const [key, value] of Object.entries(fields)) {
      if (!ARC_TEXT_FIELDS.includes(key)) return fail('REFUSED_BAD_ARGS', `unknown arc field ${key}; the fields are ${ARC_TEXT_FIELDS.join(', ')}`, { field: key });
      if (value !== null && !lineText(value)) return fail('REFUSED_BAD_ARGS', `${key} must be a single line of text without control characters (max 2000)`, { field: key });
    }
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const entry = [...docs, ...(lb.shared?.docs ?? [])].find((d) => d.kind === 'entry' && !d.archived && d.fm.id === character);
    if (!entry) return fail('REFUSED_UNKNOWN_ENTRY', `no entry ${character}`, { field: 'character', entry: character });
    if (entry.fm.type !== 'character') return fail('REFUSED_BAD_ARGS', `${character} is a ${entry.fm.type}, not a character`, { field: 'character' });
    const twin = arcDocs(docs, false).find((d) => d.fm.character === character);
    if (twin) return fail('REFUSED_DUPLICATE_ARC', `${twin.rel} is already the arc of this character`, { existing: { slug: arcSlugOf(twin) } });

    const base = slugify(typeof entry.fm.slug === 'string' ? entry.fm.slug : '') || 'character';
    const slug = await freeName(store, base, arcPath);
    const id = `note_${ulid()}`;
    const rel = arcPath(slug);
    const lines = ['---', 'schema: storyforge.arc/v1', `id: ${id}`, `slug: ${slug}`, `character: ${character}`];
    if (typeof arcType === 'string' && arcType !== '') lines.push(`arc_type: ${arcType}`);
    for (const key of ARC_TEXT_FIELDS) {
      const v = fields[key];
      if (typeof v === 'string' && v !== '') lines.push(`${key}: ${formatYamlText(v)}`);
    }
    lines.push('---', '');
    const changes = [{ from: null, to: rel, content: Buffer.from(lines.join('\n'), 'utf8'), before: null }];
    return finish({ bookRoot, store, lb, op: 'createArc', args: { character, arc_type: arcType, fields: Object.keys(fields), file: rel }, changes, dryRun, withDiff: true, extra: { id, slug, path: rel } });
  });
}

/** The live arc `slug` of a prepared book, read for writing: { doc, rel, before } or { result }. */
async function liveArc(store, docs, slug) {
  const rel = arcPath(slug);
  const doc = arcDocs(docs, false).find((d) => d.rel === rel);
  if (!doc) return { result: fail('NOT_FOUND', `no arc ${slug}`) };
  return { doc, rel, before: await readBytes(store, rel) };
}

/**
 * Change an arc's type, text fields or notes. `baseSha256` is required; a different file on disk is CONFLICT with `current`. `arc_type` and each field: a string
 * sets it, `null` or '' removes the key (`arc_type` is one of positive, negative, flat, custom). `body` (optional, max 20000) replaces the body. The milestones,
 * the file name and the slug are never changed here.
 * @param {string} bookRoot @param {string} slug
 * @param {{ arc_type?: string | null, fields?: Record<string, string | null>, body?: string, baseSha256: string, dryRun?: boolean }} args
 */
export function updateArc(bookRoot, slug, args = {}) {
  return guarded(async () => {
    const { arc_type: arcType, fields = {}, body, baseSha256, dryRun = false } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no arc ${slug}`);
    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required');
    if (!isMap(fields)) return fail('REFUSED_BAD_ARGS', 'fields must be an object');
    if (arcType !== undefined && arcType !== null && arcType !== '' && !ARC_TYPES.includes(arcType)) return fail('REFUSED_BAD_ARGS', `arc_type must be one of ${ARC_TYPES.join(', ')}`, { field: 'arc_type' });
    for (const [key, value] of Object.entries(fields)) {
      if (!ARC_TEXT_FIELDS.includes(key)) return fail('REFUSED_BAD_ARGS', `unknown arc field ${key}; the fields are ${ARC_TEXT_FIELDS.join(', ')}`, { field: key });
      if (value !== null && !lineText(value)) return fail('REFUSED_BAD_ARGS', `${key} must be a single line of text without control characters (max 2000), or null to remove it`, { field: key });
    }
    if (body !== undefined && (typeof body !== 'string' || body.length > 20000 || BODY_BAD_RE.test(body))) return fail('REFUSED_BAD_ARGS', 'body must be text without control characters (max 20000 characters)', { field: 'body' });
    if (arcType === undefined && Object.keys(fields).length === 0 && body === undefined) return fail('REFUSED_BAD_ARGS', 'nothing to change');

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const got = await liveArc(store, docs, slug);
    if (got.result) return got.result;
    const { doc, rel, before } = got;
    const changed = stale(before, baseSha256, rel);
    if (changed) return changed;

    let buf = before;
    const has = (key) => new RegExp(`^${key}:`, 'm').test(buf.toString('latin1'));
    const edits = { ...(arcType === undefined ? {} : { arc_type: arcType }), ...fields };
    for (const key of ARC_KEYS) {
      if (!Object.hasOwn(edits, key)) continue;
      const v = edits[key];
      const r = v === null || v === '' ? (has(key) ? replaceFrontMatterBlock(buf, key, []) : { ok: true, buf }) : editFrontMatterLine(buf, key, v, { anchors: arcAnchors(key), plain: true });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: key });
      buf = r.buf;
    }
    if (body !== undefined) {
      const parts = splitDocument(buf);
      if (!parts) return fail('REFUSED_UNSIMPLE_FIELD', `${rel}: the file has no closed front matter`, { file: rel, field: 'body' });
      const head = buf.subarray(0, parts.bodyStart);
      buf = Buffer.concat([head, Buffer.from(bodyText(body, head.includes('\r\n') ? '\r\n' : '\n'), 'utf8')]);
    }
    const out = buf.equals(before) ? [] : [{ from: rel, to: rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'updateArc', args: { slug, arc_type: arcType, fields: Object.keys(fields), body: body === undefined ? undefined : `<${body.length} chars>` }, changes: out, dryRun, withDiff: true, extra: { id: doc.fm.id, slug, path: rel } });
  });
}

/**
 * Replace the whole `milestones:` block of an arc. `milestones` is an array (max 200) of { scene, pressure?, choice?, belief_before?, belief_after?, cost? };
 * `scene` must be a live scene of the book (REFUSED_UNKNOWN_SCENE with the item `index`), the texts single lines (max 2000; an empty text is left out).
 * Written as a block of mappings through replaceFrontMatterBlock (inserted after the last arc field when absent, removed when the list is empty); a hand-edited
 * block with a comment, anchor or alias is REFUSED_UNSIMPLE_FIELD. `baseSha256` is required; a different file on disk is CONFLICT with `current`.
 * @param {string} bookRoot @param {string} slug
 * @param {{ milestones: { scene: string, pressure?: string, choice?: string, belief_before?: string, belief_after?: string, cost?: string }[], baseSha256: string, dryRun?: boolean }} args
 */
export function setArcMilestones(bookRoot, slug, args = {}) {
  return guarded(async () => {
    const { milestones, baseSha256, dryRun = false } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no arc ${slug}`);
    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required');
    if (!Array.isArray(milestones) || milestones.length > 200) return fail('REFUSED_BAD_ARGS', 'milestones must be a list of up to 200 items', { field: 'milestones' });
    for (const [i, m] of milestones.entries()) {
      const at = (k) => `milestones[${i}].${k}`;
      if (!isMap(m)) return fail('REFUSED_BAD_ARGS', `milestones[${i}] must be an object with a scene`, { field: `milestones[${i}]`, index: i });
      if (typeof m.scene !== 'string' || m.scene === '' || m.scene.length > 100) return fail('REFUSED_BAD_ARGS', `${at('scene')} must be a scene id`, { field: at('scene'), index: i });
      for (const [key, value] of Object.entries(m)) {
        if (key === 'scene') continue;
        if (!MILESTONE_FIELDS.includes(key)) return fail('REFUSED_BAD_ARGS', `unknown milestone field ${key}; the fields are scene, ${MILESTONE_FIELDS.join(', ')}`, { field: at(key), index: i });
        if (value !== null && value !== undefined && !lineText(value)) return fail('REFUSED_BAD_ARGS', `${at(key)} must be a single line of text without control characters (max 2000)`, { field: at(key), index: i });
      }
    }

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const got = await liveArc(store, docs, slug);
    if (got.result) return got.result;
    const { doc, rel, before } = got;
    const changed = stale(before, baseSha256, rel);
    if (changed) return changed;
    const scenes = liveScenes(lb);
    for (const [i, m] of milestones.entries()) {
      if (!scenes.has(m.scene)) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${m.scene} in the book`, { field: `milestones[${i}].scene`, index: i });
    }

    const lines = milestones.length === 0 ? [] : ['milestones:'];
    for (const m of milestones) {
      lines.push(`  - scene: ${m.scene}`);
      for (const key of MILESTONE_FIELDS) {
        const v = m[key];
        if (typeof v === 'string' && v !== '') lines.push(`    ${key}: ${formatYamlText(v)}`);
      }
    }
    let buf = before;
    if (lines.length > 0 || /^milestones:/m.test(buf.toString('latin1'))) {
      const r = replaceFrontMatterBlock(buf, 'milestones', lines, { after: [...ARC_KEYS].reverse().concat('character') });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: 'milestones' });
      buf = r.buf;
    }
    const out = buf.equals(before) ? [] : [{ from: rel, to: rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'setArcMilestones', args: { slug, milestones: milestones.length }, changes: out, dryRun, withDiff: true, extra: { id: doc.fm.id, slug, path: rel } });
  });
}

/** Move an arc to archive/planning/arcs/. @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args */
export function archiveArc(bookRoot, slug, args = {}) {
  return moveArc(bookRoot, slug, args, false);
}

/**
 * Move an archived arc back. A live file with that name: REFUSED_PATH_TAKEN; a live arc for the same character: REFUSED_DUPLICATE_ARC with `existing: { slug }`.
 * @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args
 */
export function restoreArc(bookRoot, slug, args = {}) {
  return moveArc(bookRoot, slug, args, true);
}

function moveArc(bookRoot, slug, args, restoring) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no arc ${slug}`);
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const live = arcPath(slug);
    const from = restoring ? `archive/${live}` : live;
    const to = restoring ? live : `archive/${live}`;
    if (!(await store.exists(from))) return fail('NOT_FOUND', `no ${restoring ? 'archived ' : ''}arc ${slug}`);
    const before = await readBytes(store, from);
    const changed = stale(before, baseSha256, from);
    if (changed) return changed;
    if (restoring) {
      if (await store.exists(live)) return fail('REFUSED_PATH_TAKEN', `an arc file ${live} already exists`, { path: live });
      const doc = arcDocs(docs, true).find((d) => d.rel === from);
      const twin = doc ? arcDocs(docs, false).find((d) => d.fm.character === doc.fm.character) : null;
      if (twin) return fail('REFUSED_DUPLICATE_ARC', `${twin.rel} is already the arc of this character`, { existing: { slug: arcSlugOf(twin) } });
    }
    return finish({ bookRoot, store, lb, op: restoring ? 'restoreArc' : 'archiveArc', args: { slug }, changes: [{ from, to, content: before, before }], dryRun, withDiff: false, extra: { slug, path: to } });
  });
}

// ------------------------------------------------------------------ structures and beat sheets (ADR 0003 M4)

export const STRUCTURE_DIR = 'planning/structures';
/** The text keys of a beat besides `name`, in the order they are written (after id and name). */
export const BEAT_TEXT_FIELDS = ['purpose', 'question', 'position'];
export const BEAT_STATES = ['open', 'done', 'omitted'];
const BEAT_ID_RE = /^note_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_BEATS = 200;
const MAX_BEAT_SCENES = 50;
const STRUCTURE_BEFORE_BEATS = ['template_version', 'template', 'name', 'slug', 'id'];

/** Book-relative path of a live structure. @param {string} slug */
export const structurePath = (slug) => `${STRUCTURE_DIR}/${slug}.md`;
const structureDocs = (docs, archived) => docs.filter((d) => d.kind === 'structure' && d.archived === archived);
const structureName = (v) => isText(v) && v.trim() !== '' && v.length <= 200;

/** The lines of a `beats:` block for already checked beats ({ id, name, purpose?, question?, position?, state?, scenes? }); no lines for no beats. */
function beatLines(beats) {
  if (beats.length === 0) return [];
  const lines = ['beats:'];
  for (const b of beats) {
    lines.push(`  - id: ${b.id}`, `    name: ${formatYamlText(b.name)}`);
    for (const key of BEAT_TEXT_FIELDS) {
      const v = b[key];
      if (typeof v === 'string' && v !== '') lines.push(`    ${key}: ${formatYamlText(v)}`);
    }
    if (b.state === 'done' || b.state === 'omitted') lines.push(`    state: ${b.state}`);
    if (Array.isArray(b.scenes) && b.scenes.length > 0) lines.push(`    scenes: [${b.scenes.join(', ')}]`);
  }
  return lines;
}

/**
 * New structure file planning/structures/<slug>.md from a built-in template: schema, id, slug, name, template, template_version, then the template's beats copied with
 * fresh note_ ids (state absent = open, no scenes). `template` must be a known template id (REFUSED_BAD_ARGS, field template); `name` a single line of 1 to 200 characters.
 * The slug is slugify(name) (-2, -3 on a clash with a live or archived file). The template never changes the file again.
 * @param {string} bookRoot
 * @param {{ template: string, name: string, dryRun?: boolean }} args
 */
export function createStructure(bookRoot, args = {}) {
  return guarded(async () => {
    const { template: templateId, name, dryRun = false } = args ?? {};
    const template = templateById(templateId);
    if (!template) return fail('REFUSED_BAD_ARGS', `template must be one of ${STRUCTURE_TEMPLATES.map((t) => t.id).join(', ')}`, { field: 'template' });
    if (!structureName(name)) return fail('REFUSED_BAD_ARGS', 'name must be a single line of 1 to 200 characters', { field: 'name' });
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const slug = await freeName(store, slugify(name) || 'structure', structurePath);
    const id = `note_${ulid()}`;
    const rel = structurePath(slug);
    const beats = template.beats.map((b) => ({ ...b, id: `note_${ulid()}` }));
    const lines = ['---', 'schema: storyforge.structure/v1', `id: ${id}`, `slug: ${slug}`, `name: ${formatYamlText(name)}`, `template: ${template.id}`, `template_version: ${template.version}`, ...beatLines(beats), '---', ''];
    const changes = [{ from: null, to: rel, content: Buffer.from(lines.join('\n'), 'utf8'), before: null }];
    return finish({ bookRoot, store, lb, op: 'createStructure', args: { template: template.id, name, file: rel }, changes, dryRun, withDiff: true, extra: { id, slug, path: rel } });
  });
}

/** The live structure `slug` of a prepared book, read for writing: { doc, rel, before } or { result }. */
async function liveStructure(store, docs, slug) {
  const rel = structurePath(slug);
  const doc = structureDocs(docs, false).find((d) => d.rel === rel);
  if (!doc) return { result: fail('NOT_FOUND', `no structure ${slug}`) };
  return { doc, rel, before: await readBytes(store, rel) };
}

/**
 * Change a structure's name or notes. `baseSha256` is required; a different file on disk is CONFLICT with `current`. `name` (single line, 1 to 200) replaces the name; `body`
 * (optional, max 20000) replaces the body. The template, template_version, beats, file name and slug are never changed here.
 * @param {string} bookRoot @param {string} slug
 * @param {{ name?: string, body?: string, baseSha256: string, dryRun?: boolean }} args
 */
export function updateStructure(bookRoot, slug, args = {}) {
  return guarded(async () => {
    const { name, body, baseSha256, dryRun = false } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no structure ${slug}`);
    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required');
    if (name !== undefined && !structureName(name)) return fail('REFUSED_BAD_ARGS', 'name must be a single line of 1 to 200 characters', { field: 'name' });
    if (body !== undefined && (typeof body !== 'string' || body.length > 20000 || BODY_BAD_RE.test(body))) return fail('REFUSED_BAD_ARGS', 'body must be text without control characters (max 20000 characters)', { field: 'body' });
    if (name === undefined && body === undefined) return fail('REFUSED_BAD_ARGS', 'nothing to change');

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const got = await liveStructure(store, docs, slug);
    if (got.result) return got.result;
    const { doc, rel, before } = got;
    const changed = stale(before, baseSha256, rel);
    if (changed) return changed;

    let buf = before;
    if (name !== undefined) {
      const r = editFrontMatterLine(buf, 'name', name, { anchors: ['slug', 'id'], plain: true });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: 'name' });
      buf = r.buf;
    }
    if (body !== undefined) {
      const parts = splitDocument(buf);
      if (!parts) return fail('REFUSED_UNSIMPLE_FIELD', `${rel}: the file has no closed front matter`, { file: rel, field: 'body' });
      const head = buf.subarray(0, parts.bodyStart);
      buf = Buffer.concat([head, Buffer.from(bodyText(body, head.includes('\r\n') ? '\r\n' : '\n'), 'utf8')]);
    }
    const out = buf.equals(before) ? [] : [{ from: rel, to: rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'updateStructure', args: { slug, name, body: body === undefined ? undefined : `<${body.length} chars>` }, changes: out, dryRun, withDiff: true, extra: { id: doc.fm.id, slug, path: rel } });
  });
}

/**
 * Replace the whole `beats:` block of a structure. `beats` is an array (max 200) of { id?, name, purpose?, question?, position?, state?, scenes? }: `name` is required (single
 * line, max 200); the texts are single lines (max 2000; an empty text is left out); `state` is open, done or omitted (open is written as no key); `scenes` is an array (max 50)
 * of scene ids, de-duplicated keeping the order, each a live scene of the book (REFUSED_UNKNOWN_SCENE with the beat `index`). An `id` must be a note_ id and unique in the list
 * (REFUSED_BAD_ARGS); a beat without one gets a new id. Written as a block of mappings through replaceFrontMatterBlock (after template_version when absent, removed when the list
 * is empty); a hand-edited block with a comment, anchor or alias is REFUSED_UNSIMPLE_FIELD. `baseSha256` is required; a different file on disk is CONFLICT with `current`.
 * A beat that this save removes and that is the `from` or `to` of a link is REFUSED_BEAT_LINKED with `links: [slug]` (live) and `archived_links: [slug]` (M5); nothing is cut silently.
 * @param {string} bookRoot @param {string} slug
 * @param {{ beats: { id?: string, name: string, purpose?: string, question?: string, position?: string, state?: string, scenes?: string[] }[], baseSha256: string, dryRun?: boolean }} args
 */
export function setStructureBeats(bookRoot, slug, args = {}) {
  return guarded(async () => {
    const { beats, baseSha256, dryRun = false } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no structure ${slug}`);
    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required');
    if (!Array.isArray(beats) || beats.length > MAX_BEATS) return fail('REFUSED_BAD_ARGS', `beats must be a list of up to ${MAX_BEATS} items`, { field: 'beats' });
    const ids = new Set();
    /** @type {{ id: string, name: string, purpose?: string, question?: string, position?: string, state?: string, scenes: string[] }[]} */
    const clean = [];
    for (const [i, b] of beats.entries()) {
      const at = (k) => `beats[${i}].${k}`;
      if (!isMap(b)) return fail('REFUSED_BAD_ARGS', `beats[${i}] must be an object with a name`, { field: `beats[${i}]`, index: i });
      for (const key of Object.keys(b)) {
        if (!['id', 'name', ...BEAT_TEXT_FIELDS, 'state', 'scenes'].includes(key)) return fail('REFUSED_BAD_ARGS', `unknown beat field ${key}; the fields are id, name, ${BEAT_TEXT_FIELDS.join(', ')}, state, scenes`, { field: at(key), index: i });
      }
      if (!structureName(b.name)) return fail('REFUSED_BAD_ARGS', `${at('name')} must be a single line of 1 to 200 characters`, { field: at('name'), index: i });
      for (const key of BEAT_TEXT_FIELDS) {
        const v = b[key];
        if (v !== undefined && v !== null && !lineText(v)) return fail('REFUSED_BAD_ARGS', `${at(key)} must be a single line of text without control characters (max 2000)`, { field: at(key), index: i });
      }
      let state = b.state;
      if (state === undefined || state === null || state === '') state = 'open';
      if (!BEAT_STATES.includes(state)) return fail('REFUSED_BAD_ARGS', `${at('state')} must be one of ${BEAT_STATES.join(', ')}`, { field: at('state'), index: i });
      let scenes = b.scenes ?? [];
      if (!Array.isArray(scenes) || scenes.length > MAX_BEAT_SCENES) return fail('REFUSED_BAD_ARGS', `${at('scenes')} must be a list of up to ${MAX_BEAT_SCENES} scene ids`, { field: at('scenes'), index: i });
      for (const [j, s] of scenes.entries()) {
        if (typeof s !== 'string' || s === '' || s.length > 100) return fail('REFUSED_BAD_ARGS', `${at('scenes')}[${j}] must be a scene id`, { field: `${at('scenes')}[${j}]`, index: i });
      }
      scenes = [...new Set(scenes)];
      let id = b.id;
      if (id === undefined || id === null || id === '') id = `note_${ulid()}`;
      else if (typeof id !== 'string' || !BEAT_ID_RE.test(id)) return fail('REFUSED_BAD_ARGS', `${at('id')} must be a note_ id`, { field: at('id'), index: i });
      if (ids.has(id)) return fail('REFUSED_BAD_ARGS', `${at('id')} ${id} is used by another beat of the list`, { field: at('id'), index: i });
      ids.add(id);
      clean.push({ id, name: b.name, purpose: b.purpose ?? undefined, question: b.question ?? undefined, position: b.position ?? undefined, state, scenes });
    }

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const got = await liveStructure(store, docs, slug);
    if (got.result) return got.result;
    const { doc, rel, before } = got;
    const changed = stale(before, baseSha256, rel);
    if (changed) return changed;
    const keptIds = new Set(clean.map((b) => b.id));
    const removed = new Set((Array.isArray(doc.fm.beats) ? doc.fm.beats : []).filter((b) => isMap(b) && typeof b.id === 'string' && !keptIds.has(b.id)).map((b) => b.id));
    if (removed.size > 0) {
      // archived links count too: an archived link to a beat that no longer exists would be E301 and roll the save back with no clear reason
      const uses = (d) => removed.has(d.fm.from) || removed.has(d.fm.to);
      const linked = linkDocs(docs, false).filter(uses).map(slugOfDoc);
      const archivedLinked = linkDocs(docs, true).filter(uses).map(slugOfDoc);
      if (linked.length + archivedLinked.length > 0) {
        const named = [...linked, ...archivedLinked.map((x) => `${x} (archived)`)].join(', ');
        return fail('REFUSED_BEAT_LINKED', `a beat that is removed is still linked by ${named}; re-point the links first (restore an archived link to change it)`, { links: linked, archived_links: archivedLinked });
      }
    }
    const scenes = liveScenes(lb);
    for (const [i, b] of clean.entries()) {
      for (const [j, s] of b.scenes.entries()) {
        if (!scenes.has(s)) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${s} in the book`, { field: `beats[${i}].scenes[${j}]`, index: i });
      }
    }

    const lines = beatLines(clean);
    let buf = before;
    if (lines.length > 0 || /^beats:/m.test(buf.toString('latin1'))) {
      const r = replaceFrontMatterBlock(buf, 'beats', lines, { after: STRUCTURE_BEFORE_BEATS });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: 'beats' });
      buf = r.buf;
    }
    const out = buf.equals(before) ? [] : [{ from: rel, to: rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'setStructureBeats', args: { slug, beats: clean.length }, changes: out, dryRun, withDiff: true, extra: { id: doc.fm.id, slug, path: rel } });
  });
}

/** Move a structure to archive/planning/structures/. @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args */
export function archiveStructure(bookRoot, slug, args = {}) {
  return moveStructure(bookRoot, slug, args, false);
}

/**
 * Move an archived structure back. A live file with that name: REFUSED_PATH_TAKEN.
 * @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args
 */
export function restoreStructure(bookRoot, slug, args = {}) {
  return moveStructure(bookRoot, slug, args, true);
}

function moveStructure(bookRoot, slug, args, restoring) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no structure ${slug}`);
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const live = structurePath(slug);
    const from = restoring ? `archive/${live}` : live;
    const to = restoring ? live : `archive/${live}`;
    if (!(await store.exists(from))) return fail('NOT_FOUND', `no ${restoring ? 'archived ' : ''}structure ${slug}`);
    const before = await readBytes(store, from);
    const changed = stale(before, baseSha256, from);
    if (changed) return changed;
    if (restoring && (await store.exists(live))) return fail('REFUSED_PATH_TAKEN', `a structure file ${live} already exists`, { path: live });
    return finish({ bookRoot, store, lb, op: restoring ? 'restoreStructure' : 'archiveStructure', args: { slug }, changes: [{ from, to, content: before, before }], dryRun, withDiff: false, extra: { slug, path: to } });
  });
}

// ------------------------------------------------------------------ relationships (ADR 0003 M5)

export const RELATIONSHIP_DIR = 'planning/relationships';
/** The single-line text keys of a relationship, in the order they are written (after b). */
export const RELATIONSHIP_TEXT_FIELDS = ['baseline', 'end_state'];
/** The text keys of a development besides `scene`, in the order they are written. */
export const DEVELOPMENT_FIELDS = ['change', 'a_view', 'b_view'];
const MAX_DEVELOPMENTS = 200;

/** Book-relative path of a live relationship. @param {string} slug */
export const relationshipPath = (slug) => `${RELATIONSHIP_DIR}/${slug}.md`;
const relationshipDocs = (docs, archived) => docs.filter((d) => d.kind === 'relationship' && d.archived === archived);
const relationshipSlugOf = (d) => (typeof d.fm.slug === 'string' ? d.fm.slug : stem(d.rel).split('/').pop());
const pairKey = (a, b) => JSON.stringify([a, b].sort());
const samePair = (d, a, b) => typeof d.fm.a === 'string' && typeof d.fm.b === 'string' && pairKey(d.fm.a, d.fm.b) === pairKey(a, b);
/** Anchors for inserting a relationship key: the keys before it, nearest first, then `b`, `a`. */
const relationshipAnchors = (key) => [...RELATIONSHIP_TEXT_FIELDS.slice(0, RELATIONSHIP_TEXT_FIELDS.indexOf(key)).reverse(), 'b', 'a', 'slug', 'id'];
const liveEntry = (docs, lb, id) => [...docs, ...(lb.shared?.docs ?? [])].find((d) => d.kind === 'entry' && !d.archived && d.fm.id === id);

/**
 * New relationship file planning/relationships/<a-slug>-and-<b-slug>.md: schema, id, slug, a, b, then baseline and end_state when given (single line, max 2000).
 * `a` and `b` must be ids of live entries (any type) in the book or its series (REFUSED_UNKNOWN_ENTRY, with `field`); the same entry twice is REFUSED_BAD_ARGS.
 * A live relationship for the pair, in either order: REFUSED_DUPLICATE_RELATIONSHIP with `existing: { slug }`. -2, -3 on a clash with a live or archived file name.
 * No developments key. The Codex entries are never written.
 * @param {string} bookRoot
 * @param {{ a: string, b: string, fields?: { baseline?: string | null, end_state?: string | null }, dryRun?: boolean }} args
 */
export function createRelationship(bookRoot, args = {}) {
  return guarded(async () => {
    const { a, b, fields = {}, dryRun = false } = args ?? {};
    for (const [field, id] of [['a', a], ['b', b]]) {
      if (typeof id !== 'string' || id === '' || id.length > 100) return fail('REFUSED_BAD_ARGS', `${field} must be an entry id`, { field });
    }
    if (a === b) return fail('REFUSED_BAD_ARGS', 'a relationship needs two different entries', { field: 'b' });
    if (!isMap(fields)) return fail('REFUSED_BAD_ARGS', 'fields must be an object');
    for (const [key, value] of Object.entries(fields)) {
      if (!RELATIONSHIP_TEXT_FIELDS.includes(key)) return fail('REFUSED_BAD_ARGS', `unknown relationship field ${key}; the fields are ${RELATIONSHIP_TEXT_FIELDS.join(', ')}`, { field: key });
      if (value !== null && value !== undefined && !lineText(value)) return fail('REFUSED_BAD_ARGS', `${key} must be a single line of text without control characters (max 2000)`, { field: key });
    }
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const entries = {};
    for (const [field, id] of [['a', a], ['b', b]]) {
      entries[field] = liveEntry(docs, lb, id);
      if (!entries[field]) return fail('REFUSED_UNKNOWN_ENTRY', `no entry ${id}`, { field, entry: id });
    }
    const twin = relationshipDocs(docs, false).find((d) => samePair(d, a, b));
    if (twin) return fail('REFUSED_DUPLICATE_RELATIONSHIP', `${twin.rel} is already the relationship of this pair`, { existing: { slug: relationshipSlugOf(twin) } });

    const name = (e) => slugify(typeof e.fm.slug === 'string' ? e.fm.slug : '') || 'entry';
    const slug = await freeName(store, `${name(entries.a)}-and-${name(entries.b)}`, relationshipPath);
    const id = `note_${ulid()}`;
    const rel = relationshipPath(slug);
    const lines = ['---', 'schema: storyforge.relationship/v1', `id: ${id}`, `slug: ${slug}`, `a: ${a}`, `b: ${b}`];
    for (const key of RELATIONSHIP_TEXT_FIELDS) {
      const v = fields[key];
      if (typeof v === 'string' && v !== '') lines.push(`${key}: ${formatYamlText(v)}`);
    }
    lines.push('---', '');
    const changes = [{ from: null, to: rel, content: Buffer.from(lines.join('\n'), 'utf8'), before: null }];
    return finish({ bookRoot, store, lb, op: 'createRelationship', args: { a, b, fields: Object.keys(fields), file: rel }, changes, dryRun, withDiff: true, extra: { id, slug, path: rel } });
  });
}

/** The live relationship `slug` of a prepared book, read for writing: { doc, rel, before } or { result }. */
async function liveRelationship(store, docs, slug) {
  const rel = relationshipPath(slug);
  const doc = relationshipDocs(docs, false).find((d) => d.rel === rel);
  if (!doc) return { result: fail('NOT_FOUND', `no relationship ${slug}`) };
  return { doc, rel, before: await readBytes(store, rel) };
}

/**
 * Change a relationship's baseline, end state or notes. `baseSha256` is required; a different file on disk is CONFLICT with `current`. Each field: a string sets it,
 * `null` or '' removes the key. `body` (optional, max 20000) replaces the body. `a`, `b`, the developments, the file name and the slug never change here.
 * @param {string} bookRoot @param {string} slug
 * @param {{ fields?: { baseline?: string | null, end_state?: string | null }, body?: string, baseSha256: string, dryRun?: boolean }} args
 */
export function updateRelationship(bookRoot, slug, args = {}) {
  return guarded(async () => {
    const { fields = {}, body, baseSha256, dryRun = false } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no relationship ${slug}`);
    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required');
    if (!isMap(fields)) return fail('REFUSED_BAD_ARGS', 'fields must be an object');
    for (const [key, value] of Object.entries(fields)) {
      if (!RELATIONSHIP_TEXT_FIELDS.includes(key)) return fail('REFUSED_BAD_ARGS', `unknown relationship field ${key}; the fields are ${RELATIONSHIP_TEXT_FIELDS.join(', ')}`, { field: key });
      if (value !== null && !lineText(value)) return fail('REFUSED_BAD_ARGS', `${key} must be a single line of text without control characters (max 2000), or null to remove it`, { field: key });
    }
    if (body !== undefined && (typeof body !== 'string' || body.length > 20000 || BODY_BAD_RE.test(body))) return fail('REFUSED_BAD_ARGS', 'body must be text without control characters (max 20000 characters)', { field: 'body' });
    if (Object.keys(fields).length === 0 && body === undefined) return fail('REFUSED_BAD_ARGS', 'nothing to change');

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const got = await liveRelationship(store, docs, slug);
    if (got.result) return got.result;
    const { doc, rel, before } = got;
    const changed = stale(before, baseSha256, rel);
    if (changed) return changed;

    let buf = before;
    const has = (key) => new RegExp(`^${key}:`, 'm').test(buf.toString('latin1'));
    for (const key of RELATIONSHIP_TEXT_FIELDS) {
      if (!Object.hasOwn(fields, key)) continue;
      const v = fields[key];
      const r = v === null || v === '' ? (has(key) ? replaceFrontMatterBlock(buf, key, []) : { ok: true, buf }) : editFrontMatterLine(buf, key, v, { anchors: relationshipAnchors(key), plain: true });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: key });
      buf = r.buf;
    }
    if (body !== undefined) {
      const parts = splitDocument(buf);
      if (!parts) return fail('REFUSED_UNSIMPLE_FIELD', `${rel}: the file has no closed front matter`, { file: rel, field: 'body' });
      const head = buf.subarray(0, parts.bodyStart);
      buf = Buffer.concat([head, Buffer.from(bodyText(body, head.includes('\r\n') ? '\r\n' : '\n'), 'utf8')]);
    }
    const out = buf.equals(before) ? [] : [{ from: rel, to: rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'updateRelationship', args: { slug, fields: Object.keys(fields), body: body === undefined ? undefined : `<${body.length} chars>` }, changes: out, dryRun, withDiff: true, extra: { id: doc.fm.id, slug, path: rel } });
  });
}

/**
 * Replace the whole `developments:` block of a relationship. `developments` is an array (max 200) of { scene, change, a_view?, b_view? }; `scene` must be a live scene of
 * the book (REFUSED_UNKNOWN_SCENE with the item `index`); `change` is required, a single line (max 2000); `a_view` and `b_view` are optional single lines (an empty one is left out).
 * Written as a block of mappings through replaceFrontMatterBlock (inserted after the last relationship field when absent, removed when the list is empty); a hand-edited
 * block with a comment, anchor or alias is REFUSED_UNSIMPLE_FIELD. `baseSha256` is required; a different file on disk is CONFLICT with `current`.
 * @param {string} bookRoot @param {string} slug
 * @param {{ developments: { scene: string, change: string, a_view?: string, b_view?: string }[], baseSha256: string, dryRun?: boolean }} args
 */
export function setRelationshipDevelopments(bookRoot, slug, args = {}) {
  return guarded(async () => {
    const { developments, baseSha256, dryRun = false } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no relationship ${slug}`);
    if (typeof baseSha256 !== 'string' || baseSha256 === '') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required');
    if (!Array.isArray(developments) || developments.length > MAX_DEVELOPMENTS) return fail('REFUSED_BAD_ARGS', `developments must be a list of up to ${MAX_DEVELOPMENTS} items`, { field: 'developments' });
    for (const [i, m] of developments.entries()) {
      const at = (k) => `developments[${i}].${k}`;
      if (!isMap(m)) return fail('REFUSED_BAD_ARGS', `developments[${i}] must be an object with a scene and a change`, { field: `developments[${i}]`, index: i });
      if (typeof m.scene !== 'string' || m.scene === '' || m.scene.length > 100) return fail('REFUSED_BAD_ARGS', `${at('scene')} must be a scene id`, { field: at('scene'), index: i });
      for (const [key, value] of Object.entries(m)) {
        if (key === 'scene') continue;
        if (!DEVELOPMENT_FIELDS.includes(key)) return fail('REFUSED_BAD_ARGS', `unknown development field ${key}; the fields are scene, ${DEVELOPMENT_FIELDS.join(', ')}`, { field: at(key), index: i });
        if (key !== 'change' && (value === null || value === undefined)) continue;
        if (!lineText(value)) return fail('REFUSED_BAD_ARGS', `${at(key)} must be a single line of text without control characters (max 2000)`, { field: at(key), index: i });
      }
      if (typeof m.change !== 'string' || m.change.trim() === '') return fail('REFUSED_BAD_ARGS', `${at('change')} is required`, { field: at('change'), index: i });
    }

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const got = await liveRelationship(store, docs, slug);
    if (got.result) return got.result;
    const { doc, rel, before } = got;
    const changed = stale(before, baseSha256, rel);
    if (changed) return changed;
    const scenes = liveScenes(lb);
    for (const [i, m] of developments.entries()) {
      if (!scenes.has(m.scene)) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${m.scene} in the book`, { field: `developments[${i}].scene`, index: i });
    }

    const lines = developments.length === 0 ? [] : ['developments:'];
    for (const m of developments) {
      lines.push(`  - scene: ${m.scene}`);
      for (const key of DEVELOPMENT_FIELDS) {
        const v = m[key];
        if (typeof v === 'string' && v !== '') lines.push(`    ${key}: ${formatYamlText(v)}`);
      }
    }
    let buf = before;
    if (lines.length > 0 || /^developments:/m.test(buf.toString('latin1'))) {
      const r = replaceFrontMatterBlock(buf, 'developments', lines, { after: [...RELATIONSHIP_TEXT_FIELDS].reverse().concat('b', 'a') });
      if (!r.ok) return fail(r.code, `${rel}: ${r.message}`, { file: rel, field: 'developments' });
      buf = r.buf;
    }
    const out = buf.equals(before) ? [] : [{ from: rel, to: rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'setRelationshipDevelopments', args: { slug, developments: developments.length }, changes: out, dryRun, withDiff: true, extra: { id: doc.fm.id, slug, path: rel } });
  });
}

/** Move a relationship to archive/planning/relationships/. @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args */
export function archiveRelationship(bookRoot, slug, args = {}) {
  return moveRelationship(bookRoot, slug, args, false);
}

/**
 * Move an archived relationship back. A live file with that name: REFUSED_PATH_TAKEN; a live relationship for the same pair: REFUSED_DUPLICATE_RELATIONSHIP with `existing: { slug }`.
 * @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args
 */
export function restoreRelationship(bookRoot, slug, args = {}) {
  return moveRelationship(bookRoot, slug, args, true);
}

function moveRelationship(bookRoot, slug, args, restoring) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no relationship ${slug}`);
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const live = relationshipPath(slug);
    const from = restoring ? `archive/${live}` : live;
    const to = restoring ? live : `archive/${live}`;
    if (!(await store.exists(from))) return fail('NOT_FOUND', `no ${restoring ? 'archived ' : ''}relationship ${slug}`);
    const before = await readBytes(store, from);
    const changed = stale(before, baseSha256, from);
    if (changed) return changed;
    if (restoring) {
      if (await store.exists(live)) return fail('REFUSED_PATH_TAKEN', `a relationship file ${live} already exists`, { path: live });
      const doc = relationshipDocs(docs, true).find((d) => d.rel === from);
      const twin = doc && typeof doc.fm.a === 'string' && typeof doc.fm.b === 'string' ? relationshipDocs(docs, false).find((d) => samePair(d, doc.fm.a, doc.fm.b)) : null;
      if (twin) return fail('REFUSED_DUPLICATE_RELATIONSHIP', `${twin.rel} is already the relationship of this pair`, { existing: { slug: relationshipSlugOf(twin) } });
    }
    return finish({ bookRoot, store, lb, op: restoring ? 'restoreRelationship' : 'archiveRelationship', args: { slug }, changes: [{ from, to, content: before, before }], dryRun, withDiff: false, extra: { slug, path: to } });
  });
}
