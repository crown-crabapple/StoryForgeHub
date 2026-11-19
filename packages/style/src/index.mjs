// @storyforge/style (M13-J03): style checks with the textlint kernel and StoryForge's own curated rules. Server-only, no file or process access.
// checkStyle() runs the enabled rules from the fixed RULES table on the projected prose (J01 §5) and maps every report back to the body.
// A replacement travels from a rule to its finding as the textlint message's `fix`; `related` travels through a per-run side channel
// (`run.related`, see rules/util.mjs) because textlint messages drop custom data. Nothing here names a module, path or package from settings.
import { createHash } from 'node:crypto';
import { TextlintKernel } from '@textlint/kernel';
import textPlugin from '@textlint/textlint-plugin-text';
import { FINDING_SCHEMA, findingId, isWholeRange, projectProse, toBodyRange } from '@storyforge/format';
import { RULES } from './rules/index.mjs';
import { extension, gramKey, isCommonPhrase, MAX_CANDIDATES, tokenize } from './rules/phrases.mjs';
import { intOption, relatedKey } from './rules/util.mjs';

export const TEXTLINT_VERSION = '16.1.1';
export const STYLE_RULE_IDS = Object.freeze(Object.keys(RULES));

const deepFreeze = (v) => {
  if (v !== null && typeof v === 'object') for (const x of Object.values(v)) deepFreeze(x);
  return Object.freeze(v);
};

/** Every rule's default settings, as data (the shape of `checks.style.rules`). */
export const STYLE_DEFAULTS = deepFreeze(Object.fromEntries(STYLE_RULE_IDS.map((id) => [id, structuredClone(RULES[id].defaults)])));

const MAX_MESSAGE = 1000;
const MAX_RELATED = 20;
const RELATED_TEXT = 200;
const CONTEXT = 24;

const kernel = new TextlintKernel();

/** The options of a rule: its defaults overridden by the settings' map for that id (only keys the rule defines). Unknown ids are never read. */
function optionsOf(settings, id) {
  const given = settings?.rules?.[id];
  const out = structuredClone(RULES[id].defaults);
  if (given !== null && typeof given === 'object' && !Array.isArray(given)) {
    for (const key of Object.keys(out)) if (Object.prototype.hasOwnProperty.call(given, key)) out[key] = given[key];
  }
  return out;
}

const isOn = (options) => options.enabled === true;

function baseFinding(id, sceneId, body, sha256, range) {
  const meta = RULES[id];
  return {
    schema: FINDING_SCHEMA,
    id: '',
    engine: 'textlint',
    engineVersion: TEXTLINT_VERSION,
    ruleId: id,
    category: meta.category,
    severity: meta.severity,
    advisory: meta.advisory,
    message: '',
    sceneId,
    source: { sha256, length: body.length },
    range,
    original: body.slice(range.from, range.to),
    replacements: [],
  };
}

/** A related occurrence from a body range, or null. */
function relatedOf(sceneId, body, range) {
  if (!range || range.to <= range.from) return null;
  return { sceneId, from: range.from, to: range.to, text: body.slice(range.from, range.to).slice(0, RELATED_TEXT) };
}

const order = (a, b) => a.range.from - b.range.from || a.range.to - b.range.to || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0);

/**
 * Style findings for one scene.
 * @param {{ sceneId: string, body: string, settings?: { rules?: Record<string, any> }, sha256: string }} input `body` has LF line breaks;
 *   `settings` is the book's `checks.style` (only `rules` is read; whether style checks are on at all is the caller's decision).
 * @returns {Promise<object[]>} findings sorted by range
 */
