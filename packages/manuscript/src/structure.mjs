// Structure commands (M03-J01): scene fields, chapters, acts, renumber chapters, archive chapter,
// split, merge, undo. Every one has a dry run, refuses on a broken book and goes through the store.
import path from 'node:path';
import {
  editFrontMatterLine,
  formatYamlString,
  readSimpleLine,
  splitDocument,
  topLevelBlocks,
} from './frontmatter.mjs';
import { fail, finish, guarded, isInt, placementNeighbours, prepare, readBytes, sceneChange, STATUSES, unsimpleResult } from './ops.mjs';
import { makePathResolver, sceneFileName, sceneSlugOf } from './paths.mjs';
import { placeInChapter } from './seq.mjs';
import { newSceneId, pad, sha256, slugify, SLUG_RE, ulid } from './util.mjs';

const ACT_DIR_RE = /^act-(\d+)(?:-|$)/;
const CHAP_DIR_RE = /^ch-(\d+)(?:-|$)/;
const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
/** UTF-8 text as the latin1 string form used for byte-exact splicing. */
const l1 = (t) => Buffer.from(t, 'utf8').toString('latin1');
const isText = (v) => typeof v === 'string' && !CONTROL_RE.test(v);

// ------------------------------------------------------------------ shared helpers

async function dirsOf(store, rel) {
  return (await store.list(rel)).filter((e) => e.isDirectory && !e.name.startsWith('.')).map((e) => e.name).sort();
}

/** act.md / chapter.md files under manuscript/ by their number fields (not by folder). */
async function scanMeta(store) {
  const acts = [];
  const chapters = [];
  const actNumbers = [];
  for (const a of await dirsOf(store, 'manuscript')) {
    const am = ACT_DIR_RE.exec(a);
    const actNum = am ? Number(am[1]) : null;
    if (actNum !== null) actNumbers.push(actNum);
    const number = async (rel, key) => {
      const read = await store.read(rel);
      const n = read ? readSimpleLine(read.bytes, key) : null;
      return n !== null && /^\d+$/.test(n) ? Number(n) : null;
    };
    const actRel = `manuscript/${a}/act.md`;
    const an = await number(actRel, 'act');
    if (an !== null) acts.push({ n: an, rel: actRel });
    for (const c of await dirsOf(store, `manuscript/${a}`)) {
      const rel = `manuscript/${a}/${c}/chapter.md`;
      const cn = await number(rel, 'chapter');
      if (cn !== null) chapters.push({ n: cn, rel, actNum });
    }
  }
  return { acts, chapters, actNumbers };
}

/**
 * Edit lines of one file. edits: [{ key, value, anchors? }]. Returns { change } (null when nothing changes)
 * or { refusal } (a ready failure result).
 */
async function lineEdit(store, rel, edits, to = rel) {
  const before = await readBytes(store, rel);
  let buf = before;
  for (const e of edits) {
    const r = editFrontMatterLine(buf, e.key, e.value, { anchors: e.anchors, plain: e.plain });
    if (!r.ok) {
      return { refusal: r.code === 'REFUSED_UNSIMPLE_FIELD' ? fail(r.code, `${rel}: ${r.message}`, { file: rel, field: r.field }) : fail(r.code, r.message) };
    }
    buf = r.buf;
  }
  if (to === rel && buf.equals(before)) return { change: null };
  return { change: { from: rel, to, content: buf, before } };
}

const created = (to, text) => ({ from: null, to, content: Buffer.from(text, 'utf8'), before: null });

const chapterFileText = ({ id, chapter, label, title }) =>
  `---\nschema: storyforge.chapter/v1\nid: ${id}\nchapter: ${chapter}\n` +
  `${label !== undefined ? `label: ${formatYamlString(label)}\n` : ''}${title !== undefined ? `title: ${formatYamlString(title)}\n` : ''}---\n`;

const withNumber = (nums) => nums.filter((n) => Number.isInteger(n));

// ------------------------------------------------------------------ setSceneFields

/**
 * Single-line front-matter edits for title / status / pov / summary; optionally also rename the file.
 * @param {string} bookRoot @param {string} sceneId
 * @param {{title?:string, status?:string, pov?:string, summary?:string, renameFile?:boolean, dryRun?:boolean}} args
 */
