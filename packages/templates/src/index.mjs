// @storyforge/templates - the book templates are documented files in templates/<name>/ (see each template.md).
// This module only reads them: listTemplates() describes them, renderTemplate() fills in a book's placeholders.
// A library may add its own in <library>/_templates/<name>/, laid out the same way (M07-J01); templateFromBook() makes
// one from a book. It is a pure function over what it reads: the caller writes the files, through @storyforge/store.
// Read-only filesystem access (its own template folder, a library's _templates/ and the book it is asked to read); nothing here writes.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'yaml';
import { ulid } from '@storyforge/manuscript';

const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));
/** The order templates are offered in; any other template folder follows alphabetically. */
const ORDER = ['blank', 'story-circle', 'heros-journey', 'seven-point'];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID_PREFIXES = new Set(['lib', 'series', 'book', 'act', 'chap', 'scene', 'entry', 'thread', 'event', 'note', 'rcpt']);
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_]+(?::[A-Za-z0-9-]+)?)\s*\}\}/g;
const VARS = new Set(['book_title', 'book_slug', 'pen_name', 'today', 'series_number']);
/** Variables that may be left out; a line that uses one that is missing is dropped. */
const OPTIONAL = new Set(['pen_name', 'series_number']);
/** Variables written as quoted YAML strings when they sit inside front matter. */
const QUOTED_IN_FRONT_MATTER = new Set(['book_title', 'pen_name']);

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {string} text @returns {{ fm: Record<string, any>, body: string }} */
function splitFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0].replace(/\r$/, '') !== '---') return { fm: {}, body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === '---');
  if (end < 0) return { fm: {}, body: text };
  const fm = parse(lines.slice(1, end).join('\n'), { version: '1.2', schema: 'core' });
  return { fm: fm && typeof fm === 'object' ? fm : {}, body: lines.slice(end + 1).join('\n') };
}

/** Every file under `dir` as forward-slash relative paths. @param {string} dir @returns {Promise<string[]>} */
async function walkFiles(dir) {
  const out = [];
  /** @param {string} rel */
  async function visit(rel) {
    for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await visit(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  }
  await visit('');
  return out.sort(byCodePoint);
}

/** Template folder names in a templates folder, in display order (a folder that is absent has none). @param {string} dir */
async function templateNames(dir = TEMPLATES_DIR) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name);
  const known = ORDER.filter((n) => names.includes(n));
  return [...known, ...names.filter((n) => !ORDER.includes(n)).sort(byCodePoint)];
}

/** The folder of a library's own templates. @param {string} libraryRoot */
const libraryTemplatesDir = (libraryRoot) => path.join(path.resolve(libraryRoot), '_templates');

/**
 * @typedef {{ name: string, title: string, description: string, beats: string[], acts: number, chapters: number, scenes: number,
 *             source: 'builtin' | 'library', shadows_builtin?: boolean }} TemplateInfo
 */

/** One template folder, described. @param {string} dir @param {string} name @param {'builtin'|'library'} source @returns {Promise<TemplateInfo|null>} */
async function describe(dir, name, source) {
  let text;
  try {
    text = await readFile(path.join(dir, name, 'template.md'), 'utf8');
  } catch {
    if (source === 'library') return null; // a folder without a template.md is not a template (the validator reports it)
    throw new Error(`template ${name} has no template.md`);
  }
  const { fm } = splitFrontMatter(text.replace(/\r\n/g, '\n'));
  let files = [];
  try {
    files = await walkFiles(path.join(dir, name, 'book'));
  } catch {
    // no book/ folder: an empty template
  }
  return {
    name,
    title: String(fm.title ?? name),
    description: String(fm.description ?? ''),
    beats: Array.isArray(fm.beats) ? fm.beats.map(String) : [],
    acts: files.filter((f) => /^manuscript\/[^/]+\/act\.md$/.test(f)).length,
    chapters: files.filter((f) => /^manuscript\/[^/]+\/[^/]+\/chapter\.md$/.test(f)).length,
    scenes: files.filter((f) => /^manuscript\/[^/]+\/[^/]+\/\d{4}-[^/]+\.md$/.test(f)).length,
    source,
  };
}

