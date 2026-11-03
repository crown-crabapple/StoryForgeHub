// Series shared worlds, labels, typed fields and user templates (M07-J01). Everything here is additive within v1:
// loading a series' shared entries, and the checks W309, W311, W312 plus the shape of `_templates/<name>/template.md`.
import path from 'node:path';
import { isDirectory, isFile, listDirs, mapOrdered, readText, walkSharedMarkdown } from './fs.mjs';
import { checkDuplicateSlugs } from './ids.mjs';
import { loadDoc } from './load.mjs';
import { checkPlacement } from './placement.mjs';
import { checkCodex } from './codex.mjs';
import { parseText } from './frontmatter.mjs';
import { checkFields, isIsoDate } from './schema.mjs';

/** @typedef {import('./load.mjs').Doc} Doc */

/** @param {string} a @param {string} b */
const join = (a, b) => (a ? `${a}/${b}` : b);
const fold = (s) => s.trim().toLowerCase();

/**
 * Load and check the shared world of one series: every `.md` under `<series>/codex/` and `<series>/archive/`.
 * `rel` is relative to the series folder, `file` to the validated root.
 * @param {string} rootDir absolute validated root
 * @param {string} seriesPath series folder relative to rootDir ('' = rootDir itself)
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 * @returns {Promise<Doc[]>} the typed documents
 */
export async function loadShared(rootDir, seriesPath, add) {
  const seriesDir = seriesPath ? path.join(rootDir, ...seriesPath.split('/')) : rootDir;
  const files = await walkSharedMarkdown(seriesDir);
  const loaded = await mapOrdered(
    files,
    (rel, bufferedAdd) => loadDoc(path.join(seriesDir, ...rel.split('/')), rel, join(seriesPath, rel), bufferedAdd),
    add,
  );
  /** @type {Doc[]} */
  const typed = [];
  for (const { doc } of loaded) if (doc?.kind) typed.push(doc);
  for (const d of typed) checkFields(d, { inSeries: false }, add);
  checkDuplicateSlugs(typed, add);
  checkPlacement(typed, add);
  checkCodex(typed, add);
  return typed;
}

/**
 * The label names a book.md or series.md defines (folded).
 * @param {Doc|undefined} doc
 * @returns {Set<string>}
 */
export function labelNames(doc) {
  const out = new Set();
  if (Array.isArray(doc?.fm.labels)) {
    for (const l of doc.fm.labels) if (l && typeof l === 'object' && typeof l.name === 'string' && l.name.trim() !== '') out.add(fold(l.name));
  }
  return out;
}

/**
 * W311: a document names a label that neither its book nor its series defines.
 * @param {Doc[]} docs @param {Set<string>} defined folded names
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkLabelRefs(docs, defined, add) {
  for (const d of docs) {
    if (d.kind === 'book' || d.kind === 'series' || !Array.isArray(d.fm.labels)) continue;
    d.fm.labels.forEach((l, i) => {
      if (typeof l === 'string' && !defined.has(fold(l))) add('W311', d.file, `labels[${i}]`, `label ${l} is not defined by the book or its series`);
    });
  }
}

/**
 * W309: a book-local entry, thread or event has the same slug as a shared entry of the series (the local one wins).
 * @param {Doc[]} localDocs @param {Doc[]} sharedDocs
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkShadows(localDocs, sharedDocs, add) {
  const shared = new Set(sharedDocs.filter((d) => d.kind === 'entry' && !d.archived && typeof d.fm.slug === 'string').map((d) => d.fm.slug));
  if (shared.size === 0) return;
  for (const d of localDocs) {
    if (d.archived || !['entry', 'thread', 'event'].includes(d.kind)) continue;
    if (typeof d.fm.slug === 'string' && shared.has(d.fm.slug)) add('W309', d.file, 'slug', `this entry shadows the series entry ${d.fm.slug}; links in this book reach this one`);
  }
}

/**
 * Type names of the non-archived type files.
 * @param {Doc[]} docs
 * @returns {Set<string>}
 */
