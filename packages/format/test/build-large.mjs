// Deterministic synthetic "large book" for the M06-J03 recovery tests. NOT a test (the name does not end in .test.mjs).
// Built into a temp folder at test time and never committed. All text is generated from a fixed word list and a fixed seed:
// no user text, no randomness beyond the seeded generator, no clock (every date is a literal), so two runs write identical bytes.
//
//   import { buildLargeBook, LARGE } from '../../../packages/format/test/build-large.mjs';
//   const { root, stats } = await buildLargeBook(dir);
//
// Shape (LARGE): 3 acts, 60 chapters, 320 scenes (~130 000 words), 220 Codex entries (with fields, relations and wiki links), 40 threads,
// 120 timeline events (with `state`), 30 research notes (+ 3 sources), 10 continuity exceptions, 3 suggestions, receipts for 8 scenes.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildReceipt, objectPath, receiptPath, sha256Hex } from '../../receipts/src/index.mjs';

export const LARGE = { acts: 3, chapters: 60, scenes: 320, entries: 220, threads: 40, events: 120, notes: 30, exceptions: 10, suggestions: 3, receiptScenes: 8 };

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulid(tag, n) {
  let s = '';
  let x = n;
  for (let i = 0; i < 22; i++) {
    s = ALPHA[x % 32] + s;
    x = Math.floor(x / 32);
  }
  return `01${tag}${s}`;
}
const ids = {
  book: () => `book_${ulid('BK', 1)}`,
  act: (n) => `act_${ulid('AC', n)}`,
  chap: (n) => `chap_${ulid('CH', n)}`,
  scene: (n) => `scene_${ulid('SC', n)}`,
  entry: (n) => `entry_${ulid('EN', n)}`,
  thread: (n) => `thread_${ulid('TH', n)}`,
  event: (n) => `event_${ulid('EV', n)}`,
  note: (n) => `note_${ulid('NT', n)}`,
  rcpt: (n) => `rcpt_${ulid('RC', n)}`,
};

/** Small deterministic generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'tide harbour lantern salt orchard ferry key wall ash bell rope stone mist gull net oar keel hull sail pier quay dune reed marsh brine ' +
  'wind lamp door stair attic cellar window shutter hearth candle table chair letter ledger map chart compass knife glass bottle cloth ' +
  'morning evening winter summer autumn spring dawn dusk night noon rain frost thaw flood drought storm calm grey green amber pale dark ' +
  'quiet slow sudden careful tired eager bitter gentle rough narrow wide low high old new broken whole empty full cold warm ' +
  'walked waited watched turned opened closed carried held dropped found lost kept told asked answered counted measured mended ' +
  'remembered forgot followed crossed climbed knelt listened whispered refused agreed doubted hoped feared and but while until before after ' +
  'because though still again once never always almost nearly far near beside beyond under over through along across against toward ' +
  'she he they her his their the a an of in on at by with from into onto about around between without within'
).split(/\s+/);
const SYL_A = ['Mar', 'Til', 'Bran', 'Col', 'Dar', 'Eld', 'Fen', 'Gar', 'Hal', 'Jor', 'Kes', 'Lor', 'Mor', 'Nor', 'Ost', 'Pel'];
const SYL_B = ['en', 'ric', 'wyn', 'dal', 'vik', 'mere', 'ton', 'sey', 'low', 'ham', 'ford', 'gate', 'wick', 'ley'];
const TYPES = [
  ['character', 'characters', 80],
  ['location', 'locations', 50],
  ['object', 'objects', 40],
  ['faction', 'factions', 20],
  ['lore', 'lore', 30],
];
const SCENE_STATUS = ['outline', 'drafting', 'revised', 'final'];
const ENTRY_STATUS = ['seed', 'sketch', 'canon'];
const THREAD_STATUS = ['planned', 'planted', 'developed', 'paid'];
const THREAD_KIND = ['promise', 'question', 'mystery', 'subplot', 'arc'];

const q = (s) => JSON.stringify(s);
const pad = (n, w) => String(n).padStart(w, '0');
const list = (a) => `[${a.join(', ')}]`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Write the large book into `dir` (created; must be empty or absent). Returns { root, stats, files }.
 * @param {string} dir
 * @param {{ seed?: number }} [opts]
 */
