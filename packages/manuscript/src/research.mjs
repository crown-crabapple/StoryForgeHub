// Research, planning-doc and source commands (M04-J04): new note / doc / source, note fields, archive / restore, and attachments.
// Every command has a dry run (except the upload), goes through the store (one batch, one opId), is refused when it would add a validation
// error, and never deletes. Front matter is edited by lines (a scalar through editFrontMatterLine, a list as that key's own block); YAML is
// never re-serialised and the text (the body) is not touched here.
import path from 'node:path';
import { editFrontMatterLine, formatYamlText } from './frontmatter.mjs';
import { flowList, frontOf, prepareCodex, replaceFrontMatterBlock, stale } from './codex.mjs';
import { fail, finish, guarded, readBytes } from './ops.mjs';
import { SLUG_RE, slugify, ulid } from './util.mjs';
import { openStore } from '@storyforge/store';

const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const isText = (v) => typeof v === 'string' && !CONTROL_RE.test(v);
const NOTE_KINDS = ['research', 'doc', 'source'];
/** The text fields of a source, in file order after `title`. */
export const SOURCE_FIELDS = ['type', 'author', 'year', 'publisher', 'url', 'accessed', 'locator'];
const quote = (v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The live or archived note document (research, planning doc or source) with this id. */
const findNote = (docs, id, archived) => docs.find((d) => NOTE_KINDS.includes(d.kind) && d.archived === archived && d.fm.id === id && (d.kind !== 'doc' || d.rel.startsWith(archived ? 'archive/planning/' : 'planning/'))) ?? null;

// ------------------------------------------------------------------ createNote

/**
 * New file. `kind`: 'research' -> research/<slug>.md (schema, id, title, tags, canon, sources, links); 'doc' -> planning/<slug>.md (storyforge.doc/v1: schema, id,
 * title, locked); 'source' -> research/sources/<cite-key>.md (cite_key, title and the source fields given). The file name comes from `slug` (else the title; for a
 * source the cite key). A cite key another source has (archived ones too): CITE_KEY_TAKEN. A file that is already there: REFUSED_PATH_TAKEN.
 * @param {string} bookRoot
 * @param {{ kind: 'research' | 'doc' | 'source', title: string, slug?: string, tags?: string[], links?: string[], sources?: string[], canon?: boolean,
 *   cite_key?: string, type?: string, author?: string, year?: string, publisher?: string, url?: string, accessed?: string, locator?: string, dryRun?: boolean }} args
 */
export function createNote(bookRoot, args = {}) {
  return guarded(async () => {
    const { kind, title, slug: given, tags = [], links = [], sources = [], canon = false, cite_key: citeKey, dryRun = false } = args ?? {};
    if (!NOTE_KINDS.includes(kind)) return fail('REFUSED_BAD_ARGS', `kind must be one of ${NOTE_KINDS.join(', ')}`);
    if (!isText(title) || title.trim() === '' || title.length > 300) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters (max 300)');
    if (kind === 'source') {
      if (typeof citeKey !== 'string' || !SLUG_RE.test(citeKey) || citeKey.length > 60) return fail('REFUSED_BAD_ARGS', 'cite_key must be lower-case letters, digits and single hyphens (1-60 characters)');
    }
    const fileSlug = kind === 'source' ? citeKey : given !== undefined && given !== null && given !== '' ? given : slugify(title);
    if (typeof fileSlug !== 'string' || !SLUG_RE.test(fileSlug) || fileSlug.length > 60) {
      return fail('REFUSED_BAD_ARGS', given ? 'slug must be lower-case letters, digits and single hyphens (1-60 characters)' : 'the title has no letters or digits to make a file name from; give a slug');
    }
    const strings = (v, max) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.trim() !== '' && isText(x) && x.length <= 300);
    if (!strings(tags, 100)) return fail('REFUSED_BAD_ARGS', 'tags must be a list of up to 100 non-empty strings');
    if (!strings(links, 200) || !strings(sources, 200)) return fail('REFUSED_BAD_ARGS', 'links and sources must be lists of non-empty strings');
    if (typeof canon !== 'boolean') return fail('REFUSED_BAD_ARGS', 'canon must be true or false');
    const extra = [];
    if (kind === 'source') {
      for (const f of SOURCE_FIELDS) {
        const v = args[f];
        if (v === undefined || v === null || v === '') continue;
        if (!isText(v) || String(v).length > 500) return fail('REFUSED_BAD_ARGS', `${f} must be text without control characters (max 500)`);
        extra.push(`${f}: ${quote(String(v))}`);
      }
    }
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    if (kind === 'source' && docs.some((d) => d.kind === 'source' && d.fm.cite_key === citeKey)) return fail('CITE_KEY_TAKEN', `the cite key "${citeKey}" is used by another source`, { cite_key: citeKey });
    const miss = unknownLinks(docs, { links, sources });
    if (miss) return miss;

    const id = `note_${ulid()}`;
    const to = kind === 'research' ? `research/${fileSlug}.md` : kind === 'doc' ? `planning/${fileSlug}.md` : `research/sources/${fileSlug}.md`;
    let head;
    if (kind === 'research') {
      head = `schema: storyforge.research/v1\nid: ${id}\ntitle: ${formatYamlText(title)}\n${flowList('tags', tags)[0]}\ncanon: ${canon}\n${flowList('sources', sources)[0]}\n${flowList('links', links)[0]}\n`;
    } else if (kind === 'doc') {
      head = `schema: storyforge.doc/v1\nid: ${id}\ntitle: ${formatYamlText(title)}\nlocked: false\n`;
    } else {
      head = `schema: storyforge.source/v1\nid: ${id}\ncite_key: ${formatYamlText(citeKey)}\ntitle: ${formatYamlText(title)}\n${extra.map((l) => `${l}\n`).join('')}`;
    }
    const changes = [{ from: null, to, content: Buffer.from(`---\n${head}---\n`, 'utf8'), before: null }];
    return finish({ bookRoot, store, lb, op: 'createNote', args: { kind, title, file: to }, changes, dryRun, withDiff: true, extra: { id, kind, path: to, ...(kind === 'source' ? { cite_key: citeKey } : {}) } });
  });
}

