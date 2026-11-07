// Planning export: planner data (gathered by the caller from repository reads) -> Markdown files and a zip.
// Pure and deterministic: no clock, no I/O. Separate from the manuscript exports.
import { writeZip } from './zip.mjs';

const NONE = 'Nothing planned yet.';
const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const label = (key) => {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** @param {string[]} lines @returns {string} LF lines, one trailing newline */
function finish(lines) {
  return `${lines.join('\n').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')}\n`;
}

/** "- Label: value" lines for the non-empty keys, in the order given. */
function fieldLines(obj, keys) {
  const out = [];
  for (const k of keys) {
    const v = str(obj?.[k]);
    if (v) out.push(`- ${label(k)}: ${v}`);
  }
  return out;
}

function storyPlan(data) {
  const f = data.story?.fields ?? {};
  const keys = ['premise', 'logline', 'theme_question', 'central_conflict', 'protagonist_goal', 'stakes', 'protagonist', 'primary_structure'];
  const lines = [`# Story plan: ${str(data.book?.title)}`, ''];
  const fl = fieldLines(f, keys);
  const body = str(data.story?.body);
  if (!fl.length && !body) lines.push(NONE);
  else {
    lines.push(...fl);
    if (body) lines.push('', body);
  }
  return finish(lines);
}

const PLAN_KEYS = ['goal', 'opposition', 'conflict', 'turn', 'outcome', 'consequence', 'stakes', 'emotional_start', 'emotional_end', 'purpose'];

function outline(data) {
  const lines = ['# Outline', ''];
  const scenes = arr(data.scenes);
  if (!scenes.length) lines.push(NONE);
  let act = Symbol('none');
  let chapter = Symbol('none');
  for (const s of scenes) {
    if (s.act !== act) {
      act = s.act;
      chapter = Symbol('none');
      if (act != null && act !== '') lines.push(`## Act ${act}`, '');
    }
    if (s.chapter !== chapter) {
      chapter = s.chapter;
      if (chapter != null && chapter !== '') lines.push(`### Chapter ${chapter}`, '');
    }
    const summary = str(s.summary);
    lines.push(`**${str(s.title)}**${summary ? ` — ${summary}` : ''}`);
    const pl = fieldLines(s.plan, PLAN_KEYS);
    if (pl.length) lines.push('', ...pl);
    lines.push('');
  }
  return finish(lines);
}

const ARC_KEYS = ['want', 'need', 'false_belief', 'fear', 'wound'];
const MILESTONE_KEYS = ['pressure', 'choice', 'belief_before', 'belief_after', 'cost'];

function characters(data) {
  const lines = ['# Characters', ''];
  const arcs = arr(data.arcs);
  const rels = arr(data.relationships);
  lines.push('## Arcs', '');
  if (!arcs.length) lines.push(NONE, '');
  for (const a of arcs) {
    lines.push(`### ${str(a.character?.name) || str(a.slug) || 'Unnamed character'}`, '');
    const head = [];
    if (str(a.arc_type)) head.push(`- Arc type: ${str(a.arc_type)}`);
    if (str(a.fields?.start_state)) head.push(`- Start: ${str(a.fields.start_state)}`);
    if (str(a.fields?.end_state)) head.push(`- End: ${str(a.fields.end_state)}`);
    head.push(...fieldLines(a.fields, ARC_KEYS));
    if (head.length) lines.push(...head, '');
    const ms = arr(a.milestones);
    if (ms.length) {
      lines.push('Milestones:', '');
      ms.forEach((m, i) => {
        lines.push(`${i + 1}. ${str(m.scene_title) || 'Unknown scene'}`);
        for (const l of fieldLines(m, MILESTONE_KEYS)) lines.push(`   ${l}`);
      });
      lines.push('');
    }
  }
  lines.push('## Relationships', '');
  if (!rels.length) lines.push(NONE, '');
  for (const r of rels) {
    lines.push(`### ${str(r.name) || str(r.slug)}`, '');
    const head = [];
    if (str(r.baseline)) head.push(`- Baseline: ${str(r.baseline)}`);
    if (str(r.end_state)) head.push(`- End state: ${str(r.end_state)}`);
    if (head.length) lines.push(...head, '');
    const ds = arr(r.developments);
    if (ds.length) {
      lines.push('Developments:', '');
      ds.forEach((d, i) => {
        lines.push(`${i + 1}. ${str(d.scene_title) || 'Unknown scene'}`);
        const sub = [];
        if (str(d.change)) sub.push(`- Change: ${str(d.change)}`);
        if (str(d.a_view)) sub.push(`- ${str(r.a?.name) || 'A'} sees: ${str(d.a_view)}`);
        if (str(d.b_view)) sub.push(`- ${str(r.b?.name) || 'B'} sees: ${str(d.b_view)}`);
        for (const l of sub) lines.push(`   ${l}`);
      });
      lines.push('');
    }
  }
  return finish(lines);
}

function structure(data) {
  const st = data.structure;
  const lines = ['# Structure', ''];
  if (!st) {
    lines.push('No primary structure.');
    return finish(lines);
  }
  lines.push(`## ${str(st.name) || str(st.slug)}`, '');
  const beats = arr(st.beats);
  if (!beats.length) lines.push(NONE);
  for (const b of beats) {
    lines.push(`### ${str(b.name)}`, '');
    const l = [];
    if (str(b.purpose)) l.push(`- Purpose: ${str(b.purpose)}`);
    if (str(b.question)) l.push(`- Question: ${str(b.question)}`);
    if (str(b.position)) l.push(`- Position: ${str(b.position)}`);
    if (str(b.state)) l.push(`- State: ${str(b.state)}`);
    const titles = arr(b.scenes).map((s) => str(s.title)).filter(Boolean);
    if (titles.length) l.push(`- Scenes: ${titles.join(', ')}`);
    if (l.length) lines.push(...l, '');
  }
  return finish(lines);
}

function clues(data) {
  const lines = ['# Clues', ''];
  const list = arr(data.clues);
  if (!list.length) lines.push(NONE);
  for (const c of list) {
    lines.push(`## ${str(c.fact)}`, '');
    if (str(c.kind)) lines.push(`- Kind: ${str(c.kind)}`);
    const planted = arr(c.planted).map((p) => str(p.title)).filter(Boolean);
    lines.push(`- Planted in: ${planted.length ? planted.join(', ') : 'not planted'}`);
    lines.push(`- Revealed in: ${str(c.revealed?.title) || 'not revealed'}`);
    if (c.red_herring) lines.push('- Red herring: yes');
    const ks = arr(c.knowers);
    if (ks.length) {
      lines.push('- Who learns it:');
      for (const k of ks) {
        const who = str(k.who?.name) || 'Unknown';
        const reader = k.who?.reader ? ' (reader)' : '';
        const how = str(k.how) ? ` (${str(k.how)})` : '';
        const unreliable = k.reliable === false ? ' [unreliable]' : '';
        lines.push(`  - ${who}${reader} in ${str(k.scene?.title) || 'unknown scene'}${how}${unreliable}`);
      }
    }
    lines.push('');
  }
  return finish(lines);
}

function links(data) {
  const lines = ['# Links', ''];
  const list = arr(data.links);
  if (!list.length) lines.push(NONE);
  const branches = [...new Set(list.filter((l) => l.branch).map((l) => String(l.branch)))].sort();
  const groups = [{ title: 'Main plan', items: list.filter((l) => !l.branch) }, ...branches.map((b) => ({ title: `Branch: ${b}`, items: list.filter((l) => l.branch === b) }))];
  for (const g of groups) {
    if (!g.items.length) continue;
    lines.push(`## ${g.title}`, '');
    for (const l of g.items) {
      lines.push(`- ${str(l.from_title)} → ${str(l.relation)} → ${str(l.to_title)}`);
      if (str(l.rationale)) lines.push(`  ${str(l.rationale)}`);
    }
    lines.push('');
  }
  return finish(lines);
}

/**
 * @param {object} data planner data (book, story, scenes, arcs, relationships, structure, synopses, clues, links; any may be empty or null)
 * @returns {{ path: string, text: string }[]}
 */
export function planningFiles(data) {
  const d = data ?? {};
  const files = [
    { path: 'story-plan.md', text: storyPlan(d) },
    { path: 'outline.md', text: outline(d) },
    { path: 'characters.md', text: characters(d) },
    { path: 'structure.md', text: structure(d) },
  ];
  const syn = arr(d.synopses).slice().sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const s of syn) {
    const body = str(s.body);
    files.push({ path: `synopses/${s.slug}.md`, text: finish([`# ${str(s.name) || str(s.slug)}`, ...(body ? ['', body] : [])]) });
  }
  files.push({ path: 'clues.md', text: clues(d) }, { path: 'links.md', text: links(d) });
  return files;
}

/**
 * @param {object} data see planningFiles
 * @returns {{ bytes: Buffer, filename: string }}
 */
export function planningZip(data) {
  const slug = str(data?.book?.slug) || 'book';
  const dir = `${slug}-planning`;
  const bytes = writeZip(planningFiles(data).map((f) => ({ name: `${dir}/${f.path}`, data: Buffer.from(f.text, 'utf8') })));
  return { bytes, filename: `${slug}-planning.zip` };
}
