// Preferences (M07-J04): the `preferences:` map of library.md and book.md, the profile layer, and the one resolver that says which layer wins.
// Pure: no filesystem. Customization never changes what a book means; these values only say how the app looks and which features are on.

/** Feature modules (contract section 5). `insights` and `tasks` belong to J02; they are gated by id here. */
export const MODULE_IDS = ['ai', 'continuity', 'receipts', 'suggestions', 'timeline', 'board', 'threads', 'insights', 'tasks', 'research', 'planner', 'integrations', 'workspace'];

/**
 * M12 AI level, lowest to highest: how much an AI connection (MCP or plugin token) may do in a book, whatever its token was granted.
 * off: read only. advisor: + suggest edits, tasks, checks. planner: + plan, canvas, workspace docs, ledgers, state. cowriter: + create chapters and scenes.
 */
export const AI_LEVELS = ['off', 'advisor', 'planner', 'cowriter'];
/** The level a book has when nothing sets one: what AI connections could already do before M12 (suggest, canvas, plan). */
export const DEFAULT_AI_LEVEL = 'planner';
/** Does `level` reach `min`? Unknown levels count as the default. @param {string} level @param {string} min */
export const aiLevelReaches = (level, min) => AI_LEVELS.indexOf(AI_LEVELS.includes(level) ? level : DEFAULT_AI_LEVEL) >= AI_LEVELS.indexOf(min);

/** Keys where the project outranks the person: built-in < profile < library < book. */
export const PROJECT_KEYS = ['modules', 'labels', 'export', 'ai', 'checks'];
/** Keys where the person at the keyboard wins: built-in < library < book < profile. */
export const APPEARANCE_KEYS = ['theme', 'typography', 'layout', 'shortcuts'];
/** Every key a `preferences` map may hold. */
export const PREFERENCE_KEYS = [...PROJECT_KEYS, ...APPEARANCE_KEYS];

/** The right-rail sections a layout can pin, in the default order. */
export const INSPECTOR_SECTIONS = ['goal', 'scene', 'plan', 'linked', 'notes', 'events', 'research', 'grammar', 'continuity', 'comments', 'suggestions', 'problems', 'revisions', 'receipts', 'book-problems'];

export const BUILTIN_THEMES = ['dark', 'light', 'high-contrast'];
export const FONT_FAMILIES = ['serif', 'sans', 'mono', 'accessible'];
/** Inclusive ranges of the typography settings. `measure` may also be the word "full". */
export const TYPOGRAPHY_RANGES = {
  size: [14, 24],
  lineHeight: [1.4, 2],
  paragraphSpacing: [0, 2],
  letterSpacing: [0, 0.12],
  measure: [50, 100],
};
export const PANEL_WIDTH_RANGES = { rail: [180, 480], inspector: [240, 560] };

/** The built-in layer: every key's default. The reference dark theme, serif 18 px, the Writing layout. */
export const BUILTIN = Object.freeze({
  modules: Object.freeze(Object.fromEntries(MODULE_IDS.map((id) => [id, true]))),
  labels: Object.freeze({}),
  export: Object.freeze({}),
  ai: Object.freeze({ level: DEFAULT_AI_LEVEL }),
  // M13-J01: optional local checks. Nothing runs until the author turns it on.
  checks: Object.freeze({
    version: 1,
    grammar: Object.freeze({ enabled: false, language: 'en', dialect: 'american', words: Object.freeze([]), rules: Object.freeze({}) }),
    style: Object.freeze({ enabled: false }),
    epub: Object.freeze({ validate: false }),
  }),
  theme: 'dark',
  typography: Object.freeze({ family: 'serif', size: 18, lineHeight: 1.7, paragraphSpacing: 0, letterSpacing: 0, measure: 72 }),
  layout: Object.freeze({ name: 'Writing' }),
  shortcuts: Object.freeze({}),
});