/**
 * Every template with its structure counts, read from its template.md and its book/ folder: the built-in ones, then
 * (with `libraryRoot`) the library's own from `_templates/`. A library template with a built-in name is listed under
 * that name with `source: 'library'` and `shadows_builtin: true`; both stay selectable by `source` and `name`.
 * @param {{ libraryRoot?: string }} [opts]
 * @returns {Promise<TemplateInfo[]>}
 */
export async function listTemplates({ libraryRoot } = {}) {
  const out = [];
  const builtin = await templateNames();
  for (const name of builtin) out.push(/** @type {TemplateInfo} */ (await describe(TEMPLATES_DIR, name, 'builtin')));
  if (typeof libraryRoot === 'string' && libraryRoot !== '') {
    const dir = libraryTemplatesDir(libraryRoot);
    for (const name of (await templateNames(dir)).sort(byCodePoint)) {
      const info = await describe(dir, name, 'library');
      if (info) out.push({ ...info, shadows_builtin: builtin.includes(name) });
    }
  }
  return out;
}

/**
 * Fill in one file's placeholders.
 * Front matter is where YAML needs care: `{{book_title}}` and `{{pen_name}}` become quoted YAML strings there,
 * so a template writes them bare. Elsewhere they are plain text.
 * @param {string} text @param {Record<string, string | number | undefined>} vars @param {Map<string, string>} ids
 */
function fill(text, vars, ids) {
  const lines = text.split('\n');
  const fmEnd = lines[0] === '---' ? lines.findIndex((l, i) => i > 0 && l === '---') : -1;
  const out = [];
  lines.forEach((line, i) => {
    const inFrontMatter = fmEnd > 0 && i > 0 && i < fmEnd;
    let drop = false;
    const rendered = line.replace(PLACEHOLDER_RE, (_m, ref) => {
      if (ref.startsWith('id:')) {
        const key = ref.slice(3);
        const prefix = key.split(/[-:]/)[0];
        if (!ID_PREFIXES.has(prefix)) throw new Error(`template placeholder {{id:${key}}} has no valid ID prefix`);
        if (!ids.has(key)) ids.set(key, `${prefix}_${ulid()}`);
        return /** @type {string} */ (ids.get(key));
      }
      if (!VARS.has(ref)) throw new Error(`unknown template placeholder {{${ref}}}`);
      const v = vars[ref];
      if (v === undefined || v === null || v === '') {
        if (OPTIONAL.has(ref)) {
          drop = true;
          return '';
        }
        throw new Error(`template variable ${ref} is required`);
      }
      return inFrontMatter && QUOTED_IN_FRONT_MATTER.has(ref) ? JSON.stringify(String(v)) : String(v);
    });
    if (!drop) out.push(rendered);
  });
  return out.join('\n');
}

/**
 * The files a new book gets, with placeholders filled in. Each distinct `{{id:<key>}}` becomes one fresh ULID
 * (its prefix is the part of the key before the first `-` or `:`). A line that uses a missing optional variable
 * (`pen_name`, `series_number`) is left out.
 * @param {string} name template name
 * @param {{ book_title: string, book_slug: string, pen_name?: string, today?: string, series_number?: number }} vars
 * @param {{ libraryRoot?: string, source?: 'builtin' | 'library' }} [opts] `source: 'library'` (with `libraryRoot`) renders the library's template of
 *   that name. Without `source`, a built-in template of that name is used if there is one, else the library's.
 * @returns {Promise<Map<string, Buffer>>} book-relative path (forward slashes) -> file bytes
 */
