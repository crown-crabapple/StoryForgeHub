// What the right rail says about the open scene, worked out from its front matter and body. Pure.
import { segmentProse } from '../prose.js';

export const LINK_GROUPS = [
  { id: 'characters', title: 'Characters' },
  { id: 'locations', title: 'Locations' },
  { id: 'threads', title: 'Plot threads' },
  { id: 'other', title: 'Other links' },
];

const FRONT_FIELDS = [
  ['characters', 'characters'],
  ['locations', 'locations'],
  ['plot_threads', 'threads'],
];

/**
 * Every `<!-- note: ... -->` of the body with its 1-based line and character offset, in order.
 * @param {string} body @returns {{ text: string, line: number, offset: number }[]}
 */
export function sceneNoteList(body) {
  const out = [];
  let offset = 0;
  let line = 1;
  for (const seg of segmentProse(body)) {
    if (seg.type === 'comment' && seg.note) out.push({ text: seg.note, line, offset });
    for (const ch of seg.raw) if (ch === '\n') line++;
    offset += seg.raw.length;
  }
  return out;
}

/** Every `[[link]]` target in the body (outside code), in order, without the label. @param {string} body @returns {string[]} */
export function bodyLinkRefs(body) {
  return segmentProse(body).flatMap((s) => (s.type === 'wikilink' && s.slug !== '' ? [s.slug.split('#')[0].trim()] : []));
}

/**
 * The characters, locations and threads of the scene from its front matter, plus every `[[link]]` of the body, each once.
 * A link that only the body makes is `mentioned`. `objects` is the GET /objects answer (slug, id and title all resolve).
 * @param {Record<string, any> | null | undefined} front
 * @param {string} body
 * @param {{ id: string, kind: string, slug: string | null, title: string | null, type?: string | null }[] | null | undefined} objects
 * @returns {{ key: string, id: string | null, kind: string | null, ref: string, name: string, group: 'characters' | 'locations' | 'threads' | 'other', mentioned: boolean }[]}
 */
export function sceneLinkItems(front, body, objects) {
  const byRef = new Map();
  for (const o of objects ?? []) {
    if (!o) continue;
    for (const k of [o.slug, o.id, typeof o.title === 'string' ? o.title.toLowerCase() : null]) if (typeof k === 'string' && k !== '' && !byRef.has(k)) byRef.set(k, o);
  }
  const find = (ref) => byRef.get(ref) ?? byRef.get(ref.toLowerCase()) ?? null;
  const groupOf = (o) => (o?.kind === 'thread' ? 'threads' : o?.type === 'character' ? 'characters' : o?.type === 'location' ? 'locations' : 'other');
  /** @type {Map<string, any>} */
  const items = new Map();
  const add = (ref, group, mentioned) => {
    if (typeof ref !== 'string' || ref.trim() === '') return;
    const o = find(ref);
    const key = o?.id ?? ref;
    if (items.has(key)) return;
    items.set(key, { key, id: o?.id ?? null, kind: o?.kind ?? null, ref: o?.slug ?? o?.id ?? ref, name: (typeof o?.title === 'string' && o.title !== '' ? o.title : null) ?? ref, group: group ?? groupOf(o), mentioned });
  };
  for (const [field, group] of FRONT_FIELDS) {
    const list = front?.[field];
    if (Array.isArray(list)) for (const ref of list) add(ref, group, false);
  }
  for (const ref of bodyLinkRefs(body ?? '')) add(ref, null, true);
  return [...items.values()];
}

/** Scenes that are final and all scenes of a chapter, for the thin bar under its count. @param {{ status?: string | null }[]} scenes */
export function chapterProgress(scenes) {
  const total = scenes.length;
  const final = scenes.filter((s) => s.status === 'final').length;
  return { final, total, percent: total === 0 ? 0 : Math.round((final / total) * 100) };
}

/** Book words against the word target: { words, target, percent } or null without a target. @param {number} words @param {number | null | undefined} target */
export function bookProgress(words, target) {
  if (!Number.isInteger(target) || /** @type {number} */ (target) < 1) return null;
  return { words, target: /** @type {number} */ (target), percent: Math.max(0, Math.min(100, Math.round((words / /** @type {number} */ (target)) * 100))) };
}
