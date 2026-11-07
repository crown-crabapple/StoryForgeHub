// Pure row building for the canvas Inspector (M10 C6): what the right-hand panel shows for the picked card, as sections of label/value rows.
// Nothing here touches the DOM or the network; the Inspector component only renders what these functions return.
import { kindLabel } from '../../planner/clues.js';
import { arcName, milestoneSummary, relationshipName, sceneName } from '../../planner/model.js';
import { ARC_TYPES, PLAN_FIELDS, STORY_FIELDS, arcMilestonesForScene, beatsForScene, linksForScene, relationLabel } from '../../planner/requests.js';
import { targetText, typeLabel } from '../../planner/synopsis.js';
import { REF_KIND_LABEL } from '../model.js';
import { activeStructure } from './selectors.js';

/** The ref kinds that have an editor in the drawer (the "Edit plan" action). */
export const EDITABLE_KINDS = ['scene', 'story-plan', 'structure', 'beat', 'arc', 'relationship', 'synopsis', 'clue'];
/** @param {string | null | undefined} kind */
export const canEditKind = (kind) => EDITABLE_KINDS.includes(String(kind));
/** The ref kinds whose card has an "Open" link (a page of its own). @param {string | null | undefined} kind */
export const canOpenKind = (kind) => kind === 'scene' || kind === 'entry';

/** @typedef {{ label: string, value?: string, items?: string[], warn?: boolean }} InspectorRow */
/** @typedef {{ id: string, title: string, rows: InspectorRow[] }} InspectorSection */

const BEAT_STATE_LABEL = { open: 'Open', done: 'Done', omitted: 'Omitted' };
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const asList = (data, key) => (Array.isArray(data?.[key]) ? data[key] : []);

/** The title of a scene by id from the plan's scene list; "Untitled scene" when it has none or is unknown. @param {any} plan @param {string | { id?: string, title?: string } | null | undefined} scene */
export function sceneTitleOf(plan, scene) {
  const id = typeof scene === 'string' ? scene : scene?.id;
  const found = (plan?.scenes ?? []).find((s) => s?.id === id);
  return sceneName(found?.title ?? (typeof scene === 'object' ? scene?.title : undefined));
}

/** Rows for the given [key, label] pairs that have text. @param {Record<string, any> | null | undefined} fields @param {{ key: string, label: string }[]} defs */
function fieldRows(fields, defs) {
  return defs.map((d) => ({ label: d.label, value: text(fields?.[d.key]) })).filter((r) => r.value !== '');
}

/** "a → b" with an ellipsis for a missing side; '' when both are empty. */
const arrow = (a, b) => (text(a) || text(b) ? `${text(a) || '…'} → ${text(b) || '…'}` : '');

/** Does a finding name this clue? PL6 puts the clue in `subject`. @param {any} finding @param {any} clue */
const namesClue = (finding, clue) => finding?.subject?.id === clue?.id || (typeof clue?.slug === 'string' && finding?.subject?.slug === clue.slug);

// ---------------------------------------------------------------- beats of a scene

/**
 * The beats of one structure with whether the scene sits in each (the accessible checkbox list). Null when there is no structure.
 * @param {any} structure a Structure of GET /structures @param {string} sceneId
 * @returns {{ structure: any, beats: { id: string, name: string, member: boolean }[] } | null}
 */
export function beatChoices(structure, sceneId) {
  if (!structure) return null;
  const beats = (structure.beats ?? [])
    .filter((b) => typeof b?.id === 'string' && b.id !== '')
    .map((b) => ({ id: b.id, name: text(b.name) || 'Untitled beat', member: (b.scenes ?? []).some((s) => (typeof s === 'string' ? s : s?.id) === sceneId) }));
  return { structure, beats };
}

/**
 * The whole beat list of a structure (the body of the beat save) with the scene added to or removed from one beat. The other beats are sent as they are.
 * @param {any} structure @param {string} beatId @param {string} sceneId @param {boolean} on
 */