export const GRAMMAR_DIALECTS = ['american', 'british', 'australian', 'canadian', 'indian'];
export const MAX_GRAMMAR_WORDS = 5000;
export const GRAMMAR_RULE_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
/** A book-dictionary word: 1 to 64 characters, no whitespace at either end, no line break. @param {unknown} w */
export const isGrammarWord = (w) => typeof w === 'string' && w.length >= 1 && w.length <= 64 && w === w.trim() && !/[\r\n\u2028\u2029]/.test(w);

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inRange = (v, [lo, hi]) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
export const THEME_RE = /^(dark|light|high-contrast|custom:[A-Za-z0-9][A-Za-z0-9 _-]{0,39})$/;
export const COMMAND_ID_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;

/**
 * Problems of one `preferences` key's value: [{ location, message }] with `location` relative to `preferences.` (e.g. `typography.size`).
 * @param {string} key @param {any} value
 * @returns {{ location: string, message: string }[]}
 */
export function preferenceProblems(key, value) {
  /** @type {{ location: string, message: string }[]} */
  const out = [];
  const bad = (location, message) => out.push({ location, message });
  switch (key) {
    case 'modules':
      if (!isMap(value)) return [{ location: key, message: 'modules must be a mapping of module id to true or false' }];
      for (const [id, v] of Object.entries(value)) {
        if (!MODULE_IDS.includes(id)) bad(`${key}.${id}`, `unknown module ${id} (modules: ${MODULE_IDS.join(', ')})`);
        else if (typeof v !== 'boolean') bad(`${key}.${id}`, `${id} must be true or false`);
      }
      return out;
    case 'ai':
      if (!isMap(value)) return [{ location: key, message: 'ai must be a mapping (level: off, advisor, planner or cowriter)' }];
      for (const [k, v] of Object.entries(value)) {
        if (k === 'level') {
          if (!AI_LEVELS.includes(v)) bad(`${key}.${k}`, `level must be one of ${AI_LEVELS.join(', ')}`);
        } else bad(`${key}.${k}`, `unknown ai setting ${k}`);
      }
      return out;
    case 'checks': {
      if (!isMap(value)) return [{ location: key, message: 'checks must be a mapping (version, grammar, style, epub)' }];
      const flags = { grammar: ['enabled', 'language', 'dialect', 'words', 'rules'], style: ['enabled'], epub: ['validate'] };
      for (const [k, v] of Object.entries(value)) {
        if (k === 'version') {
          if (v !== 1) bad(`${key}.${k}`, 'checks.version must be 1: this book was saved by a newer StoryForge');
        } else if (Object.hasOwn(flags, k)) {
          if (!isMap(v)) bad(`${key}.${k}`, `${k} must be a mapping (${flags[k].join(', ')})`);
          else {
            for (const [s, sv] of Object.entries(v)) {
              if (!flags[k].includes(s)) bad(`${key}.${k}.${s}`, `unknown ${k} setting ${s}`);
              else if (s === 'language') {
                if (sv !== 'en') bad(`${key}.${k}.${s}`, 'language must be en (the only language supported)');
              } else if (s === 'dialect') {
                if (!GRAMMAR_DIALECTS.includes(sv)) bad(`${key}.${k}.${s}`, `dialect must be one of ${GRAMMAR_DIALECTS.join(', ')}`);
              } else if (s === 'words') {
                if (!Array.isArray(sv)) bad(`${key}.${k}.${s}`, 'words must be a list of words');
                else {
                  if (sv.length > MAX_GRAMMAR_WORDS) bad(`${key}.${k}.${s}`, `words holds at most ${MAX_GRAMMAR_WORDS} words`);
                  const seen = new Set();
                  sv.forEach((w, i) => {
                    if (!isGrammarWord(w)) bad(`${key}.${k}.${s}.${i}`, 'a word is 1 to 64 characters with no space at either end and no line break');
                    else if (seen.has(w)) bad(`${key}.${k}.${s}.${i}`, `the word ${w} is listed twice`);
                    else seen.add(w);
                  });
                }
              } else if (s === 'rules') {
                if (!isMap(sv)) bad(`${key}.${k}.${s}`, 'rules must be a mapping of rule name to false');
                else {
                  for (const [rule, rv] of Object.entries(sv)) {
                    if (!GRAMMAR_RULE_RE.test(rule)) bad(`${key}.${k}.${s}.${rule}`, 'a rule name is a letter followed by up to 63 letters or digits');
                    else if (rv !== false) bad(`${key}.${k}.${s}.${rule}`, 'a rule is turned off with false; leave it out to use the default');
                  }
                }
              } else if (typeof sv !== 'boolean') bad(`${key}.${k}.${s}`, `${s} must be true or false`);
            }
          }
        } else bad(`${key}.${k}`, `unknown checks setting ${k}`);
      }
      return out;
    }
    case 'labels':
    case 'export':
      return isMap(value) ? [] : [{ location: key, message: `${key} must be a mapping` }];
    case 'theme':
      return typeof value === 'string' && THEME_RE.test(value) ? [] : [{ location: key, message: 'theme must be dark, light, high-contrast or custom:<name>' }];
    case 'typography': {
      if (!isMap(value)) return [{ location: key, message: 'typography must be a mapping' }];
      for (const [k, v] of Object.entries(value)) {
        if (k === 'family') {
          if (!FONT_FAMILIES.includes(v)) bad(`${key}.${k}`, `family must be one of ${FONT_FAMILIES.join(', ')}`);
        } else if (k === 'measure') {
          if (v !== 'full' && !inRange(v, TYPOGRAPHY_RANGES.measure)) bad(`${key}.${k}`, 'measure must be 50 to 100 (characters) or "full"');
        } else if (Object.hasOwn(TYPOGRAPHY_RANGES, k)) {
          if (!inRange(v, TYPOGRAPHY_RANGES[k])) bad(`${key}.${k}`, `${k} must be a number from ${TYPOGRAPHY_RANGES[k][0]} to ${TYPOGRAPHY_RANGES[k][1]}`);
        } else bad(`${key}.${k}`, `unknown typography setting ${k}`);
      }
      return out;
    }
    case 'layout': {
      if (!isMap(value)) return [{ location: key, message: 'layout must be a mapping' }];
      for (const [k, v] of Object.entries(value)) {
        if (k === 'name') {
          if (typeof v !== 'string' || v.trim() === '' || v.length > 40) bad(`${key}.${k}`, 'layout name must be a short non-empty string');
        } else if (k === 'rail' || k === 'inspector') {
          if (!isMap(v)) bad(`${key}.${k}`, `${k} must be a mapping with shown and width`);
          else {
            if (v.shown !== undefined && typeof v.shown !== 'boolean') bad(`${key}.${k}.shown`, 'shown must be true or false');
            if (v.width !== undefined && !(Number.isInteger(v.width) && inRange(v.width, PANEL_WIDTH_RANGES[k]))) bad(`${key}.${k}.width`, `width must be a whole number from ${PANEL_WIDTH_RANGES[k][0]} to ${PANEL_WIDTH_RANGES[k][1]}`);
          }
        } else if (k === 'pinned') {
          if (!Array.isArray(v) || v.some((s) => !INSPECTOR_SECTIONS.includes(s))) bad(`${key}.${k}`, `pinned must be a list of right-rail sections (${INSPECTOR_SECTIONS.join(', ')})`);
        } else bad(`${key}.${k}`, `unknown layout setting ${k}`);
      }
      return out;
    }
    case 'shortcuts': {
      if (!isMap(value)) return [{ location: key, message: 'shortcuts must be a mapping of command id to a key chord (or null to remove it)' }];
      for (const [id, chord] of Object.entries(value)) {
        if (!COMMAND_ID_RE.test(id)) bad(`${key}.${id}`, 'not a command id (like editor.bold)');
        else if (chord !== null && normalizeChord(chord) === null) bad(`${key}.${id}`, 'a chord like Mod+Shift+K, or null to remove the binding');
      }
      return out;
    }
    default:
      return [{ location: key, message: 'unknown preference' }];
  }
}

