#!/usr/bin/env node
// Independent canon resolver (M07-J01 section 8). A deliberately separate second implementation of the link resolution
// rules of FORMAT-v1 1.8 (with the series shared world, step 3a, and the cross-book form), used to check the validator and
// the index against each other. It must NOT import @storyforge/format or the index: only `yaml` and node:fs / node:path.
//
//   node tools/canon-check/resolve.mjs <library-folder>
//
// prints JSON  { owners: { <id>: 'series:<slug>' | 'book:<slug>' }, links: [ { from_id, raw, to_id } ] }
// for every object (scene, entry, thread, event) and every [[link]] and front-matter reference they make.
// `to_id` is null when the reference does not resolve. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const ID_RE = /^(lib|series|book|act|chap|scene|entry|thread|event|note|rcpt)_[0-9A-HJKMNP-TV-Z]{26}$/;
const looksLikeId = (t) => /^(lib|series|book|act|chap|scene|entry|thread|event|note|rcpt)_/.test(t);
const OBJECT_KINDS = new Set(['scene', 'entry', 'thread', 'event']);
const NAMED_KINDS = new Set(['entry', 'thread', 'event']);

/** The front-matter reference fields of each kind: [field, isList]. */
const REFS = {
  scene: [['pov', false], ['characters', true], ['locations', true], ['plot_threads', true], ['events', true], ['variant_of', false]],
  entry: [['first_appearance', false]],
  thread: [['setup', true], ['develop', true], ['payoff', true], ['characters', true]],
  event: [['scenes', true], ['characters', true], ['locations', true]],
};

const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
const has = (d, f) => fs.existsSync(path.join(d, f)) && fs.statSync(path.join(d, f)).isFile();

function markdownBelow(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...markdownBelow(dir, r));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(r);
  }
  return out.sort();
}

/** Front matter and body of one file, or null when it has no front matter. */
function readDoc(abs, rel) {
  const text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  let fm;
  try {
    fm = parse(lines.slice(1, end).join('\n'), { version: '1.2', schema: 'core' });
  } catch {
    return null;
  }
  if (!fm || typeof fm !== 'object' || typeof fm.schema !== 'string') return null;
  const kind = /^storyforge\.([a-z-]+)\/v\d+$/.exec(fm.schema)?.[1] ?? null;
  return { rel, kind, fm, body: lines.slice(end + 1).join('\n'), archived: rel.startsWith('archive/') };
}

/** Every `[[target]]` in prose: not inside fenced code or inline code. The target is what precedes the first `|`. */
function wikiTargets(body) {
  const out = [];
  let fence = null;
  for (const line of body.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    const noCode = line.replace(/(`+)[^`]*?\1/g, ' ');
    for (const w of noCode.matchAll(/\[\[([^\]\n]+?)\]\]/g)) out.push(w[1].split('|')[0].trim());
  }
  return out;
}

/** Walk a library folder into { books, series } with every document loaded. */
function load(root) {
  const books = [];
  const series = [];
  const takeBook = (dir, seriesRef) => {
    const docs = [];
    for (const rel of markdownBelow(dir)) {
      const d = readDoc(path.join(dir, ...rel.split('/')), rel);
      if (d && d.kind) docs.push(d);
    }
    const bookDoc = docs.find((d) => d.rel === 'book.md');
    books.push({ dir, docs, slug: bookDoc?.fm.slug ?? null, series: seriesRef });
  };
  for (const name of dirs(root)) {
    if (name === '_templates') continue;
    const dir = path.join(root, name);
    if (has(dir, 'book.md')) takeBook(dir, null);
    else if (has(dir, 'series.md')) {
      const sdoc = readDoc(path.join(dir, 'series.md'), 'series.md');
      const shared = [];
      for (const sub of ['codex', 'archive']) {
        if (!fs.existsSync(path.join(dir, sub))) continue;
        for (const rel of markdownBelow(dir, sub)) {
          const d = readDoc(path.join(dir, ...rel.split('/')), rel);
          if (d && d.kind) shared.push(d);
        }
      }
      const s = { dir, slug: sdoc?.fm.slug ?? null, shared };
      series.push(s);
      for (const child of dirs(dir)) if (has(path.join(dir, child), 'book.md')) takeBook(path.join(dir, child), s);
    }
  }
  return { books, series };
}

/**
 * Resolve `target` against ordered layers of documents. A document matches by id, by current slug (rank 0) or by previous
 * slug (rank 1). The best match is the one that is live (not archived), then from the earliest layer, then the current slug.
 */