/** Refuse a link or source the book does not have: null when all exist. */
function unknownLinks(docs, { links = [], sources = [] }) {
  const named = docs.filter((d) => ['entry', 'thread', 'event'].includes(d.kind) && !d.archived);
  const missing = links.find((l) => !named.some((d) => d.fm.slug === l || d.fm.id === l || (Array.isArray(d.fm.previous_slugs) && d.fm.previous_slugs.includes(l))));
  if (missing) return fail('REFUSED_UNKNOWN_LINK', `no entry, thread or event ${missing}`, { link: missing });
  const cites = new Set(docs.filter((d) => d.kind === 'source' && !d.archived).map((d) => d.fm.cite_key));
  const noSource = sources.find((s) => !cites.has(s));
  return noSource ? fail('REFUSED_UNKNOWN_SOURCE', `no source with the cite key ${noSource}`, { source: noSource }) : null;
}

// ------------------------------------------------------------------ setNoteFields

/**
 * Edit a note's front matter by its id. research: `title`, `canon` (true / false), `tags`, `sources` (cite keys), `links` (entry, thread or event slugs or ids);
 * doc: `title`, `locked`; source: `title` and the text fields (type, author, year, publisher, url, accessed, locator; '' removes nothing, it empties the line).
 * Scalars are their own line, a list is that key's block (a key the file lacks is inserted after the previous one). A block with a comment, anchor or tag:
 * REFUSED_UNSIMPLE_FIELD. A link or source that is not in the book (and was not already in the file): REFUSED_UNKNOWN_LINK / REFUSED_UNKNOWN_SOURCE.
 * @param {string} bookRoot @param {string} id note id
 * @param {Record<string, any>} args
 */
