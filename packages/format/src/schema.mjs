// Per-kind field tables (spec sections 4-7 and 11.1) and the E102 / I401 / E103 checks.
import path from 'node:path';
import { isValidId, isValidSlug } from './ids.mjs';

/**
 * Field type codes: str, int (>= 0), int1 (>= 1), num, bool, list, map, any, slug,
 * or an array of allowed enum values.
 * @type {Record<string, {prefix:string, required:string[], fields:Record<string, any>}>}
 */
export const KINDS = {
  library: {
    prefix: 'lib',
    required: ['title'],
    fields: { title: 'str', pen_names: 'list' },
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
      genre: 'list', word_target: 'int', cover: 'str', language: 'str', previous_slugs: 'list',
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
      variant_of: 'str', events: 'list',
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
      status: ['open', 'paid', 'abandoned'], setup: 'list', payoff: 'list', characters: 'list', previous_slugs: 'list',
    },
  },
  event: {
    prefix: 'event',
    required: ['slug', 'title', 'order'],
    fields: {
      slug: 'slug', title: 'str', order: 'num', when: 'any', date: 'any', scenes: 'list',
      characters: 'list', locations: 'list', previous_slugs: 'list',
    },
  },
  doc: {
    prefix: 'note',
    required: ['title'],
    fields: { title: 'str', locked: 'bool' },
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

/** List-valued reference fields whose items must be strings. */
const STRING_LIST_FIELDS = new Set([
  'characters', 'locations', 'plot_threads', 'events', 'setup', 'payoff', 'scenes', 'sources', 'links',
]);

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
    default: return null;
  }
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
    if (type === 'list' && STRING_LIST_FIELDS.has(key)) {
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