export async function renderTemplate(name, vars, { libraryRoot, source } = {}) {
  const bad = () => Object.assign(new Error(`no such template: ${name}`), { code: 'NO_SUCH_TEMPLATE' });
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad();
  const libDir = typeof libraryRoot === 'string' && libraryRoot !== '' ? libraryTemplatesDir(libraryRoot) : null;
  const inBuiltin = (await templateNames()).includes(name);
  const inLibrary = libDir !== null && (await templateNames(libDir)).includes(name);
  const useLibrary = source === 'library' ? inLibrary : source === 'builtin' ? false : !inBuiltin && inLibrary;
  if (!(useLibrary || (source !== 'library' && inBuiltin))) throw bad();
  const all = { today: new Date().toISOString().slice(0, 10), ...vars };
  const dir = path.join(useLibrary ? /** @type {string} */ (libDir) : TEMPLATES_DIR, name, 'book');
  const ids = new Map();
  const out = new Map();
  for (const rel of await walkFiles(dir)) {
    const text = (await readFile(path.join(dir, rel), 'utf8')).replace(/\r\n/g, '\n');
    out.set(rel, Buffer.from(fill(text, all, ids), 'utf8'));
  }
  return out;
}

// ------------------------------------------------------------------ save a book as a template (M07-J01 section 5)

/** Top-level `key:` lines of a front matter block start a new key. */
const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_-]*):/;

/**
 * A document's front matter as ordered top-level blocks (each key with its continuation lines), plus the body.
 * Line-based on purpose: kept blocks are copied byte for byte (their YAML is never re-serialised).
 * @param {string} text LF text @returns {{ blocks: { key: string, lines: string[] }[], body: string } | null}
 */
function frontBlocks(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  /** @type {{ key: string, lines: string[] }[]} */
  const blocks = [];
  for (const line of lines.slice(1, end)) {
    const m = KEY_LINE_RE.exec(line);
    if (m) blocks.push({ key: m[1], lines: [line] });
    else if (blocks.length > 0) blocks[blocks.length - 1].lines.push(line);
  }
  return { blocks, body: lines.slice(end + 1).join('\n') };
}

const render = (blocks, body) => `---\n${blocks.flatMap((b) => b.lines).join('\n')}\n---\n${body}`;

/** Front matter keys a template keeps, per kind. Everything else (story text, canon, per-book state) is dropped. */
const KEEP = {
  book: ['schema', 'id', 'slug', 'title', 'series_number', 'pen_name', 'profile', 'status', 'genre', 'word_target', 'daily_word_goal', 'cover_color', 'language', 'labels'],
  act: ['schema', 'id', 'act', 'title', 'labels'],
  chapter: ['schema', 'id', 'chapter', 'label', 'title', 'labels'],
  scene: ['schema', 'id', 'title', 'act', 'chapter', 'sequence', 'status', 'labels'],
  thread: ['schema', 'id', 'slug', 'title', 'kind', 'status', 'setup', 'develop', 'payoff', 'labels'],
  doc: ['schema', 'id', 'title', 'locked', 'labels'],
  'codex-type': ['schema', 'id', 'type', 'name', 'plural', 'fields', 'values'],
};