export function setSceneFields(bookRoot, sceneId, args = {}) {
  return guarded(async () => {
    const { title, status, pov, summary, renameFile = false, dryRun = false } = args ?? {};
    if (typeof sceneId !== 'string') return fail('REFUSED_BAD_ARGS', 'sceneId must be a string');
    if (title === undefined && status === undefined && pov === undefined && summary === undefined && !renameFile) return fail('REFUSED_BAD_ARGS', 'nothing to change');
    if (title !== undefined && (!isText(title) || title.length > 300)) return fail('REFUSED_BAD_ARGS', 'title must be a string without control characters (max 300)');
    if (status !== undefined && !STATUSES.includes(status)) return fail('REFUSED_BAD_ARGS', `status must be one of ${STATUSES.join(', ')}`);
    if (pov !== undefined && (typeof pov !== 'string' || !SLUG_RE.test(pov) || pov.length > 60)) return fail('REFUSED_BAD_ARGS', 'pov must be a codex slug');
    if (summary !== undefined && (!isText(summary) || summary.length > 2000)) return fail('REFUSED_BAD_ARGS', 'summary must be a single line of text without line breaks (max 2000)');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const scene = lb.book.order.find((s) => s.id === sceneId);
    if (!scene) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${sceneId} in the book order`);

    let to = scene.path;
    if (renameFile) {
      const slug = slugify(title ?? scene.title) || 'untitled';
      to = `${path.posix.dirname(scene.path)}/${sceneFileName(scene.sequence, slug)}`;
    }
    const edits = [];
    if (title !== undefined) edits.push({ key: 'title', value: title });
    if (status !== undefined) edits.push({ key: 'status', value: status });
    if (pov !== undefined) edits.push({ key: 'pov', value: pov });
    if (summary !== undefined) edits.push({ key: 'summary', value: summary, anchors: ['pov', 'status'], plain: true });
    const r = await lineEdit(store, scene.path, edits, to);
    if (r.refusal) return r.refusal;
    return finish({
      bookRoot,
      store,
      lb,
      op: 'setSceneFields',
      args: { sceneId, title, status, pov, summary, renameFile },
      changes: r.change ? [r.change] : [],
      dryRun,
      withDiff: true,
      extra: { id: sceneId, path: to },
    });
  });
}

// ------------------------------------------------------------------ chapters

/**
 * New chapter folder with chapter.md and one empty scene. The number is the next free one after `after`
 * (a chapter number; null = start of the act; omitted = end of the act); no gap -> NO_CHAPTER_GAP.
 * @param {string} bookRoot
 * @param {{act?:number, after?:number|null, title:string, dryRun?:boolean}} args
 */
export function createChapter(bookRoot, args = {}) {
  return guarded(async () => {
    const { act, after, title, dryRun = false } = args ?? {};
    if (!isText(title) || title.trim() === '' || title.length > 300) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters');
    if (act !== undefined && !isInt(act)) return fail('REFUSED_BAD_ARGS', 'act must be an integer >= 0');
    if (after !== undefined && after !== null && !isInt(after)) return fail('REFUSED_BAD_ARGS', 'after must be a chapter number, null or omitted');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const meta = await scanMeta(store);

    /** chapter number -> act number (scenes first, then the act folder of a metadata-only chapter) */
    const actOf = new Map();
    for (const c of meta.chapters) if (c.actNum !== null) actOf.set(c.n, c.actNum);
    for (const s of lb.book.order) actOf.set(s.chapter, s.act);
    for (const c of meta.chapters) if (!actOf.has(c.n)) actOf.set(c.n, undefined);
    const used = [...new Set([...actOf.keys()])].sort((a, b) => a - b);

    let targetAct = act;
    let candidate;
    if (typeof after === 'number') {
      if (!used.includes(after)) return fail('REFUSED_BAD_ANCHOR', `chapter ${after} does not exist`);
      targetAct ??= actOf.get(after);
      if (targetAct === undefined) return fail('REFUSED_BAD_ARGS', 'act is required (the chapter after has no known act)');
      candidate = after + 1;
    } else {
      if (targetAct === undefined) return fail('REFUSED_BAD_ARGS', 'act is required when no chapter is given to insert after');
      const below = used.filter((n) => (actOf.get(n) ?? targetAct) < targetAct || (after === undefined && (actOf.get(n) ?? targetAct) === targetAct));
      candidate = Math.max((below.length ? below[below.length - 1] : -1) + 1, 1);
    }
    if (used.includes(candidate)) {
      return fail('NO_CHAPTER_GAP', `no free chapter number right after ${typeof after === 'number' ? `chapter ${after}` : 'that position'}; renumber chapters first`, { chapter: candidate });
    }
    for (const n of used) {
      const a = actOf.get(n);
      if (a === undefined) continue;
      if ((n < candidate && a > targetAct) || (n > candidate && a < targetAct)) {
        return fail('REFUSED_BAD_ANCHOR', `chapter ${candidate} in act ${targetAct} would break the act order (chapter ${n} is in act ${a})`);
      }
    }

    const resolver = await makePathResolver(store);
    const actDir = path.posix.dirname(resolver.dir(targetAct, candidate));
    const chapDir = `${actDir}/ch-${pad(candidate, 3)}${slugify(title) ? `-${slugify(title)}` : ''}`;
    const sceneId = newSceneId();
    const chapterPath = `${chapDir}/chapter.md`;
    const scenePath = `${chapDir}/${sceneFileName(10, 'untitled')}`;
    const changes = [
      created(chapterPath, chapterFileText({ id: `chap_${ulid()}`, chapter: candidate, title })),
      created(
        scenePath,
        `---\nschema: storyforge.scene/v1\nid: ${sceneId}\ntitle: ""\nact: ${targetAct}\nchapter: ${candidate}\nsequence: 10\nstatus: drafting\n---\n`,
      ),
    ];
    return finish({
      bookRoot,
      store,
      lb,
      op: 'createChapter',
      args: { act: targetAct, after: after ?? null, title },
      changes,
      dryRun,
      withDiff: true,
      extra: { chapter: candidate, act: targetAct, path: scenePath, chapterPath, sceneId },
    });
  });
}

/**
 * Edit chapter.md title/label (created if missing).
 * @param {string} bookRoot @param {number} chapter @param {{title?:string, label?:string, dryRun?:boolean}} args
 */
export function setChapterFields(bookRoot, chapter, args = {}) {
  return guarded(async () => {
    const { title, label, dryRun = false } = args ?? {};
    if (!isInt(chapter)) return fail('REFUSED_BAD_ARGS', 'chapter must be an integer >= 0');
    if (title === undefined && label === undefined) return fail('REFUSED_BAD_ARGS', 'nothing to change');
    for (const [k, v] of [['title', title], ['label', label]]) {
      if (v !== undefined && (!isText(v) || v.length > 300)) return fail('REFUSED_BAD_ARGS', `${k} must be a string without control characters (max 300)`);
    }
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const meta = (await scanMeta(store)).chapters.find((c) => c.n === chapter);
    const scenes = lb.book.order.filter((s) => s.chapter === chapter);
    let change;
    if (meta) {
      const edits = [];
      if (label !== undefined) edits.push({ key: 'label', value: label, anchors: ['chapter'] });
      if (title !== undefined) edits.push({ key: 'title', value: title, anchors: ['label', 'chapter'] });
      const r = await lineEdit(store, meta.rel, edits);
      if (r.refusal) return r.refusal;
      change = r.change;
    } else {
      if (scenes.length === 0) return fail('REFUSED_UNKNOWN_CHAPTER', `chapter ${chapter} has no scenes and no chapter.md`);
      change = created(`${path.posix.dirname(scenes[0].path)}/chapter.md`, chapterFileText({ id: `chap_${ulid()}`, chapter, label, title }));
    }
    return finish({
      bookRoot,
      store,
      lb,
      op: 'setChapterFields',
      args: { chapter, title, label },
      changes: change ? [change] : [],
      dryRun,
      withDiff: true,
      extra: { chapter },
    });
  });
}

/**
 * Renumber chapters so they run 0/1..N in the current order (0 stays 0 unless `start` says otherwise): chapter lines of every
 * scene and chapter.md, folder names, and any other file in a moved chapter folder. Bodies are untouched.
 * @param {string} bookRoot @param {{step?:number, start?:0|1, dryRun?:boolean}} args
 */
export function renumberChapters(bookRoot, args = {}) {
  return guarded(async () => {
    const { step = 1, start, dryRun = false } = args ?? {};
    if (!isInt(step, 1)) return fail('REFUSED_BAD_ARGS', 'step must be an integer >= 1');
    if (start !== undefined && start !== 0 && start !== 1) return fail('REFUSED_BAD_ARGS', 'start must be 0 or 1');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const meta = await scanMeta(store);
    const nums = [...new Set([...lb.book.order.map((s) => s.chapter), ...meta.chapters.map((c) => c.n)])].sort((a, b) => a - b);
    // the first chapter is 0 when asked (a prologue as chapter 0) or when the book already starts at 0, else 1
    const base = start ?? (nums[0] === 0 ? 0 : 1);
    const mapping = new Map(nums.map((n, i) => [n, (base + i) * step]));
    const newOf = (n) => mapping.get(n) ?? n;

    const mapDir = (dir) => {
      const base = path.posix.basename(dir);
      const m = CHAP_DIR_RE.exec(base);
      if (!m || newOf(Number(m[1])) === Number(m[1])) return dir;
      return `${path.posix.dirname(dir)}/${base.replace(/^ch-\d+/, `ch-${pad(newOf(Number(m[1])), 3)}`)}`;
    };

    const changes = [];
    const handled = new Set();
    const take = async (rel, edits, to) => {
      handled.add(rel);
      const r = await sceneChange(store, { path: rel }, edits, to);
      if ('unsimple' in r) return unsimpleResult(r.unsimple);
      if (r.change) changes.push(r.change);
      return null;
    };
    for (const s of lb.book.order) {
      const bad = await take(s.path, newOf(s.chapter) === s.chapter ? {} : { chapter: newOf(s.chapter) }, `${mapDir(path.posix.dirname(s.path))}/${path.posix.basename(s.path)}`);
      if (bad) return bad;
    }
    for (const c of meta.chapters) {
      const bad = await take(c.rel, newOf(c.n) === c.n ? {} : { chapter: newOf(c.n) }, `${mapDir(path.posix.dirname(c.rel))}/chapter.md`);
      if (bad) return bad;
    }
    for (const x of lb.book.excluded.filter((e) => e.reason === 'variant')) {
      const dir = path.posix.dirname(x.path);
      const read = await store.read(x.path);
      const n = read ? readSimpleLine(read.bytes, 'chapter') : null;
      const edits = n !== null && /^\d+$/.test(n) && newOf(Number(n)) !== Number(n) ? { chapter: newOf(Number(n)) } : {};
      const bad = await take(x.path, edits, `${mapDir(dir)}/${path.posix.basename(x.path)}`);
      if (bad) return bad;
    }
    // anything else that lives in a folder that moves goes with it, unchanged
    const moved = new Set([...handled].map((p) => path.posix.dirname(p)).filter((d) => mapDir(d) !== d));
    for (const dir of moved) {
      for (const e of await store.list(dir)) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory || e.name.startsWith('.') || handled.has(rel)) continue;
        const before = await readBytes(store, rel);
        changes.push({ from: rel, to: `${mapDir(dir)}/${e.name}`, content: before, before });
      }
    }
    const res = await finish({
      bookRoot,
      store,
      lb,
      op: 'renumberChapters',
      args: { step, ...(start !== undefined ? { start } : {}) },
      changes,
      dryRun,
      withDiff: true,
      extra: { mapping: Object.fromEntries([...mapping].filter(([a, b]) => a !== b)) },
    });
    // a chapter folder the renumbering emptied is removed (only an empty one can be); undo recreates it
    if (res.ok && !dryRun) for (const dir of moved) await store.removeEmptyDir(dir);
    return res;
  });
}

/**
 * Move a whole chapter into an act (the same act or another), before or after the other chapters there.
 * `after` is a chapter number in the target act (null = first in the act; omitted = last in the act).
 *
 * Book order follows chapter numbers and an act may never come after a later act (E206), so the chapter
 * takes a number that fits its new place: it keeps its own when that already fits; otherwise a book numbered without
 * gaps is renumbered 1..N (0..N-1 when the book has a chapter 0) in the new order, so it stays without gaps, and a
 * book that already has gaps gives the chapter the first free number between its new neighbours when there is one
 * (else it too is renumbered in full). Every file of the moved chapter's folder (scenes, chapter.md, variants, anything else) goes
 * to the target act's folder; scenes get the new `act` (and `chapter`) line. Bodies are never touched.
 * @param {string} bookRoot @param {number} chapter
 * @param {{act:number, after?:number|null, dryRun?:boolean}} args
 */
export function moveChapter(bookRoot, chapter, args = {}) {
  return guarded(async () => {
    const { act, after, dryRun = false } = args ?? {};
    if (!isInt(chapter)) return fail('REFUSED_BAD_ARGS', 'chapter must be an integer >= 0');
    if (!isInt(act)) return fail('REFUSED_BAD_ARGS', 'act must be an integer >= 0');
    if (after !== undefined && after !== null && !isInt(after)) return fail('REFUSED_BAD_ARGS', 'after must be a chapter number, null or omitted');
    if (after === chapter) return fail('REFUSED_BAD_ANCHOR', 'a chapter cannot be placed after itself');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const meta = await scanMeta(store);

    // every live chapter with its act: scenes first, then the act folder of a chapter that only has chapter.md
    /** @type {Map<number, number>} */
    const actOf = new Map();
    for (const s of lb.book.order) actOf.set(s.chapter, s.act);
    for (const c of meta.chapters) if (!actOf.has(c.n) && c.actNum !== null) actOf.set(c.n, c.actNum);
    if (!actOf.has(chapter)) return fail('REFUSED_UNKNOWN_CHAPTER', `chapter ${chapter} has no scenes and no chapter.md in an act folder`);
    const acts = new Set([...actOf.values(), ...meta.acts.map((a) => a.n), ...withNumber(meta.actNumbers)]);
    if (!acts.has(act)) return fail('REFUSED_UNKNOWN_ACT', `act ${act} does not exist`);

    const order = [...actOf.keys()].sort((a, b) => a - b).map((n) => ({ n, act: actOf.get(n) }));
    const rest = order.filter((c) => c.n !== chapter);
    let at;
    if (typeof after === 'number') {
      const anchor = rest.findIndex((c) => c.n === after);
      if (anchor === -1) return fail('REFUSED_BAD_ANCHOR', `chapter ${after} does not exist`);
      if (rest[anchor].act !== act) return fail('REFUSED_BAD_ANCHOR', `chapter ${after} is not in act ${act}`);
      at = anchor + 1;
    } else {
      const inAct = rest.map((c, i) => (c.act === act ? i : -1)).filter((i) => i !== -1);
      if (inAct.length) at = after === null ? inAct[0] : inAct[inAct.length - 1] + 1;
      else {
        // an empty act: after every chapter of an earlier act, before every chapter of a later one
        const later = rest.findIndex((c) => c.act > act);
        at = later === -1 ? rest.length : later;
      }
    }
    const next = [...rest.slice(0, at), { n: chapter, act }, ...rest.slice(at)];
    for (let i = 1; i < next.length; i++) {
      if (next[i].act < next[i - 1].act) return fail('REFUSED_BAD_ANCHOR', `that place would put act ${next[i].act} after act ${next[i - 1].act}`);
    }

    // numbers: keep everyone's if the mover fits between its new neighbours. Otherwise a book numbered without gaps stays that way
    // (every chapter renumbered in the new order, from the same first number); a book that already has gaps gives the mover a free
    // number between its neighbours when there is one, else is renumbered in full.
    const prev = next[at - 1]?.n;
    const following = next[at + 1]?.n;
    const lo = prev === undefined ? 0 : prev + 1;
    const hi = following === undefined ? Infinity : following - 1;
    const first = order[0].n === 0 ? 0 : 1;
    const gapless = order.every((c, i) => c.n === order[0].n + i);
    /** @type {Map<number, number>} old number -> new number */
    const mapping = new Map(order.map((c) => [c.n, c.n]));
    if (chapter < lo || chapter > hi) {
      if (!gapless && lo <= hi) mapping.set(chapter, prev === undefined && hi >= 1 ? Math.max(1, lo) : lo);
      else next.forEach((c, i) => mapping.set(c.n, first + i));
    }
    const newOf = (n) => mapping.get(n) ?? n;
    const actAfter = (n) => (n === chapter ? act : actOf.get(n));

    // folders: a chapter's folder goes to its act's folder with ch-NNN for its new number (the rest of the name is kept)
    const resolver = await makePathResolver(store);
    const actDirOf = (a, n) => path.posix.dirname(resolver.dir(a, n));
    const mapDir = (dir, oldN) => {
      const n = newOf(oldN);
      const a = actAfter(oldN);
      if (n === oldN && a === actOf.get(oldN)) return dir;
      const base = path.posix.basename(dir);
      const name = CHAP_DIR_RE.test(base) ? base.replace(/^ch-\d+/, `ch-${pad(n, 3)}`) : base;
      return `${a === actOf.get(oldN) ? path.posix.dirname(dir) : actDirOf(a, n)}/${name}`;
    };

    const changes = [];
    const handled = new Set();
    /** @type {Map<string, string>} old folder -> new folder */
    const movedDirs = new Map();
    const take = async (rel, edits, to) => {
      handled.add(rel);
      const r = await sceneChange(store, { path: rel }, edits, to);
      if ('unsimple' in r) return unsimpleResult(r.unsimple);
      if (r.change) changes.push(r.change);
      return null;
    };
    const editsFor = (oldN, { withAct }) => {
      const e = {};
      if (newOf(oldN) !== oldN) e.chapter = newOf(oldN);
      if (withAct && actAfter(oldN) !== actOf.get(oldN)) e.act = actAfter(oldN);
      return e;
    };
    for (const s of lb.book.order) {
      const dir = path.posix.dirname(s.path);
      const to = mapDir(dir, s.chapter);
      if (to !== dir) movedDirs.set(dir, to);
      const bad = await take(s.path, editsFor(s.chapter, { withAct: true }), `${to}/${path.posix.basename(s.path)}`);
      if (bad) return bad;
    }
    for (const c of meta.chapters) {
      if (!actOf.has(c.n)) continue;
      const dir = path.posix.dirname(c.rel);
      const to = mapDir(dir, c.n);
      if (to !== dir) movedDirs.set(dir, to);
      const bad = await take(c.rel, editsFor(c.n, { withAct: false }), `${to}/chapter.md`);
      if (bad) return bad;
    }
    for (const x of lb.book.excluded.filter((e) => e.reason === 'variant')) {
      const dir = path.posix.dirname(x.path);
      if (!movedDirs.has(dir)) continue;
      const read = await store.read(x.path);
      const n = read ? readSimpleLine(read.bytes, 'chapter') : null;
      const oldN = n !== null && /^\d+$/.test(n) ? Number(n) : null;
      const edits = {};
      if (oldN !== null) {
        const e = editsFor(oldN, { withAct: true });
        for (const k of Object.keys(e)) if (new RegExp(`^${k}:`, 'm').test(read.bytes.toString('latin1'))) edits[k] = e[k];
      }
      const bad = await take(x.path, edits, `${movedDirs.get(dir)}/${path.posix.basename(x.path)}`);
      if (bad) return bad;
    }
    // anything else in a folder that moves goes with it, unchanged
    for (const [dir, to] of movedDirs) {
      for (const e of await store.list(dir)) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory || e.name.startsWith('.') || handled.has(rel)) continue;
        const before = await readBytes(store, rel);
        changes.push({ from: rel, to: `${to}/${e.name}`, content: before, before });
      }
    }
    const renumbered = Object.fromEntries([...mapping].filter(([a, b]) => a !== b));
    const res = await finish({
      bookRoot,
      store,
      lb,
      op: 'moveChapter',
      args: { chapter, act, after: after ?? null },
      changes,
      dryRun,
      withDiff: true,
      extra: { chapter: newOf(chapter), act, mapping: renumbered },
    });
    // a folder the move emptied is removed (only an empty one can be); undo recreates it
    if (res.ok && !dryRun) for (const dir of movedDirs.keys()) await store.removeEmptyDir(dir);
    return res;
  });
}

/**
 * Archive every scene of a chapter, its chapter.md and its variants in one batch.
 * @param {string} bookRoot @param {number} chapter @param {{dryRun?:boolean}} args
 */
export function archiveChapter(bookRoot, chapter, args = {}) {
  return guarded(async () => {
    const { dryRun = false } = args ?? {};
    if (!isInt(chapter)) return fail('REFUSED_BAD_ARGS', 'chapter must be an integer >= 0');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const scenes = lb.book.order.filter((s) => s.chapter === chapter);
    const metaFile = (await scanMeta(store)).chapters.find((c) => c.n === chapter);
    if (scenes.length === 0 && !metaFile) return fail('REFUSED_UNKNOWN_CHAPTER', `chapter ${chapter} has no scenes and no chapter.md`);
    const dirs = new Set(scenes.map((s) => path.posix.dirname(s.path)));
    const files = [
      ...scenes.map((s) => s.path),
      ...(metaFile ? [metaFile.rel] : []),
      ...lb.book.excluded.filter((e) => e.reason === 'variant' && dirs.has(path.posix.dirname(e.path))).map((e) => e.path),
    ];
    const changes = [];
    for (const rel of [...new Set(files)]) {
      const before = await readBytes(store, rel);
      changes.push({ from: rel, to: `archive/${rel}`, content: before, before });
    }
    return finish({ bookRoot, store, lb, op: 'archiveChapter', args: { chapter }, changes, dryRun, withDiff: true, extra: { chapter } });
  });
}

// ------------------------------------------------------------------ acts

/**
 * Next act number (after every act in scenes, act.md and act folders); creates manuscript/act-NN-<slug>/act.md.
 * @param {string} bookRoot @param {{title:string, dryRun?:boolean}} args
 */
export function createAct(bookRoot, args = {}) {
  return guarded(async () => {
    const { title, dryRun = false } = args ?? {};
    if (!isText(title) || title.trim() === '' || title.length > 300) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const meta = await scanMeta(store);
    const n = Math.max(0, ...lb.book.order.map((s) => s.act), ...meta.acts.map((a) => a.n), ...withNumber(meta.actNumbers)) + 1;
    const slug = slugify(title);
    const rel = `manuscript/act-${pad(n, 2)}${slug ? `-${slug}` : ''}/act.md`;
    const text = `---\nschema: storyforge.act/v1\nid: act_${ulid()}\nact: ${n}\ntitle: ${formatYamlString(title)}\n---\n`;
    return finish({ bookRoot, store, lb, op: 'createAct', args: { title, act: n }, changes: [created(rel, text)], dryRun, withDiff: true, extra: { act: n, path: rel } });
  });
}

/**
 * Edit act.md title (created if missing).
 * @param {string} bookRoot @param {number} act @param {{title:string, dryRun?:boolean}} args
 */
export function setActFields(bookRoot, act, args = {}) {
  return guarded(async () => {
    const { title, dryRun = false } = args ?? {};
    if (!isInt(act)) return fail('REFUSED_BAD_ARGS', 'act must be an integer >= 0');
    if (!isText(title) || title.length > 300) return fail('REFUSED_BAD_ARGS', 'title must be a string without control characters (max 300)');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const metaFile = (await scanMeta(store)).acts.find((a) => a.n === act);
    let change;
    if (metaFile) {
      const r = await lineEdit(store, metaFile.rel, [{ key: 'title', value: title, anchors: ['act'] }]);
      if (r.refusal) return r.refusal;
      change = r.change;
    } else {
      const scene = lb.book.order.find((s) => s.act === act);
      if (!scene) return fail('REFUSED_UNKNOWN_ACT', `act ${act} has no scenes and no act.md`);
      const segs = scene.path.split('/');
      const dir = segs.length >= 3 && ACT_DIR_RE.test(segs[1]) ? `manuscript/${segs[1]}` : path.posix.dirname((await makePathResolver(store)).dir(act, 0));
      change = created(`${dir}/act.md`, `---\nschema: storyforge.act/v1\nid: act_${ulid()}\nact: ${act}\ntitle: ${formatYamlString(title)}\n---\n`);
    }
    return finish({ bookRoot, store, lb, op: 'setActFields', args: { act, title }, changes: change ? [change] : [], dryRun, withDiff: true, extra: { act } });
  });
}

// ------------------------------------------------------------------ split / merge

const splitKeepLines = (text) => text.match(/[^\n]*\n|[^\n]+/g) ?? [];

/** Is the start of line `atLine` (1-based) inside a fenced code block, an HTML comment or an sf:anchor range? */
function insideFenceOrComment(lines, atLine) {
  let fence = null;
  let comment = false;
  let anchors = 0;
  for (let i = 0; i < atLine - 1; i++) {
    const text = lines[i].replace(/\r?\n$/, '');
    if (!comment && fence) {
      const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    if (!comment) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = { ch: m[1][0], len: m[1].length };
        continue;
      }
    }
    if (!comment) {
      for (const m of text.matchAll(/<!--\s*(\/?)sf:anchor\b[^>]*?-->/g)) anchors = m[1] ? Math.max(0, anchors - 1) : anchors + 1;
    }
    let pos = 0;
    for (;;) {
      if (comment) {
        const e = text.indexOf('-->', pos);
        if (e < 0) break;
        comment = false;
        pos = e + 3;
      } else {
        const s = text.indexOf('<!--', pos);
        if (s < 0) break;
        comment = true;
        pos = s + 4;
      }
    }
  }
  return fence !== null || comment || anchors > 0;
}

/**
 * Split a scene's body at a body line: lines before stay, lines from `atLine` become a new scene right after it.
 * @param {string} bookRoot @param {string} sceneId @param {{atLine:number, dryRun?:boolean}} args
 */
export function splitScene(bookRoot, sceneId, args = {}) {
  return guarded(async () => {
    const { atLine, dryRun = false } = args ?? {};
    if (typeof sceneId !== 'string') return fail('REFUSED_BAD_ARGS', 'sceneId must be a string');
    if (!isInt(atLine, 1)) return fail('REFUSED_BAD_ARGS', 'atLine must be an integer >= 1 (a line of the body)');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const scene = lb.book.order.find((s) => s.id === sceneId);
    if (!scene) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${sceneId} in the book order`);
    const before = await readBytes(store, scene.path);
    const doc = splitDocument(before);
    if (!doc) return fail('REFUSED_BAD_ARGS', 'the scene has no front matter');
    const lines = splitKeepLines(before.toString('latin1').slice(doc.bodyStart));
    if (atLine > lines.length) return fail('REFUSED_BAD_ARGS', `atLine ${atLine} is past the end of the body (${lines.length} lines)`);
    if (insideFenceOrComment(lines, atLine)) {
      return fail('BAD_SPLIT_POINT', `line ${atLine} is inside a fenced code block, an HTML comment or an sf:anchor range`, { atLine });
    }
    const body1 = lines.slice(0, atLine - 1).join('');
    const body2 = lines.slice(atLine - 1).join('');

    const list = lb.book.order.filter((s) => s.chapter === scene.chapter);
    const place = placeInChapter(list, scene.id);
    const nb = await placementNeighbours(store, list, place);
    if (nb.unsimple) return unsimpleResult(nb.unsimple);

    // the original keeps its front matter (maybe a renumbered sequence line) and its first lines
    const changes = [...nb.changes];
    const own = changes.find((c) => c.from === scene.path);
    const baseContent = own ? own.content : before;
    const baseDoc = /** @type {{bodyStart:number}} */ (splitDocument(baseContent));
    const content1 = Buffer.concat([baseContent.subarray(0, baseDoc.bodyStart), Buffer.from(body1, 'latin1')]);
    if (own) own.content = content1;
    else changes.push({ from: scene.path, to: scene.path, content: content1, before });

    const eol = doc.region.includes('\r\n') ? '\r\n' : '\n';
    const blocks = topLevelBlocks(doc.region);
    const raw = (k) => blocks.find((b) => b.key === k)?.text ?? '';
    const newId = newSceneId();
    const title2 = `${scene.title} (part 2)`.trim();
    const slug = `${sceneSlugOf(scene.path).slice(0, 50).replace(/-+$/, '')}-part-2`;
    const resolver = await makePathResolver(store);
    const to = resolver.scenePath(scene.act, scene.chapter, nb.moverSequence, slug);
    const front =
      `---${eol}${raw('schema') || `schema: storyforge.scene/v1${eol}`}id: ${newId}${eol}title: ${l1(formatYamlString(title2))}${eol}` +
      `${raw('act')}${raw('chapter')}sequence: ${nb.moverSequence}${eol}${raw('status')}${raw('pov')}${raw('characters')}${raw('locations')}---${eol}`;
    const content2 = Buffer.from(front + body2, 'latin1');
    changes.push({ from: null, to, content: content2, before: null });

    return finish({
      bookRoot,
      store,
      lb,
      op: 'splitScene',
      args: { sceneId, atLine },
      changes,
      dryRun,
      withDiff: true,
      extra: { id: newId, path: to, sequence: nb.moverSequence, sceneId },
    });
  });
}