/**
 * Validate a whole `preferences` map: I401 for an unknown key, E102 for a wrong value (the location says which part).
 * @param {any} map
 * @returns {{ code: 'I401' | 'E102', location: string, message: string }[]}
 */
export function checkPreferenceMap(map) {
  if (!isMap(map)) return [{ code: 'E102', location: 'preferences', message: 'preferences must be a mapping' }];
  const out = [];
  for (const [key, value] of Object.entries(map)) {
    if (key.startsWith('x-')) continue;
    if (!PREFERENCE_KEYS.includes(key)) {
      out.push({ code: 'I401', location: `preferences.${key}`, message: 'unknown field' });
      continue;
    }
    for (const p of preferenceProblems(key, value)) out.push({ code: 'E102', location: `preferences.${p.location}`, message: p.message });
  }
  return out;
}

/**
 * The validator's hook: report the problems of a library.md / book.md `preferences` map.
 * @param {{ file: string, fm: any }} doc @param {(code: string, file: string, loc: string, msg: string) => void} add
 */
export function checkPreferences(doc, add) {
  if (doc.fm.preferences === undefined || doc.fm.preferences === null) return;
  for (const p of checkPreferenceMap(doc.fm.preferences)) add(p.code, doc.file, p.location, p.message);
}

/** The keys of a layer that are valid (a broken value is ignored by the resolver, the validator reports it). @param {any} layer */
function usable(layer) {
  if (!isMap(layer)) return {};
  const out = {};
  for (const key of PREFERENCE_KEYS) {
    if (layer[key] === undefined || layer[key] === null) continue;
    if (preferenceProblems(key, layer[key]).length === 0) out[key] = layer[key];
    else if (isMap(layer[key])) {
      // keep the parts that are fine, drop the parts that are not
      const kept = {};
      for (const [k, v] of Object.entries(layer[key])) if (preferenceProblems(key, { [k]: v }).length === 0) kept[k] = v;
      if (Object.keys(kept).length > 0) out[key] = kept;
    }
  }
  return out;
}

