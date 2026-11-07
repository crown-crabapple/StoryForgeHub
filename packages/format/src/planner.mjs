// Story Planner records (ADR 0003): W316 when two live links share (from, to, relation, branch), W317 when two live scene plans name the same scene.
// (E211, a link from a scene to itself, is a field check in schema.mjs.) Archived files are left out of both.
// W318: a live story plan (schema storyforge.story-plan/v1) that is not planning/story.md; every such file is flagged, so at most one live plan is clean.
// Arcs (M3): every arc's `milestones` list is checked (E102 shape, I401 unknown key, E301 unknown scene, W303 archived scene); W319 when two live arcs name the same character.
// Relationships (M5): every relationship's `developments` list is checked (E102 shape, I401 unknown key, E301 unknown scene, W303 archived scene); W320 when two live relationships name the same pair of entries, in either order.
// Clues (M8): every clue's `planted` and `revealed` scenes and `knowers` list are checked (E102 shape, I401 unknown knower key, E301 unknown scene or entry, W303 archived); `who` is an entry id or the word reader.
// (E212, a relationship whose a and b are the same entry, is a field check in schema.mjs.)

const STORY_PLAN_PATH = 'planning/story.md';
const MILESTONE_TEXT_KEYS = ['pressure', 'choice', 'belief_before', 'belief_after', 'cost'];
// Structures (M4): every structure's `beats` list is checked (E102 shape, I401 unknown key, E301 unknown scene, W303 archived scene); a beat id used twice among the live structures is E102 on the later one.
const BEAT_TEXT_KEYS = ['purpose', 'question', 'position'];
const BEAT_KEYS = ['id', 'name', ...BEAT_TEXT_KEYS, 'state', 'scenes'];
const BEAT_STATES = ['open', 'done', 'omitted'];
const BEAT_ID_RE = /^note_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_BEAT_SCENES = 50;
const DEVELOPMENT_VIEW_KEYS = ['a_view', 'b_view'];
const DEVELOPMENT_KEYS = ['scene', 'change', ...DEVELOPMENT_VIEW_KEYS];
const oneLine = (v) => typeof v === 'string' && !/[\x00-\x1f\x7f\x85\u2028\u2029]/.test(v);
const KNOWER_KEYS = ['who', 'scene', 'how', 'reliable'];
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

/** Development items of one relationship: E102 / I401 on the shape, E301 / W303 on the scene. */
function checkDevelopments(d, scenes, add) {
  if (!Array.isArray(d.fm.developments)) return; // a non-list is reported by the field table
  d.fm.developments.forEach((m, i) => {
    const at = (k) => `developments[${i}].${k}`;
    if (!isMap(m)) {
      add('E102', d.file, `developments[${i}]`, 'development must be a mapping with a scene, a change and optional a_view and b_view');
      return;
    }
    if (typeof m.scene !== 'string' || m.scene === '') add('E102', d.file, at('scene'), 'development scene must be a scene id');
    else {
      const hit = scenes.get(m.scene);
      if (!hit) add('E301', d.file, at('scene'), `cannot resolve ${m.scene}`);
      else if (hit.archived) add('W303', d.file, at('scene'), `${m.scene} points into archive/`);
    }
    if (!oneLine(m.change) || m.change === '') add('E102', d.file, at('change'), 'development change must be a single line of text');
    for (const k of DEVELOPMENT_VIEW_KEYS) {
      if (Object.hasOwn(m, k) && !oneLine(m[k])) add('E102', d.file, at(k), `${k} must be a single line of text`);
    }
    for (const k of Object.keys(m)) {
      if (!DEVELOPMENT_KEYS.includes(k)) add('I401', d.file, at(k), 'unknown field');
    }
  });
}

/** One scene-id field of a clue: E102 on the shape, E301 / W303 on the target. */
function checkSceneRef(d, scenes, add, loc, v) {
  if (typeof v !== 'string' || v === '') {
    add('E102', d.file, loc, 'must be a scene id');
    return;
  }
  const hit = scenes.get(v);
  if (!hit) add('E301', d.file, loc, `cannot resolve ${v}`);
  else if (hit.archived) add('W303', d.file, loc, `${v} points into archive/`);
}

/** Planted, revealed and knowers of one clue. `entries` maps entry ids to docs (the book's, then the series' shared). */
function checkClue(d, scenes, entries, add) {
  const { fm } = d;
  if (Array.isArray(fm.planted)) fm.planted.forEach((s, i) => checkSceneRef(d, scenes, add, `planted[${i}]`, s));
  if (Object.hasOwn(fm, 'revealed') && typeof fm.revealed === 'string') checkSceneRef(d, scenes, add, 'revealed', fm.revealed);
  if (!Array.isArray(fm.knowers)) return; // a non-list is reported by the field table
  fm.knowers.forEach((m, i) => {
    const at = (k) => `knowers[${i}].${k}`;
    if (!isMap(m)) {
      add('E102', d.file, `knowers[${i}]`, 'knower must be a mapping with who, scene and optional how and reliable');
      return;
    }
    if (typeof m.who !== 'string' || m.who === '') add('E102', d.file, at('who'), 'knower who must be an entry id or reader');
    else if (m.who !== 'reader') {
      const hit = entries.get(m.who);
      if (!hit) add('E301', d.file, at('who'), `cannot resolve ${m.who}`);
      else if (hit.archived) add('W303', d.file, at('who'), `${m.who} points into archive/`);
    }
    checkSceneRef(d, scenes, add, at('scene'), m.scene);
    if (Object.hasOwn(m, 'how') && !oneLine(m.how)) add('E102', d.file, at('how'), 'how must be a single line of text');
    if (Object.hasOwn(m, 'reliable') && typeof m.reliable !== 'boolean') add('E102', d.file, at('reliable'), 'reliable must be true or false');
    for (const k of Object.keys(m)) {
      if (!KNOWER_KEYS.includes(k)) add('I401', d.file, at(k), 'unknown field');
    }
  });
}

