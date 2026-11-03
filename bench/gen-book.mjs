// Synthetic book generator for the benchmark's XL fixture (M08-J04 contract section 4). Not a test and not user text: every word comes from a fixed word list through a seeded
// generator, every date is a literal, so two runs write identical bytes. Written into a temp folder by bench/fixtures.mjs and never committed.
//
//   const { root, stats } = generateBook(dir, { chapters: 150, scenesPerChapter: 10, wordsPerScene: 400 });
//
// The files follow the same formats as packages/format/test/build-large.mjs (the M06-J03 large book): book.md, acts, chapters, scenes with front matter, Codex entries that the
// scenes name as POV, character and location. XL = 1 book, 1,500 scenes, about 600,000 words.
import fs from 'node:fs';
import path from 'node:path';

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A 26-character id body (`01` + 2-letter tag + 22 digits of base 32), the shape format/ids.mjs accepts. */
export function ulid(tag, n) {
  let s = '';
  let x = n;
  for (let i = 0; i < 22; i++) {
    s = ALPHA[x % 32] + s;
    x = Math.floor(x / 32);
  }
  return `01${tag}${s}`;
}

/** Small deterministic generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const WORDS = (
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
const STATUS = ['outline', 'drafting', 'revised', 'final'];
const pad = (n, w) => String(n).padStart(w, '0');
const q = (s) => JSON.stringify(s);

/**
 * @param {string} dir the book folder (created)
 * @param {{ acts?: number, chapters?: number, scenesPerChapter?: number, wordsPerScene?: number, characters?: number, locations?: number, seed?: number, slug?: string, tag?: string }} [opts]
 * @returns {{ root: string, stats: { acts: number, chapters: number, scenes: number, words: number, entries: number, bookId: string, sceneIds: string[], scenePaths: string[] } }}
 */
export function generateBook(dir, opts = {}) {
  const { acts = 3, chapters = 150, scenesPerChapter = 10, wordsPerScene = 400, characters = 120, locations = 80, seed = 20261102, slug = 'xl-book', tag = 'XB' } = opts;
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const sentence = (n) => {
    const w = [];
    for (let i = 0; i < n; i++) w.push(pick(WORDS));
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return `${w.join(' ')}.`;
  };
  const paragraph = (words, link) => {
    const out = [];
    let count = 0;
    while (count < words) {
      const n = Math.min(words - count, 7 + Math.floor(rand() * 9));
      const s = n < 3 ? `${pick(WORDS)}.` : sentence(n);
      out.push(s);
      count += s.split(/\s+/).length;
    }
    const text = out.join(' ');
    return link ? text.replace(/\.$/, `, near [[${link}]].`) : text;
  };
  const put = (rel, text) => {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  const id = (kind, n) => `${kind}_${ulid(tag, n)}`;

  // Codex entries first: scenes name them
  const entries = [];
  for (let i = 0; i < characters + locations; i++) {
    const type = i < characters ? 'character' : 'location';
    const name = `${SYL_A[i % SYL_A.length]}${SYL_B[Math.floor(i / SYL_A.length) % SYL_B.length]}${Math.floor(i / (SYL_A.length * SYL_B.length)) || ''}`;
    entries.push({ n: i + 1, type, folder: type === 'character' ? 'characters' : 'locations', name, slug: name.toLowerCase() });
  }
  const chars = entries.filter((e) => e.type === 'character');
  const locs = entries.filter((e) => e.type === 'location');
  for (const e of entries) {
    put(`codex/${e.folder}/${e.slug}.md`, ['---', 'schema: storyforge.entry/v1', `id: ${id('entry', e.n)}`, `slug: ${e.slug}`, `type: ${e.type}`, `name: ${e.name}`, 'status: sketch', `role: ${q(pick(WORDS))}`, '---', '## Overview', sentence(12), ''].join('\n'));
  }

  const bookId = id('book', 1);
  put('book.md', `---\nschema: storyforge.book/v1\nid: ${bookId}\nslug: ${slug}\ntitle: The Extra Large Book\nsubtitle: ""\nprofile: fiction\nstatus: drafting\ngenre: [synthetic]\nword_target: 600000\nlanguage: en\n---\nA generated book for the benchmark.\n`);
  const perAct = Math.ceil(chapters / acts);
  for (let a = 1; a <= acts; a++) put(`manuscript/act-${pad(a, 2)}-part-${a}/act.md`, `---\nschema: storyforge.act/v1\nid: ${id('act', a)}\nact: ${a}\ntitle: Part ${a}\n---\n`);
  let words = 0;
  let sceneN = 0;
  const sceneIds = [];
  const scenePaths = [];
  for (let c = 1; c <= chapters; c++) {
    const act = Math.min(acts, Math.ceil(c / perAct));
    const chDir = `manuscript/act-${pad(act, 2)}-part-${act}/ch-${pad(c, 3)}-chapter-${c}`;
    put(`${chDir}/chapter.md`, `---\nschema: storyforge.chapter/v1\nid: ${id('chap', c)}\nchapter: ${c}\nlabel: Chapter ${c}\ntitle: Chapter ${c}\nstatus: drafting\nsummary: ${q(`Summary of chapter ${c}.`)}\n---\nNotes for chapter ${c}.\n`);
    for (let s = 1; s <= scenesPerChapter; s++) {
      sceneN++;
      const i = sceneN - 1;
      const pov = chars[(i * 7) % chars.length];
      const cast = [...new Set([pov, chars[(i * 3 + 1) % chars.length], chars[(i * 5 + 2) % chars.length]].map((x) => x.slug))];
      const fm = [
        '---', 'schema: storyforge.scene/v1', `id: ${id('scene', sceneN)}`, `title: ${q(`Scene ${sceneN}`)}`, `act: ${act}`, `chapter: ${c}`, `sequence: ${s * 10}`, `status: ${STATUS[i % 4]}`,
        `pov: ${pov.slug}`, `characters: [${cast.join(', ')}]`, `locations: [${locs[i % locs.length].slug}, ${locs[(i * 11 + 3) % locs.length].slug}]`, `summary: ${q(`What happens in scene ${sceneN}.`)}`, '---',
      ];
      const target = wordsPerScene + (i % 13);
      const paras = [];
      for (let p = 0; p < 4; p++) paras.push(paragraph(Math.round(target / 4), p % 2 === 0 ? pick(entries).slug : null));
      words += paras.join(' ').split(/\s+/).length;
      const rel = `${chDir}/${pad(s * 10, 4)}-scene-${sceneN}.md`;
      put(rel, `${fm.join('\n')}\n${paras.join('\n\n')}\n`);
      sceneIds.push(id('scene', sceneN));
      scenePaths.push(rel);
    }
  }
  return { root: dir, stats: { acts, chapters, scenes: sceneN, words, entries: entries.length, bookId, sceneIds, scenePaths } };
}
