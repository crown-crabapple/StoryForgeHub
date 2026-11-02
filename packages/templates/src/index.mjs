// @storyforge/templates - the book templates are documented files in templates/<name>/ (see each template.md).
// This module only reads them: listTemplates() describes them, renderTemplate() fills in a book's placeholders.
// Read-only filesystem access (it reads its own template folder); nothing here writes.
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

/** Template folder names, in display order. */
async function templateNames() {
  const entries = await readdir(TEMPLATES_DIR, { withFileTypes: true });
  const names = entries.filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name);
  const known = ORDER.filter((n) => names.includes(n));
  return [...known, ...names.filter((n) => !ORDER.includes(n)).sort(byCodePoint)];
}

/**
 * @typedef {{ name: string, title: string, description: string, beats: string[], acts: number, chapters: number, scenes: number }} TemplateInfo
 */

/**
 * Every template with its structure counts, read from its template.md and its book/ folder.
 * @returns {Promise<TemplateInfo[]>}
 */
export async function listTemplates() {
  const out = [];
  for (const name of await templateNames()) {
    const dir = path.join(TEMPLATES_DIR, name);
    const { fm } = splitFrontMatter(await readFile(path.join(dir, 'template.md'), 'utf8'));
    const files = await walkFiles(path.join(dir, 'book'));
    out.push({
      name,
      title: String(fm.title ?? name),
      description: String(fm.description ?? ''),
      beats: Array.isArray(fm.beats) ? fm.beats.map(String) : [],
      acts: files.filter((f) => /^manuscript\/[^/]+\/act\.md$/.test(f)).length,
      chapters: files.filter((f) => /^manuscript\/[^/]+\/[^/]+\/chapter\.md$/.test(f)).length,
      scenes: files.filter((f) => /^manuscript\/[^/]+\/[^/]+\/\d{4}-[^/]+\.md$/.test(f)).length,
    });
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
 * @returns {Promise<Map<string, Buffer>>} book-relative path (forward slashes) -> file bytes
 */
export async function renderTemplate(name, vars) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || !(await templateNames()).includes(name)) {
    throw Object.assign(new Error(`no such template: ${name}`), { code: 'NO_SUCH_TEMPLATE' });
  }
  const all = { today: new Date().toISOString().slice(0, 10), ...vars };
  const dir = path.join(TEMPLATES_DIR, name, 'book');
  const ids = new Map();
  const out = new Map();
  for (const rel of await walkFiles(dir)) {
    const text = (await readFile(path.join(dir, rel), 'utf8')).replace(/\r\n/g, '\n');
    out.set(rel, Buffer.from(fill(text, all, ids), 'utf8'));
  }
  return out;
}
