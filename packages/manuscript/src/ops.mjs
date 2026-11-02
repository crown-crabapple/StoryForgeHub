// insertScene, moveScene, renumberChapter, planRepair, applyRepair.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadBook, manuscriptErrors } from './book.mjs';
import { commit, publicChanges } from './commit.mjs';
import { hasSimpleField, setFields, yamlQuote } from './frontmatter.mjs';
import { makePathResolver, sceneFileName, sceneSlugOf } from './paths.mjs';
import { placeInChapter } from './seq.mjs';
import { newSceneId, SCENE_ID_RE, SLUG_RE } from './util.mjs';

const STATUSES = ['outline', 'drafting', 'revised', 'final'];
const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;
const abs = (root, rel) => path.join(root, ...rel.split('/'));
const fail = (code, message, extra = {}) => ({ ok: false, code, changes: [], message, ...extra });

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Never throw on bad input: wrap every operation. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    return fail('ERROR', String(e?.message ?? e));
  }
}

/**
 * Load + rule 5. Returns {lb} or {result} (a refusal).
 * @param {string} bookRoot
 * @param {{allowCodes?:string[], onInvalid?:(lb:any, errs:object[])=>Promise<object|null>}} [opts]
 */
async function prepare(bookRoot, { allowCodes = [], onInvalid } = {}) {
  const lb = await loadBook(bookRoot);
  if ('error' in lb) return { result: fail(lb.error.code, lb.error.message) };
  const errs = manuscriptErrors(lb.diagnostics, allowCodes);
  if (errs.length) {
    const special = onInvalid ? await onInvalid(lb, errs) : null;
    return { result: special ?? fail('REFUSED_INVALID_BOOK', 'book has manuscript errors', { diagnostics: errs }) };
  }
  return { lb };
}

/**
 * Build a Change for a scene: apply front-matter edits, target path. Null if nothing changes.
 * @returns {Promise<{change:object|null} | {unsimple:{file:string, field:string}}>}
 */
async function sceneChange(root, scene, edits, to) {
  const before = await readFile(abs(root, scene.path));
  const r = setFields(before, edits);
  if ('error' in r) return { unsimple: { file: scene.path, field: r.error.field } };
  if (to === scene.path && r.buf.equals(before)) return { change: null };
  return { change: { from: scene.path, to, content: r.buf, before } };
}

const unsimpleResult = ({ file, field }) =>
  fail('REFUSED_UNSIMPLE_FIELD', `${file}: front-matter line for "${field}" is not a simple "${field}: <integer>"`, { file, field });

/** Reject targets that already exist (unless vacated by another change) or are claimed twice. */
async function checkPaths(root, changes) {
  const seen = new Set();
  for (const c of changes) {
    if (c.to === c.from) continue;
    if (seen.has(c.to)) return fail('REFUSED_PATH_TAKEN', `two changes target ${c.to}`, { path: c.to });
    seen.add(c.to);
    const vacated = changes.some((o) => o !== c && o.from === c.to);
    if (!vacated && (await exists(abs(root, c.to)))) {
      return fail('REFUSED_PATH_TAKEN', `target path already exists: ${c.to}`, { path: c.to });
    }
  }
  return null;
}

async function finish({ bookRoot, lb, op, args, changes, dryRun, extra = {} }) {
  const taken = await checkPaths(lb.root, changes);
  if (taken) return taken;
  if (dryRun) return { ok: true, code: 'OK', dryRun: true, changes: publicChanges(changes), ...extra };
  if (changes.length === 0) return { ok: true, code: 'OK', changes: [], ...extra };
  const res = await commit({ bookRoot, root: lb.root, op, args, changes, beforeDiagnostics: lb.diagnostics });
  return { ...res, ...extra };
}

/** Renumber step-wise within the same directory; scenes whose sequence and filename already match are skipped. */
async function renumberChanges(root, list, step) {
  const changes = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const seq = step * (i + 1);
    const to = `${path.posix.dirname(s.path)}/${sceneFileName(seq, sceneSlugOf(s.path))}`;
    const r = await sceneChange(root, s, seq === s.sequence ? {} : { sequence: seq }, to);
    if ('unsimple' in r) return { unsimple: r.unsimple };
    if (r.change) changes.push(r.change);
  }
  return { changes };
}

/**
 * Neighbour changes for a placement. With renumber, every scene of the chapter gets 10*(k+1) and
 * the mover takes its slot; otherwise neighbours are untouched.
 */
