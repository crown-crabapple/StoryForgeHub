// CS1 (dead on the page) and CS2 (gone object used): a scene's `cast` against the died / revived / destroyed / lost / found state items,
// both read by chapter. A state item counts from the chapter after its own; a scene in the same chapter is never reported.
// With `planned` (a pre-flight check for a chapter not written yet) the given cast is checked as if one more scene of that chapter had it.
import { fingerprintOf } from './rules.mjs';
import { stateItems } from './timeline.mjs';

const has = (d, type) => d && d.fm.type === type;
const nameOf = (d) => String(d.fm.name ?? d.fm.slug);
const subjectOf = (d) => ({ kind: 'entry', id: d.fm.id, slug: d.fm.slug, name: nameOf(d) });

/**
 * The chapter an event belongs to: the chapter of its first scene, else the number in a "Chapter N" title or a chapter-N slug; null when it cannot be placed.
 * @param {import('./model.mjs').Model} model @param {import('@storyforge/format').Doc} event
 */
export function chapterOfEvent(model, event) {
  const first = (model.eventScenes.get(event) ?? [])[0];
  if (first && Number.isInteger(first.doc.fm.chapter)) return first.doc.fm.chapter;
  const m = /^Chapter (\d+)\b/.exec(String(event.fm.title ?? '')) ?? /(?:^|-)chapter-(\d+)(?:-|$)/.exec(String(event.fm.slug ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * @param {import('./model.mjs').Model} model
 * @param {{ chapter?: number, cast?: { entry: string, role: string }[] }} [planned] a planned cast for `chapter`
 * @returns {Promise<import('./engine.mjs').Finding[]>}
 */
export async function castFindings(model, planned = {}) {
  /** @type {any[]} */
  const findings = [];
  const items = stateItems(model)
    .map((it, n) => ({ ...it, chapter: chapterOfEvent(model, it.event), n }))
    .filter((it) => it.chapter !== null && ['died', 'revived', 'destroyed', 'lost', 'found'].includes(it.kind));
  /** earlier = sorts before: chapter, event order, then the position in the list */
  const before = (a, b) => a.chapter - b.chapter || a.order - b.order || a.n - b.n;

  /** the latest ending item of `entry` that is in force in `chapter`, or null @param {any} entry @param {number} chapter @param {'CS1'|'CS2'} rule */
  const ending = (entry, chapter, rule) => {
    const mine = items.filter((i) => i.entry === entry).sort(before);
    const ends = rule === 'CS1' ? ['died'] : ['destroyed', 'lost'];
    const back = rule === 'CS1' ? ['revived'] : ['found'];
    const gone = [...mine].reverse().find((i) => ends.includes(i.kind) && i.chapter < chapter);
    if (!gone) return null;
    return mine.some((i) => back.includes(i.kind) && before(gone, i) < 0 && i.chapter <= chapter) ? null : gone;
  };

  /** @param {any} entry @param {number} chapter @param {{ role: string }} m @param {{ sceneDoc: any, index: number } | null} scene */
  const check = async (entry, chapter, m, scene) => {
    if (m.role !== 'pov' && m.role !== 'appears') return;
    for (const rule of /** @type {const} */ (['CS1', 'CS2'])) {
      if (rule === 'CS1' && !has(entry, 'character')) continue;
      const gone = ending(entry, chapter, rule);
      if (!gone) continue;
      const name = nameOf(entry);
      const verb = { died: 'died', destroyed: 'was destroyed', lost: 'was lost' }[/** @type {'died'|'destroyed'|'lost'} */ (gone.kind)];
      const where = scene ? `"${scene.sceneDoc.fm.title}" (chapter ${chapter})` : `the planned cast of chapter ${chapter}`;
      const sources = [await model.fmSource(gone.event, 'event', 'event', `state[${gone.index}]`, ['state', gone.index])];
      if (scene) sources.push(await model.fmSource(scene.sceneDoc, 'text', 'scene', `cast[${scene.index}]`, ['cast', scene.index]));
      const sceneId = scene ? scene.sceneDoc.fm.id : null;
      findings.push({
        fingerprint: fingerprintOf(rule, entry.fm.id, [gone.event.fm.id, ...(sceneId ? [sceneId] : [])], `${rule === 'CS1' ? 'dead' : 'gone'}|${entry.fm.slug}|${sceneId ?? `planned-chapter-${chapter}`}`),
        rule, rule_version: 1, severity: 'error',
        title: rule === 'CS1' ? `${name} is on the page after dying` : `${name} is used after being ${gone.kind === 'lost' ? 'lost' : 'destroyed'}`,
        message: `${name} ${verb} in chapter ${gone.chapter} (${gone.event.fm.title}) with no ${rule === 'CS1' ? 'revival' : 'find'} after it, but is ${m.role === 'pov' ? 'the pov' : 'in the cast'} of ${where}.`,
        subject: subjectOf(entry),
        sources,
        related: sceneId ? [sceneId] : [],
        ...(scene ? {} : { planned: true }),
      });
    }
  };

  for (const s of model.scenes) {
    const chapter = s.doc.fm.chapter;
    if (!Number.isInteger(chapter) || !Array.isArray(s.doc.fm.cast)) continue;
    for (const [index, m] of s.doc.fm.cast.entries()) {
      const entry = model.ref(s.doc, `cast[${index}].entry`);
      if (entry && entry.kind === 'entry' && m && typeof m === 'object') await check(entry, chapter, m, { sceneDoc: s.doc, index });
    }
  }
  if (Number.isInteger(planned.chapter) && Array.isArray(planned.cast)) {
    for (const m of planned.cast) {
      const entry = model.entries.find((e) => e.fm.id === m.entry || e.fm.slug === m.entry);
      if (entry) await check(entry, /** @type {number} */ (planned.chapter), m, null);
    }
  }
  return findings;
}