/** Beat items of one structure: E102 / I401 on the shape, E301 / W303 on the scenes; `seen` (a Set of beat ids) is given for live structures to find duplicate ids. */
function checkBeats(d, scenes, add, seen) {
  if (!Array.isArray(d.fm.beats)) return; // a non-list is reported by the field table
  d.fm.beats.forEach((b, i) => {
    const at = (k) => `beats[${i}].${k}`;
    if (!isMap(b)) {
      add('E102', d.file, `beats[${i}]`, 'beat must be a mapping with an id, a name and optional purpose, question, position, state and scenes');
      return;
    }
    if (typeof b.id !== 'string' || !BEAT_ID_RE.test(b.id)) add('E102', d.file, at('id'), 'beat id must be note_ followed by a 26-character ULID');
    else if (seen) {
      if (seen.has(b.id)) add('E102', d.file, at('id'), `beat id ${b.id} is already used by another beat`);
      seen.add(b.id);
    }
    if (!oneLine(b.name) || b.name === '') add('E102', d.file, at('name'), 'beat name must be a single line of text');
    for (const k of BEAT_TEXT_KEYS) {
      if (Object.hasOwn(b, k) && !oneLine(b[k])) add('E102', d.file, at(k), `${k} must be a single line of text`);
    }
    if (Object.hasOwn(b, 'state') && !BEAT_STATES.includes(b.state)) add('E102', d.file, at('state'), `state must be one of ${BEAT_STATES.join(', ')}`);
    if (Object.hasOwn(b, 'scenes')) {
      if (!Array.isArray(b.scenes)) add('E102', d.file, at('scenes'), 'scenes must be a list of scene ids');
      else {
        if (b.scenes.length > MAX_BEAT_SCENES) add('E102', d.file, at('scenes'), `a beat can hold at most ${MAX_BEAT_SCENES} scenes`);
        b.scenes.forEach((s, j) => {
          const loc = `${at('scenes')}[${j}]`;
          if (typeof s !== 'string' || s === '') {
            add('E102', d.file, loc, 'scene must be a scene id');
            return;
          }
          const hit = scenes.get(s);
          if (!hit) add('E301', d.file, loc, `cannot resolve ${s}`);
          else if (hit.archived) add('W303', d.file, loc, `${s} points into archive/`);
        });
      }
    }
    for (const k of Object.keys(b)) {
      if (!BEAT_KEYS.includes(k)) add('I401', d.file, at(k), 'unknown field');
    }
  });
}

/**
 * @param {import('./load.mjs').Doc[]} docs typed documents of one book
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 * @param {import('./load.mjs').Doc[]} [shared] the series' shared entries, which a clue knower may name
 */
export function checkPlanner(docs, add, shared = []) {
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const links = new Map();
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const plans = new Map();
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const arcs = new Map();
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const relationships = new Map();
  const push = (map, key, d) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  };
  // a live scene beats an archived one with the same id
  const scenes = new Map();
  for (const d of docs) if (d.kind === 'scene' && typeof d.fm.id === 'string' && (!scenes.has(d.fm.id) || scenes.get(d.fm.id).archived)) scenes.set(d.fm.id, d);
  for (const d of docs) if (d.kind === 'arc') checkMilestones(d, scenes, add);
  for (const d of docs) if (d.kind === 'relationship') checkDevelopments(d, scenes, add);
  const entries = new Map();
  for (const d of [...docs, ...shared]) if (d.kind === 'entry' && typeof d.fm.id === 'string' && (!entries.has(d.fm.id) || entries.get(d.fm.id).archived)) entries.set(d.fm.id, d);
  for (const d of docs) if (d.kind === 'clue') checkClue(d, scenes, entries, add);
  const seenBeats = new Set();
  const stemOf = (d) => d.file.replace(/[.]md$/, '');
  // live structures first, by name, so a duplicate beat id is reported on the later file
  const structures = docs.filter((d) => d.kind === 'structure').sort((a, b) => Number(a.archived) - Number(b.archived) || (stemOf(a) < stemOf(b) ? -1 : stemOf(a) > stemOf(b) ? 1 : 0));
  for (const d of structures) checkBeats(d, scenes, add, d.archived ? null : seenBeats);
  for (const d of docs) {
    if (d.archived) continue;
    const { fm } = d;
    if (d.kind === 'story-plan' && d.rel !== STORY_PLAN_PATH) add('W318', d.file, 'schema', `a story plan must be ${STORY_PLAN_PATH}`);
    if (d.kind === 'link' && typeof fm.from === 'string' && typeof fm.to === 'string' && typeof fm.relation === 'string') push(links, JSON.stringify([fm.from, fm.to, fm.relation, typeof fm.branch === 'string' ? fm.branch : '']), d);
    else if (d.kind === 'scene-plan' && typeof fm.scene === 'string') push(plans, fm.scene, d);
    else if (d.kind === 'arc' && typeof fm.character === 'string') push(arcs, fm.character, d);
    else if (d.kind === 'relationship' && typeof fm.a === 'string' && typeof fm.b === 'string' && fm.a !== fm.b) push(relationships, JSON.stringify([fm.a, fm.b].sort()), d);
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
  for (const list of relationships.values()) {
    if (list.length < 2) continue;
    list.sort(byFile);
    for (const d of list.slice(1)) add('W320', d.file, 'b', `${list[0].file} is already the relationship of this pair`);
  }
}