export function beatListWithScene(structure, beatId, sceneId, on) {
  return (structure?.beats ?? []).map((b) => {
    const scenes = (b.scenes ?? []).map((s) => (typeof s === 'string' ? s : s?.id)).filter((s) => typeof s === 'string');
    if (b.id !== beatId) return { ...b, scenes };
    const has = scenes.includes(sceneId);
    return { ...b, scenes: on ? (has ? scenes : [...scenes, sceneId]) : scenes.filter((s) => s !== sceneId) };
  });
}

// ---------------------------------------------------------------- the rows of each kind

function sceneSections({ plan, refInfo, scenePlan }) {
  const sceneId = refInfo.id;
  /** @type {InspectorSection[]} */
  const sections = [];

  /** @type {InspectorRow[]} */
  const planRows = [];
  if (scenePlan === undefined) planRows.push({ label: 'Plan', value: 'Loading…' });
  else {
    const f = scenePlan?.fields ?? {};
    const filled = PLAN_FIELDS.some((p) => text(f[p.key]) !== '');
    if (!filled) planRows.push({ label: 'Plan', value: 'No plan yet', warn: true });
    else {
      const feeling = arrow(f.emotional_start, f.emotional_end);
      for (const p of PLAN_FIELDS) {
        if (p.key === 'emotional_start') {
          if (feeling) planRows.push({ label: 'Emotional start → end', value: feeling });
        } else if (p.key !== 'emotional_end' && text(f[p.key]) !== '') planRows.push({ label: p.label, value: text(f[p.key]) });
      }
    }
    const names = (Array.isArray(scenePlan?.characters) ? scenePlan.characters : []).map((c) => (typeof c === 'string' ? c : (c?.name ?? c?.title ?? ''))).filter(Boolean);
    if (names.length > 0) planRows.push({ label: 'Characters', items: names });
  }
  sections.push({ id: 'scene-plan', title: 'Scene plan', rows: planRows });

  const live = { links: asList(plan?.links, 'links').filter((l) => !l?.broken && !l?.archived) };
  const { outgoing, incoming } = linksForScene(live, sceneId);
  /** @type {InspectorRow[]} */
  const linkRows = [];
  if (outgoing.length > 0) linkRows.push({ label: 'Leads to', items: outgoing.map((l) => `${relationLabel(l.relation)} ${sceneName(l.to_title)}`) });
  if (incoming.length > 0) linkRows.push({ label: 'Comes from', items: incoming.map((l) => `${sceneName(l.from_title)} ${relationLabel(l.relation)}`) });
  if (linkRows.length === 0) linkRows.push({ label: 'Links', value: 'Not linked to other scenes yet' });
  sections.push({ id: 'links', title: 'Causal links', rows: linkRows });

  const inBeats = beatsForScene(plan?.structures, sceneId);
  sections.push({
    id: 'beats',
    title: 'Beats',
    rows: inBeats.length === 0 ? [{ label: 'Beats', value: 'No beat uses this scene' }] : [{ label: 'In beats', items: inBeats.map(({ structure, beat }) => `${structure.name}: ${beat.name}`) }],
  });

  const clues = asList(plan?.clues, 'clues');
  const planted = clues.filter((c) => (c.planted ?? []).some((p) => p?.id === sceneId));
  const revealed = clues.filter((c) => c.revealed?.id === sceneId);
  /** @type {InspectorRow[]} */
  const clueRows = [];
  if (planted.length > 0) clueRows.push({ label: 'Planted here', items: planted.map((c) => c.fact) });
  if (revealed.length > 0) clueRows.push({ label: 'Revealed here', items: revealed.map((c) => c.fact) });
  if (clueRows.length === 0) clueRows.push({ label: 'Clues', value: 'No clue is planted or revealed here' });
  sections.push({ id: 'clues', title: 'Clues', rows: clueRows });

  const miles = arcMilestonesForScene(plan?.arcs, sceneId);
  sections.push({
    id: 'arcs',
    title: 'Arc milestones',
    rows: miles.length === 0 ? [{ label: 'Milestones', value: 'No character arc has a milestone here' }] : [{ label: 'Milestones', items: miles.map(({ arc, milestone }) => `${arcName(arc)}: ${milestoneSummary(milestone) || `milestone ${milestone.index + 1}`}`) }],
  });
  return sections;
}

