// IDs, slugs and the uniqueness rules over them (E201, E208).

export const ID_PREFIXES = ['lib', 'series', 'book', 'act', 'chap', 'scene', 'entry', 'thread', 'event', 'note', 'rcpt'];
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
export const ID_RE = new RegExp(`^(${ID_PREFIXES.join('|')})_${ULID}$`);
export const ID_PREFIX_RE = new RegExp(`^(${ID_PREFIXES.join('|')})_`);
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** @param {any} v */
export function isValidSlug(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 60 && SLUG_RE.test(v);
}

/** @param {any} v @param {string} prefix */
export function isValidId(v, prefix) {
  return typeof v === 'string' && ID_RE.test(v) && v.startsWith(`${prefix}_`);
}

/**
 * E201: every document sharing an id with another one is reported, archived files included.
 * @param {{file:string, fm:any}[]} docs
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkDuplicateIds(docs, add) {
  /** @type {Map<string, any[]>} */
  const byId = new Map();
  for (const d of docs) {
    const id = d.fm.id;
    if (typeof id !== 'string') continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(d);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    for (const d of list) add('E201', d.file, 'id', `duplicate id ${id}`);
  }
}

/**
 * E208: entries, threads and events of one book share one slug namespace (archive excluded).
 * @param {{file:string, kind:string, archived:boolean, fm:any}[]} docs
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function checkDuplicateSlugs(docs, add) {
  /** @type {Map<string, any[]>} */
  const bySlug = new Map();
  for (const d of docs) {
    if (d.archived || !['entry', 'thread', 'event'].includes(d.kind)) continue;
    const s = d.fm.slug;
    if (typeof s !== 'string') continue;
    if (!bySlug.has(s)) bySlug.set(s, []);
    bySlug.get(s).push(d);
  }
  for (const [slug, list] of bySlug) {
    if (list.length < 2) continue;
    for (const d of list) add('E208', d.file, 'slug', `duplicate slug ${slug}`);
  }
}
