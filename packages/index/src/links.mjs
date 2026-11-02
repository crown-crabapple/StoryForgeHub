// Link rows for the `links` table. Resolution follows the same rules as @storyforge/format's link
// resolver (spec 1.8) and reuses its field table and patterns; the format package reports problems as
// diagnostics, this records every link and what it resolved to.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  CITE_RE, ID_PREFIX_RE, MDLINK_RE, NAMED, REFERENCES, WIKI_RE, escapesRoot, proseLines,
} from '@storyforge/format';

/** @typedef {{ src_id: string|null, src_path: string, location: string, raw: string,
 *              target_id: string|null, target_kind: string|null, resolution: string }} LinkRow */

const idOf = (doc) => (typeof doc.fm.id === 'string' ? doc.fm.id : null);

/**
 * @param {any[]} docs typed documents of one book (`rel` is relative to the book root)
 * @param {string} bookDir absolute book directory
 * @returns {Promise<LinkRow[]>}
 */
export async function collectLinks(docs, bookDir) {
  const byId = new Map();
  const bySlug = new Map();
  const byPrev = new Map();
  const byCite = new Map();
  const byRel = new Map();
  const push = (map, key, d) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  };
  for (const d of docs) {
    byRel.set(d.rel, d);
    if (typeof d.fm.id === 'string' && !byId.has(d.fm.id)) byId.set(d.fm.id, d);
    if (NAMED.includes(d.kind)) {
      if (typeof d.fm.slug === 'string') push(bySlug, d.fm.slug, d);
      if (Array.isArray(d.fm.previous_slugs)) {
        for (const p of d.fm.previous_slugs) if (typeof p === 'string') push(byPrev, p, d);
      }
    }
    if (d.kind === 'source' && typeof d.fm.cite_key === 'string') push(byCite, d.fm.cite_key, d);
  }

  function lookup(target) {
    if (ID_PREFIX_RE.test(target)) {
      const d = byId.get(target);
      return d ? { doc: d, viaPrevious: false } : null;
    }
    for (const [map, viaPrevious] of [[bySlug, false], [byPrev, true]]) {
      const live = (map.get(target) ?? []).find((d) => !d.archived);
      if (live) return { doc: live, viaPrevious };
    }
    for (const [map, viaPrevious] of [[bySlug, false], [byPrev, true]]) {
      const any = (map.get(target) ?? [])[0];
      if (any) return { doc: any, viaPrevious };
    }
    return null;
  }

  /** @type {LinkRow[]} */
  const rows = [];
  const add = (src, location, raw, targetId, targetKind, resolution) =>
    rows.push({ src_id: idOf(src), src_path: src.rel, location, raw, target_id: targetId, target_kind: targetKind, resolution });

  function target(src, location, raw, kinds) {
    const t = raw.trim();
    if (t === '') return;
    if (t.includes(':')) return add(src, location, t, null, null, 'cross_book');
    const hit = lookup(t);
    if (!hit) return add(src, location, t, null, null, 'broken');
    let resolution = 'ok';
    if (kinds && !kinds.includes(hit.doc.kind)) resolution = 'wrong_kind';
    else if (hit.doc.archived) resolution = 'archived';
    else if (hit.viaPrevious) resolution = 'previous_slug';
    return add(src, location, t, idOf(hit.doc), hit.doc.kind, resolution);
  }

  function cite(src, location, key) {
    const list = byCite.get(key);
    if (!list) return add(src, location, key, null, null, 'broken');
    const live = list.find((d) => !d.archived);
    return add(src, location, key, idOf(live ?? list[0]), 'source', live ? 'ok' : 'archived');
  }

  async function fileLink(src, location, rawTarget) {
    let t = rawTarget.trim();
    if (t.startsWith('<')) {
      const end = t.indexOf('>');
      t = end > 0 ? t.slice(1, end) : t.slice(1);
    } else {
      t = t.split(/\s+/)[0];
    }
    if (t === '' || t.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(t)) return;
    t = t.split('#')[0].split('?')[0];
    if (t === '') return;
    try {
      t = decodeURIComponent(t);
    } catch {
      // keep the raw text
    }
    const joined = path.posix.join(path.posix.dirname(src.rel), t);
    const resolved = path.posix.normalize(joined);
    if (t.startsWith('/') || escapesRoot(joined)) return add(src, location, rawTarget.trim(), null, 'file', 'broken');
    if (resolved.startsWith('.storyforge/') || resolved === '.storyforge') return;
    let present = true;
    try {
      await stat(path.join(bookDir, ...resolved.split('/')));
    } catch {
      present = false;
    }
    const doc = byRel.get(resolved);
    const resolution = !present ? 'broken' : resolved.startsWith('archive/') ? 'archived' : 'ok';
    return add(src, location, rawTarget.trim(), doc ? idOf(doc) : null, doc ? doc.kind : 'file', resolution);
  }

  for (const d of docs) {
    const { fm } = d;
    for (const ref of REFERENCES[d.kind] ?? []) {
      const value = fm[ref.field];
      const items = ref.list ? (Array.isArray(value) ? value : []) : value === undefined ? [] : [value];
      items.forEach((item, i) => {
        if (typeof item === 'string') target(d, ref.list ? `${ref.field}[${i}]` : ref.field, item, ref.kinds);
      });
    }
    if (d.kind === 'entry' && Array.isArray(fm.related)) {
      fm.related.forEach((r, i) => {
        if (r && typeof r === 'object' && typeof r.to === 'string') target(d, `related[${i}].to`, r.to, NAMED);
      });
    }
    if (d.kind === 'research' && Array.isArray(fm.sources)) {
      fm.sources.forEach((s, i) => {
        if (typeof s === 'string') cite(d, `sources[${i}]`, s);
      });
    }
    if (d.kind === 'entry' && fm.fields && typeof fm.fields === 'object' && !Array.isArray(fm.fields)) {
      for (const [label, value] of Object.entries(fm.fields)) {
        if (typeof value !== 'string') continue;
        for (const m of value.matchAll(WIKI_RE)) target(d, `fields.${label}`, m[1].split('|')[0], null);
      }
    }
    for (const [lineNo, text] of proseLines(d.body, d.bodyStartLine)) {
      const location = `line ${lineNo}`;
      for (const m of text.matchAll(WIKI_RE)) target(d, location, m[1].split('|')[0], null);
      for (const m of text.matchAll(CITE_RE)) cite(d, location, m[1]);
      for (const m of text.matchAll(MDLINK_RE)) await fileLink(d, location, m[3]);
    }
  }
  return rows;
}