function pick(layers, target, anywhere) {
  if (looksLikeId(target)) {
    for (const layer of layers) {
      const hit = layer.find((d) => d.fm.id === target);
      if (hit) return hit;
    }
    return anywhere ? (anywhere.get(target) ?? null) : null;
  }
  let best = null;
  layers.forEach((layer, li) => {
    for (const d of layer) {
      if (!NAMED_KINDS.has(d.kind)) continue;
      let rank = -1;
      if (d.fm.slug === target) rank = 0;
      else if (Array.isArray(d.fm.previous_slugs) && d.fm.previous_slugs.includes(target)) rank = 1;
      if (rank < 0) continue;
      const score = [d.archived ? 1 : 0, li, rank];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
        best = { d, score };
      }
    }
  });
  return best ? best.d : null;
}

/**
 * @param {string} rootDir a library folder
 * @returns {{ owners: Record<string, string>, links: { from_id: string, raw: string, to_id: string|null }[] }}
 */
export function resolveLibrary(rootDir) {
  const { books, series } = load(path.resolve(rootDir));
  /** @type {Record<string, string>} */
  const owners = {};
  /** @type {Map<string, any>} */
  const anywhere = new Map();
  for (const s of series) {
    for (const d of s.shared) {
      if (d.kind === 'entry' && ID_RE.test(String(d.fm.id))) {
        owners[d.fm.id] = `series:${s.slug}`;
        anywhere.set(d.fm.id, d);
      }
    }
  }
  for (const b of books) {
    for (const d of b.docs) {
      if (OBJECT_KINDS.has(d.kind) && ID_RE.test(String(d.fm.id))) {
        owners[d.fm.id] ??= `book:${b.slug}`;
        if (!anywhere.has(d.fm.id)) anywhere.set(d.fm.id, d);
      }
    }
  }

  const bookBySlug = new Map(books.filter((b) => b.slug).map((b) => [b.slug, b]));
  const seriesBySlug = new Map(series.filter((s) => s.slug).map((s) => [s.slug, s]));
  const layersOfBook = (b) => (b.series ? [b.docs, b.series.shared.filter((d) => d.kind === 'entry')] : [b.docs]);

  const links = [];
  /** @param {any} src the document that links @param {any[][]} home the layers the source sees @param {boolean} fromShared */
  const emit = (src, home, fromShared) => {
    if (!OBJECT_KINDS.has(src.kind) || typeof src.fm.id !== 'string') return;
    const add = (raw, cross) => {
      let hit = null;
      if (cross && raw.includes(':')) {
        const at = raw.indexOf(':');
        const prefix = raw.slice(0, at).trim();
        const rest = raw.slice(at + 1).trim();
        const book = bookBySlug.get(prefix);
        if (book) hit = pick(layersOfBook(book), rest, null);
        else if (seriesBySlug.has(prefix)) hit = pick([seriesBySlug.get(prefix).shared.filter((d) => d.kind === 'entry')], rest, null);
      } else if (!raw.includes(':')) {
        hit = pick(home, raw, fromShared ? anywhere : null);
      }
      links.push({ from_id: src.fm.id, raw, to_id: hit && typeof hit.fm.id === 'string' ? hit.fm.id : null });
    };
    for (const [field, isList] of REFS[src.kind] ?? []) {
      const v = src.fm[field];
      for (const item of isList ? (Array.isArray(v) ? v : []) : v === undefined ? [] : [v]) if (typeof item === 'string' && item.trim() !== '') add(item.trim(), false);
    }
    if (src.kind === 'entry' && Array.isArray(src.fm.related)) {
      for (const r of src.fm.related) if (r && typeof r.to === 'string' && r.to.trim() !== '') add(r.to.trim(), false);
    }
    if (src.kind === 'event' && Array.isArray(src.fm.state)) {
      for (const s of src.fm.state) for (const k of ['slug', 'value']) if (s && typeof s[k] === 'string' && s[k].trim() !== '' && (k === 'slug' || ['holder', 'location'].includes(s.event))) add(s[k].trim(), false);
    }
    if (src.kind === 'entry' && src.fm.fields && typeof src.fm.fields === 'object' && !Array.isArray(src.fm.fields)) {
      for (const v of Object.values(src.fm.fields)) if (typeof v === 'string') for (const t of wikiTargets(`${v}`)) add(t, true);
    }
    for (const t of wikiTargets(src.body)) add(t, true);
  };

  for (const s of series) {
    const home = [s.shared.filter((d) => d.kind === 'entry')];
    for (const d of s.shared) emit(d, home, true);
  }
  for (const b of books) for (const d of b.docs) emit(d, layersOfBook(b), false);

  const sortedOwners = Object.fromEntries(Object.entries(owners).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { owners: sortedOwners, links };
}

const here = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(here)) {
  const root = process.argv[2];
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write('usage: node tools/canon-check/resolve.mjs <library-folder>\n');
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(resolveLibrary(root), null, 2)}\n`);
}
