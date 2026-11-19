// Harper grammar adapter (M13-J02 §4). Pure: no Harper import, no I/O. Turns plain data the worker extracted from Harper's lints
// into storyforge.finding/v1 objects whose ranges are exact body offsets.
import { findingId, FINDING_SCHEMA } from '../findings/findings.js';
import { isWholeRange, toBodyRange } from '../findings/prose-map.js';

/** The pinned harper.js version; a test checks it equals the dependency in apps/web/package.json. */
export const HARPER_VERSION = '3.2.0';

/** Harper lint kind -> finding category. Any kind not listed is `grammar`. */
export const KIND_CATEGORY = Object.freeze({
  Spelling: 'spelling',
  Typo: 'spelling',
  Punctuation: 'punctuation',
  Formatting: 'punctuation',
  Capitalization: 'punctuation',
  Style: 'style',
  Readability: 'style',
  Redundancy: 'style',
  Enhancement: 'style',
  WordChoice: 'style',
  Repetition: 'style',
  Regionalism: 'style',
});

const MAX_REPLACEMENTS = 8;
const MAX_MESSAGE = 1000;

/** @param {string} kind */
export function categoryOf(kind) {
  return Object.prototype.hasOwnProperty.call(KIND_CATEGORY, kind) ? KIND_CATEGORY[kind] : 'grammar';
}

/**
 * @typedef {{ text: string, map: Int32Array }} Projection (see findings/prose-map.js)
 * @typedef {object} Finding (see findings/findings.js)
 * @typedef {{ kind: 'Replace' | 'Remove' | 'InsertAfter', text: string }} HarperSuggestion
 * @typedef {{ start: number, end: number, kind: string, message: string, problem?: string, suggestions: HarperSuggestion[] }} HarperLint
 */

/** @param {HarperSuggestion[]} suggestions @param {string} original */
function replacementsOf(suggestions, original) {
  const out = [];
  for (const s of suggestions ?? []) {
    let r;
    if (s.kind === 'Replace') r = s.text;
    else if (s.kind === 'Remove') r = '';
    else if (s.kind === 'InsertAfter') r = original + s.text;
    else continue;
    if (typeof r !== 'string' || out.includes(r)) continue;
    out.push(r);
    if (out.length === MAX_REPLACEMENTS) break;
  }
  return out;
}

/**
 * @param {{ sceneId: string, body: string, projection: Projection, sha256: string,
 *   organized: Record<string, HarperLint[]> }} input
 * `body` has LF line breaks; `start`/`end` in `organized` are UTF-16 offsets into `projection.text`.
 * @returns {Finding[]} sorted by range
 */
export function toFindings({ sceneId, body, projection, sha256, organized }) {
  const out = [];
  for (const [ruleId, lints] of Object.entries(organized ?? {})) {
    for (const lint of lints) {
      // A lint across left-out text (e.g. the double space where inline code was) would delete that text if applied: skip it.
      if (!isWholeRange(projection, lint.start, lint.end)) continue;
      const range = toBodyRange(projection, lint.start, lint.end);
      if (!range) continue;
      const original = body.slice(range.from, range.to);
      if (original === '') continue;
      const category = categoryOf(lint.kind);
      const advisory = category === 'style';
      const message = String(lint.message || ruleId).slice(0, MAX_MESSAGE);
      const f = {
        schema: FINDING_SCHEMA,
        id: '',
        engine: 'harper',
        engineVersion: HARPER_VERSION,
        ruleId,
        category,
        severity: advisory ? 'info' : 'warning',
        advisory,
        message,
        sceneId,
        source: { sha256, length: body.length },
        range,
        original,
        replacements: replacementsOf(lint.suggestions, original),
      };
      f.id = findingId(f);
      out.push(f);
    }
  }
  out.sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  return out;
}