export function setNoteFields(bookRoot, id, args = {}) {
  return guarded(async () => {
    const { title, canon, locked, tags, sources, links, dryRun = false, baseSha256 } = args ?? {};
    if (typeof id !== 'string' || id === '') return fail('REFUSED_BAD_ARGS', 'the note must be an id');
    const sourceEdits = Object.fromEntries(SOURCE_FIELDS.filter((f) => args?.[f] !== undefined).map((f) => [f, args[f]]));
    if ([title, canon, locked, tags, sources, links].every((v) => v === undefined) && Object.keys(sourceEdits).length === 0) return fail('REFUSED_BAD_ARGS', 'nothing to change');
    if (title !== undefined && (!isText(title) || title.trim() === '' || title.length > 300)) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters (max 300)');
    for (const [name, v] of [['canon', canon], ['locked', locked]]) if (v !== undefined && typeof v !== 'boolean') return fail('REFUSED_BAD_ARGS', `${name} must be true or false`);
    const strings = (v, max) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.trim() !== '' && isText(x) && x.length <= 300);
    if (tags !== undefined && !strings(tags, 100)) return fail('REFUSED_BAD_ARGS', 'tags must be a list of up to 100 non-empty strings');
    for (const [name, v] of [['sources', sources], ['links', links]]) if (v !== undefined && !strings(v, 200)) return fail('REFUSED_BAD_ARGS', `${name} must be a list of non-empty strings`);
    for (const [f, v] of Object.entries(sourceEdits)) if (!isText(v) || String(v).length > 500) return fail('REFUSED_BAD_ARGS', `${f} must be text without control characters (max 500)`);

    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findNote(docs, id, false);
    if (!doc) return fail('REFUSED_UNKNOWN_NOTE', `no note ${id}`);
    const allowed = { research: ['title', 'canon', 'tags', 'sources', 'links'], doc: ['title', 'locked'], source: ['title', ...SOURCE_FIELDS] };
    const given = Object.entries({ title, canon, locked, tags, sources, links, ...sourceEdits }).filter(([, v]) => v !== undefined).map(([k]) => k);
    const wrong = given.find((k) => !allowed[doc.kind].includes(k));
    if (wrong) return fail('REFUSED_BAD_ARGS', `a ${doc.kind} has no ${wrong}`);
    const had = (key) => (Array.isArray(doc.fm[key]) ? doc.fm[key] : []);
    const miss = unknownLinks(docs, {
      links: (links ?? []).filter((l) => !had('links').includes(l)),
      sources: (sources ?? []).filter((s) => !had('sources').includes(s)),
    });
    if (miss) return miss;

    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    let buf = before;
    const has = (key) => new RegExp(`^${key}:`, 'm').test(frontOf(buf));
    const scalar = (key, value, opts) => {
      if (value === undefined) return null;
      if (value === '' && SOURCE_FIELDS.includes(key) && !has(key)) return null;
      const r = editFrontMatterLine(buf, key, value, opts);
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: r.field });
      buf = r.buf;
      return null;
    };
    const block = (key, newLines, after) => {
      const r = replaceFrontMatterBlock(buf, key, newLines, { after });
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: key });
      buf = r.buf;
      return null;
    };
    const bad = scalar('title', title, { anchors: doc.kind === 'source' ? ['cite_key', 'id'] : ['id'], plain: true });
    if (bad) return bad;
    if (canon !== undefined) {
      const b = block('canon', [`canon: ${canon}`], ['tags', 'title']);
      if (b) return b;
    }
    if (locked !== undefined) {
      const b = block('locked', [`locked: ${locked}`], ['title']);
      if (b) return b;
    }
    const after = { tags: ['title'], sources: ['canon', 'tags', 'title'], links: ['sources', 'canon', 'tags', 'title'] };
    for (const [key, list] of [['tags', tags], ['sources', sources], ['links', links]]) {
      if (list === undefined) continue;
      const uniq = list.filter((x, i) => list.indexOf(x) === i);
      if (uniq.length === 0 && !has(key)) continue;
      const b = block(key, flowList(key, uniq), after[key]);
      if (b) return b;
    }
    let prev = ['title'];
    for (const f of SOURCE_FIELDS) {
      if (sourceEdits[f] !== undefined && !(sourceEdits[f] === '' && !has(f))) {
        const b = block(f, [`${f}: ${quote(String(sourceEdits[f]))}`], [...prev].reverse().concat(['title']));
        if (b) return b;
      }
      if (has(f)) prev = [...prev, f];
    }
    const changes = buf.equals(before) ? [] : [{ from: doc.rel, to: doc.rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'setNoteFields', args: { id, fields: given }, changes, dryRun, withDiff: true, extra: { id: doc.fm.id, path: doc.rel } });
  });
}