export function buildLargeBook(dir, { seed = 20261102 } = {}) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const files = new Map(); // rel -> string | Buffer
  const put = (rel, content) => files.set(rel, content);

  const sentence = (n) => {
    const w = [];
    for (let i = 0; i < n; i++) w.push(pick(WORDS));
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return `${w.join(' ')}.`;
  };
  /** A paragraph of about `words` words. */
  const paragraph = (words, link) => {
    const out = [];
    let count = 0;
    while (count < words) {
      const n = Math.min(words - count, 7 + Math.floor(rand() * 9));
      const s = n < 3 ? `${pick(WORDS)}.` : sentence(n);
      out.push(s);
      count += s.split(/\s+/).length;
    }
    let text = out.join(' ');
    if (link) text = text.replace(/\.$/, `, near [[${link}]].`);
    return text;
  };

  // ---- Codex entries (slugs first: scenes and threads refer to them)
  const entries = [];
  let n = 0;
  for (const [type, folder, count] of TYPES) {
    for (let i = 0; i < count; i++, n++) {
      const name = SYL_A[n % SYL_A.length] + SYL_B[Math.floor(n / SYL_A.length) % SYL_B.length];
      entries.push({ n: n + 1, type, folder, name, slug: name.toLowerCase() });
    }
  }
  const byType = (t) => entries.filter((e) => e.type === t);
  const characters = byType('character');
  const locations = byType('location');

  // ---- book, acts, chapters, scenes
  const bookId = ids.book();
  put('book.md', `---\nschema: storyforge.book/v1\nid: ${bookId}\nslug: large-book\ntitle: The Large Book\nsubtitle: ""\nprofile: fiction\nstatus: drafting\ngenre: [synthetic]\nword_target: 130000\nlanguage: en\n---\nA generated book for recovery tests.\n`);
  const ACT_SLUG = ['one', 'two', 'three'];
  const perAct = LARGE.chapters / LARGE.acts;
  for (let a = 1; a <= LARGE.acts; a++) {
    put(`manuscript/act-${pad(a, 2)}-${ACT_SLUG[a - 1]}/act.md`, `---\nschema: storyforge.act/v1\nid: ${ids.act(a)}\nact: ${a}\ntitle: Act ${ACT_SLUG[a - 1]}\n---\n`);
  }
  const scenes = [];
  let sceneN = 0;
  for (let c = 1; c <= LARGE.chapters; c++) {
    const act = Math.ceil(c / perAct);
    const chDir = `manuscript/act-${pad(act, 2)}-${ACT_SLUG[act - 1]}/ch-${pad(c, 3)}-chapter-${c}`;
    put(`${chDir}/chapter.md`, `---\nschema: storyforge.chapter/v1\nid: ${ids.chap(c)}\nchapter: ${c}\nlabel: Chapter ${c}\ntitle: Chapter ${c}\nstatus: drafting\nsummary: ${q(`Summary of chapter ${c}.`)}\n---\nNotes for chapter ${c}.\n`);
    const count = 5 + (c <= LARGE.scenes - 5 * LARGE.chapters ? 1 : 0);
    for (let s = 1; s <= count; s++) {
      sceneN++;
      const slug = `scene-${sceneN}`;
      scenes.push({ n: sceneN, id: ids.scene(sceneN), act, chapter: c, sequence: s * 10, slug, rel: `${chDir}/${pad(s * 10, 4)}-${slug}.md`, words: 0 });
    }
  }
  const events = [];
  for (let e = 1; e <= LARGE.events; e++) events.push({ n: e, slug: `ev-${pad(e, 3)}`, id: ids.event(e), order: e * 10 });
  const threads = [];
  for (let t = 1; t <= LARGE.threads; t++) threads.push({ n: t, slug: `thread-${pad(t, 2)}`, id: ids.thread(t) });

  const WORDS_PER_SCENE = 396;
  scenes.forEach((sc, i) => {
    const pov = characters[(i * 7) % characters.length];
    const cast = [pov, characters[(i * 3 + 1) % characters.length], characters[(i * 5 + 2) % characters.length]];
    const locs = [locations[i % locations.length], locations[(i * 11 + 3) % locations.length]];
    const ev = i % 2 === 0 && i / 2 < events.length ? [events[i / 2]] : [];
    const th = threads[i % threads.length];
    const fm = [
      '---', 'schema: storyforge.scene/v1', `id: ${sc.id}`, `title: ${q(`Scene ${sc.n}`)}`, `act: ${sc.act}`, `chapter: ${sc.chapter}`, `sequence: ${sc.sequence}`,
      `status: ${SCENE_STATUS[i % 4]}`, `pov: ${pov.slug}`, `characters: ${list([...new Set(cast.map((x) => x.slug))])}`, `locations: ${list(locs.map((x) => x.slug))}`,
      ...(i % 4 === 0 ? [`plot_threads: ${list([th.slug])}`] : []),
      ...(ev.length ? [`events: ${list(ev.map((e) => e.slug))}`] : []),
      `summary: ${q(`What happens in scene ${sc.n}.`)}`, '---',
    ];
    const target = WORDS_PER_SCENE + (i % 13);
    const paras = [];
    for (let p = 0; p < 4; p++) paras.push(paragraph(Math.round(target / 4), p % 2 === 0 ? pick(entries).slug : null));
    sc.words = paras.join(' ').split(/\s+/).length;
    sc.text = `${fm.join('\n')}\n${paras.join('\n\n')}\n`;
    sc.fmLines = fm.length;
    put(sc.rel, sc.text);
  });

  // ---- Codex
  const FIELD_KEYS = ['Age', 'Home', 'Colour', 'Mood', 'Weight', 'Origin'];
  entries.forEach((e, i) => {
    const related = [entries[(i + 1) % entries.length], entries[(i + 17) % entries.length]].filter((r) => r.slug !== e.slug);
    const fields = FIELD_KEYS.slice(0, 2 + (i % 4)).map((k) => `  ${k}: ${q(`${pick(WORDS)} ${pick(WORDS)}`)}`);
    const first = e.type === 'character' ? [`first_appearance: ${scenes[(i * 3) % scenes.length].id}`] : [];
    put(`codex/${e.folder}/${e.slug}.md`, [
      '---', 'schema: storyforge.entry/v1', `id: ${ids.entry(e.n)}`, `slug: ${e.slug}`, `type: ${e.type}`, `name: ${e.name}`,
      `aliases: ${list([q(`${e.name} the ${pick(WORDS)}`)])}`, `status: ${ENTRY_STATUS[i % 3]}`, `role: ${q(pick(WORDS))}`, ...first,
      'fields:', ...fields, 'related:', ...related.flatMap((r) => [`  - to: ${r.slug}`, `    as: ${q(pick(WORDS))}`]), '---',
      '## Overview', `${sentence(12)} See [[${related[0].slug}]] and [[${related[related.length - 1].slug}]].`, '', '## Notes', sentence(14), '',
    ].join('\n'));
  });

  // ---- threads
  threads.forEach((t, i) => {
    const status = THREAD_STATUS[i % 4];
    const sc = (k) => scenes[(i * 7 + k * 41) % scenes.length].id;
    const setup = status === 'planned' ? [] : [sc(0)];
    const develop = status === 'developed' || status === 'paid' ? [sc(1)] : [];
    const payoff = status === 'paid' ? [sc(2)] : [];
    put(`planning/threads/${t.slug}.md`, [
      '---', 'schema: storyforge.thread/v1', `id: ${t.id}`, `slug: ${t.slug}`, `title: ${q(`Thread ${t.n}`)}`, `kind: ${THREAD_KIND[i % 5]}`, `status: ${status}`,
      `setup: ${list(setup)}`, ...(develop.length ? [`develop: ${list(develop)}`] : []), `payoff: ${list(payoff)}`, `characters: ${list([characters[i % characters.length].slug])}`, '---',
      sentence(16), '',
    ].join('\n'));
  });

  // ---- timeline events (some with state)
  const STATE_KIND = ['holder', 'location', 'learns', 'knows'];
  events.forEach((e, i) => {
    const sc = scenes[(i * 2) % scenes.length];
    const obj = byType('object')[i % 40];
    const state = [];
    if (i % 3 === 0) {
      const k = STATE_KIND[(i / 3) % 4 | 0];
      if (k === 'holder') state.push(`  - { slug: ${obj.slug}, event: holder, value: ${characters[i % characters.length].slug} }`);
      else if (k === 'location') state.push(`  - { slug: ${characters[i % characters.length].slug}, event: location, value: ${locations[i % locations.length].slug} }`);
      else state.push(`  - { slug: ${characters[i % characters.length].slug}, event: ${k}, value: fact-${i} }`);
    }
    put(`planning/timeline/${e.slug}.md`, [
      '---', 'schema: storyforge.event/v1', `id: ${e.id}`, `slug: ${e.slug}`, `title: ${q(`Event ${e.n}`)}`, `order: ${e.order}`, `when: ${q(`Year ${Math.floor(e.n / 4)}, day ${e.n}`)}`,
      `scenes: ${list([sc.id])}`, ...(state.length ? ['state:', ...state] : []), '---', sentence(9), '',
    ].join('\n'));
  });

  // ---- notes
  put('planning/plan.md', `---\nschema: storyforge.doc/v1\nid: ${ids.note(1)}\ntitle: Book plan\nlocked: false\n---\n## Plan\n${sentence(12)}\n`);
  const SOURCES = ['source-one', 'source-two', 'source-three'];
  SOURCES.forEach((k, i) => put(`research/sources/${k}.md`, `---\nschema: storyforge.source/v1\nid: ${ids.note(2 + i)}\ncite_key: ${k}\ntype: report\nauthor: ${q('A. Generator')}\ntitle: ${q(`Source ${i + 1}`)}\nyear: ${1990 + i}\n---\n.\n`));
  for (let i = 0; i < LARGE.notes; i++) {
    put(`research/note-${pad(i + 1, 2)}.md`, [
      '---', 'schema: storyforge.research/v1', `id: ${ids.note(10 + i)}`, `title: ${q(`Research note ${i + 1}`)}`, `tags: ${list([pick(WORDS), pick(WORDS)])}`, `canon: ${i % 2 === 0}`,
      `sources: ${list([SOURCES[i % 3]])}`, `links: ${list([entries[(i * 9) % entries.length].slug])}`, '---', paragraph(40), '',
    ].join('\n'));
  }
  for (let i = 0; i < LARGE.exceptions; i++) {
    const fp = `cf1-${sha(`exception-${i}`).slice(0, 16)}`;
    put(`planning/continuity/exception-${pad(i + 1, 2)}.md`, `---\nschema: storyforge.continuity-exception/v1\nid: ${ids.note(100 + i)}\nslug: exception-${pad(i + 1, 2)}\nfingerprint: ${fp}\nrule: CF1\ntitle: Kept on purpose\ncreated: "2026-11-02"\n---\n${sentence(10)}\n`);
  }

  // ---- suggestions: a few single-line edits to three scenes (the first prose line of each is the target)
  const sugTargets = [scenes[10], scenes[100], scenes[200]];
  sugTargets.forEach((sc, i) => {
    const lines = sc.text.split('\n');
    const lineNo = sc.fmLines + 1; // first prose line (1-based)
    const original = lines[lineNo - 1];
    const replacement = `${original.replace(/\.( |$)/, ', and nobody answered.$1')}`;
    const fm = [
      '---', 'schema: storyforge.suggestion/v1', `id: ${ids.note(200 + i)}`, `target: ${sc.id}`, `target_path: ${q(sc.rel)}`, `base_sha256: ${q(sha(sc.text))}`,
      'source: claude-book', 'mode: suggest', `created: ${q('2026-11-02T14:03:22Z')}`, 'status: pending', 'hunks:',
      `  - { id: h1, line: ${lineNo}, lines: 1, original_sha256: ${q(sha(original))}, status: pending }`, '---',
    ];
    put(`suggestions/2026/2026110${i + 1}-140322-scene-${sc.n}.md`, `${fm.join('\n')}\nOne small edit.\n\n\`\`\`diff\n@@ -${lineNo},1 +${lineNo},1 @@ h1\n-${original}\n+${replacement}\n\`\`\`\n`);
  });

  // ---- receipts: a baseline for 8 scenes; the first two also get an author edit so the chain has two links
  let rn = 0;
  for (let i = 0; i < LARGE.receiptScenes; i++) {
    const sc = scenes[i * 37];
    const v1 = Buffer.from(sc.text);
    const edited = i < 2;
    const v0 = edited ? Buffer.from(sc.text.replace(/ the /, ' a ')) : v1;
    const target = { id: sc.id, path: sc.rel };
    const at0 = `2026-11-02T14:${pad(5 + i, 2)}:00.000Z`;
    const r0 = buildReceipt({ id: ids.rcpt(++rn), at: at0, actor: 'system', operation: 'baseline', workflow: 'editor', target, before_sha256: '', after_sha256: sha256Hex(v0), beforeBytes: Buffer.alloc(0), afterBytes: v0 });
    put(receiptPath(at0, ids.rcpt(rn)), r0.text);
    put(objectPath(sha256Hex(v0)), v0);
    if (edited) {
      const at1 = `2026-11-02T15:${pad(5 + i, 2)}:30.250Z`;
      const r1 = buildReceipt({ id: ids.rcpt(++rn), at: at1, actor: 'author', operation: 'author.edit', workflow: 'editor', target, before_sha256: sha256Hex(v0), after_sha256: sha256Hex(v1), beforeBytes: v0, afterBytes: v1, parents: [{ id: ids.rcpt(rn - 1), sha256: r0.sha256 }] });
      put(receiptPath(at1, ids.rcpt(rn)), r1.text);
      put(objectPath(sha256Hex(v1)), v1);
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of files) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const stats = {
    acts: LARGE.acts,
    chapters: LARGE.chapters,
    scenes: scenes.length,
    words: scenes.reduce((s, x) => s + x.words, 0),
    entries: entries.length,
    threads: threads.length,
    events: events.length,
    notes: LARGE.notes,
    files: files.size,
  };
  return { root: dir, stats, bookId, scenes: scenes.map(({ n: num, id, rel, act, chapter, sequence }) => ({ n: num, id, rel, act, chapter, sequence })), entries };
}
