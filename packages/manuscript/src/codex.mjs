// Codex commands (M04-J02): new entry, entry fields, change slug, archive / restore, new type. Every one has a dry run,
// goes through the store (one batch, one opId), is refused when it would add a validation error, and never deletes.
// Front matter is edited by lines: a scalar line through editFrontMatterLine, a list / map key by replacing only that
// key's own lines. YAML is never re-serialised.
import { extractDocs, extractLinks, validate } from '@storyforge/format';
import path from 'node:path';
import { openStore } from '@storyforge/store';
import { editFrontMatterLine, formatYamlText, frontMatterRange } from './frontmatter.mjs';
import { fail, finish, guarded, readBytes } from './ops.mjs';
import { sha256, SLUG_RE, slugify, ulid } from './util.mjs';

export const ENTRY_STATUSES = ['seed', 'sketch', 'canon'];
const BUILTIN_FOLDERS = { character: 'characters', location: 'locations', faction: 'factions', object: 'objects', lore: 'lore' };
const TYPE_RE = /^[a-z]+$/;
const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const isText = (v) => typeof v === 'string' && !CONTROL_RE.test(v);
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']);
/** UTF-8 text as the latin1 string form used for byte-exact splicing. */
const l1 = (t) => Buffer.from(t, 'utf8').toString('latin1');

/** The folder under codex/ for a type: the built-in folder, else "<type>s". @param {string} type */
export const entryFolder = (type) => BUILTIN_FOLDERS[type] ?? `${type}s`;

// ------------------------------------------------------------------ YAML text for the blocks we write