// ------------------------------------------------------------------ archive / restore

/**
 * Move a note, doc or source to archive/ (never deleted).
 * @param {string} bookRoot @param {string} id @param {{ dryRun?: boolean, baseSha256?: string }} args
 */
export function archiveNote(bookRoot, id, args = {}) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (typeof id !== 'string' || id === '') return fail('REFUSED_BAD_ARGS', 'the note must be an id');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findNote(docs, id, false);
    if (!doc) return fail('REFUSED_UNKNOWN_NOTE', `no note ${id}`);
    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    return finish({ bookRoot, store, lb, op: 'archiveNote', args: { id }, changes: [{ from: doc.rel, to: `archive/${doc.rel}`, content: before, before }], dryRun, withDiff: true, extra: { id: doc.fm.id, path: `archive/${doc.rel}` } });
  });
}

/**
 * Move an archived note back to where it came from. A file already there: REFUSED_PATH_TAKEN. A cite key a live source has now: CITE_KEY_TAKEN.
 * @param {string} bookRoot @param {string} id @param {{ dryRun?: boolean, baseSha256?: string }} args
 */
export function restoreNote(bookRoot, id, args = {}) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (typeof id !== 'string' || id === '') return fail('REFUSED_BAD_ARGS', 'the note must be an id');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findNote(docs, id, true);
    if (!doc) return fail('REFUSED_UNKNOWN_NOTE', `no archived note ${id}`);
    if (doc.kind === 'source' && docs.some((d) => d !== doc && d.kind === 'source' && !d.archived && d.fm.cite_key === doc.fm.cite_key)) {
      return fail('CITE_KEY_TAKEN', `the cite key "${doc.fm.cite_key}" is used by another source now`, { cite_key: doc.fm.cite_key });
    }
    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    return finish({ bookRoot, store, lb, op: 'restoreNote', args: { id }, changes: [{ from: doc.rel, to: doc.rel.slice('archive/'.length), content: before, before }], dryRun, withDiff: true, extra: { id: doc.fm.id, path: doc.rel.slice('archive/'.length) } });
  });
}

// ------------------------------------------------------------------ attachments

/** Extensions an attachment may have, with the type they are served as and whether the browser may show them inline. */
export const ATTACHMENT_TYPES = {
  '.png': { type: 'image/png', inline: true },
  '.jpg': { type: 'image/jpeg', inline: true },
  '.jpeg': { type: 'image/jpeg', inline: true },
  '.webp': { type: 'image/webp', inline: true },
  '.gif': { type: 'image/gif', inline: true },
  '.pdf': { type: 'application/pdf', inline: false },
  '.txt': { type: 'text/plain; charset=utf-8', inline: false },
  '.md': { type: 'text/plain; charset=utf-8', inline: false },
  '.csv': { type: 'text/csv; charset=utf-8', inline: false },
};
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_DIR = 'assets/research';
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/**
 * The stored name for an uploaded file name: only the last path segment, lower-case, anything outside `[a-z0-9._-]` becomes a hyphen, no leading dot or hyphen,
 * at most 80 characters, and an allowed extension. Returns { name } or { code: 'BAD_NAME' | 'UNSUPPORTED_TYPE', message }.
 * @param {unknown} original
 */
