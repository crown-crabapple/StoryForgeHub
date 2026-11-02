// Build the Claude-Book context pack (contract M05-J05 section 3) as a map of relative path -> text.
// Pure apart from the file modification times the ledger asks the model for.
import { checkContinuity } from '@storyforge/continuity';
import { deriveState, placedEvents } from './state.mjs';
import { renderContinuity } from './continuity-md.mjs';
import { UsageError } from './io.mjs';

/** @typedef {import('./model.mjs').Model} Model */

export const ADAPTER_VERSION = 1;
export const NOT_PROVIDED = '_Not provided in the StoryForge project._';
const SEP = '\n\n---\n\n';

export const pad2 = (n) => String(n).padStart(2, '0');
const json = (objs) => (objs.length === 0 ? '\n' : `${objs.map((o) => JSON.stringify(o, null, 2)).join('\n\n')}\n`);
const titleCase = (s) => (s === '' ? s : s[0].toUpperCase() + s.slice(1));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const str = (v) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The folder name of an entry under codex/ ("characters"); falls back to the type + "s". @param {import('@storyforge/format').Doc} d */
export function dbOf(d) {
  const m = /^codex\/([^/]+)\//.exec(d.rel);
  return m && m[1] !== '_types' ? m[1] : `${str(d.fm.type)}s`;
}

/** Chapter word range from book.md `x-claude-book`. @param {Model} model @returns {{min: number, max: number}} */
export function wordRange(model) {
  const x = model.bookDoc.fm['x-claude-book'];
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return {
    min: x && typeof x === 'object' && ok(x.min_words) ? x.min_words : 1,
    max: x && typeof x === 'object' && ok(x.max_words) ? x.max_words : 100000,
  };
}

/** Scene bodies of a list of scenes, ready to read. @param {Model} model @param {{doc: {body: string}}[]} scenes */
export const joinScenes = (model, scenes) => scenes.map((s) => model.prose(s.doc.body)).join(SEP);

function renderBook(model) {
  const fm = model.bookDoc.fm;
  const lines = [`# ${str(fm.title)}`, ''];
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'schema' || k === 'x-claude-book' || str(v) === '' || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(`- **${titleCase(k.replace(/_/g, ' '))}:** ${Array.isArray(v) ? v.map(str).join(', ') : str(v)}`);
  }
  if (fm['x-claude-book']) {
    const r = wordRange(model);
    lines.push(`- **Chapter word range:** ${r.min}-${r.max}`);
  }
  const body = model.prose(model.bookDoc.body);
  return `${lines.join('\n')}\n${body ? `\n${body}\n` : ''}`;
}

