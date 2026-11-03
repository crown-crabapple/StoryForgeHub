// Custom prompt components and workflows (M07-J04): `<library>/_prompts/<slug>.md` and `<library>/_prompts/workflows/<slug>.md`.
// Parsing, the placeholder rules and rendering are pure; loadPrompts reads the folder (read-only). `_prompts/` is not a book: the scanner skips it.
import path from 'node:path';
import { isDirectory, isFile, readText, byCodePoint } from './fs.mjs';
import { isValidId, isValidSlug } from './ids.mjs';
import { parseText } from './frontmatter.mjs';
import { readdir } from 'node:fs/promises';

export const PROMPT_SCHEMA = 'storyforge.prompt/v1';
export const WORKFLOW_SCHEMA = 'storyforge.prompt-workflow/v1';
/** What a prompt can be given to read (each is shown in the context preview before anything is sent). */
export const PROMPT_INPUTS = ['selection', 'scene', 'chapter', 'entries', 'threads', 'pov-entry', 'notes'];
export const PROMPT_TASKS = ['chat', 'rewrite'];
/** The `{{<input>.<field>}}` fields each list-like input offers. */
const ENTRY_FIELDS = ['name', 'slug', 'type', 'role', 'status', 'body'];
export const INPUT_FIELDS = {
  'pov-entry': ENTRY_FIELDS,
  entries: ENTRY_FIELDS,
  threads: ['title', 'slug', 'kind', 'status', 'body'],
  notes: ['title', 'tags', 'body'],
};
/** Placeholders with no field. `previous` is the last step's reply in a workflow (empty when a prompt runs alone). */
const BARE = ['selection', 'scene', 'chapter', 'previous'];

const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Every `{{...}}` in a prompt body with its line in the file.
 * @param {string} body @param {number} [bodyStartLine] the file line the body starts on
 * @returns {{ raw: string, name: string, field: string | null, line: number }[]}
 */
export function placeholdersOf(body, bodyStartLine = 1) {
  const out = [];
  body.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      const dot = m[1].indexOf('.');
      out.push({ raw: m[0], name: dot < 0 ? m[1] : m[1].slice(0, dot).trim(), field: dot < 0 ? null : m[1].slice(dot + 1).trim(), line: bodyStartLine + i });
    }
  });
  return out;
}

/** Is this placeholder known for a prompt that declares `inputs`? @param {{ name: string, field: string | null }} p @param {string[]} inputs */
function placeholderKnown(p, inputs) {
  if (p.field === null) return BARE.includes(p.name) && (p.name === 'previous' || inputs.includes(p.name));
  return Object.hasOwn(INPUT_FIELDS, p.name) && inputs.includes(p.name) && INPUT_FIELDS[p.name].includes(p.field);
}

/** @param {any} v */
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Parse and check one prompt or workflow file's text.
 * @param {string} text the file as read @param {string} stem the file name without `.md` @param {'prompt' | 'workflow'} kind
 * @returns {{ ok: boolean, item: any, problems: { code: string, location: string, message: string }[] }}
 */
export function parsePromptFile(text, stem, kind) {
  /** @type {{ code: string, location: string, message: string }[]} */
  const problems = [];
  const bad = (location, message, code = 'E102') => problems.push({ code, location, message });
  const parsed = parseText(text);
  if (parsed.status === 'error') return { ok: false, item: null, problems: [{ code: parsed.error.code, location: '', message: parsed.error.message }] };
  const fm = parsed.fm ?? {};
  const schema = kind === 'prompt' ? PROMPT_SCHEMA : WORKFLOW_SCHEMA;
  if (fm.schema !== schema) bad('schema', `schema must be ${schema}`);
  if (!isValidId(fm.id, 'note')) bad('id', 'id must be note_ followed by a 26-character ULID');
  if (!isValidSlug(fm.slug)) bad('slug', 'slug must be a valid slug (a-z, 0-9, single hyphens)');
  else if (fm.slug !== stem) bad('slug', `slug must be the file name (${stem})`);
  if (typeof fm.name !== 'string' || fm.name.trim() === '') bad('name', 'name must be a non-empty string');
  const item = { kind, schema, id: typeof fm.id === 'string' ? fm.id : null, slug: typeof fm.slug === 'string' ? fm.slug : stem, name: typeof fm.name === 'string' ? fm.name : stem, body: parsed.body };
  if (kind === 'prompt') {
    let inputs = [];
    if (!Array.isArray(fm.inputs) || fm.inputs.some((i) => !PROMPT_INPUTS.includes(i))) bad('inputs', `inputs must be a list of: ${PROMPT_INPUTS.join(', ')}`);
    else inputs = fm.inputs;
    if (!PROMPT_TASKS.includes(fm.task)) bad('task', 'task must be chat or rewrite');
    if (fm.task === 'rewrite' && !inputs.includes('selection')) bad('inputs', 'a rewrite prompt needs the selection input');
    if (parsed.body.trim() === '') bad('body', 'the prompt text is empty');
    for (const p of placeholdersOf(parsed.body, parsed.bodyStartLine)) {
      if (!placeholderKnown(p, inputs)) bad('body', `unknown placeholder ${p.raw} on line ${p.line}`);
    }
    Object.assign(item, { inputs, task: fm.task === 'rewrite' ? 'rewrite' : 'chat' });
  } else {
    if (!Array.isArray(fm.steps) || fm.steps.length === 0 || fm.steps.some((s) => typeof s !== 'string')) bad('steps', 'steps must be a non-empty list of prompt slugs');
    Object.assign(item, { steps: Array.isArray(fm.steps) ? fm.steps.filter((s) => typeof s === 'string') : [] });
  }
  return { ok: problems.length === 0, item, problems };
}