export async function checkStyle({ sceneId, body, settings, sha256 }) {
  if (typeof body !== 'string' || body === '') return [];
  const projection = projectProse(body);
  if (projection.text === '') return [];
  const run = { related: new Map() };
  const rules = [];
  for (const id of STYLE_RULE_IDS) {
    const options = optionsOf(settings, id);
    if (!isOn(options)) continue;
    const mod = RULES[id];
    rules.push({ ruleId: id, rule: (context, opts) => mod.rule(context, opts, run), options });
  }
  if (rules.length === 0) return [];
  const result = await kernel.lintText(projection.text, { ext: '.txt', plugins: [{ pluginId: 'text', plugin: textPlugin }], rules });

  const out = [];
  const seen = new Set();
  for (const msg of result.messages) {
    if (!Object.prototype.hasOwnProperty.call(RULES, msg.ruleId)) continue;
    const [from, to] = msg.range;
    const replacements = [];
    if (msg.fix) {
      if (msg.fix.range[0] !== from || msg.fix.range[1] !== to) continue;
      replacements.push(msg.fix.text);
      if (!isWholeRange(projection, from, to)) continue;
    }
    const range = toBodyRange(projection, from, to);
    if (!range) continue;
    if (replacements.length > 0 && range.to - range.from !== to - from) continue;
    const f = baseFinding(msg.ruleId, sceneId, body, sha256, range);
    if (f.original === '') continue;
    f.message = String(msg.message || msg.ruleId).slice(0, MAX_MESSAGE);
    f.replacements = replacements;
    const related = run.related.get(relatedKey(msg.ruleId, from, to));
    if (related) f.related = related.slice(0, MAX_RELATED).map((r) => relatedOf(sceneId, body, toBodyRange(projection, r.from, r.to))).filter(Boolean);
    f.id = findingId(f);
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  out.sort(order);
  return out;
}

/**
 * Advisory `repeated-phrases` findings for phrases that recur in different scenes. Runs only when `repeated-phrases` is on.
 * In every scene that has the phrase, the first occurrence found is reported, with `related` listing the occurrences in other scenes
 * (earliest scenes first, at most 20).
 * @param {{ sceneId: string, body: string, sha256: string }[]} scenes in book order
 * @param {{ rules?: Record<string, any> }} [settings]
 * @returns {object[]} findings in scene order, then range order
 */
export function crossSceneRepeats(scenes, settings) {
  const options = optionsOf(settings, 'repeated-phrases');
  if (!isOn(options) || !Array.isArray(scenes) || scenes.length < 2) return [];
  const minWords = intOption(options.minWords, RULES['repeated-phrases'].defaults.minWords, 3, 8);
  const data = scenes.map((s) => {
    const projection = projectProse(s.body);
    return { scene: s, projection, tokens: tokenize(projection.text) };
  });
  /** @type {Map<string, { s: number, w: number }[]>} */
  const grams = new Map();
  data.forEach((d, s) => {
    for (let w = 0; w < d.tokens.words.length; w += 1) {
      const key = gramKey(d.tokens, w, minWords);
      if (key === null) continue;
      const list = grams.get(key);
      if (list) list.push({ s, w }); else grams.set(key, [{ s, w }]);
    }
  });
  const out = [];
  data.forEach((d, s) => {
    const t = d.tokens;
    const { body, sceneId, sha256 } = d.scene;
    const seenInScene = new Set();
    let i = 0;
    while (i < t.words.length) {
      const key = gramKey(t, i, minWords);
      const others = key === null ? [] : (grams.get(key) ?? []).filter((c) => c.s !== s);
      let best = 0;
      let found = [];
      for (let k = 0; k < others.length && k < MAX_CANDIDATES; k += 1) {
        const c = others[k];
        const n = extension(t, i, data[c.s].tokens, c.w, minWords);
        if (n === 0) continue;
        if (n > best) { best = n; found = [c]; } else if (n === best) found.push(c);
      }
      if (best === 0 || isCommonPhrase(t, i, best)) { i += 1; continue; }
      const phrase = t.words.slice(i, i + best).join(' ');
      const range = toBodyRange(d.projection, t.starts[i], t.ends[i + best - 1]);
      if (!range || seenInScene.has(phrase)) { i += best; continue; }
      seenInScene.add(phrase);
      const related = [];
      for (const c of found) {
        const o = data[c.s];
        const r = relatedOf(o.scene.sceneId, o.scene.body, toBodyRange(o.projection, o.tokens.starts[c.w], o.tokens.ends[c.w + best - 1]));
        if (r) related.push(r);
        if (related.length === MAX_RELATED) break;
      }
      const f = baseFinding('repeated-phrases', sceneId, body, sha256, range);
      f.message = `This phrase of ${best} words also appears in another scene.`;
      f.related = related;
      f.id = findingId(f);
      out.push(f);
      i += best;
    }
  });
  return out;
}

/**
 * The fingerprint of a style finding: `sty-` + the first 16 hex of SHA-256 over JSON [ruleId, sceneId, original, before, after],
 * where before/after are up to 24 characters of body text either side of the range. It changes when the passage changes.
 * @param {{ ruleId: string, sceneId: string, original: string, range: { from: number, to: number } }} finding @param {string} body
 */
export function styleFingerprint(finding, body) {
  const { from, to } = finding.range;
  const before = body.slice(Math.max(0, from - CONTEXT), from);
  const after = body.slice(to, to + CONTEXT);
  const hex = createHash('sha256').update(JSON.stringify([finding.ruleId, finding.sceneId, finding.original, before, after])).digest('hex');
  return `sty-${hex.slice(0, 16)}`;
}