/**
 * A reusable template from a book (spec: "Save book as template"). It keeps the acts, chapters, scene titles, sequence and
 * status, the codex `_types`, labels (in book.md), planning docs and plot threads. It drops scene, entry and thread bodies, codex entries
 * and their fields, timeline events, continuity exceptions, research, receipts, suggestions, AI records, activity, `legacy/`,
 * `provenance/`, `assets/` and `archive/`. Every ID becomes a `{{id:<key>}}` placeholder, so each book made from the template
 * gets fresh IDs; the book's slug, title, series number and pen name become the usual placeholders.
 *
 * Pure: reads the book and returns the template's files, it writes nothing. Paths are relative to the template folder
 * (`template.md` and `book/...`), ready for `writeNewTree` at `<library>/_templates/<name>/`.
 * @param {string} bookRoot absolute path of a book folder
 * @param {{ name: string, title: string, description?: string, seriesLabels?: { name: string, color: string }[] }} meta the template's own `name` (a slug), `title` and `description`.
 *   `seriesLabels` (the labels the book's series defines): a label a kept document uses that only the series defines is written into the template's book.md,
 *   so a book made from the template has every label it names (a template is validated on its own, without the series).
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function templateFromBook(bookRoot, meta) {
  if (!meta || typeof meta.name !== 'string' || !NAME_RE.test(meta.name)) {
    throw Object.assign(new Error('a template needs a name that is a slug (a-z, 0-9, single hyphens)'), { code: 'BAD_TEMPLATE_NAME' });
  }
  if (typeof meta.title !== 'string' || meta.title.trim() === '') {
    throw Object.assign(new Error('a template needs a title'), { code: 'BAD_TEMPLATE_TITLE' });
  }
  const root = path.resolve(bookRoot);

  /** @type {string[]} */
  const rels = [];
  /** @param {string} rel */
  const visit = async (rel) => {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await visit(child);
      else if (e.isFile() && /\.md$/i.test(e.name)) rels.push(child);
    }
  };
  await visit('');
  rels.sort(byCodePoint);

  // pass 1: read what is kept, and give every kept scene its placeholder (threads name scenes by id)
  /** @type {{ rel: string, kind: string, fm: Record<string, any>, parsed: NonNullable<ReturnType<typeof frontBlocks>> }[]} */
  const kept = [];
  /** @type {Map<string, string>} */
  const sceneKey = new Map();
  let nScene = 0;
  let nChap = 0;
  for (const rel of rels) {
    const logical = rel;
    if (/^(archive|legacy|provenance|suggestions|ai|activity|research|assets)\//.test(logical)) continue;
    const text = (await readFile(path.join(root, ...rel.split('/')), 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const parsed = frontBlocks(text);
    if (!parsed) continue;
    let fm;
    try {
      fm = splitFrontMatter(text).fm;
    } catch {
      continue;
    }
    const kind = typeof fm.schema === 'string' ? (/^storyforge\.([a-z-]+)\/v1$/.exec(fm.schema)?.[1] ?? null) : null;
    if (!kind || !Object.hasOwn(KEEP, kind)) continue;
    if (kind === 'book' && rel !== 'book.md') continue;
    if (kind === 'scene' && (!logical.startsWith('manuscript/') || (typeof fm.variant_of === 'string' && fm.variant_of !== ''))) continue;
    if (kind === 'thread' && !logical.startsWith('planning/threads/')) continue;
    if (kind === 'doc' && !logical.startsWith('planning/')) continue;
    if (kind === 'codex-type' && !logical.startsWith('codex/_types/')) continue;
    if ((kind === 'act' || kind === 'chapter') && !logical.startsWith('manuscript/')) continue;
    if (kind === 'scene' && typeof fm.id === 'string') sceneKey.set(fm.id, `scene-${++nScene}`);
    kept.push({ rel, kind, fm, parsed });
  }

  // labels the kept documents use that the book does not define: copied from the series' definitions (book.md of the template), so the template stands alone
  const fold = (n) => String(n).trim().toLowerCase();
  const bookLabels = Array.isArray(kept.find((k) => k.kind === 'book')?.fm.labels) ? kept.find((k) => k.kind === 'book')?.fm.labels.filter((l) => l && typeof l.name === 'string') : [];
  const have = new Set(bookLabels.map((l) => fold(l.name)));
  /** @type {{ name: string, color: string }[]} */
  const addLabels = [];
  for (const def of Array.isArray(meta.seriesLabels) ? meta.seriesLabels : []) {
    if (!def || typeof def.name !== 'string' || typeof def.color !== 'string' || have.has(fold(def.name))) continue;
    if (kept.some((k) => k.kind !== 'book' && Array.isArray(k.fm.labels) && k.fm.labels.some((l) => typeof l === 'string' && fold(l) === fold(def.name)))) addLabels.push(def);
  }

  // pass 2: rewrite
  const out = new Map();
  const beats = [];
  let nNote = 0;
  for (const { rel, kind, fm, parsed } of kept) {
    const wanted = new Set(KEEP[kind]);
    const blocks = parsed.blocks.filter((b) => wanted.has(b.key));
    const set = (key, line) => {
      const b = blocks.find((x) => x.key === key);
      if (b) b.lines = [line];
    };
    let idKey;
    if (kind === 'book') idKey = 'book';
    else if (kind === 'act') idKey = `act-${Number.isInteger(fm.act) ? fm.act : ++nNote}`;
    else if (kind === 'chapter') idKey = `chap-${++nChap}`;
    else if (kind === 'scene') idKey = sceneKey.get(fm.id) ?? `scene-${++nScene}`;
    else if (kind === 'thread') idKey = `thread-${String(fm.slug ?? ++nNote)}`;
    else if (kind === 'codex-type') idKey = `note-type-${String(fm.type ?? ++nNote)}`;
    else idKey = `note-${++nNote}`;
    set('id', `id: {{id:${idKey}}}`);
    let body = '';
    if (kind === 'book') {
      if (addLabels.length > 0) {
        const lines = ['labels:', ...[...bookLabels, ...addLabels].flatMap((l) => [`  - name: ${JSON.stringify(l.name)}`, `    color: ${JSON.stringify(l.color)}`])];
        const at = blocks.findIndex((b) => b.key === 'labels');
        if (at >= 0) blocks[at].lines = lines;
        else blocks.push({ key: 'labels', lines });
      }
      set('slug', 'slug: {{book_slug}}');
      set('title', 'title: {{book_title}}');
      set('status', 'status: planning');
      if (blocks.some((b) => b.key === 'series_number')) set('series_number', 'series_number: {{series_number}}');
      else blocks.splice(blocks.findIndex((b) => b.key === 'title') + 1, 0, { key: 'series_number', lines: ['series_number: {{series_number}}'] });
      if (blocks.some((b) => b.key === 'pen_name')) set('pen_name', 'pen_name: {{pen_name}}');
      else blocks.splice(blocks.findIndex((b) => b.key === 'series_number') + 1, 0, { key: 'pen_name', lines: ['pen_name: {{pen_name}}'] });
    } else if (kind === 'scene') {
      if (typeof fm.title === 'string' && fm.title.trim() !== '') beats.push(fm.title.trim());
    } else if (kind === 'thread') {
      // a thread keeps the scenes of the template it points at, under their placeholders; the rest is per-book state
      for (const key of ['setup', 'develop', 'payoff']) {
        const list = Array.isArray(fm[key]) ? fm[key].filter((v) => typeof v === 'string' && sceneKey.has(v)).map((v) => `{{id:${sceneKey.get(v)}}}`) : [];
        const at = blocks.findIndex((b) => b.key === key);
        if (list.length === 0) {
          if (at >= 0) blocks.splice(at, 1);
        } else if (at >= 0) blocks[at].lines = [`${key}: [${list.join(', ')}]`];
      }
      set('status', 'status: planned');
    } else if (kind === 'doc' || kind === 'codex-type') {
      body = parsed.body; // planning docs and type descriptions are structure, kept as written
    }
    const text = render(blocks, body);
    const leftover = text.replace(PLACEHOLDER_RE, '');
    if (leftover.includes('{{')) {
      throw Object.assign(new Error(`${rel} contains "{{" and cannot be kept in a template`), { code: 'TEMPLATE_PLACEHOLDER_CLASH', file: rel });
    }
    out.set(`book/${rel}`, Buffer.from(text, 'utf8'));
  }
  if (!out.has('book/book.md')) throw Object.assign(new Error('no book.md to make a template from'), { code: 'NOT_A_BOOK' });

  const q = (v) => JSON.stringify(String(v));
  const head = [
    'schema: storyforge.template/v1', `name: ${meta.name}`, `title: ${q(meta.title.trim())}`, `description: ${q(String(meta.description ?? '').trim() || meta.title.trim())}`,
    ...(beats.length > 0 ? ['beats:', ...beats.map((b) => `  - ${q(b)}`)] : []),
  ];
  const result = new Map();
  result.set('template.md', Buffer.from(`---\n${head.join('\n')}\n---\nSaved from a book on ${new Date().toISOString().slice(0, 10)}. It keeps the structure (acts, chapters, scene titles, types, labels, planning documents and threads) and none of the story text.\n`, 'utf8'));
  for (const rel of [...out.keys()].sort(byCodePoint)) result.set(rel, /** @type {Buffer} */ (out.get(rel)));
  return result;
}