/** The `.md` files directly inside a folder, sorted. @param {string} dir */
async function mdFiles(dir) {
  if (!(await isDirectory(dir))) return [];
  const names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.endsWith('.md')).map((e) => e.name);
  return names.sort(byCodePoint);
}

/**
 * Read `<library>/_prompts/`: the prompt components and the workflows, each with its problems (never an exception).
 * `diagnostics` are shaped like the validator's: { code, file, location, message } with `file` library-relative.
 * @param {string} libraryRoot absolute
 * @returns {Promise<{ prompts: any[], workflows: any[], diagnostics: { code: string, file: string, location: string, message: string }[] }>}
 */
export async function loadPrompts(libraryRoot) {
  const dir = path.join(libraryRoot, '_prompts');
  /** @type {{ code: string, file: string, location: string, message: string }[]} */
  const diagnostics = [];
  const prompts = [];
  const workflows = [];
  const seen = { slug: new Map(), id: new Map() };
  const take = (item, rel, kind) => {
    for (const k of ['slug', 'id']) {
      const key = `${kind}|${item[k]}`;
      if (item[k] && seen[k].has(key)) diagnostics.push({ code: 'E102', file: rel, location: k, message: `${k} ${item[k]} is used by ${seen[k].get(key)} too` });
      else if (item[k]) seen[k].set(key, rel);
    }
  };
  for (const [sub, kind, list] of [['', 'prompt', prompts], ['workflows', 'workflow', workflows]]) {
    const folder = sub ? path.join(dir, sub) : dir;
    for (const name of await mdFiles(folder)) {
      const rel = sub ? `_prompts/${sub}/${name}` : `_prompts/${name}`;
      const stem = name.slice(0, -3);
      const abs = path.join(folder, name);
      if (!(await isFile(abs))) continue;
      const r = parsePromptFile(await readText(abs), stem, /** @type {'prompt' | 'workflow'} */ (kind));
      for (const p of r.problems) diagnostics.push({ code: p.code, file: rel, location: p.location, message: p.message });
      if (r.item) {
        take(r.item, rel, kind);
        list.push({ ...r.item, path: rel, problems: r.problems });
      }
    }
  }
  const slugs = new Set(prompts.filter((p) => p.problems.length === 0).map((p) => p.slug));
  for (const w of workflows) {
    w.steps.forEach((s, i) => {
      if (!slugs.has(s)) {
        const message = `step ${s} is not a valid prompt in _prompts/`;
        w.problems.push({ code: 'E102', location: `steps[${i}]`, message });
        diagnostics.push({ code: 'E102', file: w.path, location: `steps[${i}]`, message });
      }
    });
  }
  return { prompts, workflows, diagnostics };
}

/**
 * The validator's hook for a library root: the shape of every file in `_prompts/` (E102).
 * @param {string} libraryRoot @param {(code: string, file: string, loc: string, msg: string) => void} add
 */
export async function checkPrompts(libraryRoot, add) {
  for (const d of (await loadPrompts(libraryRoot)).diagnostics) add(d.code, d.file, d.location, d.message);
}

/**
 * Fill a prompt's placeholders.
 * @param {{ body: string, inputs: string[] }} prompt
 * @param {Record<string, any>} values `selection`, `scene`, `chapter`, `previous`: text; `entries`, `threads`, `notes`: lists of records; `pov-entry`: one record
 * @returns {{ text: string, missing: string[] }} `missing`: placeholders whose input was not given (they are left empty in the text)
 */
export function renderPrompt(prompt, values) {
  /** @type {string[]} */
  const missing = [];
  const text = prompt.body.replace(PLACEHOLDER_RE, (whole, inner) => {
    const dot = inner.indexOf('.');
    const name = dot < 0 ? inner.trim() : inner.slice(0, dot).trim();
    const field = dot < 0 ? null : inner.slice(dot + 1).trim();
    const v = values[name];
    if (field === null) {
      if (typeof v === 'string') return v;
      if (name === 'previous') return '';
      missing.push(name);
      return '';
    }
    const list = Array.isArray(v) ? v : isMap(v) ? [v] : null;
    if (list === null || list.length === 0) {
      missing.push(name);
      return '';
    }
    const sep = field === 'body' ? '\n\n' : ', ';
    return list.map((r) => (Array.isArray(r?.[field]) ? r[field].join(', ') : String(r?.[field] ?? ''))).join(sep);
  });
  return { text, missing: [...new Set(missing)] };
}