function clueSection({ plan, item, findings }) {
  if (!item) return [];
  const chip = item.red_herring ? 'Red herring' : kindLabel(item.kind ?? 'clue');
  /** @type {InspectorRow[]} */
  const rows = [{ label: 'Kind', value: chip }];
  if (text(item.fact)) rows.push({ label: 'Fact', value: item.fact });
  const planted = (item.planted ?? []).map((p) => sceneTitleOf(plan, p));
  rows.push(planted.length > 0 ? { label: 'Planted', items: planted } : { label: 'Planted', value: 'Nowhere yet' });
  rows.push(item.revealed ? { label: 'Revealed', value: sceneTitleOf(plan, item.revealed) } : { label: 'Revealed', value: 'Not yet', warn: true });
  for (const f of (findings ?? []).filter((x) => x?.rule === 'PL6' && namesClue(x, item))) rows.push({ label: 'Plan check (PL6)', value: f.title ?? f.message ?? 'Revealed before it is planted', warn: true });
  const knowers = (item.knowers ?? []).map((k) => `${k.who?.reader ? 'The reader' : (k.who?.name ?? 'Someone')}${k.scene ? ` in ${sceneTitleOf(plan, k.scene)}` : ''}${k.reliable === false ? ' (believes something false)' : ''}`);
  rows.push(knowers.length > 0 ? { label: 'Who knows', items: knowers } : { label: 'Who knows', value: 'Nobody yet' });
  return [{ id: 'clue', title: 'Clue', rows }];
}

function arcSections({ plan, item }) {
  if (!item) return [];
  const f = item.fields ?? {};
  /** @type {InspectorRow[]} */
  const rows = [];
  if (item.arc_type) rows.push({ label: 'Type', value: ARC_TYPES.find((t) => t.value === item.arc_type)?.label ?? item.arc_type });
  rows.push(...fieldRows(f, [{ key: 'want', label: 'Want' }, { key: 'need', label: 'Need' }, { key: 'false_belief', label: 'False belief' }, { key: 'wound', label: 'Wound' }]));
  const shape = arrow(f.start_state, f.end_state);
  if (shape) rows.push({ label: 'Start → end', value: shape });
  const miles = (item.milestones ?? []).map((m) => `${sceneTitleOf(plan, m.scene)}: ${milestoneSummary(m) || `milestone ${(m.index ?? 0) + 1}`}`);
  return [
    { id: 'arc', title: 'Arc', rows },
    { id: 'milestones', title: 'Milestones', rows: miles.length > 0 ? [{ label: 'Per scene', items: miles }] : [{ label: 'Per scene', value: 'No milestones yet' }] },
  ];
}

function relationshipSections({ plan, item }) {
  if (!item) return [];
  /** @type {InspectorRow[]} */
  const rows = [];
  const baseline = text(item.baseline) || text(item.fields?.baseline);
  const end = text(item.end_state) || text(item.fields?.end_state);
  if (baseline) rows.push({ label: 'Baseline', value: baseline });
  if (end) rows.push({ label: 'End state', value: end });
  const devs = (item.developments ?? []).map((d) => `${sceneTitleOf(plan, d.scene)}: ${d.change || 'development'}`);
  return [
    { id: 'relationship', title: 'Relationship', rows },
    { id: 'developments', title: 'Developments', rows: devs.length > 0 ? [{ label: 'Per scene', items: devs }] : [{ label: 'Per scene', value: 'No developments yet' }] },
  ];
}

function synopsisSection({ item }) {
  if (!item) return [];
  /** @type {InspectorRow[]} */
  const rows = [{ label: 'Type', value: typeLabel(item.type) }];
  if (typeof item.words === 'number') rows.push({ label: 'Words', value: targetText(item.words, item.target_words) });
  if (item.stale) rows.push({ label: 'Sources', value: 'Sources changed since this was written', warn: true });
  return [{ id: 'synopsis', title: 'Synopsis', rows }];
}