/** Merge `layer` into `into` (plain mappings merge key by key, anything else replaces), recording the layer that set each leaf. */
function mergeInto(into, layer, name, sources, prefix) {
  for (const [k, v] of Object.entries(layer)) {
    const at = prefix ? `${prefix}.${k}` : k;
    if (isMap(v)) {
      if (!isMap(into[k])) into[k] = {};
      mergeInto(into[k], v, name, sources, at);
    } else {
      into[k] = Array.isArray(v) ? [...v] : v;
      sources[at] = name;
    }
  }
}

/** @typedef {'builtin' | 'library' | 'book' | 'profile'} Layer */

/**
 * Resolve the preferences of one book (or of no book: leave `book` out) for one profile.
 * Project keys: built-in < profile < library < book. Appearance keys: built-in < library < book < profile.
 * @param {{ profile?: any, library?: any, book?: any }} layers each is a preferences-shaped map or null
 * @returns {{ values: any, sources: Record<string, Layer>, order: { project: Layer[], appearance: Layer[] } }}
 *   `sources` names the layer that set each leaf (`modules.ai`, `typography.size`, `theme`, ...); a leaf nothing set is 'builtin'.
 */
export function resolvePreferences({ profile = null, library = null, book = null } = {}) {
  const given = { profile: usable(profile), library: usable(library), book: usable(book) };
  const order = { project: /** @type {Layer[]} */ (['builtin', 'profile', 'library', 'book']), appearance: /** @type {Layer[]} */ (['builtin', 'library', 'book', 'profile']) };
  /** @type {Record<string, Layer>} */
  const sources = {};
  const values = {};
  for (const key of PREFERENCE_KEYS) {
    const chain = PROJECT_KEYS.includes(key) ? order.project : order.appearance;
    for (const name of chain) {
      const layer = name === 'builtin' ? { [key]: BUILTIN[key] } : given[name];
      if (layer[key] === undefined) continue;
      mergeInto(values, { [key]: layer[key] }, name, sources, '');
    }
  }
  return { values, sources, order };
}

