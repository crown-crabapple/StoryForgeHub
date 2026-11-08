// Per-kind field tables (spec sections 4-7 and 11.1) and the E102 / I401 / E103 checks.
import path from 'node:path';
import { isValidId, isValidSlug } from './ids.mjs';
import { checkPreferences } from './preferences.mjs';

/**
 * Field type codes: str, int (>= 0), int1 (>= 1), num, bool, list, map, any, slug,
 * or an array of allowed enum values.
 * @type {Record<string, {prefix:string, required:string[], fields:Record<string, any>}>}
 */
export const KINDS = {
  library: {
    prefix: 'lib',
    required: ['title'],
    fields: { title: 'str', pen_names: 'list', preferences: 'map' },
  },
  series: {
    prefix: 'series',
    required: ['slug', 'title', 'status'],
    fields: { slug: 'slug', title: 'str', status: ['planned', 'active', 'complete', 'archived'], previous_slugs: 'list' },
  },
  book: {
    prefix: 'book',
    required: ['slug', 'title', 'profile', 'status'],
    fields: {
      slug: 'slug', title: 'str', subtitle: 'str', series_number: 'int', pen_name: 'str',
      profile: ['fiction', 'nonfiction', 'memoir', 'selfhelp'],
      status: ['planning', 'drafting', 'revising', 'complete', 'archived'],
      genre: 'list', word_target: 'int', daily_word_goal: 'int1', cover: 'str', cover_color: 'hex', language: 'str', previous_slugs: 'list', preferences: 'map',
    },
  },
  act: {
    prefix: 'act',
    required: ['act'],
    fields: { act: 'int', title: 'str' },
  },
  chapter: {
    prefix: 'chap',
    required: ['chapter'],
    fields: { chapter: 'int', label: 'str', title: 'str', status: 'str', summary: 'str' },
  },
  scene: {
    prefix: 'scene',
    required: ['title', 'act', 'chapter', 'sequence', 'status'],
    fields: {
      title: 'str', act: 'int', chapter: 'int', sequence: 'int1',
      status: ['outline', 'drafting', 'revised', 'final'],
      pov: 'str', characters: 'list', locations: 'list', plot_threads: 'list', summary: 'str',
      variant_of: 'str', events: 'list', cast: 'list',
    },
  },
  entry: {
    prefix: 'entry',
    required: ['slug', 'type', 'name', 'status'],
    fields: {
      slug: 'slug', type: 'str', name: 'str', aliases: 'list', status: ['seed', 'sketch', 'canon'],
      role: 'str', first_appearance: 'str', image: 'str', fields: 'map', related: 'list', previous_slugs: 'list',
    },
  },
  thread: {
    prefix: 'thread',
    required: ['slug', 'title', 'kind', 'status'],
    fields: {
      slug: 'slug', title: 'str', kind: ['promise', 'question', 'mystery', 'subplot', 'arc'],
      status: ['planned', 'planted', 'developed', 'paid', 'dropped', 'unresolved', 'open', 'abandoned'],
      setup: 'list', develop: 'list', payoff: 'list', characters: 'list', previous_slugs: 'list',
    },
  },
  event: {
    prefix: 'event',
    required: ['slug', 'title', 'order'],
    fields: {
      slug: 'slug', title: 'str', order: 'num', when: 'any', date: 'any', scenes: 'list',
      characters: 'list', locations: 'list', previous_slugs: 'list', state: 'list',
    },
  },
  'codex-type': {
    prefix: 'note',
    required: ['type'],
    fields: { type: 'str', name: 'str', plural: 'str', fields: 'list', values: 'map' },
  },
  'continuity-exception': {
    prefix: 'note',
    required: ['slug', 'fingerprint', 'rule', 'title'],
    fields: { slug: 'slug', fingerprint: 'str', rule: 'str', title: 'str', created: 'any', intentional: 'bool' },
  },
  // Added 2026-11-07, M12 W4 (additive within v1): the author's continuity settings, one file: planning/continuity/settings.md. `overdue_chapters` is how many chapters a promise or question may stay open (TH2); `severity` maps a rule id to error, warning, info or off.
  'continuity-settings': {
    prefix: 'note',
    required: [],
    fields: { overdue_chapters: 'int1', severity: 'map' },
  },
  // Added 2026-11-02, M05-J04 (additive within v1): one saved AI chat or rewrite, under ai/<YYYY>/.
  'ai-record': {
    prefix: 'note',
    required: ['task', 'provider', 'model'],
    fields: { task: 'str', provider: 'str', model: 'str', locality: ['local', 'cloud'], contextSha256: 'str', files: 'list', applied: 'bool', created: 'any', fullContext: 'bool' },
  },
  // Added 2026-11-03, M08-J03 (additive within v1): the sidecar of an AI-generated draft asset, next to it under assets/drafts/. A record of how the asset was made; never story text or canon.
  'asset-note': {
    prefix: 'note',
    required: ['asset', 'created', 'sha256'],
    fields: { asset: 'str', prompt: 'str', provider: 'str', model: 'str', locality: ['local', 'cloud'], created: 'any', sha256: 'str' },
  },
  // Added 2026-11-02, M05-J06 (additive within v1): a proposed change to a canonical file, under suggestions/<YYYY>/. Never story text or canon.
  suggestion: {
    prefix: 'note',
    required: ['target', 'base_sha256', 'source', 'mode', 'hunks'],
    fields: {
      target: 'str', target_path: 'str', base_sha256: 'str', source: ['ai', 'claude-book', 'author', 'reviewer', 'plugin'], mode: ['suggest', 'state', 'canon'],
      created: 'any', status: ['pending', 'accepted', 'declined', 'partial'], ai: 'map', hunks: 'list', by: 'map', plugin: 'slug', // plugin: M08-J02, additive within v1
    },
  },
  // Added 2026-11-02, M05-J07 (additive within v1): a provenance receipt, under provenance/<YYYY>/<MM>/. A record of what happened; never story text or canon.
  // (provenance/objects/** holds raw bytes with no extension and is not read as documents.)
  receipt: {
    prefix: 'rcpt',
    required: ['at', 'actor', 'operation', 'workflow', 'target', 'before_sha256', 'after_sha256', 'parents'],
    fields: {
      at: 'str', actor: ['author', 'ai', 'external', 'system'],
      operation: ['baseline', 'author.edit', 'external.change', 'ai.proposal', 'ai.generation', 'suggestion.accept', 'suggestion.decline', 'undo', 'revision.restore', 'publish', 'check.report', 'ai.chat'],
      workflow: ['editor', 'ai-rewrite', 'ai-chat', 'suggestion', 'claude-book', 'watcher', 'revision', 'undo', 'export', 'check', 'ai-cover'],
      target: 'map', before_sha256: 'str', after_sha256: 'str', ranges: 'list', parents: 'list', ai: 'map', by: 'map', suggestion: 'map', // suggestion: M07-J05, additive within v1
    },
  },
  // Added 2026-11-02, M07-J03 (additive within v1): a comment anchored to lines of a scene, under comments/<YYYY>/. Never story text or canon, never exported to readers.
  comment: {
    prefix: 'note',
    required: ['target', 'anchor', 'status'],
    fields: { target: 'str', anchor: 'map', status: ['open', 'resolved'], by: 'map', created: 'any' },
  },
  // Added 2026-11-02, M07-J02 (additive within v1): the author's goals, at activity/goals.md.
  goals: {
    prefix: 'note',
    required: [],
    fields: { goals: 'list', title: 'str' },
  },
  // Added 2026-11-02, M07-J02 (additive within v1): a revision task made from a finding or by hand, under planning/tasks/. Never story text or canon.
  task: {
    prefix: 'note',
    required: ['slug', 'title', 'status'],
    fields: { slug: 'slug', title: 'str', status: ['open', 'doing', 'done', 'dropped'], source: 'map', targets: 'list', created: 'any', for: ['ai', 'author'] },
  },
  // Added 2026-11-05, Story Planner M1 (ADR 0003, additive within v1): one causal link between two scenes, under planning/links/. Never story text or canon.
  link: {
    prefix: 'note',
    required: ['slug', 'from', 'to', 'relation'],
    fields: {
      slug: 'slug', from: 'str', to: 'str',
      relation: ['therefore', 'but', 'enables', 'reveals', 'motivates', 'prevents', 'foreshadows', 'pays_off', 'parallel', 'other'],
      branch: 'str', created: 'any',
    },
  },
  // Added 2026-11-05, Story Planner M1 (ADR 0003, additive within v1): the planning sidecar of one scene, under planning/scene-plans/. Never story text or canon.
  'scene-plan': {
    prefix: 'note',
    required: ['scene'],
    fields: {
      scene: 'str', goal: 'str', opposition: 'str', conflict: 'str', turn: 'str', outcome: 'str', consequence: 'str', stakes: 'str',
      emotional_start: 'str', emotional_end: 'str', purpose: 'str', characters: 'list',
    },
  },
  // Added 2026-11-05, Story Planner M2 (ADR 0003, additive within v1): the book-level story plan, one file at planning/story.md. Never story text or canon.
  'story-plan': {
    prefix: 'note',
    required: [],
    fields: { premise: 'str', logline: 'str', theme_question: 'str', central_conflict: 'str', protagonist_goal: 'str', stakes: 'str', protagonist: 'str', primary_structure: 'str' },
  },
  // Added 2026-11-06, Story Planner M3 (ADR 0003, additive within v1): the arc of one character in one book, under planning/arcs/. `character` is an entry id. Never story text or canon.
  arc: {
    prefix: 'note',
    required: ['slug', 'character'],
    fields: {
      slug: 'slug', character: 'str', arc_type: ['positive', 'negative', 'flat', 'custom'],
      want: 'str', need: 'str', false_belief: 'str', fear: 'str', wound: 'str', start_state: 'str', end_state: 'str', milestones: 'list',
    },
  },
  // Added 2026-11-06, Story Planner M4 (ADR 0003, additive within v1): a story structure with its beat sheet, under planning/structures/. Never story text or canon.
  structure: {
    prefix: 'note',
    required: ['slug', 'name'],
    fields: { slug: 'slug', name: 'str', template: 'str', template_version: 'int', beats: 'list' },
  },
  // Added 2026-11-06, Story Planner M5 (ADR 0003, additive within v1): how two Codex entries relate, with scene-by-scene developments, under planning/relationships/. `a` and `b` are entry ids. Never story text or canon.
  relationship: {
    prefix: 'note',
    required: ['slug', 'a', 'b'],
    fields: { slug: 'slug', a: 'str', b: 'str', baseline: 'str', end_state: 'str', developments: 'list' },
  },
  // Added 2026-11-06, Story Planner M7 (ADR 0003, additive within v1): one synopsis of the whole book, under planning/synopses/. The body is the author's own text. `basis` is the sha256 of the extracted text last reviewed. Never canon.
  synopsis: {
    prefix: 'note',
    required: ['slug', 'type'],
    fields: {
      slug: 'slug', type: ['premise', 'logline', 'elevator-pitch', 'short', 'one-page', 'long', 'chapter-treatment', 'custom'],
      name: 'str', target_words: 'int1', basis: 'str', created: 'any',
    },
  },
  // Added 2026-11-06, Story Planner M8 (ADR 0003, additive within v1): one fact the reader or a character learns, under planning/clues/. `planted` and `revealed` are scene ids; `knowers` is a list of { who, scene, how?, reliable? }. Never canon.
  clue: {
    prefix: 'note',
    required: ['slug', 'fact'],
    fields: {
      slug: 'slug', fact: 'str', kind: ['clue', 'reveal', 'secret'], planted: 'list', revealed: 'str', red_herring: 'bool', knowers: 'list', created: 'any',
    },
  },
  doc: {
    prefix: 'note',
    required: ['title'],
    // M12 W2 (additive within v1): a workspace doc (planning/workspace/, planning/state/chapter-NN/, planning/development/) says which kind it is; `chapter` is the state doc's chapter.
    fields: { title: 'str', locked: 'bool', workspace: ['book', 'style', 'state', 'other'], chapter: 'int' },
  },
  research: {
    prefix: 'note',
    required: ['title'],
    fields: { title: 'str', tags: 'list', canon: 'bool', sources: 'list', links: 'list' },
  },
  source: {
    prefix: 'note',
    required: ['cite_key', 'title'],
    fields: {
      cite_key: 'str', title: 'str', type: 'any', author: 'any', year: 'any', publisher: 'any',
      url: 'any', accessed: 'any', locator: 'any',
    },
  },
};