/** A field label as a YAML key: plain when it is a simple phrase, else double-quoted. */
function formatKey(label) {
  if (/^[A-Za-z][A-Za-z0-9 _-]*$/.test(label) && label === label.trim() && !RESERVED.has(label.toLowerCase())) return label;
  return `"${label.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** A scalar field value: a number or boolean plain, a string through formatYamlText. Null for an unwritable value. */
function formatScalar(v) {
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isFinite(v) && /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : null;
  if (typeof v === 'string' && isText(v)) return v === '' ? '""' : formatYamlText(v);
  return null;
}

const flowList = (key, items) => [`${key}: [${items.map((i) => formatYamlText(i, { flow: true })).join(', ')}]`];

/** Lines of `fields:` for [{ label, value }]. */
const fieldsLines = (pairs) => (pairs.length === 0 ? ['fields: {}'] : ['fields:', ...pairs.map((p) => `  ${formatKey(p.label)}: ${formatScalar(p.value)}`)]);

/** Lines of `related:` for [{ to, as? }]. */
function relatedLines(items) {
  if (items.length === 0) return ['related: []'];
  const out = ['related:'];
  for (const r of items) {
    out.push(`  - to: ${formatYamlText(r.to)}`);
    if (r.as !== undefined && r.as !== '') out.push(`    as: ${formatYamlText(r.as)}`);
  }
  return out;
}

// ------------------------------------------------------------------ block replacement

/** Lines of a latin1 region as { start, end, text, eol }. */
function splitRegion(region) {
  const out = [];
  let pos = 0;
  while (pos < region.length) {
    const nl = region.indexOf('\n', pos);
    const end = nl < 0 ? region.length : nl + 1;
    const raw = region.slice(pos, end);
    const eol = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    out.push({ start: pos, end, text: raw.slice(0, raw.length - eol.length), eol });
    pos = end;
  }
  return out;
}

const isContinuation = (text) => text === '' || /^[ \t]/.test(text) || text === '-' || text.startsWith('- ');
const withoutQuoted = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^']|'')*'/g, "''");

/**
 * Replace (or insert) the whole block of one top-level key with `newLines` (text lines, no terminators). Only that key's own
 * lines change. A block with a comment, anchor, alias, tag or block scalar is refused: REFUSED_UNSIMPLE_FIELD.
 * Absent key: inserted after the block of the first existing `after` key, else at the end of the front matter.
 * @param {Buffer} bytes @param {string} key @param {string[]} newLines @param {{ after?: string[] }} [opts]
 * @returns {{ ok: true, buf: Buffer, changed: boolean } | { ok: false, code: string, field: string, message: string }}
 */
export function replaceFrontMatterBlock(bytes, key, newLines, { after = [] } = {}) {
  const refuse = (message) => ({ ok: false, code: 'REFUSED_UNSIMPLE_FIELD', field: key, message });
  const s = bytes.toString('latin1');
  const range = frontMatterRange(s);
  if (!range) return refuse('the file has no closed front matter');
  const region = s.slice(range.start, range.end);
  const lines = splitRegion(region);
  const eol = region.includes('\r\n') ? '\r\n' : '\n';
  const blockEnd = (i) => {
    let j = i + 1;
    while (j < lines.length && isContinuation(lines[j].text)) j++;
    while (j > i + 1 && lines[j - 1].text.trim() === '') j--;
    return j;
  };
  const text = newLines.map((l) => `${l1(l)}${eol}`).join('');
  const rebuild = (nextRegion) => {
    const out = Buffer.from(s.slice(0, range.start) + nextRegion + s.slice(range.end), 'latin1');
    return { ok: true, buf: out, changed: !out.equals(bytes) };
  };

  const hits = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.text.startsWith(`${key}:`));
  if (hits.length > 1) return refuse(`"${key}" appears more than once`);
  if (hits.length === 1) {
    const i = hits[0].i;
    const j = blockEnd(i);
    const rest = lines[i].text.slice(key.length + 1).trim();
    if (/^[|>&*!]/.test(rest)) return refuse(`"${key}" uses a block scalar, anchor, alias or tag`);
    for (let k = i; k < j; k++) {
      const plain = withoutQuoted(lines[k].text);
      if (/(^|[ \t])#/.test(plain) || /(^|[\s[{,])[&*!]/.test(plain.replace(`${key}:`, ''))) {
        return refuse(`"${key}" has a comment, anchor, alias or tag; edit it in your own editor`);
      }
    }
    const from = lines[i].start;
    const to = lines[j - 1].end;
    const lastHadEol = lines[j - 1].eol !== '';
    return rebuild(region.slice(0, from) + (lastHadEol ? text : text.replace(/(\r?\n)$/, '')) + region.slice(to));
  }
  for (const a of after) {
    const at = lines.findIndex((l) => l.text.startsWith(`${a}:`));
    if (at < 0) continue;
    const j = blockEnd(at);
    const end = lines[j - 1].end;
    const lead = lines[j - 1].eol === '' ? eol : '';
    return rebuild(region.slice(0, end) + lead + text + region.slice(end));
  }
  const lead = region === '' || region.endsWith('\n') ? '' : eol;
  return rebuild(region + lead + text);
}

// ------------------------------------------------------------------ shared

/** Open the store, validate the book. Codex commands do not need a clean manuscript: the post-write check refuses *new* errors. */
async function prepareCodex(bookRoot) {
  if (typeof bookRoot !== 'string' || bookRoot === '') return { result: fail('REFUSED_NOT_A_BOOK', 'bookRoot must be a path') };
  const root = path.resolve(bookRoot);
  const store = await openStore(root);
  const result = await validate(root);
  if (result.books.length !== 1 || result.books[0].path !== '') return { result: fail('REFUSED_NOT_A_BOOK', `${bookRoot} is not a single book root (book.md missing)`) };
  const lb = { root, diagnostics: result.diagnostics, book: result.books[0] };
  return { lb, store, docs: extractDocs(result, ''), links: extractLinks(result, '') };
}

/** The live (or archived) entry document for an id or slug. */
const findEntry = (docs, ref, archived) => docs.find((d) => d.kind === 'entry' && d.archived === archived && (d.fm.id === ref || d.fm.slug === ref || (archived && d.rel === ref))) ?? null;
/** The author saw another version of the file than the one on disk: nothing is written. */
const stale = (before, baseSha256, rel) => (typeof baseSha256 === 'string' && sha256(before) !== baseSha256 ? fail('CONFLICT', `${rel} changed on disk since it was read`, { file: rel }) : null);
/** Is this slug used by a live entry, thread or event (other than `except`)? */
const slugTaken = (docs, slug, except) => docs.some((d) => !d.archived && d !== except && ['entry', 'thread', 'event'].includes(d.kind) && d.fm.slug === slug);

/** Fields as [{ label, value }] from an object or an ordered array of { label, value }; or an error string. */
function normaliseFields(fields) {
  /** @type {{ label: string, value: any }[]} */
  let pairs;
  if (Array.isArray(fields)) {
    if (fields.some((f) => !isMap(f) || typeof f.label !== 'string')) return 'fields must be an object, or a list of { label, value }';
    pairs = fields.map((f) => ({ label: f.label, value: f.value }));
  } else if (isMap(fields)) pairs = Object.entries(fields).map(([label, value]) => ({ label, value }));
  else return 'fields must be an object, or a list of { label, value }';
  if (pairs.length > 200) return 'too many fields (max 200)';
  const seen = new Set();
  for (const p of pairs) {
    if (!isText(p.label) || p.label.trim() === '' || p.label.length > 100) return 'a field label must be 1 to 100 characters without control characters';
    if (seen.has(p.label)) return `the field label "${p.label}" is used twice`;
    seen.add(p.label);
    if (formatScalar(p.value) === null) return `the value of "${p.label}" must be text, a number or true / false`;
  }
  return pairs;
}

/**
 * An entry file the validator cannot read (E100 / E101: an anchor, a tag, broken YAML) is not in the document list. Is there one with this
 * id or slug under codex/? Then the edit is refused as REFUSED_UNSIMPLE_FIELD instead of "no such entry".
 */
async function unreadableEntry(store, ref) {
  const escaped = ref.replace(/[^A-Za-z0-9_-]/g, (ch) => `\${ch}`);
  const wanted = new RegExp(`^(id|slug):[ \t]*["']?${escaped}["']?[ \t]*\r?$`, 'm');
  const walk = async (dir, depth) => {
    for (const e of await store.list(dir)) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory && depth < 3 && !e.name.startsWith('.')) {
        const hit = await walk(rel, depth + 1);
        if (hit) return hit;
      } else if (!e.isDirectory && e.name.endsWith('.md')) {
        const r = await store.read(rel);
        const s = r ? r.bytes.toString('latin1') : '';
        const range = r ? frontMatterRange(s) : null;
        if (range && wanted.test(s.slice(range.start, range.end))) return rel;
      }
    }
    return null;
  };
  return walk('codex', 0);
}