function storySection({ plan, item }) {
  if (!item) return [];
  const f = item.fields ?? {};
  const rows = fieldRows(f, STORY_FIELDS.filter((d) => ['logline', 'premise', 'theme_question', 'protagonist_goal'].includes(d.key)));
  const primary = asList(plan?.structures, 'structures').find((s) => s.primary);
  rows.push({ label: 'Primary structure', value: primary?.name ?? 'None set' });
  return [{ id: 'story-plan', title: 'Story plan', rows }];
}

function beatSection({ plan, item }) {
  if (!item) return [];
  /** @type {InspectorRow[]} */
  const rows = [{ label: 'Name', value: item.name ?? 'Untitled beat' }];
  if (text(item.position)) rows.push({ label: 'Position', value: item.position });
  if (text(item.question)) rows.push({ label: 'Question', value: item.question });
  rows.push({ label: 'State', value: BEAT_STATE_LABEL[item.state ?? 'open'] ?? 'Open' });
  const scenes = (item.scenes ?? []).map((s) => sceneTitleOf(plan, s));
  rows.push(scenes.length > 0 ? { label: 'Scenes', items: scenes } : { label: 'Scenes', value: 'No scene assigned' });
  return [{ id: 'beat', title: 'Beat', rows }];
}

function structureSection({ item }) {
  if (!item) return [];
  /** @type {InspectorRow[]} */
  const rows = [{ label: 'Name', value: item.name ?? 'Structure' }, { label: 'Beats', value: String(item.counts?.beats ?? (item.beats ?? []).length) }];
  if (item.primary) rows.push({ label: 'Primary', value: 'Yes' });
  return [{ id: 'structure', title: 'Structure', rows }];
}

/**
 * Everything the Inspector shows for one picked card.
 * @param {{ plan: any, refInfo: { kind: string, id: string, title?: string | null, summary?: string | null, path?: string | null } | null | undefined, item: any, scenePlan?: any, findings?: any[] | null, structureId?: string | null }} p
 *   `item` is the planner object (planItemFor); `scenePlan` is GET /scene-plans/:id for a scene (undefined while loading, null when it has none).
 * @returns {{ kind: string, kindLabel: string, title: string, path: string | null, sections: InspectorSection[], beatChoices: ReturnType<typeof beatChoices> }}
 */
export function buildInspector({ plan, refInfo, item, scenePlan, findings = null, structureId = null }) {
  const kind = refInfo?.kind ?? 'card';
  const base = { kind, kindLabel: REF_KIND_LABEL[kind] ?? kind, path: refInfo?.path ?? null, beatChoices: /** @type {ReturnType<typeof beatChoices>} */ (null) };
  const args = { plan, refInfo, item, findings, scenePlan };
  let title = refInfo?.title ?? '';
  /** @type {InspectorSection[]} */
  let sections;
  switch (kind) {
    case 'scene':
      sections = sceneSections({ plan, refInfo: /** @type {any} */ (refInfo), scenePlan });
      return { ...base, title: title || 'Untitled scene', sections, beatChoices: beatChoices(activeStructure(plan?.structures, structureId), /** @type {any} */ (refInfo).id) };
    case 'clue':
      title = item?.fact ?? title;
      sections = clueSection(args);
      break;
    case 'arc':
      title = item ? arcName(item) : title;
      sections = arcSections(args);
      break;
    case 'relationship':
      title = item ? relationshipName(item) : title;
      sections = relationshipSections(args);
      break;
    case 'synopsis':
      title = item?.name || title;
      sections = synopsisSection(args);
      break;
    case 'story-plan':
      sections = storySection(args);
      break;
    case 'beat':
      title = item?.name ?? title;
      sections = beatSection(args);
      break;
    case 'structure':
      title = item?.name ?? title;
      sections = structureSection(args);
      break;
    default:
      sections = [];
  }
  if (sections.length === 0 && text(refInfo?.summary)) sections = [{ id: 'summary', title: 'Summary', rows: [{ label: 'Summary', value: /** @type {string} */ (refInfo?.summary) }] }];
  return { ...base, title: title || base.kindLabel, sections };
}
