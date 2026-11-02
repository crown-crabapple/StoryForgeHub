// Shared helpers for the continuity tests. Contains no tests itself.
// Builds small synthetic books (the independent oracle) and copies/mutates fixture books in temp dirs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(HERE, '../../format/fixtures');
export const VALID = path.join(FIXTURES, 'valid');

export const ARRIVAL_FILE = 'manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md';
export const MAREN_FILE = 'codex/characters/maren-hollis.md';
export const ARRIVAL_ID = 'scene_01S50000000000000000000002';
export const MAREN_ID = 'entry_01S5000000000000000000000G';

export function tmp(prefix = 'sf-cont-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copy a fixture book into a fresh temp dir; returns the copy's path. */
export function copyFixture(name = 'salt-orchard') {
  const dest = path.join(tmp(), name);
  fs.cpSync(path.join(VALID, name), dest, { recursive: true });
  return dest;
}

export const abs = (root, rel) => path.join(root, ...rel.split('/'));
export const read = (root, rel) => fs.readFileSync(abs(root, rel), 'utf8');
export function put(root, rel, text) {
  const f = abs(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

/** Valid 26-char ULID-shaped ids (Crockford digits only). */
export const id = (prefix, n) => `${prefix}_01T6${String(n).padStart(22, '0')}`;

const yamlList = (xs) => `[${xs.join(', ')}]`;
const chDir = (ch) => `ch-${String(ch).padStart(3, '0')}-c${ch}`;

/**
 * Build a synthetic one-act book.
 *  entries: [{ slug, type, name?, aliases?, fields?: {Label: 'v'}, body? }]
 *  scenes:  [{ n, ch?, title?, pov?, characters?, locations?, variantOf?, archived?, body }]
 *           `n` is the scene number (id) and ordering: sequence = n*10 inside chapter `ch` (default 1).
 *  events:  [{ n, slug, order, date?, scenes?: [n], characters?, locations?, state?: ['yaml flow map', ...] }]
 *  threads: [{ n, slug, status, setup?: [n], develop?: [n], payoff?: [n] }]
 *  notes:   [{ n, title?, canon?, links?, body }]
 *  types:   [{ n, type, fields: ['Eyes'], values?: 'raw yaml line for values' }]
 */
export function buildBook({ entries = [], scenes = [], events = [], threads = [], notes = [], types = [] } = {}) {
  const root = path.join(tmp(), 'book');
  put(root, 'book.md', `---
schema: storyforge.book/v1
id: ${id('book', 1)}
slug: test-book
title: Test Book
profile: fiction
status: drafting
---
A synthetic book.
`);
  put(root, 'manuscript/act-01-one/act.md', `---
schema: storyforge.act/v1
id: ${id('act', 1)}
act: 1
title: One
---
`);
  const chapters = new Set(scenes.filter((s) => !s.archived).map((s) => s.ch ?? 1));
  for (const c of chapters) {
    put(root, `manuscript/act-01-one/${chDir(c)}/chapter.md`, `---
schema: storyforge.chapter/v1
id: ${id('chap', c)}
chapter: ${c}
title: Chapter ${c}
---
`);
  }
  entries.forEach((e, i) => {
    const f = e.fields ? `fields:\n${Object.entries(e.fields).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}\n` : '';
    const dir = { character: 'characters', object: 'objects', location: 'locations', lore: 'lore' }[e.type];
    put(root, `codex/${dir}/${e.slug}.md`, `---
schema: storyforge.entry/v1
id: ${id('entry', i + 1)}
slug: ${e.slug}
type: ${e.type}
name: ${e.name ?? e.slug}
${e.aliases ? `aliases: ${yamlList(e.aliases)}\n` : ''}status: canon
${f}---
${e.body ?? 'Entry.\n'}`);
  });
  for (const s of scenes) {
    const ch = s.ch ?? 1;
    const dir = `${s.archived ? 'archive/' : ''}manuscript/act-01-one/${chDir(ch)}`;
    const seq = s.n * 10;
    put(root, `${dir}/${String(seq).padStart(4, '0')}-s${s.n}.md`, `---
schema: storyforge.scene/v1
id: ${id('scene', s.n)}
title: ${s.title ?? `Scene ${s.n}`}
act: 1
chapter: ${ch}
sequence: ${seq}
status: drafting
${s.pov ? `pov: ${s.pov}\n` : ''}${s.characters ? `characters: ${yamlList(s.characters)}\n` : ''}${s.locations ? `locations: ${yamlList(s.locations)}\n` : ''}${s.variantOf ? `variant_of: ${id('scene', s.variantOf)}\n` : ''}---
${s.body}
`);
  }
  for (const ev of events) {
    put(root, `planning/timeline/${ev.slug}.md`, `---
schema: storyforge.event/v1
id: ${id('event', ev.n)}
slug: ${ev.slug}
title: ${ev.slug}
order: ${ev.order}
${ev.date ? `date: "${ev.date}"\n` : ''}${ev.scenes ? `scenes: ${yamlList(ev.scenes.map((n) => id('scene', n)))}\n` : ''}${ev.characters ? `characters: ${yamlList(ev.characters)}\n` : ''}${ev.locations ? `locations: ${yamlList(ev.locations)}\n` : ''}${ev.state ? `state:\n${ev.state.map((x) => `  - ${x}`).join('\n')}\n` : ''}---
Event.
`);
  }
  for (const t of threads) {
    const ids = (xs) => yamlList(xs.map((n) => id('scene', n)));
    put(root, `planning/threads/${t.slug}.md`, `---
schema: storyforge.thread/v1
id: ${id('thread', t.n)}
slug: ${t.slug}
title: ${t.slug}
kind: mystery
status: ${t.status}
${t.setup ? `setup: ${ids(t.setup)}\n` : ''}${t.develop ? `develop: ${ids(t.develop)}\n` : ''}${t.payoff ? `payoff: ${ids(t.payoff)}\n` : ''}---
Thread.
`);
  }
  for (const n of notes) {
    put(root, `research/note-${n.n}.md`, `---
schema: storyforge.research/v1
id: ${id('note', 100 + n.n)}
title: ${n.title ?? `Note ${n.n}`}
${n.canon === undefined ? '' : `canon: ${n.canon}\n`}${n.links ? `links: ${yamlList(n.links)}\n` : ''}---
${n.body}
`);
  }
  for (const t of types) {
    put(root, `codex/_types/${t.type}.md`, `---
schema: storyforge.codex-type/v1
id: ${id('note', 200 + t.n)}
type: ${t.type}
name: ${t.type}
plural: ${t.type}s
fields: ${yamlList(t.fields)}
${t.values ?? ''}---
Type.
`);
  }
  return root;
}

export const MAREN = { slug: 'maren-hollis', type: 'character', name: 'Maren Hollis', aliases: ['Mare'], fields: { Eyes: 'Grey' } };
export const TOBIN = { slug: 'tobin-reyes', type: 'character', name: 'Tobin Reyes' };
export const PELL = { slug: 'pell', type: 'character', name: 'Pell' };
export const KNIFE = { slug: 'grafting-knife', type: 'object', name: 'Grafting Knife' };
export const PORT = { slug: 'port-aldine', type: 'location', name: 'Port Aldine' };
export const ORCHARD = { slug: 'salt-orchard', type: 'location', name: 'Salt Orchard' };

/** Findings of one rule family (e.g. 'TL1' also matches TL1a). */
export const ofRule = (result, prefix) => result.findings.filter((f) => f.rule.toUpperCase().startsWith(prefix));
export const files = (f) => f.sources.map((s) => s.file);

/** path -> {bytes, mtimeMs} for every file under dir, dotfiles included. */
export function statTree(dir, rel = '') {
  const out = {};
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, statTree(dir, r));
    else {
      const f = path.join(dir, r);
      out[r] = { bytes: fs.readFileSync(f).toString('base64'), mtimeMs: fs.statSync(f).mtimeMs };
    }
  }
  return out;
}