const notUsable = (rel) => fail('REFUSED_UNSIMPLE_FIELD', `${rel}: its front matter cannot be read as plain YAML (a comment, anchor, tag or syntax problem); fix the file in your own editor first`, { file: rel });

// ------------------------------------------------------------------ createEntry

/**
 * New entry file codex/<folder>/<slug>.md: schema, id, slug, type, name, status, fields (the type's default labels with empty
 * values, overridden by `fields`), body "## Overview". A slug used by another entry, thread or event: SLUG_TAKEN.
 * @param {string} bookRoot
 * @param {{ type: string, name: string, slug?: string, status?: string, fields?: Record<string, any> | { label: string, value: any }[], dryRun?: boolean }} args
 */
export function createEntry(bookRoot, args = {}) {
  return guarded(async () => {
    const { type, name, slug: given, status = 'seed', fields, dryRun = false } = args ?? {};
    if (typeof type !== 'string' || !TYPE_RE.test(type) || type.length > 40) return fail('REFUSED_BAD_ARGS', 'type must be a lower-case word (a-z)');
    if (!isText(name) || name.trim() === '' || name.length > 300) return fail('REFUSED_BAD_ARGS', 'name must be a non-empty string without control characters (max 300)');
    if (!ENTRY_STATUSES.includes(status)) return fail('REFUSED_BAD_ARGS', `status must be one of ${ENTRY_STATUSES.join(', ')}`);
    const slug = given !== undefined && given !== null && given !== '' ? given : slugify(name);
    if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 60) {
      return fail('REFUSED_BAD_ARGS', given ? 'slug must be lower-case letters, digits and single hyphens (1-60 characters)' : 'the name has no letters or digits to make a slug from; give a slug');
    }
    let override = [];
    if (fields !== undefined && fields !== null) {
      const n = normaliseFields(fields);
      if (typeof n === 'string') return fail('REFUSED_BAD_ARGS', n);
      override = n;
    }
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    if (slugTaken(docs, slug)) return fail('SLUG_TAKEN', `the slug "${slug}" is already used by another entry, thread or event`, { slug });

    const def = docs.find((d) => d.kind === 'codex-type' && !d.archived && d.fm.type === type);
    const defaults = Array.isArray(def?.fm.fields) ? def.fm.fields.filter((f) => typeof f === 'string' && f.trim() !== '' && isText(f)) : [];
    const merged = new Map(defaults.map((label) => [label, '']));
    for (const p of override) merged.set(p.label, p.value);
    const pairs = [...merged].map(([label, value]) => ({ label, value }));

    const id = `entry_${ulid()}`;
    const to = `codex/${entryFolder(type)}/${slug}.md`;
    const text =
      `---\nschema: storyforge.entry/v1\nid: ${id}\nslug: ${formatYamlText(slug)}\ntype: ${type}\nname: ${formatYamlText(name)}\nstatus: ${status}\n` +
      `${pairs.length > 0 ? `${fieldsLines(pairs).join('\n')}\n` : ''}---\n## Overview\n\n`;
    const changes = [{ from: null, to, content: Buffer.from(text, 'utf8'), before: null }];
    return finish({ bookRoot, store, lb, op: 'createEntry', args: { type, name, slug, status }, changes, dryRun, withDiff: true, extra: { id, slug, type, path: to } });
  });
}

