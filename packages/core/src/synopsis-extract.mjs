// Deterministic synopsis extraction (ADR 0003, M7): text built from structured records only (story plan fields, scene summaries, the primary structure's
// beats), never from prose. A pure function: no filesystem, no network, no clock. The same inputs always give the same text, so its sha256 is a stable basis.
import { createHash } from 'node:crypto';

/**
 * @typedef {{ id: string, title?: string | null, summary?: string | null, act?: number | null, chapter?: number | null }} ExtractScene  a live scene, in reading order
 * @typedef {{ beats: { name?: string | null, scenes?: (string | { id: string })[] }[] }} ExtractStructure  the primary structure (beats in file order)
 */

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

/** The text with a sentence end: a period is added when it does not already end in . ! ? or an ellipsis (a closing quote or bracket may follow). */
const sentence = (s) => (/[.!?…]["'”’)\]]*$/.test(s) ? s : `${s}.`);

/** Group scenes by a key, in order of first appearance. @returns {Map<any, ExtractScene[]>} */
function groupBy(scenes, key) {
  const out = new Map();
  for (const s of scenes) {
    const k = key(s);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(s);
  }
  return out;
}

/** One paragraph per group of scenes: the summaries joined by a space; a group with no summary gives none. */
const paragraphsBy = (scenes, key) => [...groupBy(scenes, key).values()].map((g) => g.map((s) => clean(s.summary)).filter((t) => t !== '').join(' ')).filter((t) => t !== '');

const finish = (paragraphs, skipped) => ({ text: paragraphs.length === 0 ? '' : `${paragraphs.join('\n\n')}\n`, skipped });
const noSummary = (scenes) => scenes.filter((s) => clean(s.summary) === '').length;

/**
 * The proposal for one synopsis type.
 * - premise: the premise, then " " and the central conflict. logline: the logline. elevator-pitch: logline, protagonist_goal, central_conflict, stakes as sentences in that order.
 * - short: one paragraph per beat of the primary structure, "**<beat name>.** " and its scene summaries joined by " " (beats with no summarised scene are left out); no primary structure: as one-page.
 * - one-page: one paragraph per act of scene summaries joined by " ". long and custom: one paragraph per chapter.
 * - chapter-treatment: "## Chapter <n>" per chapter, then "**<title>.** <summary>" as a paragraph for each scene with a summary.
 * Paragraphs are separated by one blank line and the text ends with one line break ('' when there is nothing). `skipped` counts the scenes without a summary that the type would have used.
 * @param {string} type
 * @param {{ storyPlan?: any, scenes?: ExtractScene[], primaryStructure?: ExtractStructure | null }} input storyPlan is the story plan's fields (or the getStoryPlan result, which holds them under `fields`)
 * @returns {{ text: string, skipped: number }}
 */
export function extractText(type, { storyPlan, scenes = [], primaryStructure = null } = {}) {
  const f = storyPlan?.fields ?? storyPlan ?? {};
  const field = (k) => clean(f[k]);
  switch (type) {
    case 'premise': {
      const text = [field('premise'), field('central_conflict')].filter((t) => t !== '').join(' ');
      return finish(text === '' ? [] : [text], 0);
    }
    case 'logline': {
      const text = field('logline');
      return finish(text === '' ? [] : [text], 0);
    }
    case 'elevator-pitch': {
      const text = ['logline', 'protagonist_goal', 'central_conflict', 'stakes'].map(field).filter((t) => t !== '').map(sentence).join(' ');
      return finish(text === '' ? [] : [text], 0);
    }
    case 'short': {
      if (!primaryStructure || !Array.isArray(primaryStructure.beats)) return extractText('one-page', { storyPlan, scenes });
      const byId = new Map(scenes.map((s) => [s.id, s]));
      const paragraphs = [];
      const missing = new Set();
      for (const beat of primaryStructure.beats) {
        const ids = (Array.isArray(beat.scenes) ? beat.scenes : []).map((s) => (typeof s === 'string' ? s : s?.id)).filter((id) => byId.has(id));
        for (const id of ids) if (clean(byId.get(id).summary) === '') missing.add(id);
        const summaries = ids.map((id) => clean(byId.get(id).summary)).filter((t) => t !== '');
        if (summaries.length === 0) continue;
        const name = clean(beat.name);
        paragraphs.push(`${name === '' ? '' : `**${name}.** `}${summaries.join(' ')}`);
      }
      return finish(paragraphs, missing.size);
    }
    case 'one-page':
      return finish(paragraphsBy(scenes, (s) => s.act ?? null), noSummary(scenes));
    case 'long':
    case 'custom':
      return finish(paragraphsBy(scenes, (s) => s.chapter ?? null), noSummary(scenes));
    case 'chapter-treatment': {
      const paragraphs = [];
      for (const [chapter, group] of groupBy(scenes, (s) => s.chapter ?? null)) {
        paragraphs.push(chapter === null ? '## No chapter' : `## Chapter ${chapter}`);
        for (const s of group) {
          const summary = clean(s.summary);
          if (summary === '') continue;
          const title = clean(s.title);
          paragraphs.push(`${title === '' ? '' : `**${title}.** `}${summary}`);
        }
      }
      return finish(paragraphs, noSummary(scenes));
    }
    default:
      return { text: '', skipped: 0 };
  }
}

/** sha256 (hex) of the text as UTF-8: the `basis` of a proposal. @param {string} text */
export const basisOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