async function placementNeighbours(root, list, place) {
  if (!place.renumber) return { moverSequence: place.sequence, changes: [] };
  const changes = [];
  let moverSequence = null;
  let k = 0;
  for (let i = 0; i <= list.length; i++) {
    if (i === place.index) moverSequence = 10 * ++k;
    if (i === list.length) break;
    const s = list[i];
    const seq = 10 * ++k;
    if (seq === s.sequence) continue;
    const to = `${path.posix.dirname(s.path)}/${sceneFileName(seq, sceneSlugOf(s.path))}`;
    const r = await sceneChange(root, s, { sequence: seq }, to);
    if ('unsimple' in r) return { unsimple: r.unsimple };
    if (r.change) changes.push(r.change);
  }
  return { moverSequence, changes };
}

// ---------------------------------------------------------------- insertScene

/**
 * @param {string} bookRoot
 * @param {{chapter:number, act?:number, after:string|null, title:string, slug:string, body:string,
 *          status?:string, id?:string, dryRun?:boolean}} args
 */
export function insertScene(bookRoot, args = {}) {
  return guarded(async () => {
    const { chapter, act, after, title, slug, body, status = 'drafting', id, dryRun = false } = args ?? {};
    if (!isInt(chapter)) return fail('REFUSED_BAD_ARGS', 'chapter must be an integer >= 0');
    if (act !== undefined && !isInt(act)) return fail('REFUSED_BAD_ARGS', 'act must be an integer >= 0');
    if (after === undefined || (after !== null && typeof after !== 'string')) {
      return fail('REFUSED_BAD_ARGS', 'after must be a scene id or null');
    }
    if (typeof title !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(title)) {
      return fail('REFUSED_BAD_ARGS', 'title must be a string without control characters');
    }
    if (typeof slug !== 'string' || !SLUG_RE.test(slug) || slug.length > 60) return fail('REFUSED_BAD_ARGS', 'slug is not a valid slug');
    if (typeof body !== 'string') return fail('REFUSED_BAD_ARGS', 'body must be a string');
    if (!STATUSES.includes(status)) return fail('REFUSED_BAD_ARGS', `status must be one of ${STATUSES.join(', ')}`);
    if (id !== undefined && (typeof id !== 'string' || !SCENE_ID_RE.test(id))) return fail('REFUSED_BAD_ARGS', 'id is not a valid scene id');

    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb } = prep;
    const { order, excluded } = lb.book;

    const list = order.filter((s) => s.chapter === chapter);
    const sceneAct = act ?? list[0]?.act;
    if (sceneAct === undefined) return fail('REFUSED_UNKNOWN_CHAPTER', `chapter ${chapter} has no scenes and no act was given`);
    const newId = id ?? newSceneId();
    if (order.some((s) => s.id === newId) || excluded.some((s) => s.id === newId)) {
      return fail('REFUSED_DUPLICATE_ID', `id already exists in this book: ${newId}`);
    }

    const place = placeInChapter(list, after);
    if ('error' in place) return fail('REFUSED_BAD_ANCHOR', `scene ${after} is not in chapter ${chapter}`);
    const nb = await placementNeighbours(lb.root, list, place);
    if (nb.unsimple) return unsimpleResult(nb.unsimple);

    const resolver = await makePathResolver(lb.root);
    const to = resolver.scenePath(sceneAct, chapter, nb.moverSequence, slug);
    const text =
      `---\nschema: storyforge.scene/v1\nid: ${newId}\ntitle: ${yamlQuote(title)}\nact: ${sceneAct}\n` +
      `chapter: ${chapter}\nsequence: ${nb.moverSequence}\nstatus: ${status}\n---\n`;
    const content = Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from(body, 'utf8')]);
    const changes = [...nb.changes, { from: null, to, content, before: null }];

    return finish({
      bookRoot,
      lb,
      op: 'insertScene',
      args: { ...args, body: `<${Buffer.byteLength(body)} bytes>` },
      changes,
      dryRun,
      extra: { id: newId, path: to, sequence: nb.moverSequence },
    });
  });
}

// ------------------------------------------------------------------ moveScene

/**
 * @param {string} bookRoot
 * @param {string} sceneId
 * @param {{chapter:number, act?:number, after:string|null, dryRun?:boolean}} args
 */
