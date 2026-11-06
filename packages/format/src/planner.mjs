// Story Planner records (ADR 0003): W316 when two live links share (from, to, relation), W317 when two live scene plans name the same scene.
// (E211, a link from a scene to itself, is a field check in schema.mjs.) Archived files are left out of both.
// W318: a live story plan (schema storyforge.story-plan/v1) that is not planning/story.md; every such file is flagged, so at most one live plan is clean.

const STORY_PLAN_PATH = 'planning/story.md';

/**
 * @param {import('./load.mjs').Doc[]} docs typed documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkPlanner(docs, add) {
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const links = new Map();
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const plans = new Map();
  const push = (map, key, d) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  };
  for (const d of docs) {
    if (d.archived) continue;
    const { fm } = d;
    if (d.kind === 'story-plan' && d.rel !== STORY_PLAN_PATH) add('W318', d.file, 'schema', `a story plan must be ${STORY_PLAN_PATH}`);
    if (d.kind === 'link' && typeof fm.from === 'string' && typeof fm.to === 'string' && typeof fm.relation === 'string') push(links, JSON.stringify([fm.from, fm.to, fm.relation]), d);
    else if (d.kind === 'scene-plan' && typeof fm.scene === 'string') push(plans, fm.scene, d);
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
}