// Added 2026-11-02, M07-J01 (additive within v1): `labels` on book/series (definitions) and on documents (names).
for (const k of ['series', 'book', 'act', 'chapter', 'scene', 'entry', 'thread', 'event', 'doc', 'task']) KINDS[k].fields.labels = 'list';

/** Kinds of a typed field in a codex type file (spec 5.1). */
export const FIELD_KINDS = ['text', 'number', 'date', 'link', 'choice', 'list'];
const LABEL_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** List-valued reference fields whose items must be strings. */
const STRING_LIST_FIELDS = new Set([
  'characters', 'locations', 'plot_threads', 'events', 'setup', 'develop', 'payoff', 'scenes', 'sources', 'links', 'fields',
]);

/**
 * Event `state` vocabulary (spec 6.2): what each `event` word needs as `value`.
 * 'none' = value must be absent; 'link' = a slug (holder may also be ""); 'fact' = a slug-shaped fact key.
 */
export const STATE_EVENTS = {
  died: 'none', revived: 'none', destroyed: 'none', lost: 'none', found: 'none',
  holder: 'link', location: 'link', learns: 'fact', knows: 'fact',
};

/** M12 W4: the words a continuity settings file may give a rule's severity. */
export const SETTINGS_SEVERITIES = ['error', 'warning', 'info', 'off'];