export function moveScene(bookRoot, sceneId, args = {}) {
  return guarded(async () => {
    const { chapter, act, after, dryRun = false } = args ?? {};
    if (typeof sceneId !== 'string') return fail('REFUSED_BAD_ARGS', 'sceneId must be a string');
    if (!isInt(chapter)) return fail('REFUSED_BAD_ARGS', 'chapter must be an integer >= 0');
    if (act !== undefined && !isInt(act)) return fail('REFUSED_BAD_ARGS', 'act must be an integer >= 0');
    if (after === undefined || (after !== null && typeof after !== 'string')) {
      return fail('REFUSED_BAD_ARGS', 'after must be a scene id or null');
    }

    // A scene whose act/chapter/sequence line is unreadable shows up as E102; report the real cause.
    const onInvalid = async (lb, errs) => {
      for (const d of errs) {
        if (d.code !== 'E102' || !['act', 'chapter', 'sequence'].includes(d.location)) continue;
        let buf;
        try {
          buf = await readFile(abs(lb.root, d.file));
        } catch {
          continue;
        }
        if (new RegExp(`^id:[ \\t]*${sceneId}[ \\t]*\\r?$`, 'm').test(buf.toString('utf8'))) {
          return unsimpleResult({ file: d.file, field: d.location });
        }
      }
      return null;
    };
    const prep = await prepare(bookRoot, { onInvalid });
    if (prep.result) return prep.result;
    const { lb } = prep;

    const scene = lb.book.order.find((s) => s.id === sceneId);
    if (!scene) return fail('REFUSED_UNKNOWN_SCENE', `no scene ${sceneId} in the book order`);
    if (after === sceneId) return fail('REFUSED_BAD_ANCHOR', 'a scene cannot be placed after itself');

    const list = lb.book.order.filter((s) => s.chapter === chapter && s.id !== sceneId);
    const sameChapter = scene.chapter === chapter;
    const targetAct = act ?? list[0]?.act ?? (sameChapter ? scene.act : undefined);
    if (targetAct === undefined) return fail('REFUSED_UNKNOWN_CHAPTER', `chapter ${chapter} has no scenes and no act was given`);

    const place = placeInChapter(list, after, sameChapter ? scene.sequence : null);
    if ('error' in place) return fail('REFUSED_BAD_ANCHOR', `scene ${after} is not in chapter ${chapter}`);

    // The mover's three lines must all be simple (conservative reading of rule 2).
    const src = await readFile(abs(lb.root, scene.path));
    for (const f of ['act', 'chapter', 'sequence']) {
      if (!hasSimpleField(src, f)) return unsimpleResult({ file: scene.path, field: f });
    }

    const nb = await placementNeighbours(lb.root, list, place);
    if (nb.unsimple) return unsimpleResult(nb.unsimple);

    const resolver = await makePathResolver(lb.root);
    const to = resolver.scenePath(targetAct, chapter, nb.moverSequence, sceneSlugOf(scene.path));
    const edits = {};
    if (targetAct !== scene.act) edits.act = targetAct;
    if (chapter !== scene.chapter) edits.chapter = chapter;
    if (nb.moverSequence !== scene.sequence) edits.sequence = nb.moverSequence;
    const r = await sceneChange(lb.root, scene, edits, to);
    if ('unsimple' in r) return unsimpleResult(r.unsimple);
    const changes = [...nb.changes, ...(r.change ? [r.change] : [])];

    return finish({
      bookRoot,
      lb,
      op: 'moveScene',
      args: { sceneId, ...args },
      changes,
      dryRun,
      extra: { id: sceneId, path: to, sequence: nb.moverSequence },
    });
  });
}

// ------------------------------------------------------------- renumberChapter

/**
 * @param {string} bookRoot
 * @param {number} chapter
 * @param {{step?:number, dryRun?:boolean}} [args]
 */
export function renumberChapter(bookRoot, chapter, args = {}) {
  return guarded(async () => {
    const { step = 10, dryRun = false } = args ?? {};
    if (!isInt(chapter)) return fail('REFUSED_BAD_ARGS', 'chapter must be an integer >= 0');
    if (!isInt(step, 1)) return fail('REFUSED_BAD_ARGS', 'step must be an integer >= 1');
    const prep = await prepare(bookRoot);
    if (prep.result) return prep.result;
    const { lb } = prep;
    const list = lb.book.order.filter((s) => s.chapter === chapter);
    if (list.length === 0) return fail('REFUSED_UNKNOWN_CHAPTER', `chapter ${chapter} has no scenes`);
    const r = await renumberChanges(lb.root, list, step);
    if (r.unsimple) return unsimpleResult(r.unsimple);
    return finish({ bookRoot, lb, op: 'renumberChapter', args: { chapter, step }, changes: r.changes, dryRun });
  });
}

// ---------------------------------------------------------------------- repair

const diagKey = (d) => `${d.file}\0${d.location}`;

/**
 * Read-only. Proposes renames (W201/W202) and renumbers (E204); lists E100/E101/E102 files as
 * unrepairable. A scene in a chapter that has a renumber action gets no rename: re-plan afterwards.
 * @param {string} bookRoot
 */