export function typeNames(docs) {
  return new Set(docs.filter((d) => d.kind === 'codex-type' && !d.archived && typeof d.fm.type === 'string').map((d) => d.fm.type));
}

/**
 * Declared field kinds per type, from the first non-archived type file of each type. Plain string labels and
 * malformed items (E102 is reported elsewhere) declare nothing.
 * @param {Doc[]} docs
 * @returns {Map<string, Map<string, {kind: string, choices: string[]}>>}
 */
export function fieldDefs(docs) {
  const out = new Map();
  for (const d of docs) {
    if (d.kind !== 'codex-type' || d.archived || typeof d.fm.type !== 'string' || out.has(d.fm.type)) continue;
    const defs = new Map();
    if (Array.isArray(d.fm.fields)) {
      for (const item of d.fm.fields) {
        if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.label === 'string' && typeof item.kind === 'string') {
          defs.set(item.label, { kind: item.kind, choices: Array.isArray(item.choices) ? item.choices.filter((c) => typeof c === 'string') : [] });
        }
      }
    }
    out.set(d.fm.type, defs);
  }
  return out;
}

const LINK_VALUE_RE = /^\[\[[^\]\n|]+(\|[^\]\n]*)?\]\]$/;

/**
 * Does `value` fit a declared field kind (spec 5.1)? An empty value always fits.
 * @param {string} kind @param {any} value @param {string[]} choices
 */
export function fieldFits(kind, value, choices) {
  if (value === undefined || value === null || value === '') return true;
  switch (kind) {
    case 'text': return ['string', 'number', 'boolean'].includes(typeof value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && isIsoDate(value);
    case 'link': return typeof value === 'string' && LINK_VALUE_RE.test(value.trim());
    case 'choice': return typeof value === 'string' && choices.includes(value);
    case 'list': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    default: return true;
  }
}

/**
 * W312: an entry's `fields` value does not fit the kind its type declares. A type file among `ownDocs` (the book,
 * or the shared world itself) overrides the series' one (`seriesDocs`) for the same type.
 * @param {Doc[]} entryDocs @param {Doc[]} ownDocs @param {Doc[]} seriesDocs
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkTypedValues(entryDocs, ownDocs, seriesDocs, add) {
  const own = fieldDefs(ownDocs);
  const fallback = fieldDefs(seriesDocs);
  if (own.size === 0 && fallback.size === 0) return;
  for (const d of entryDocs) {
    if (d.kind !== 'entry' || typeof d.fm.type !== 'string') continue;
    const f = d.fm.fields;
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
    const defs = own.get(d.fm.type) ?? fallback.get(d.fm.type);
    if (!defs) continue;
    for (const [label, value] of Object.entries(f)) {
      const def = defs.get(label);
      if (def && !fieldFits(def.kind, value, def.choices)) add('W312', d.file, `fields.${label}`, `${label} should be a ${def.kind} value`);
    }
  }
}

/**
 * `_templates/<name>/template.md` of a library: its shape only (E102). The other files of a template hold
 * placeholders and are not documents.
 * @param {string} libraryRoot absolute
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export async function checkTemplates(libraryRoot, add) {
  const dir = path.join(libraryRoot, '_templates');
  if (!(await isDirectory(dir))) return;
  for (const name of await listDirs(dir)) {
    const rel = `_templates/${name}/template.md`;
    const abs = path.join(dir, name, 'template.md');
    if (!(await isFile(abs))) {
      add('E102', rel, '', 'a template folder needs a template.md');
      continue;
    }
    const parsed = parseText(await readText(abs));
    if (parsed.status === 'error') {
      add(parsed.error.code, rel, '', parsed.error.message);
      continue;
    }
    const fm = parsed.fm ?? {};
    if (fm.schema !== 'storyforge.template/v1') add('E102', rel, 'schema', 'schema must be storyforge.template/v1');
    if (typeof fm.name !== 'string' || fm.name !== name) add('E102', rel, 'name', 'name must be a string equal to the template folder name');
    for (const key of ['title', 'description']) {
      if (typeof fm[key] !== 'string' || fm[key].trim() === '') add('E102', rel, key, `${key} must be a non-empty string`);
    }
  }
}
