// Story Planner records (ADR 0003): W316 when two live links share (from, to, relation), W317 when two live scene plans name the same scene.
// (E211, a link from a scene to itself, is a field check in schema.mjs.) Archived files are left out of both.
// W318: a live story plan (schema storyforge.story-plan/v1) that is not planning/story.md; every such file is flagged, so at most one live plan is clean.
// Arcs (M3): every arc's `milestones` list is checked (E102 shape, I401 unknown key, E301 unknown scene, W303 archived scene); W319 when two live arcs name the same character.

const STORY_PLAN_PATH = 'planning/story.md';
const MILESTONE_TEXT_KEYS = ['pressure', 'choice', 'belief_before', 'belief_after', 'cost'];
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Milestone items of one arc: E102 / I401 on the shape, E301 / W303 on the scene. */
function checkMilestones(d, scenes, add) {
  if (!Array.isArray(d.fm.milestones)) return; // a non-list is reported by the field table
  d.fm.milestones.forEach((m, i) => {
    const at = (k) => `milestones[${i}].${k}`;
    if (!isMap(m)) {
      add('E102', d.file, `milestones[${i}]`, 'milestone must be a mapping with a scene and optional pressure, choice, belief_before, belief_after and cost');
      return;
    }
    if (typeof m.scene !== 'string' || m.scene === '') add('E102', d.file, at('scene'), 'milestone scene must be a scene id');
    else {
      const hit = scenes.get(m.scene);
      if (!hit) add('E301', d.file, at('scene'), `cannot resolve ${m.scene}`);
      else if (hit.archived) add('W303', d.file, at('scene'), `${m.scene} points into archive/`);
    }
    for (const k of MILESTONE_TEXT_KEYS) {
      if (Object.hasOwn(m, k) && typeof m[k] !== 'string') add('E102', d.file, at(k), `${k} must be a string`);
    }
    for (const k of Object.keys(m)) {
      if (k !== 'scene' && !MILESTONE_TEXT_KEYS.includes(k)) add('I401', d.file, at(k), 'unknown field');
    }
  });
}

/**
 * @param {import('./load.mjs').Doc[]} docs typed documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkPlanner(docs, add) {
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const links = new Map();
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const plans = new Map();
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const arcs = new Map();
  const push = (map, key, d) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  };
  // a live scene beats an archived one with the same id
  const scenes = new Map();
  for (const d of docs) if (d.kind === 'scene' && typeof d.fm.id === 'string' && (!scenes.has(d.fm.id) || scenes.get(d.fm.id).archived)) scenes.set(d.fm.id, d);
  for (const d of docs) if (d.kind === 'arc') checkMilestones(d, scenes, add);
  for (const d of docs) {
    if (d.archived) continue;
    const { fm } = d;
    if (d.kind === 'story-plan' && d.rel !== STORY_PLAN_PATH) add('W318', d.file, 'schema', `a story plan must be ${STORY_PLAN_PATH}`);
    if (d.kind === 'link' && typeof fm.from === 'string' && typeof fm.to === 'string' && typeof fm.relation === 'string') push(links, JSON.stringify([fm.from, fm.to, fm.relation]), d);
    else if (d.kind === 'scene-plan' && typeof fm.scene === 'string') push(plans, fm.scene, d);
    else if (d.kind === 'arc' && typeof fm.character === 'string') push(arcs, fm.character, d);
  }
  // by name without .md, so key-x.md comes before key-x-2.md
  const stem = (d) => d.file.replace(/[.]md$/, '');
  const byFile = (a, b) => (stem(a) < stem(b) ? -1 : stem(a) > stem(b) ? 1 : 0);
  for (const list of links.values()) {
    if (list.length < 2) continue;
    list.sort(byFile);
    for (const d of list.slice(1)) add('W316', d.file, 'relation', `${list[0].file} already links the same scenes with relation ${d.fm.relation}`);
  }
  for (const list of plans.values()) {
    if (list.length < 2) continue;
    list.sort(byFile);
    for (const d of list.slice(1)) add('W317', d.file, 'scene', `${list[0].file} is already the plan of this scene`);
  }
  for (const list of arcs.values()) {
    if (list.length < 2) continue;
    list.sort(byFile);
    for (const d of list.slice(1)) add('W319', d.file, 'character', `${list[0].file} is already the arc of this character`);
  }
}