export function planRepair(bookRoot) {
  return guarded(async () => {
    const lb = await loadBook(bookRoot);
    if ('error' in lb) return { ...fail(lb.error.code, lb.error.message), actions: [], unrepairable: [] };
    const byPath = new Map(lb.book.order.map((s) => [s.path, s]));
    const resolver = await makePathResolver(lb.root);

    const renumberChapters = new Set();
    const w201 = new Set();
    const w202 = new Set();
    const unrepairable = [];
    const seenUnrep = new Set();
    for (const d of lb.diagnostics) {
      if (d.code === 'E204' && byPath.has(d.file)) renumberChapters.add(byPath.get(d.file).chapter);
      else if (d.code === 'W201' && byPath.has(d.file)) w201.add(d.file);
      else if (d.code === 'W202' && byPath.has(d.file)) w202.add(d.file);
      else if (
        ['E100', 'E101', 'E102'].includes(d.code) &&
        d.file.startsWith('manuscript/') &&
        !/\/(act|chapter)\.md$/.test(d.file) &&
        !seenUnrep.has(diagKey(d) + d.code)
      ) {
        seenUnrep.add(diagKey(d) + d.code);
        unrepairable.push(d);
      }
    }

    const actions = [...renumberChapters].sort((a, b) => a - b).map((chapter) => ({ kind: 'renumber', chapter }));
    for (const s of lb.book.order) {
      if (renumberChapters.has(s.chapter) || !(w201.has(s.path) || w202.has(s.path))) continue;
      const name = sceneFileName(s.sequence, sceneSlugOf(s.path));
      const to = w201.has(s.path)
        ? resolver.scenePath(s.act, s.chapter, s.sequence, sceneSlugOf(s.path))
        : `${path.posix.dirname(s.path)}/${name}`;
      if (to !== s.path) actions.push({ kind: 'rename', from: s.path, to });
    }
    return { ok: true, code: 'OK', changes: [], actions, unrepairable };
  });
}

const safeTarget = (p) =>
  typeof p === 'string' &&
  p.startsWith('manuscript/') &&
  p.endsWith('.md') &&
  !p.includes('\\') &&
  !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.'));

/**
 * @param {string} bookRoot
 * @param {({kind:'rename',from:string,to:string}|{kind:'renumber',chapter:number})[]} actions
 * @param {{dryRun?:boolean}} [opts]
 */
export function applyRepair(bookRoot, actions, opts = {}) {
  return guarded(async () => {
    const { dryRun = false } = opts ?? {};
    if (!Array.isArray(actions)) return fail('REFUSED_BAD_ARGS', 'actions must be an array');
    for (const a of actions) {
      const ok =
        a && ((a.kind === 'rename' && typeof a.from === 'string' && safeTarget(a.to)) || (a.kind === 'renumber' && isInt(a.chapter)));
      if (!ok) return fail('REFUSED_BAD_ARGS', `malformed repair action: ${JSON.stringify(a)}`);
    }
    const renumbers = actions.filter((a) => a.kind === 'renumber');
    const prep = await prepare(bookRoot, { allowCodes: renumbers.length ? ['E204'] : [] });
    if (prep.result) return prep.result;
    const { lb } = prep;

    const changes = [];
    const touched = new Set();
    const renumberedChapters = new Set();
    for (const a of renumbers) {
      if (renumberedChapters.has(a.chapter)) continue;
      renumberedChapters.add(a.chapter);
      const list = lb.book.order.filter((s) => s.chapter === a.chapter);
      if (list.length === 0) return fail('REFUSED_UNKNOWN_CHAPTER', `chapter ${a.chapter} has no scenes`);
      const r = await renumberChanges(lb.root, list, 10);
      if (r.unsimple) return unsimpleResult(r.unsimple);
      for (const c of r.changes) {
        touched.add(c.from);
        changes.push(c);
      }
      for (const s of list) touched.add(s.path);
    }
    for (const a of actions.filter((x) => x.kind === 'rename')) {
      const scene = lb.book.order.find((s) => s.path === a.from);
      if (!scene || touched.has(a.from)) {
        return fail('REFUSED_STALE_ACTION', `rename source is not a current scene file (or already handled): ${a.from}`);
      }
      touched.add(a.from);
      if (a.to === a.from) continue;
      const before = await readFile(abs(lb.root, a.from));
      changes.push({ from: a.from, to: a.to, content: before, before });
    }

    return finish({ bookRoot, lb, op: 'applyRepair', args: { actions }, changes, dryRun });
  });
}