/**
 * Merge two adjacent scenes of one chapter: the first gets both bodies, the second is archived (with a note).
 * @param {string} bookRoot @param {string} firstId @param {string} secondId @param {{dryRun?:boolean}} args
 */
export function mergeScenes(bookRoot, firstId, secondId, args = {}) {
  return guarded(async () => {
    const { dryRun = false } = args ?? {};
    if (typeof firstId !== 'string' || typeof secondId !== 'string') return fail('REFUSED_BAD_ARGS', 'firstId and secondId must be strings');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const order = lb.book.order;
    const i = order.findIndex((s) => s.id === firstId);
    const j = order.findIndex((s) => s.id === secondId);
    if (i < 0 || j < 0) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${i < 0 ? firstId : secondId} in the book order`);
    if (j !== i + 1 || order[i].chapter !== order[j].chapter) {
      return fail('REFUSED_NOT_ADJACENT', 'only a scene and the scene right after it in the same chapter can be merged');
    }
    const [a, b] = [order[i], order[j]];
    const aBytes = await readBytes(store, a.path);
    const bBytes = await readBytes(store, b.path);
    const aDoc = splitDocument(aBytes);
    const bDoc = splitDocument(bBytes);
    if (!aDoc || !bDoc) return fail('REFUSED_BAD_ARGS', 'a scene has no front matter');
    const aBody = aBytes.toString('latin1').slice(aDoc.bodyStart);
    const bBody = bBytes.toString('latin1').slice(bDoc.bodyStart);
    const eolA = aBody.includes('\r\n') ? '\r\n' : '\n';
    // exactly one blank line between the two bodies, counting blank lines the bodies already have there
    let sep = '';
    if (aBody !== '' && bBody !== '') {
      const leadingBlank = /^(?:[ \t]*\r?\n)*/.exec(bBody)[0].match(/\n/g)?.length ?? 0;
      const trailingNewlines = /(?:\r?\n)*$/.exec(aBody)[0].match(/\n/g)?.length ?? 0;
      if (trailingNewlines === 0) sep = leadingBlank > 0 ? eolA : eolA + eolA;
      else if (Math.max(0, trailingNewlines - 1) + leadingBlank === 0) sep = eolA;
    }
    const merged = Buffer.concat([aBytes, Buffer.from(sep, 'latin1'), bBytes.subarray(bDoc.bodyStart)]);

    const eolB = bDoc.region.includes('\r\n') || bBody.includes('\r\n') ? '\r\n' : '\n';
    const note = `<!-- merged into ${firstId} on ${new Date().toISOString().slice(0, 10)} -->`;
    const archived = Buffer.concat([bBytes, Buffer.from(`${bBytes.length > 0 && bBytes[bBytes.length - 1] === 0x0a ? '' : eolB}${note}${eolB}`, 'utf8')]);

    const notMerged = topLevelBlocks(bDoc.region)
      .filter((blk) => ['characters', 'locations', 'plot_threads'].includes(blk.key))
      .map((blk) => ({ key: blk.key, text: blk.text.replace(/\r?\n$/, '') }));
    const changes = [
      { from: a.path, to: a.path, content: merged, before: aBytes },
      { from: b.path, to: `archive/${b.path}`, content: archived, before: bBytes },
    ];
    return finish({
      bookRoot,
      store,
      lb,
      op: 'mergeScenes',
      args: { firstId, secondId },
      changes,
      dryRun,
      withDiff: true,
      extra: { id: firstId, archived: `archive/${b.path}`, not_merged: notMerged },
    });
  });
}

// ------------------------------------------------------------------ undo

/** Operations whose created files restoreOp may remove again. */
const CREATION_UNDOABLE = new Set(['createContinuityException', 'decideSuggestion', 'createLink', 'saveScenePlan', 'saveStoryPlan', 'createArc', 'createStructure', 'createRelationship', 'createSynopsis', 'createClue']); // Story Planner M1-M8: a new link, scene plan, story plan, arc, structure, relationship, synopsis or clue is planning data only, so undo may remove it again (to the trash)

/**
 * Could restoreOp undo this recorded operation (`trash/<opId>/op.json`), judging by what it recorded alone? The same test restoreOp starts with; whether the files
 * are still as the operation left them is only known when the undo is tried. M12 AI Activity uses it to show Undo only where it can work.
 * @param {any} record the parsed op.json @returns {boolean}
 */
export function opUndoable(record) {
  const all = Array.isArray(record?.changes) ? record.changes : [];
  const recorded = all.filter((c) => !(typeof c.to === 'string' && c.to.startsWith('provenance/')));
  if (recorded.length === 0) return false;
  const froms = recorded.map((c) => c.from).filter((f) => f !== null);
  const tos = recorded.map((c) => c.to);
  if (!CREATION_UNDOABLE.has(record?.op) && recorded.some((c) => c.from === null)) return false;
  return new Set(froms).size === froms.length && new Set(tos).size === tos.length;
}

/**
 * Undo one earlier operation from its trash copies, but only if every file it wrote still has the hash the
 * operation gave it. Operations that created files, or touched one path twice, are not undoable this way.
 * Receipts (M05-J07) are records and are never undone: the files under provenance/ that the operation wrote are left as they are, and when the operation
 * had receipts `hooks.stage(tx, changes)` lets the caller write the undo's own receipt in the undo's batch.
 * @param {string} bookRoot @param {string} opId @param {{dryRun?:boolean}} [args] @param {{ stage?: (tx: any, changes: any[]) => Promise<void> }} [hooks]
 */
export function restoreOp(bookRoot, opId, args = {}, hooks = {}) {
  return guarded(async () => {
    const { dryRun = false } = args ?? {};
    if (typeof opId !== 'string') return fail('REFUSED_BAD_ARGS', 'opId must be a string');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const raw = await store.readTrash(opId, 'op.json');
    if (!raw) return fail('REFUSED_UNKNOWN_OP', `no recorded operation ${opId}`);
    let record;
    try {
      record = JSON.parse(raw.toString('utf8'));
    } catch {
      return fail('REFUSED_UNKNOWN_OP', `the record of ${opId} cannot be read`);
    }
    const isReceiptFile = (c) => typeof c.to === 'string' && c.to.startsWith('provenance/');
    const hadReceipts = (Array.isArray(record?.changes) ? record.changes : []).some(isReceiptFile);
    const recorded = (Array.isArray(record?.changes) ? record.changes : []).filter((c) => !isReceiptFile(c));
    if (recorded.length === 0) return fail('REFUSED_NOT_UNDOABLE', `${opId} changed no files`);
    // A move that renumbers neighbours may write a file at a path another of its changes vacated (a chain); that is
    // undone in the reverse order. Only a path read twice or written twice makes an operation not undoable.
    // The exceptions (M05-J02, M05-J06): a continuity exception file, or the new file a suggestion's accepted new-file hunk created, can be undone by
    // removing it again (it goes to the trash). Accepting a hunk on an existing file creates nothing and is undone like any other write.
    const creationsOk = CREATION_UNDOABLE.has(record?.op);
    const froms = recorded.map((c) => c.from).filter((f) => f !== null);
    const tos = recorded.map((c) => c.to);
    if ((!creationsOk && recorded.some((c) => c.from === null)) || new Set(froms).size !== froms.length || new Set(tos).size !== tos.length) {
      return fail('REFUSED_NOT_UNDOABLE', `${opId} created files or touched a file twice; it cannot be undone automatically`);
    }
    const changes = [];
    for (const c of recorded) {
      const now = await store.read(c.to);
      if (!now || sha256(now.bytes) !== c.after_sha256) {
        return fail('REFUSED_FILES_CHANGED', `${c.to} is not as ${opId} left it (it was changed or moved since), so the undo was not applied`, { file: c.to });
      }
      if (c.from === null) {
        changes.push({ from: c.to, to: null, content: null, before: now.bytes }); // undo of a creation: remove the file
        continue;
      }
      if (c.from !== c.to && !recorded.some((o) => o !== c && o.to === c.from) && (await store.exists(c.from))) {
        return fail('REFUSED_FILES_CHANGED', `${c.from} exists again, so the undo was not applied`, { file: c.from });
      }
      const old = await store.readTrash(opId, c.from);
      if (!old || sha256(old) !== c.before_sha256) return fail('REFUSED_TRASH_MISSING', `the saved copy of ${c.from} is missing or does not match`, { file: c.from });
      changes.push({ from: c.to, to: c.from, content: old, before: now.bytes });
    }
    return finish({ bookRoot, store, lb, op: 'restoreOp', args: { opId }, changes, dryRun, withDiff: true, extra: { restored: opId }, stage: hadReceipts ? hooks?.stage : undefined });
  });
}