/**
 * Which modules are on, and why. A module a project turns off cannot be turned on by a profile; a module the project leaves unset follows the profile.
 * @param {{ profile?: any, library?: any, book?: any }} layers
 * @returns {Record<string, { on: boolean, source: Layer, locked: boolean }>} `locked`: the project (library or book) decided it, so a profile cannot change it
 */
export function resolveModules(layers) {
  const { values, sources } = resolvePreferences(layers);
  /** @type {Record<string, { on: boolean, source: Layer, locked: boolean }>} */
  const out = {};
  for (const id of MODULE_IDS) {
    const source = sources[`modules.${id}`] ?? 'builtin';
    out[id] = { on: values.modules[id] !== false, source, locked: source === 'library' || source === 'book' };
  }
  return out;
}

/** The module a write route belongs to, by route name (null: always on). J02's `insights` and `tasks` routes are classified by the coordinator when they merge. @param {string} route */
export function moduleOfRoute(route) {
  if (route.startsWith('ai-') && !['ai-profile-create', 'ai-profile-update', 'ai-profile-delete', 'ai-book-profile', 'ai-records', 'ai-profile-secure'].includes(route)) return 'ai';
  if (route.startsWith('continuity-')) return 'continuity';
  if (route === 'receipts-flush') return 'receipts';
  if (route.startsWith('suggestion-')) return 'suggestions';
  if (route.startsWith('task-')) return 'tasks'; // M07-J02 revision tasks
  if (route.startsWith('event-')) return 'timeline';
  if (route.startsWith('thread-')) return 'threads';
  if (route.startsWith('note-') || route === 'attachment-upload') return 'research';
  if (route.startsWith('canvas-')) return 'board'; // M09-J01: canvases are visual planning, with the corkboard
  if (route.startsWith('planner-')) return 'planner'; // Story Planner M1 (ADR 0003): causal links and scene plans
  if (route.startsWith('workspace-')) return 'workspace'; // M12 W2: workspace docs (book, style, state)
  if (route === 'scene-cast' || route.startsWith('ledger-') || route === 'activity-ai-log') return 'workspace'; // M12-W3: chapter cast, ledgers, the AI writing log
  return null;
}

// ---------------------------------------------------------------- key chords (contract section 4)

/** Chords nothing may be bound to: the browser and the operating system own them, and Tab, Shift+Tab and Escape keep the keyboard walk working. */
export const RESERVED_CHORDS = ['Mod+W', 'Mod+T', 'Mod+N', 'Mod+L', 'Mod+Tab', 'F5', 'Alt+F4', 'Tab', 'Shift+Tab', 'Escape'];

/** Symbols a keyboard types with Shift held: the key already says so, so a chord for them carries no Shift. */
export const SHIFTED_SYMBOLS = '?:"<>{}|~!@#$%^&*()_+';
const MODIFIER_ORDER = ['Mod', 'Alt', 'Shift'];
const KEY_ALIASES = { esc: 'Escape', return: 'Enter', ' ': 'Space', spacebar: 'Space', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

/**
 * One spelling for a chord: modifiers in the order Mod, Alt, Shift (`Ctrl`, `Control`, `Cmd` and `Meta` all mean Mod), a single letter in capitals, named keys as the
 * browser spells them. A symbol that already needs Shift to type (`?`) carries no Shift. Null when it is not a chord.
 * @param {unknown} chord @returns {string | null}
 */
export function normalizeChord(chord) {
  if (typeof chord !== 'string' || chord.trim() === '') return null;
  const parts = chord.trim() === '+' ? ['+'] : chord.trim().split(/\+(?=.)/);
  const key = parts.pop() ?? '';
  const mods = new Set();
  for (const p of parts) {
    const m = { ctrl: 'Mod', control: 'Mod', cmd: 'Mod', meta: 'Mod', command: 'Mod', mod: 'Mod', alt: 'Alt', option: 'Alt', shift: 'Shift' }[p.toLowerCase()];
    if (!m) return null;
    mods.add(m);
  }
  let name = KEY_ALIASES[key.toLowerCase()] ?? (/^f[0-9]{1,2}$/i.test(key) ? key.toUpperCase() : key);
  if (name.length === 1) name = name.toUpperCase();
  else if (!/^(F([1-9]|1[0-2])|[A-Z][A-Za-z]+)$/.test(name)) return null;
  if (name.length === 1 && SHIFTED_SYMBOLS.includes(name)) mods.delete('Shift');
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), name].join('+');
}

