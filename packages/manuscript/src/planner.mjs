// Story Planner commands (ADR 0003, M1): causal links (planning/links/<slug>.md) and scene plan sidecars (planning/scene-plans/<scene>.md).
// Every command goes through the store: one batch with a dry run, refused when it would add a validation error, never deleting. Edits are byte edits of
// the front matter (editFrontMatterLine, replaceFrontMatterBlock); YAML is never re-serialised. A scene file is never read for writing or written here.
import { flowList, prepareCodex, replaceFrontMatterBlock, stale as staleBare } from './codex.mjs';
import { editFrontMatterLine, formatYamlText, splitDocument } from './frontmatter.mjs';
import { fail, finish, guarded, readBytes } from './ops.mjs';
import { sceneSlugOf } from './paths.mjs';
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
 * New link file planning/links/<slug>.md: schema, id, slug, from, to, relation, created; the rationale is the body. `from` and `to` must be live scenes
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
    for (const [field, id] of [['from', from], ['to', to]]) {
      if (!scenes.has(id)) return fail('REFUSED_UNKNOWN_SCENE', `${field} ${id} is not a scene of this book`, { field });
    }
    if (from === to) return fail('REFUSED_SELF_LINK', 'a link cannot point from a scene to itself', { field: 'to' });
    const twin = linkDocs(docs, false).find((d) => sameTriple(d, from, to, relation));
    if (twin) return fail('REFUSED_DUPLICATE_LINK', `${twin.rel} already links these scenes with ${relation}`, { existing: { slug: slugOfDoc(twin) } });

    const name = (id) => slugify(sceneSlugOf(scenes.get(id).path)) || slugify(scenes.get(id).title ?? '') || 'scene';
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
 * `from` / `to` are checked as live scenes only when they change; the self-link and duplicate checks run when from, to or relation change.
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
    for (const [field, id] of [['from', from], ['to', to]]) {
      if (id !== undefined && !scenes.has(id)) return fail('REFUSED_UNKNOWN_SCENE', `${field} ${id} is not a scene of this book`, { field });
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

/** The planning keys of the story plan, in the order they are written; `protagonist` is an entry slug, the rest are single-line text. */
export const STORY_FIELDS = ['premise', 'logline', 'theme_question', 'central_conflict', 'protagonist_goal', 'stakes', 'protagonist'];
export const STORY_PATH = 'planning/story.md';

/** Anchors for inserting a story key: the keys before it, nearest first, then `id`. */
const storyAnchors = (key) => [...STORY_FIELDS.slice(0, STORY_FIELDS.indexOf(key)).reverse(), 'id'];

/**
 * Save the book's story plan, planning/story.md (ADR 0003 M2). `fields` holds any of the seven keys (premise, logline, theme_question, central_conflict,
 * protagonist_goal, stakes, protagonist): a string sets it, `null` or '' removes the key. `protagonist` must be the slug of a live entry (REFUSED_UNKNOWN_ENTRY).
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