// ------------------------------------------------------------------ setEntryFields

/**
 * Edit an entry's front matter. `name`, `status`, `role`: their own line. `aliases` (flow list), `fields` (block map) and `related`
 * (block list of { to, as }): that key's block is replaced, nothing else. A block with a comment, anchor or tag: REFUSED_UNSIMPLE_FIELD.
 * `slug` is never touched here (see changeEntrySlug).
 * @param {string} bookRoot @param {string} ref entry id or slug
 * @param {{ name?: string, status?: string, role?: string, aliases?: string[], fields?: Record<string, any> | { label: string, value: any }[], related?: { to: string, as?: string }[], dryRun?: boolean }} args
 */
export function setEntryFields(bookRoot, ref, args = {}) {
  return guarded(async () => {
    const { name, status, role, aliases, fields, related, dryRun = false, baseSha256 } = args ?? {};
    if (typeof ref !== 'string' || ref === '') return fail('REFUSED_BAD_ARGS', 'the entry must be an id or slug');
    if ([name, status, role, aliases, fields, related].every((v) => v === undefined)) return fail('REFUSED_BAD_ARGS', 'nothing to change');
    if (name !== undefined && (!isText(name) || name.trim() === '' || name.length > 300)) return fail('REFUSED_BAD_ARGS', 'name must be a non-empty string without control characters (max 300)');
    if (status !== undefined && !ENTRY_STATUSES.includes(status)) return fail('REFUSED_BAD_ARGS', `status must be one of ${ENTRY_STATUSES.join(', ')}`);
    if (role !== undefined && (!isText(role) || role.length > 300)) return fail('REFUSED_BAD_ARGS', 'role must be a string without control characters (max 300)');
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.length > 100 || aliases.some((a) => !isText(a) || a.trim() === '' || a.length > 300))) {
      return fail('REFUSED_BAD_ARGS', 'aliases must be a list of up to 100 non-empty strings without control characters');
    }
    let pairs;
    if (fields !== undefined) {
      const n = normaliseFields(fields);
      if (typeof n === 'string') return fail('REFUSED_BAD_ARGS', n);
      pairs = n;
    }
    if (related !== undefined) {
      const ok = Array.isArray(related) && related.length <= 200 && related.every((r) => isMap(r) && typeof r.to === 'string' && SLUG_RE.test(r.to) && r.to.length <= 60 && (r.as === undefined || (isText(r.as) && r.as.length <= 300)));
      if (!ok) return fail('REFUSED_BAD_ARGS', 'related must be a list of { to: slug, as?: text }');
    }
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findEntry(docs, ref, false);
    if (!doc) {
      const raw = await unreadableEntry(store, ref);
      return raw ? notUsable(raw) : fail('REFUSED_UNKNOWN_ENTRY', `no entry ${ref}`);
    }

    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    let buf = before;
    const line = (key, value, anchors) => {
      if (value === undefined) return null;
      if (key === 'role' && value === '' && !/^role:/m.test(frontOf(buf))) return null;
      const r = editFrontMatterLine(buf, key, value, { anchors, plain: true });
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: r.field });
      buf = r.buf;
      return null;
    };
    for (const bad of [line('name', name, ['slug', 'type']), line('status', status, ['name']), line('role', role, ['status', 'name'])]) if (bad) return bad;

    const block = (key, newLines, after) => {
      const r = replaceFrontMatterBlock(buf, key, newLines, { after });
      if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: key });
      buf = r.buf;
      return null;
    };
    const has = (key) => new RegExp(`^${key}:`, 'm').test(frontOf(buf));
    // an empty list for a key the file does not have changes nothing
    if (aliases !== undefined && (aliases.length > 0 || has('aliases'))) {
      const bad = block('aliases', flowList('aliases', aliases), ['name']);
      if (bad) return bad;
    }
    if (pairs !== undefined && (pairs.length > 0 || has('fields'))) {
      const bad = block('fields', fieldsLines(pairs), []);
      if (bad) return bad;
    }
    if (related !== undefined && (related.length > 0 || has('related'))) {
      const bad = block('related', relatedLines(related), []);
      if (bad) return bad;
    }
    const changes = buf.equals(before) ? [] : [{ from: doc.rel, to: doc.rel, content: buf, before }];
    return finish({ bookRoot, store, lb, op: 'setEntryFields', args: { ref, name, status, role, aliases: aliases?.length, fields: pairs?.length, related: related?.length }, changes, dryRun, withDiff: true, extra: { id: doc.fm.id, path: doc.rel } });
  });
}