/** Is this chord one nothing may be bound to? @param {unknown} chord */
export function isReservedChord(chord) {
  const n = normalizeChord(chord);
  return n !== null && RESERVED_CHORDS.includes(n);
}

// ---------------------------------------------------------------- the profile layer (stored by the server; `docs/customization.md`)

/** The colour tokens of `theme/tokens.css` a custom theme may set. Every value is a #RRGGBB colour. */
export const THEME_TOKENS = ['--bg', '--surface', '--surface-2', '--divider', '--border', '--text', '--text-2', '--text-3', '--muted', '--accent', '--accent-ink', '--danger', '--warning', '--ok'];
export const PROFILE_SCHEMA = 'storyforge.profile/v1';
const CUSTOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
export const MAX_CUSTOM_THEMES = 20;
export const MAX_CUSTOM_LAYOUTS = 20;

/**
 * Problems in the extra profile-only keys (`customThemes`, `layouts`) and in every preference key of a profile.
 * @param {any} profile @returns {{ location: string, message: string }[]}
 */
export function profileProblems(profile) {
  if (!isMap(profile)) return [{ location: '', message: 'a profile is a JSON object' }];
  /** @type {{ location: string, message: string }[]} */
  const out = [];
  for (const [key, value] of Object.entries(profile)) {
    if (key === 'schema') continue;
    if (key === 'customThemes') {
      if (!isMap(value)) out.push({ location: key, message: 'customThemes must be an object of theme name to colours' });
      else {
        if (Object.keys(value).length > MAX_CUSTOM_THEMES) out.push({ location: key, message: `at most ${MAX_CUSTOM_THEMES} custom themes` });
        for (const [name, tokens] of Object.entries(value)) {
          if (!CUSTOM_NAME_RE.test(name)) out.push({ location: `${key}.${name}`, message: 'a theme name is 1 to 40 letters, digits, spaces, hyphens or underscores' });
          else if (!isMap(tokens)) out.push({ location: `${key}.${name}`, message: 'a theme is an object of token name to #RRGGBB colour' });
          else {
            for (const [token, colour] of Object.entries(tokens)) {
              if (!THEME_TOKENS.includes(token)) out.push({ location: `${key}.${name}.${token}`, message: `unknown token (${THEME_TOKENS.join(', ')})` });
              else if (typeof colour !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(colour)) out.push({ location: `${key}.${name}.${token}`, message: 'a colour like #1A2B3C' });
            }
          }
        }
      }
    } else if (key === 'layouts') {
      if (!isMap(value)) out.push({ location: key, message: 'layouts must be an object of layout name to layout' });
      else {
        if (Object.keys(value).length > MAX_CUSTOM_LAYOUTS) out.push({ location: key, message: `at most ${MAX_CUSTOM_LAYOUTS} custom layouts` });
        for (const [name, layout] of Object.entries(value)) {
          if (!CUSTOM_NAME_RE.test(name)) out.push({ location: `${key}.${name}`, message: 'a layout name is 1 to 40 letters, digits, spaces, hyphens or underscores' });
          else for (const p of preferenceProblems('layout', layout)) out.push({ location: p.location.replace(/^layout/, `${key}.${name}`), message: p.message });
        }
      }
    } else if (PREFERENCE_KEYS.includes(key)) {
      for (const p of preferenceProblems(key, value)) out.push(p);
      if (key === 'shortcuts' && isMap(value)) {
        for (const [id, chord] of Object.entries(value)) {
          if (chord !== null && isReservedChord(chord)) out.push({ location: `${key}.${id}`, message: `${chord} is reserved (the browser, the system or the keyboard walk uses it)` });
        }
      }
    } else out.push({ location: key, message: 'unknown profile key' });
  }
  return out;
}