export function safeAttachmentName(original) {
  if (typeof original !== 'string' || original.includes('\0') || original.trim() === '') return { code: 'BAD_NAME', message: 'the file needs a name' };
  const last = original.split(/[\\/]/).pop() ?? '';
  const lower = last.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot) : '';
  if (!Object.hasOwn(ATTACHMENT_TYPES, ext)) return { code: 'UNSUPPORTED_TYPE', message: `files of this type cannot be attached (allowed: ${Object.keys(ATTACHMENT_TYPES).map((e) => e.slice(1)).join(', ')})` };
  let stem = lower.slice(0, dot).replace(/[^a-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  if (stem === '' || WINDOWS_RESERVED.test(stem.split('.')[0])) stem = `file${stem === '' ? '' : `-${stem}`}`;
  stem = stem.slice(0, 80 - ext.length).replace(/[.-]+$/g, '') || 'file';
  return { name: `${stem}${ext}` };
}

/** The Markdown link to insert in a note at `notePath` (book-relative) for the stored file `rel` (book-relative). @param {string} notePath @param {string} rel @param {string} label */
export function attachmentMarkdown(notePath, rel, label) {
  const from = path.posix.dirname(notePath);
  const href = path.posix.relative(from === '.' ? '' : from, rel) || path.posix.basename(rel);
  const text = label.replace(/[[\]\\]/g, '');
  const image = ATTACHMENT_TYPES[path.posix.extname(rel)]?.inline === true;
  return `${image ? '!' : ''}[${text}](${href.split('/').map(encodeURIComponent).join('/')})`;
}

/**
 * Store an uploaded file as assets/research/<safe-name> through the store (no overwrite: a taken name gets -2, -3, ...). The bytes are limited to 25 MB.
 * `notePath` (book-relative, default research/x.md) decides what the returned `markdown` link is relative to.
 * @param {string} bookRoot @param {{ name: string, bytes: Buffer, notePath?: string }} args
 * @returns {Promise<{ ok: true, code: 'OK', changes: object[], path: string, name: string, markdown: string } | { ok: false, code: string, message: string, changes: [] }>}
 */
export function uploadAttachment(bookRoot, args = {}) {
  return guarded(async () => {
    const { name, bytes, notePath = 'research/note.md' } = args ?? {};
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return fail('BAD_ARGS', 'the file is empty');
    if (bytes.length > MAX_ATTACHMENT_BYTES) return fail('TOO_LARGE', 'attachments can be at most 25 MB');
    const safe = safeAttachmentName(name);
    if (!safe.name) return fail(safe.code, safe.message);
    if (typeof notePath !== 'string' || !/^[0-9A-Za-z._/-]+\.md$/.test(notePath) || notePath.split('/').some((s) => s === '' || s === '.' || s === '..')) return fail('BAD_ARGS', 'note must be a book-relative .md path');
    const store = await openStore(path.resolve(bookRoot));
    const ext = path.posix.extname(safe.name);
    const stem = safe.name.slice(0, safe.name.length - ext.length);
    for (let n = 1; n < 1000; n++) {
      const stored = n === 1 ? safe.name : `${stem.slice(0, 80 - ext.length - String(n).length - 1)}-${n}${ext}`;
      const rel = `${ATTACHMENT_DIR}/${stored}`;
      if (await store.exists(rel)) continue;
      const r = await store.create(rel, bytes);
      if (r.ok) {
        return {
          ok: true,
          code: 'OK',
          changes: [{ from: null, to: rel, before_sha256: null, after_sha256: r.sha256 }],
          path: rel,
          name: stored,
          markdown: attachmentMarkdown(notePath, rel, String(name).split(/[\\/]/).pop() || stored),
          opId: r.opId,
        };
      }
      if (r.code !== 'EXISTS') return fail(r.code === 'OUTSIDE_ROOT' ? 'BAD_ARGS' : r.code, r.message ?? 'the file could not be stored');
    }
    return fail('REFUSED_PATH_TAKEN', 'too many files with that name');
  });
}
