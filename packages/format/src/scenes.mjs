// Scene ordering (spec 4.2), consistency rules (E204-E207), folder/prefix checks (W201, W202),
// act/chapter labels (4.5).
import path from 'node:path';
import { byCodePoint } from './fs.mjs';

/** @param {any} v */
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

const ACT_DIR_RE = /^act-(\d+)(?:-|$)/;
const CHAP_DIR_RE = /^ch-(\d+)(?:-|$)/;
const PREFIX_RE = /^(\d+)-/;

/** @param {string} rel path without a leading archive/ segment */
const stripArchive = (rel) => (rel.startsWith('archive/') ? rel.slice('archive/'.length) : rel);

/**
 * @param {import('./load.mjs').Doc[]} docs all parsed documents of one book
 * @param {string} bookPath book root relative to the validated root ("" if it is the root)
 * @param {(code:string,file:string,loc:string,msg:string)=>void} add
 */
export function analyzeScenes(docs, bookPath, add) {
  const scenes = docs.filter((d) => d.kind === 'scene');

  // ----- act / chapter metadata (E207, W202 on the metadata files)
  /** @type {Map<number, import('./load.mjs').Doc[]>} */
  const chapterMeta = new Map();
  /** @type {Map<number, import('./load.mjs').Doc[]>} */
  const actMeta = new Map();
  for (const d of docs) {
    if (d.archived) continue;
    const table = d.kind === 'chapter' ? chapterMeta : d.kind === 'act' ? actMeta : null;
    const field = d.kind === 'chapter' ? 'chapter' : 'act';
    if (!table || !isInt(d.fm[field]) || d.fm[field] < 0) continue;
    if (!table.has(d.fm[field])) table.set(d.fm[field], []);
    table.get(d.fm[field]).push(d);
  }
  for (const [table, field] of [[chapterMeta, 'chapter'], [actMeta, 'act']]) {
    for (const [n, list] of table) {
      if (list.length < 2) continue;
      for (const d of list) add('E207', d.file, field, `duplicate ${field} metadata number ${n}`);
    }
  }
  for (const d of docs) {
    if (d.kind !== 'chapter' && d.kind !== 'act') continue;
    const field = d.kind === 'chapter' ? 'chapter' : 'act';
    if (!isInt(d.fm[field])) continue;
    const dirName = path.posix.basename(path.posix.dirname(d.rel));
    const m = (d.kind === 'chapter' ? CHAP_DIR_RE : ACT_DIR_RE).exec(dirName);
    if (m && Number(m[1]) !== d.fm[field]) {
      add('W202', d.file, field, `folder ${dirName} but ${field}=${d.fm[field]}`);
    }
  }

  // ----- placement checks and exclusions
  /** @type {{id:string|null, path:string, reason:string}[]} */
  const excluded = [];
  /** @type {import('./load.mjs').Doc[]} */
  const candidates = [];
  for (const d of scenes) {
    const id = typeof d.fm.id === 'string' ? d.fm.id : null;
    const logical = stripArchive(d.rel);
    const underManuscript = logical.startsWith('manuscript/');
    if (underManuscript) checkScenePlacement(d, logical);
    if (d.archived) {
      excluded.push({ id, path: d.file, reason: 'archived' });
    } else if (!underManuscript) {
      add('W201', d.file, 'schema', 'scene schema outside manuscript/');
      excluded.push({ id, path: d.file, reason: 'outside-manuscript' });
    } else if (typeof d.fm.variant_of === 'string' && d.fm.variant_of !== '') {
      excluded.push({ id, path: d.file, reason: 'variant' });
    } else if (
      id !== null && isInt(d.fm.act) && d.fm.act >= 0 && isInt(d.fm.chapter) && d.fm.chapter >= 0 &&
      isInt(d.fm.sequence) && d.fm.sequence >= 1
    ) {
      candidates.push(d);
    }
  }

  /** @param {import('./load.mjs').Doc} d @param {string} logical */
  function checkScenePlacement(d, logical) {
    const parts = logical.split('/').slice(1, -1); // folders between manuscript/ and the file
    const actDir = parts.map((p) => ACT_DIR_RE.exec(p)).find(Boolean);
    const chapDir = parts.map((p) => CHAP_DIR_RE.exec(p)).find(Boolean);
    const chapterBad = chapDir && isInt(d.fm.chapter) && Number(chapDir[1]) !== d.fm.chapter;
    const actBad = actDir && isInt(d.fm.act) && Number(actDir[1]) !== d.fm.act;
    if (chapterBad) add('W201', d.file, 'chapter', `chapter folder number ${Number(chapDir[1])} but chapter=${d.fm.chapter}`);
    else if (actBad) add('W201', d.file, 'act', `act folder number ${Number(actDir[1])} but act=${d.fm.act}`);
    const pm = PREFIX_RE.exec(path.posix.basename(logical));
    if (pm && isInt(d.fm.sequence) && Number(pm[1]) !== d.fm.sequence) {
      add('W202', d.file, 'sequence', `filename prefix ${pm[1]} but sequence=${d.fm.sequence}`);
    }
  }

  // ----- order
  const prefixNum = (d) => {
    const m = PREFIX_RE.exec(path.posix.basename(d.rel));
    return m ? Number(m[1]) : Infinity;
  };
  candidates.sort((a, b) => {
    const k = a.fm.chapter - b.fm.chapter || a.fm.sequence - b.fm.sequence;
    if (k) return k;
    const pa = prefixNum(a);
    const pb = prefixNum(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return byCodePoint(a.fm.id, b.fm.id);
  });

  // E204
  /** @type {Map<string, import('./load.mjs').Doc[]>} */
  const byKey = new Map();
  for (const d of candidates) {
    const key = `${d.fm.chapter}/${d.fm.sequence}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(d);
  }
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    for (const d of list) add('E204', d.file, 'sequence', `duplicate chapter ${d.fm.chapter} sequence ${d.fm.sequence}`);
  }

  // E205 / E206 (chapters in ascending order, scenes in order within each)
  /** @type {Map<number, import('./load.mjs').Doc[]>} */
  const byChapter = new Map();
  for (const d of candidates) {
    if (!byChapter.has(d.fm.chapter)) byChapter.set(d.fm.chapter, []);
    byChapter.get(d.fm.chapter).push(d);
  }
  let highestAct = -1;
  for (const [chapter, list] of byChapter) {
    const acts = new Set(list.map((d) => d.fm.act));
    if (acts.size > 1) {
      for (const d of list) add('E205', d.file, 'act', `scenes of chapter ${chapter} disagree on act (${[...acts].sort((x, y) => x - y).join(', ')})`);
    }
    if (list[0].fm.act < highestAct) {
      add('E206', list[0].file, 'act', `act ${list[0].fm.act} after an earlier chapter in act ${highestAct}`);
    }
    highestAct = Math.max(highestAct, ...acts);
  }

  // ----- Scene objects with labels
  const chapterLabel = (n) => {
    const meta = chapterMeta.get(n);
    const label = meta && typeof meta[0].fm.label === 'string' && meta[0].fm.label !== '' ? meta[0].fm.label : null;
    return label ?? (n === 0 ? 'Prologue' : `Chapter ${n}`);
  };
  const actLabel = (n) => (n === 0 ? 'Front Matter' : `Act ${n}`);

  /** @type {Map<import('./load.mjs').Doc, number>} */
  const positions = new Map();
  const order = candidates.map((d, i) => {
    positions.set(d, i + 1);
    return {
      position: i + 1,
      id: d.fm.id,
      title: typeof d.fm.title === 'string' ? d.fm.title : '',
      act: d.fm.act,
      chapter: d.fm.chapter,
      sequence: d.fm.sequence,
      act_label: actLabel(d.fm.act),
      chapter_label: chapterLabel(d.fm.chapter),
      path: d.file,
    };
  });

  excluded.sort((a, b) => byCodePoint(a.path, b.path));
  return { order, excluded, positions };
}