/** A planning doc by name: planning/<name>.md, then file name, slug, title. @param {Model} model @param {string} name */
function planningDoc(model, name) {
  const docs = model.live.filter((d) => d.kind === 'doc').sort((a, b) => cmp(a.rel, b.rel));
  const base = (d) => d.rel.replace(/^.*\//, '').replace(/\.md$/, '');
  return (
    docs.find((d) => d.rel === `planning/${name}.md`) ??
    docs.find((d) => base(d) === name) ??
    docs.find((d) => d.fm.slug === name) ??
    docs.find((d) => typeof d.fm.title === 'string' && d.fm.title.trim().toLowerCase() === name) ??
    null
  );
}

function renderEntry(d) {
  const fm = d.fm;
  const lines = [`# ${str(fm.name)}`, '', `- **Slug:** ${fm.slug}`, `- **Status:** ${str(fm.status)}`, `- **Type:** ${titleCase(str(fm.type))}`];
  if (typeof fm.role === 'string' && fm.role !== '') lines.push(`- **Role:** ${fm.role}`);
  if (Array.isArray(fm.aliases) && fm.aliases.length > 0) lines.push(`- **Aliases:** ${fm.aliases.map(str).join(', ')}`);
  if (fm.fields && typeof fm.fields === 'object' && !Array.isArray(fm.fields)) {
    for (const [k, v] of Object.entries(fm.fields)) lines.push(`- **${k}:** ${str(v)}`);
  }
  if (Array.isArray(fm.related) && fm.related.length > 0) {
    const rel = fm.related
      .map((r) => (r && typeof r === 'object' ? (r.as ? `[[${str(r.to)}]] (${str(r.as)})` : `[[${str(r.to)}]]`) : `[[${str(r)}]]`))
      .join(', ');
    lines.push(`- **Related:** ${rel}`);
  }
  const body = d.body.trim();
  return `${lines.join('\n')}\n${body ? `\n${body}\n` : ''}`;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wiki-link targets in a body. @param {string} body */
function* wikiTargets(body) {
  for (const m of body.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const bar = m[1].indexOf('|');
    yield (bar < 0 ? m[1] : m[1].slice(0, bar)).trim().replace(/#.*$/, '');
  }
}

/** Entries a chapter's scenes use: front-matter lists, wiki-links, and names or aliases in the text. @param {Model} model @param {any[]} scenes */
function relevantEntries(model, scenes) {
  const hit = new Set();
  const text = scenes.map((s) => model.prose(s.doc.body)).join('\n');
  for (const s of scenes) {
    const fm = s.doc.fm;
    const listed = [fm.pov, ...(Array.isArray(fm.characters) ? fm.characters : []), ...(Array.isArray(fm.locations) ? fm.locations : [])];
    for (const t of [...listed, ...wikiTargets(s.doc.body)]) {
      const e = model.find(t, ['entry']);
      if (e) hit.add(e);
    }
  }
  for (const e of model.entries) {
    if (hit.has(e)) continue;
    const names = [e.fm.name, ...(Array.isArray(e.fm.aliases) ? e.fm.aliases : [])].filter((x) => typeof x === 'string' && x.trim() !== '');
    if (names.some((nm) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(nm.trim())}(?![\\p{L}\\p{N}])`, 'iu').test(text))) hit.add(e);
  }
  return [...hit].sort((a, b) => cmp(a.rel, b.rel));
}

const STATUS_MAP = { planned: 'open', planted: 'open', developed: 'open', open: 'open', paid: 'paid-off', dropped: 'dropped', abandoned: 'dropped', unresolved: 'unresolved' };

/**
 * ledger.md as of chapter n (contract M05-J06 section 3): a thread whose first setup scene is after chapter n is left out;
 * payoffs after chapter n do not exist yet, so such a thread reads `open` with no payoff chapter.
 */
function renderLedger(model, n) {
  const chaptersOf = (t, field) => {
    const found = [];
    for (const id of Array.isArray(t.fm[field]) ? t.fm[field] : []) {
      const s = model.find(id, ['scene']);
      const sc = s && model.sceneOf.get(s);
      if (sc) found.push(sc);
    }
    return found.sort((a, b) => a.position - b.position).map((sc) => sc.chapter);
  };
  const firstPara = (body) => model.prose(body).split(/\n\s*\n/)[0]?.trim() ?? '';
  const rows = [];
  for (const t of [...model.threads].sort((a, b) => cmp(a.rel, b.rel))) {
    const setup = chaptersOf(t, 'setup');
    if (setup.length > 0 && Math.min(...setup) > n) continue;
    const payoff = chaptersOf(t, 'payoff');
    const paidByN = payoff.filter((c) => c <= n);
    let status = STATUS_MAP[t.fm.status] ?? 'open';
    if (status === 'paid-off' && payoff.length > 0 && paidByN.length === 0) status = 'open';
    rows.push({
      slug: t.fm.slug,
      kind: str(t.fm.kind),
      title: str(t.fm.title),
      status,
      planted_in: setup.length > 0 ? String(setup[0]) : '',
      payoff_in: paidByN.length > 0 ? String(paidByN[0]) : '',
      characters: (Array.isArray(t.fm.characters) ? t.fm.characters : []).filter((c) => typeof c === 'string'),
      notes: firstPara(t.body),
      updated_at: model.mtimeOf(t),
    });
  }
  return json(rows);
}

function renderTimeline(model, keep) {
  const evs = placedEvents(model, keep);
  if (evs.length === 0) return '_No events recorded._\n';
  return `${evs.map(({ ev, when }) => `## ${when} — ${str(ev.fm.title)}\n\n${ev.body.trim()}`.trimEnd()).join('\n\n')}\n`;
}

/** "Name (slug)" when the slug names an entry, else the slug. @param {Model} model @param {string} slug */
const label = (model, slug) => {
  const n = model.nameOf(slug);
  return n ? `${n} (${slug})` : slug;
};

function renderState(model, n, derived) {
  const upTo = `After chapter ${n - 1}`;
  const chars = model.entries.filter((e) => e.fm.type === 'character').sort((a, b) => cmp(a.rel, b.rel));

  const characters = [`# Character states - ${upTo}`, ''];
  if (chars.length === 0) characters.push('- None recorded', '');
  for (const c of chars) {
    const st = derived.characters.get(c.fm.slug);
    characters.push(`## ${str(c.fm.name)} (${c.fm.slug})`, `- Status: ${st?.dead ? 'dead' : 'alive'}`, `- Location: ${st?.location ? label(model, st.location) : 'unknown'}`, '');
  }

  const carried = new Map();
  const inPlay = [];
  const gone = [];
  for (const [slug, t] of [...derived.things].sort((a, b) => cmp(a[0], b[0]))) {
    if (t.destroyed) gone.push(`- ${label(model, slug)}: destroyed`);
    else if (t.lost) gone.push(`- ${label(model, slug)}: lost`);
    else {
      if (t.holder) {
        if (!carried.has(t.holder)) carried.set(t.holder, []);
        carried.get(t.holder).push(label(model, slug));
      }
      const where = t.location ? `at ${label(model, t.location)}` : '';
      const who = t.holder ? `held by ${label(model, t.holder)}` : 'held by nobody';
      if (t.holder || t.location) inPlay.push(`- ${label(model, slug)}: ${[t.holder ? who : '', where].filter(Boolean).join('; ')}`);
      else inPlay.push(`- ${label(model, slug)}: ${who}`);
    }
  }
  const inventory = [
    `# Inventory & Objects - ${upTo}`, '', '## Carried by characters',
    ...(carried.size > 0 ? [...carried].sort((a, b) => cmp(a[0], b[0])).map(([h, objs]) => `- ${label(model, h)}: ${objs.join(', ')}`) : ['- None recorded']),
    '', '## Important objects in play', ...(inPlay.length > 0 ? inPlay : ['- None recorded']),
    '', '## Lost or destroyed', ...(gone.length > 0 ? gone : ['- None yet']),
    '', '## Hidden / Not yet discovered', '- None recorded', '',
  ];

  const known = [];
  for (const [slug, facts] of [...derived.knowledge].sort((a, b) => cmp(a[0], b[0]))) {
    for (const f of facts) known.push(`- ${label(model, slug)} learned ${f.fact} (chapter ${f.chapter})`);
  }
  const knowledge = [
    `# Knowledge state - ${upTo}`, '', '## Known to all', '- None recorded', '',
    '## Known to specific characters', ...(known.length > 0 ? known : ['- None yet']),
    '', '## Unknown (dramatic irony)', '- None recorded', '', '## Clues found', '- None yet', '',
  ];

  const last = derived.events.slice(-5);
  const situation = [
    `# Current situation - ${upTo}`, '', `_Derived from StoryForge events up to chapter ${n - 1}._`, '',
    '## Recent events',
    ...(last.length > 0 ? last.map(({ ev, when, chapter }) => `- ${when} — ${str(ev.fm.title)} (chapter ${chapter})`) : ['- None yet']),
    '',
  ];
  return { characters: characters.join('\n'), inventory: inventory.join('\n'), knowledge: knowledge.join('\n'), situation: situation.join('\n') };
}

/**
 * @param {Model} model @param {number} n target chapter
 * @returns {Promise<{ files: Map<string, string>, candidate: string }>} file paths are relative to <work>/ ("context/book.md")
 */
export async function buildPack(model, n) {
  const target = model.chapterScenes(n);
  if (target.length === 0) throw new UsageError(`chapter ${n} has no scenes in this book`);
  const files = new Map();
  const put = (rel, text) => files.set(`context/${rel}`, text);

  put('book.md', renderBook(model));
  for (const name of ['style', 'structure', 'synopsis', 'plan']) {
    const d = planningDoc(model, name);
    put(`${name}.md`, d ? `${model.prose(d.body)}\n` : `${NOT_PROVIDED}\n`);
  }

  const prev = model.chapterScenes(n - 1);
  put('previous-chapter.md', prev.length > 0 ? `${joinScenes(model, prev)}\n` : `${NOT_PROVIDED}\n`);
  const before = model.scenes.filter((s) => s.chapter < n);
  const lastScene = before[before.length - 1];
  put('previous-scene.md', lastScene ? `${model.prose(lastScene.doc.body)}\n` : `${NOT_PROVIDED}\n`);

  const live = [...model.entries].sort((a, b) => cmp(a.rel, b.rel));
  put('entries-index.md', json(live.map((e) => ({
    db: dbOf(e),
    slug: e.fm.slug,
    name: str(e.fm.name),
    status: str(e.fm.status),
    type: titleCase(str(e.fm.type)),
    detail: typeof e.fm.role === 'string' && e.fm.role !== ''
      ? e.fm.role
      : e.fm.fields && typeof e.fm.fields === 'object' && Object.keys(e.fm.fields).length > 0 ? str(Object.values(e.fm.fields)[0]) : '',
  }))));

  const relevant = relevantEntries(model, target);
  for (const e of relevant) put(`${dbOf(e)}/${e.fm.slug}.md`, renderEntry(e));

  put('ledger.md', renderLedger(model, n));

  const derived = deriveState(model, n);
  put('state-events.md', json(derived.events.flatMap(({ items }) => items).filter((i) => i.event !== 'learns' && i.event !== 'knows').map((i) => ({
    slug: i.slug, event: i.event, chapter: String(i.chapter), value: i.value, note: i.note,
  }))));

  for (const e of relevant.filter((x) => x.fm.type === 'character')) {
    const facts = derived.knowledge.get(e.fm.slug) ?? [];
    put(`knowledge/${e.fm.slug}.md`, json([{
      ok: true,
      character: e.fm.slug,
      at: String(n - 1),
      arc: [],
      facts: facts.map((f) => ({ fact: f.fact, knows: f.fact.replace(/-/g, ' '), learned_in: String(f.chapter) })),
    }]));
  }

  const st = renderState(model, n, derived);
  put('state/current/characters.md', st.characters);
  put('state/current/inventory.md', st.inventory);
  put('state/current/knowledge.md', st.knowledge);
  put('state/current/situation.md', st.situation);

  put('timeline/history.md', renderTimeline(model, (c) => c < n));
  put('timeline/current-chapter.md', renderTimeline(model, (c) => c === n));

  put('continuity-check.md', renderContinuity(model, n, await checkContinuity(model.root)));

  const candidate = `${joinScenes(model, target)}\n`;
  files.set(`candidate/chapter-${pad2(n)}-candidate.md`, candidate);
  return { files, candidate };
}