/** M12 chapter cast: the roles a scene's `cast` items may give an entry. At most one `pov` per scene. */
export const CAST_ROLES = ['pov', 'appears', 'mentioned'];

/** Exception fingerprint shape (spec 6.4). */
export const FINGERPRINT_RE = /^[a-z0-9]{2,4}-[0-9a-f]{16}$/;

/** @param {any} v */
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
/** @param {any} v */
const isPlainMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {any} v */
const isAbsent = (v) => v === undefined || v === null;

/**
 * @param {any} value
 * @param {any} type
 * @returns {string|null} problem description, or null if the value is fine
 */
function typeProblem(value, type) {
  if (Array.isArray(type)) {
    return typeof value === 'string' && type.includes(value) ? null : `must be one of ${type.join(', ')}`;
  }
  switch (type) {
    case 'str': return typeof value === 'string' ? null : 'must be a string';
    case 'slug': return isValidSlug(value) ? null : 'must be a slug (a-z, 0-9, single hyphens, 1-60 chars)';
    case 'int': return isInt(value) && value >= 0 ? null : 'must be an integer >= 0';
    case 'int1': return isInt(value) && value >= 1 ? null : 'must be an integer >= 1';
    case 'num': return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'bool': return typeof value === 'boolean' ? null : 'must be true or false';
    case 'list': return Array.isArray(value) ? null : 'must be a list';
    case 'map': return isPlainMap(value) ? null : 'must be a mapping';
    case 'hex': return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value) ? null : 'must be a colour like "#3A5F7D"';
    default: return null;
  }
}