/** The front-matter interior of a document, latin1. */
function frontOf(buf) {
  const s = buf.toString('latin1');
  const range = frontMatterRange(s);
  return range ? s.slice(range.start, range.end) : '';
}

// ------------------------------------------------------------------ changeEntrySlug

/**
 * New slug for an entry; the old one goes into `previous_slugs` so old links still resolve (W301 tells where they remain). Nothing else changes.
 * @param {string} bookRoot @param {string} ref @param {{ slug: string, dryRun?: boolean }} args
 */
export function changeEntrySlug(bookRoot, ref, args = {}) {
  return guarded(async () => {
    const { slug, dryRun = false, baseSha256 } = args ?? {};
    if (typeof ref !== 'string' || ref === '') return fail('REFUSED_BAD_ARGS', 'the entry must be an id or slug');
    if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 60) return fail('REFUSED_BAD_ARGS', 'slug must be lower-case letters, digits and single hyphens (1-60 characters)');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findEntry(docs, ref, false);
    if (!doc) {
      const raw = await unreadableEntry(store, ref);
      return raw ? notUsable(raw) : fail('REFUSED_UNKNOWN_ENTRY', `no entry ${ref}`);
    }
    const old = doc.fm.slug;
    if (typeof old !== 'string') return fail('REFUSED_BAD_ARGS', 'the entry has no slug');
    if (slug === old) return fail('REFUSED_BAD_ARGS', 'the slug is unchanged');
    if (slugTaken(docs, slug, doc)) return fail('SLUG_TAKEN', `the slug "${slug}" is already used by another entry, thread or event`, { slug });

    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    const edit = editFrontMatterLine(before, 'slug', slug, { plain: true });
    if (!edit.ok) return fail(edit.code, `${doc.rel}: ${edit.message}`, { file: doc.rel, field: edit.field });
    const previous = [...(Array.isArray(doc.fm.previous_slugs) ? doc.fm.previous_slugs.filter((p) => typeof p === 'string') : []).filter((p) => p !== slug), old].filter((p, i, a) => a.indexOf(p) === i);
    const r = replaceFrontMatterBlock(edit.buf, 'previous_slugs', flowList('previous_slugs', previous), { after: ['slug'] });
    if (!r.ok) return fail(r.code, `${doc.rel}: ${r.message}`, { file: doc.rel, field: 'previous_slugs' });
    return finish({
      bookRoot,
      store,
      lb,
      op: 'changeEntrySlug',
      args: { ref, slug },
      changes: [{ from: doc.rel, to: doc.rel, content: r.buf, before }],
      dryRun,
      withDiff: true,
      extra: { id: doc.fm.id, slug, previous_slug: old, path: doc.rel },
    });
  });
}

// ------------------------------------------------------------------ archive / restore