/** Event `date` (spec 6.2): "" or ISO YYYY, YYYY-MM, YYYY-MM-DD with a real month and day. A bare 4-digit integer is a year. @param {any} v */
export function isIsoDate(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1000 && v <= 9999;
  if (typeof v !== 'string') return false;
  if (v === '') return true;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(v);
  if (!m) return false;
  const month = m[2] === undefined ? 1 : Number(m[2]);
  if (month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const year = Number(m[1]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return Number(m[3]) >= 1 && Number(m[3]) <= days;
}

/**
 * True when a front-matter path leaves the book root or is absolute.
 * @param {string} p
 */
export function escapesRoot(p) {
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return true;
  const n = path.posix.normalize(s);
  return n === '..' || n.startsWith('../');
}

/**
 * Event `state` items (spec 6.2): E102 for shape problems. Whether slugs resolve (E301, E302) is checked with the links.
 * @param {any[]} state
 * @param {string} file
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
function checkState(state, file, add) {
  state.forEach((item, i) => {
    if (!isPlainMap(item)) {
      add('E102', file, `state[${i}]`, 'state item must be a mapping with slug, event and value');
      return;
    }
    if (typeof item.slug !== 'string') add('E102', file, `state[${i}].slug`, 'state item needs a string slug');
    if (typeof item.event !== 'string' || !Object.hasOwn(STATE_EVENTS, item.event)) {
      add('E102', file, `state[${i}].event`, `event must be one of ${Object.keys(STATE_EVENTS).join(', ')}`);
      return;
    }
    const need = STATE_EVENTS[item.event];
    const has = !isAbsent(item.value);
    if (item.fact !== undefined) {
      if (need !== 'fact') add('E102', file, `state[${i}].fact`, `${item.event} takes no fact wording`);
      else if (typeof item.fact !== 'string' || item.fact.trim() === '' || /[\x00-\x1f\x7f]/.test(item.fact)) add('E102', file, `state[${i}].fact`, 'fact must be one line of text');
    }
    if (need === 'none') {
      if (has) add('E102', file, `state[${i}].value`, `${item.event} takes no value`);
    } else if (!has) {
      add('E102', file, `state[${i}].value`, `${item.event} needs a value`);
    } else if (typeof item.value !== 'string') {
      add('E102', file, `state[${i}].value`, 'value must be a string');
    } else if (need === 'fact' && !isValidSlug(item.value)) {
      add('E102', file, `state[${i}].value`, 'fact key must be slug-shaped (a-z, 0-9, single hyphens)');
    } else if (item.event === 'location' && item.value === '') {
      add('E102', file, `state[${i}].value`, 'location needs a location slug');
    }
  });
}

/**
 * Scene `cast` items (M12): E102 for shape problems and for a second pov. Whether `entry` resolves (E301, E302) is checked with the links.
 * @param {any[]} cast
 * @param {string} file
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
function checkCast(cast, file, add) {
  let pov = 0;
  cast.forEach((item, i) => {
    if (!isPlainMap(item)) {
      add('E102', file, `cast[${i}]`, 'cast item must be a mapping with entry and role');
      return;
    }
    if (typeof item.entry !== 'string' || item.entry.trim() === '') add('E102', file, `cast[${i}].entry`, 'cast item needs an entry id or slug');
    if (typeof item.role !== 'string' || !CAST_ROLES.includes(item.role)) add('E102', file, `cast[${i}].role`, `role must be one of ${CAST_ROLES.join(', ')}`);
    else if (item.role === 'pov' && ++pov === 2) add('E102', file, `cast[${i}].role`, 'a scene has at most one pov in its cast');
  });
}

/**
 * Labels (spec 3.4): book.md / series.md define them as a list of { name, color }; documents name them as a list of strings.
 * @param {{kind:string, file:string, fm:any}} doc
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
function checkLabels(doc, add) {
  const { fm, file } = doc;
  if (doc.kind === 'book' || doc.kind === 'series') {
    const seen = new Set();
    fm.labels.forEach((l, i) => {
      if (!isPlainMap(l)) {
        add('E102', file, `labels[${i}]`, 'label must be a mapping with name and color');
        return;
      }
      if (typeof l.name !== 'string' || l.name.trim() === '') add('E102', file, `labels[${i}].name`, 'label name must be a non-empty string');
      else {
        const key = l.name.trim().toLowerCase();
        if (seen.has(key)) add('E102', file, `labels[${i}].name`, `label name ${l.name} is used twice (names compare case-insensitively)`);
        seen.add(key);
      }
      if (typeof l.color !== 'string' || !LABEL_COLOR_RE.test(l.color)) add('E102', file, `labels[${i}].color`, 'label color must be a quoted colour like "#3A5F7D"');
    });
  } else {
    fm.labels.forEach((l, i) => {
      if (typeof l !== 'string') add('E102', file, `labels[${i}]`, 'list item must be a string');
    });
  }
}

/**
 * Type file `fields` items (spec 5.1): a string label, or { label, kind, choices? }. E102 at `fields[i]`.
 * @param {any[]} items @param {string} file
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
function checkTypeFields(items, file, add) {
  const isStrings = (v) => Array.isArray(v) && v.every((c) => typeof c === 'string');
  items.forEach((item, i) => {
    const loc = `fields[${i}]`;
    if (typeof item === 'string') return;
    if (!isPlainMap(item) || typeof item.label !== 'string' || item.label.trim() === '') {
      add('E102', file, loc, 'field must be a string label or a mapping with label, kind and optional choices');
    } else if (typeof item.kind !== 'string' || !FIELD_KINDS.includes(item.kind)) {
      add('E102', file, loc, `field kind must be one of ${FIELD_KINDS.join(', ')}`);
    } else if (item.kind === 'choice' && !(isStrings(item.choices) && item.choices.length > 0)) {
      add('E102', file, loc, 'a choice field needs choices: a non-empty list of strings');
    } else if (item.choices !== undefined && item.choices !== null && !isStrings(item.choices)) {
      add('E102', file, loc, 'choices must be a list of strings');
    }
  });
}

export const GOAL_KINDS = ['words', 'scenes', 'chapters', 'minutes'];
export const GOAL_PERIODS = ['day', 'week', 'month', 'total'];
export const TASK_SOURCE_KINDS = ['continuity', 'check', 'manual'];

/**
 * Goals (M07-J02 section 1): every item is a mapping with id, kind, target (>= 1) and period; `due` only with period total (ISO date); `scope` a string.
 * E102 at `goals[i].<key>`. Whether `scope` resolves (E301) is checked with the book's documents.
 * @param {any[]} items @param {string} file
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
function checkGoals(items, file, add) {
  const seen = new Set();
  items.forEach((g, i) => {
    const at = (k) => `goals[${i}].${k}`;
    if (!isPlainMap(g)) {
      add('E102', file, `goals[${i}]`, 'goal must be a mapping with id, kind, target and period');
      return;
    }
    if (typeof g.id !== 'string' || g.id === '') add('E102', file, at('id'), 'goal id must be a non-empty string');
    else {
      if (seen.has(g.id)) add('E102', file, at('id'), `goal id ${g.id} is used twice`);
      seen.add(g.id);
    }
    if (typeof g.kind !== 'string' || !GOAL_KINDS.includes(g.kind)) add('E102', file, at('kind'), `kind must be one of ${GOAL_KINDS.join(', ')}`);
    if (!isInt(g.target) || g.target < 1) add('E102', file, at('target'), 'target must be an integer >= 1');
    if (typeof g.period !== 'string' || !GOAL_PERIODS.includes(g.period)) add('E102', file, at('period'), `period must be one of ${GOAL_PERIODS.join(', ')}`);
    if (!isAbsent(g.due)) {
      if (g.period !== 'total') add('E102', file, at('due'), 'due is only for a goal with period total');
      else if (!isDueDate(g.due)) add('E102', file, at('due'), 'due must be an ISO date: YYYY-MM-DD');
    }
    if (!isAbsent(g.scope) && (typeof g.scope !== 'string' || g.scope === '')) add('E102', file, at('scope'), 'scope must be a chapter or act ID');
  });
}

/** A goal `due` value: a YYYY-MM-DD string (YAML may have read an unquoted date as a string already; this parser keeps it a string). @param {any} v */
const isDueDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && isIsoDate(v);

/**
 * Task shape (M07-J02 section 4): `source` { kind, code?, fingerprint? }, `targets` a list of { id, line?, quote?, sha256? }.
 * E102 at `source.<key>` / `targets[i].<key>`.
 * @param {{fm:any, file:string}} doc
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
function checkTask(doc, add) {
  const { fm, file } = doc;
  if (isPlainMap(fm.source)) {
    const s = fm.source;
    if (typeof s.kind !== 'string' || !TASK_SOURCE_KINDS.includes(s.kind)) add('E102', file, 'source.kind', `source kind must be one of ${TASK_SOURCE_KINDS.join(', ')}`);
    if (!isAbsent(s.code) && typeof s.code !== 'string') add('E102', file, 'source.code', 'source code must be a string');
    if (!isAbsent(s.fingerprint) && (typeof s.fingerprint !== 'string' || !FINGERPRINT_RE.test(s.fingerprint))) {
      add('E102', file, 'source.fingerprint', 'fingerprint must look like cf1-0123456789abcdef');
    }
  }
  if (Array.isArray(fm.targets)) {
    fm.targets.forEach((t, i) => {
      const at = (k) => `targets[${i}].${k}`;
      if (!isPlainMap(t)) {
        add('E102', file, `targets[${i}]`, 'target must be a mapping with id, and optionally line, quote and sha256');
        return;
      }
      if (typeof t.id !== 'string' || t.id === '') add('E102', file, at('id'), 'target id must be a string');
      if (!isAbsent(t.line) && (!isInt(t.line) || t.line < 1)) add('E102', file, at('line'), 'line must be an integer >= 1');
      if (!isAbsent(t.quote) && typeof t.quote !== 'string') add('E102', file, at('quote'), 'quote must be a string');
      if (!isAbsent(t.sha256) && (typeof t.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(t.sha256))) add('E102', file, at('sha256'), 'sha256 must be 64 hex characters');
    });
  }
}

const HUNK_STATUSES = ['pending', 'accepted', 'declined'];
const DIFF_HEADER_RE = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@ (\S+)$/;

/**
 * Suggestion shape (spec 9.3): every hunk is a mapping with id, line, lines and status, and the diff block has a matching `@@ ... @@ <id>`
 * header (with matching line counts) for each. E102 at `hunks[i]` or `body`.
 * @param {{fm:any, body:string, file:string}} doc
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
function checkSuggestion(doc, add) {
  const { fm, file } = doc;
  if (!Array.isArray(fm.hunks)) return;
  const lines = String(doc.body ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  let open = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === '```diff') {
      open = i;
      break;
    }
  }
  /** @type {Map<string, {lines:number, count:number, minus:number, plus:number}>} */
  const diff = new Map();
  let bad = open < 0 ? 'the diff block is missing' : null;
  if (open >= 0) {
    let close = lines.indexOf('```', open + 1);
    if (close < 0) close = lines.length;
    let cur = null;
    for (const l of lines.slice(open + 1, close)) {
      const m = DIFF_HEADER_RE.exec(l);
      if (m) {
        cur = { lines: Number(m[2]), count: Number(m[4]), minus: 0, plus: 0 };
        diff.set(m[5], cur);
      } else if (cur && l.startsWith('-')) cur.minus++;
      else if (cur && l.startsWith('+')) cur.plus++;
      else if (l !== '') bad ??= `unexpected line in the diff block: ${l.slice(0, 40)}`;
    }
  }
  if (bad) add('E102', file, 'body', bad);
  const seen = new Set();
  fm.hunks.forEach((h, i) => {
    const loc = `hunks[${i}]`;
    if (!isPlainMap(h) || typeof h.id !== 'string' || !isInt(h.line) || h.line < 1 || !isInt(h.lines) || h.lines < 0 || !HUNK_STATUSES.includes(h.status)) {
      add('E102', file, loc, 'hunk must be a mapping with id, line (>= 1), lines (>= 0) and status (pending, accepted or declined)');
      return;
    }
    if (seen.has(h.id)) add('E102', file, loc, `hunk id ${h.id} is used twice`);
    seen.add(h.id);
    const d = diff.get(h.id);
    if (open >= 0 && !d) add('E102', file, loc, `the diff block has no @@ header ending in ${h.id}`);
    else if (d && (d.lines !== h.lines || d.minus !== h.lines || d.count !== d.plus)) add('E102', file, loc, `hunk ${h.id} disagrees with its diff (line counts)`);
  });
  if (open >= 0) for (const id of diff.keys()) if (!seen.has(id)) add('E102', file, 'body', `the diff block names hunk ${id}, which the front matter does not list`);
}

/** `by` (M07-J03): a mapping with a string `name`; `id` is optional but, when present, a string. E102 at `by`. */
function checkBy(by, file, add) {
  if (typeof by.name !== 'string' || by.name.trim() === '' || (by.id !== undefined && typeof by.id !== 'string')) add('E102', file, 'by', 'by must be a mapping with a name (text) and, optionally, an id (text)');
}

/** Comment shape (spec 9.5): `anchor` is { line >= 1, lines >= 1, quote?: text, sha256?: hex }. E102 at `anchor`. */
function checkComment(doc, add) {
  const { fm, file } = doc;
  const a = fm.anchor;
  if (!isPlainMap(a)) return; // a missing or non-mapping anchor is reported by the field table
  if (!isInt(a.line) || a.line < 1 || !isInt(a.lines) || a.lines < 1) add('E102', file, 'anchor', 'anchor needs line (>= 1) and lines (>= 1)');
  else if ((a.quote !== undefined && (typeof a.quote !== 'string' || a.quote.length > 500)) || (a.sha256 !== undefined && (typeof a.sha256 !== 'string' || !/^(?:[0-9a-f]{64})?$/.test(a.sha256)))) {
    add('E102', file, 'anchor', 'anchor quote must be text (at most 500 characters) and sha256 a 64-character hex string');
  }
}

/**
 * Field-level checks for one parsed document: E102, I401, E103.
 * @param {{kind:string, rel:string, file:string, fm:any}} doc
 * @param {{inSeries?:boolean}} ctx
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkFields(doc, ctx, add) {
  const spec = KINDS[doc.kind];
  const { fm, file } = doc;

  if (isAbsent(fm.id)) add('E102', file, 'id', 'required field missing');
  else if (!isValidId(fm.id, spec.prefix)) {
    add('E102', file, 'id', `id must be ${spec.prefix}_ followed by a 26-character ULID`);
  }

  const required = [...spec.required];
  if (doc.kind === 'book' && doc.rel === 'book.md' && ctx.inSeries) required.push('series_number');

  for (const key of required) {
    if (isAbsent(fm[key])) add('E102', file, key, 'required field missing');
  }
  for (const [key, type] of Object.entries(spec.fields)) {
    if (isAbsent(fm[key])) continue;
    const problem = typeProblem(fm[key], type);
    if (problem) {
      add('E102', file, key, `${key} ${problem}`);
      continue;
    }
    if (type === 'list' && STRING_LIST_FIELDS.has(key) && key !== 'labels' && !(key === 'fields' && doc.kind === 'codex-type')) {
      fm[key].forEach((item, i) => {
        if (typeof item !== 'string') add('E102', file, `${key}[${i}]`, 'list item must be a string');
      });
    }
  }

  if (doc.kind === 'library' && Array.isArray(fm.pen_names)) {
    fm.pen_names.forEach((p, i) => {
      if (!isPlainMap(p)) add('E102', file, `pen_names[${i}]`, 'pen name must be a mapping with name and slug');
      else if (!isValidSlug(p.slug)) add('E102', file, `pen_names[${i}].slug`, 'pen name slug must be a valid slug');
    });
  }
  if (doc.kind === 'entry' && Array.isArray(fm.related)) {
    fm.related.forEach((r, i) => {
      if (!isPlainMap(r) || typeof r.to !== 'string') add('E102', file, `related[${i}].to`, 'related item needs a string `to`');
    });
  }

  if ((doc.kind === 'library' || doc.kind === 'book') && fm.preferences !== undefined) checkPreferences(doc, add); // M07-J04
  if (Array.isArray(fm.labels)) checkLabels(doc, add);
  if (doc.kind === 'codex-type' && Array.isArray(fm.fields)) checkTypeFields(fm.fields, file, add);

  if (doc.kind === 'codex-type' && typeof fm.type === 'string' && !/^[a-z]+$/.test(fm.type)) {
    add('E102', file, 'type', 'type must be a lower-case word (a-z)');
  }

  if (doc.kind === 'event' && !isAbsent(fm.date) && !isIsoDate(fm.date)) {
    add('E102', file, 'date', 'date must be "" or an ISO date: YYYY, YYYY-MM or YYYY-MM-DD');
  }

  if (doc.kind === 'event' && Array.isArray(fm.state)) checkState(fm.state, file, add);
  if (doc.kind === 'scene' && Array.isArray(fm.cast)) checkCast(fm.cast, file, add);

  if (doc.kind === 'codex-type' && isPlainMap(fm.values)) {
    for (const [label, words] of Object.entries(fm.values)) {
      if (!Array.isArray(words) || words.some((w) => typeof w !== 'string')) {
        add('E102', file, 'values', `values.${label} must be a list of words`);
      }
    }
  }

  if (doc.kind === 'continuity-settings' && isPlainMap(fm.severity)) {
    for (const [rule, word] of Object.entries(fm.severity)) {
      if (!/^[A-Z]{2}[0-9]+$/.test(rule)) add('E102', file, `severity.${rule}`, 'severity key must be a rule id such as CS1');
      else if (typeof word !== 'string' || !SETTINGS_SEVERITIES.includes(word)) add('E102', file, `severity.${rule}`, `severity must be one of ${SETTINGS_SEVERITIES.join(', ')}`);
    }
  }

  if (doc.kind === 'continuity-exception') {
    if (typeof fm.fingerprint === 'string' && !FINGERPRINT_RE.test(fm.fingerprint)) {
      add('E102', file, 'fingerprint', 'fingerprint must look like cf1-0123456789abcdef');
    }
    if (typeof doc.body === 'string' && doc.body.trim() === '') add('E102', file, 'body', 'the exception needs a written rationale');
  }

  if (doc.kind === 'link' && typeof fm.from === 'string' && fm.from === fm.to) add('E211', file, 'to', 'a link cannot point from a scene or beat to itself');
  if (doc.kind === 'relationship' && typeof fm.a === 'string' && fm.a === fm.b) add('E212', file, 'b', 'a relationship needs two different entries');

  if (doc.kind === 'link' && typeof fm.branch === 'string' && (fm.branch.length > 40 || !isValidSlug(fm.branch))) add('E102', file, 'branch', 'branch must be a slug (a-z, 0-9, single hyphens, at most 40 chars)');
  if (doc.kind === 'clue' && typeof fm.fact === 'string' && /[\x00-\x1f\x7f\x85\u2028\u2029]/.test(fm.fact)) add('E102', file, 'fact', 'fact must be a single line');

  if (doc.kind === 'synopsis') {
    if (typeof fm.name === 'string' && /[\r\n]/.test(fm.name)) add('E102', file, 'name', 'name must be a single line');
    if (typeof fm.basis === 'string' && !/^[0-9a-f]{64}$/.test(fm.basis)) add('E102', file, 'basis', 'basis must be 64 lower-case hex characters');
  }

  if (doc.kind === 'suggestion') checkSuggestion(doc, add);
  if (doc.kind === 'comment') checkComment(doc, add);
  if (Object.hasOwn(fm, 'by') && isPlainMap(fm.by) && (doc.kind === 'suggestion' || doc.kind === 'receipt' || doc.kind === 'comment')) checkBy(fm.by, file, add);
  if (doc.kind === 'goals' && Array.isArray(fm.goals)) checkGoals(fm.goals, file, add);
  if (doc.kind === 'task') checkTask(doc, add);

  for (const key of ['cover', 'image']) {
    if (Object.hasOwn(spec.fields, key) && typeof fm[key] === 'string' && escapesRoot(fm[key])) {
      add('E103', file, key, `path escapes the book root: ${fm[key]}`);
    }
  }

  for (const key of Object.keys(fm)) {
    if (key === 'schema' || key === 'id' || key.startsWith('x-') || Object.hasOwn(spec.fields, key)) continue;
    add('I401', file, key, 'unknown field');
  }
}