/** Every scene / entry that links to the entry: [{ id, kind, name, path, location }]. */
function linkSources(docs, links, id) {
  const seen = new Set();
  const out = [];
  for (const l of links) {
    if (l.target_id !== id || l.src_id === id) continue;
    const key = `${l.src_path}\0${l.location}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const src = docs.find((d) => d.fm.id === l.src_id);
    out.push({ id: l.src_id, kind: src?.kind ?? null, name: src ? (src.fm.title ?? src.fm.name ?? null) : null, path: l.src_path, location: l.location });
  }
  return out;
}

/**
 * Move an entry to archive/ (never deleted). The result lists everything that links to it (`linked_from`): those links will show W303.
 * @param {string} bookRoot @param {string} ref @param {{ dryRun?: boolean }} args
 */
export function archiveEntry(bookRoot, ref, args = {}) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (typeof ref !== 'string' || ref === '') return fail('REFUSED_BAD_ARGS', 'the entry must be an id or slug');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs, links } = prep;
    const doc = findEntry(docs, ref, false);
    if (!doc) return fail('REFUSED_UNKNOWN_ENTRY', `no entry ${ref}`);
    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    return finish({
      bookRoot,
      store,
      lb,
      op: 'archiveEntry',
      args: { ref },
      changes: [{ from: doc.rel, to: `archive/${doc.rel}`, content: before, before }],
      dryRun,
      withDiff: true,
      extra: { id: doc.fm.id, path: `archive/${doc.rel}`, linked_from: linkSources(docs, links, doc.fm.id) },
    });
  });
}

/**
 * Move an archived entry back to where it came from. A slug now used by a live entry, thread or event: SLUG_TAKEN.
 * @param {string} bookRoot @param {string} ref archived entry id or slug @param {{ dryRun?: boolean }} args
 */
export function restoreEntry(bookRoot, ref, args = {}) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (typeof ref !== 'string' || ref === '') return fail('REFUSED_BAD_ARGS', 'the entry must be an id or slug');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    const doc = findEntry(docs, ref, true);
    if (!doc) return fail('REFUSED_UNKNOWN_ENTRY', `no archived entry ${ref}`);
    if (typeof doc.fm.slug === 'string' && slugTaken(docs, doc.fm.slug, doc)) {
      return fail('SLUG_TAKEN', `the slug "${doc.fm.slug}" is used by another entry, thread or event now; change that one first`, { slug: doc.fm.slug });
    }
    const before = await readBytes(store, doc.rel);
    const changed = stale(before, baseSha256, doc.rel);
    if (changed) return changed;
    return finish({
      bookRoot,
      store,
      lb,
      op: 'restoreEntry',
      args: { ref },
      changes: [{ from: doc.rel, to: doc.rel.slice('archive/'.length), content: before, before }],
      dryRun,
      withDiff: true,
      extra: { id: doc.fm.id, path: doc.rel.slice('archive/'.length) },
    });
  });
}

// ------------------------------------------------------------------ createCodexType

/**
 * New type definition codex/_types/<type>.md (FORMAT-v1 5.1). A type that already has a definition file: TYPE_EXISTS.
 * @param {string} bookRoot @param {{ type: string, name: string, plural?: string, fields?: string[], dryRun?: boolean }} args
 */
export function createCodexType(bookRoot, args = {}) {
  return guarded(async () => {
    const { type, name, plural, fields = [], dryRun = false } = args ?? {};
    if (typeof type !== 'string' || !TYPE_RE.test(type) || type.length > 40) return fail('REFUSED_BAD_ARGS', 'type must be a lower-case word (a-z)');
    if (!isText(name) || name.trim() === '' || name.length > 100) return fail('REFUSED_BAD_ARGS', 'name must be 1 to 100 characters without control characters');
    if (plural !== undefined && (!isText(plural) || plural.trim() === '' || plural.length > 100)) return fail('REFUSED_BAD_ARGS', 'plural must be 1 to 100 characters without control characters');
    if (!Array.isArray(fields) || fields.length > 50 || fields.some((f) => !isText(f) || f.trim() === '' || f.length > 100)) {
      return fail('REFUSED_BAD_ARGS', 'fields must be a list of up to 50 labels (1 to 100 characters)');
    }
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store, docs } = prep;
    if (docs.some((d) => d.kind === 'codex-type' && !d.archived && d.fm.type === type)) return fail('TYPE_EXISTS', `the type "${type}" already has a definition`, { type });
    const to = `codex/_types/${type}.md`;
    const text =
      `---\nschema: storyforge.codex-type/v1\nid: note_${ulid()}\ntype: ${type}\nname: ${formatYamlText(name)}\nplural: ${formatYamlText(plural ?? (type === 'lore' ? name : `${name}s`))}\n` +
      `${fields.length > 0 ? `${flowList('fields', fields).join('\n')}\n` : ''}---\n`;
    return finish({ bookRoot, store, lb, op: 'createCodexType', args: { type, name }, changes: [{ from: null, to, content: Buffer.from(text, 'utf8'), before: null }], dryRun, withDiff: true, extra: { type, path: to } });
  });
}
