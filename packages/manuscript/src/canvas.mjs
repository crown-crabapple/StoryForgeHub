// Canvas commands (M09-J01): new canvas, save, archive / restore. Every command goes through the store; create, archive and restore are one batch with a dry run,
// are refused when they would add a validation error, and never delete. A save is a whole-file write guarded by the sha256 the author last saw.
import { CANVAS_DIR, CANVAS_EXT, emptyCanvas, parseCanvas, serializeCanvas } from '@storyforge/format';
import { prepareCodex, stale } from './codex.mjs';
import { fail, finish, guarded, readBytes } from './ops.mjs';
import { SLUG_RE, slugify } from './util.mjs';

const CONTROL_RE = new RegExp(`[\x00-\x1f\x7f\x85${String.fromCharCode(0x2028, 0x2029)}]`);
const isText = (v) => typeof v === 'string' && !CONTROL_RE.test(v);
/** Book-relative path of a live canvas. @param {string} slug */
export const canvasPath = (slug) => `${CANVAS_DIR}/${slug}${CANVAS_EXT}`;
const okSlug = (s) => typeof s === 'string' && SLUG_RE.test(s) && s.length <= 60;

/**
 * New, empty canvas at planning/canvases/<slug>.canvas. The slug comes from `slug`, else the title. A file already there: REFUSED_PATH_TAKEN.
 * @param {string} bookRoot @param {{ title: string, slug?: string, dryRun?: boolean }} args
 */
export function createCanvas(bookRoot, args = {}) {
  return guarded(async () => {
    const { title, slug: given, dryRun = false } = args ?? {};
    if (!isText(title) || title.trim() === '' || title.length > 300) return fail('REFUSED_BAD_ARGS', 'title must be a non-empty string without control characters (max 300)');
    const slug = given !== undefined && given !== null && given !== '' ? given : slugify(title);
    if (!okSlug(slug)) return fail('REFUSED_BAD_ARGS', given ? 'slug must be lower-case letters, digits and single hyphens (1-60 characters)' : 'the title has no letters or digits to make a file name from; give a slug');
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const to = canvasPath(slug);
    if (await store.exists(`archive/${to}`)) return fail('REFUSED_PATH_TAKEN', `an archived canvas is called ${slug}; restore it or choose another name`, { path: `archive/${to}` });
    const changes = [{ from: null, to, content: Buffer.from(serializeCanvas(emptyCanvas(title.trim())), 'utf8'), before: null }];
    return finish({ bookRoot, store, lb, op: 'createCanvas', args: { title, file: to }, changes, dryRun, withDiff: true, extra: { slug, path: to } });
  });
}

/**
 * Save the whole canvas. `canvas` is checked with parseCanvas (REFUSED_BAD_CANVAS names the rule). `baseSha256` is the file the author last saw: another file on disk
 * is CONFLICT with `current: { sha256, text }`, and nothing is written.
 * @param {string} bookRoot @param {string} slug @param {{ canvas: unknown, baseSha256: string }} args
 */
export function saveCanvas(bookRoot, slug, args = {}) {
  return guarded(async () => {
    const { canvas, baseSha256 } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no canvas ${slug}`);
    if (typeof baseSha256 !== 'string') return fail('REFUSED_BAD_ARGS', 'base_sha256 is required');
    const parsed = parseCanvas(canvas);
    if (!parsed.ok) return fail('REFUSED_BAD_CANVAS', parsed.message);
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { store } = prep;
    const rel = canvasPath(slug);
    const cur = await store.read(rel);
    if (!cur) return fail('NOT_FOUND', `no canvas ${slug}`);
    const next = Buffer.from(serializeCanvas(parsed.canvas), 'utf8');
    if (cur.sha256 === baseSha256 && next.equals(cur.bytes)) return { ok: true, code: 'OK', changes: [], sha256: cur.sha256, slug, path: rel };
    const r = await store.write(rel, next, { baseSha256 });
    if (r.ok) return { ok: true, code: 'OK', changes: [{ from: rel, to: rel }], sha256: r.sha256, slug, path: rel };
    if (r.code === 'CONFLICT') {
      const now = r.current?.bytes ?? cur.bytes;
      return fail('CONFLICT', `${rel} changed on disk since it was read`, { current: { sha256: r.current?.sha256 ?? cur.sha256, text: now.toString('utf8') } });
    }
    return fail(r.code, r.message ?? 'the canvas could not be saved');
  });
}

/** Move a canvas to archive/planning/canvases/. @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args */
export function archiveCanvas(bookRoot, slug, args = {}) {
  return moveCanvas(bookRoot, slug, args, false);
}

/** Move an archived canvas back. A live canvas with that name: REFUSED_PATH_TAKEN. @param {string} bookRoot @param {string} slug @param {{ dryRun?: boolean, baseSha256?: string }} args */
export function restoreCanvas(bookRoot, slug, args = {}) {
  return moveCanvas(bookRoot, slug, args, true);
}

function moveCanvas(bookRoot, slug, args, restoring) {
  return guarded(async () => {
    const { dryRun = false, baseSha256 } = args ?? {};
    if (!okSlug(slug)) return fail('NOT_FOUND', `no canvas ${slug}`);
    const prep = await prepareCodex(bookRoot);
    if (prep.result) return prep.result;
    const { lb, store } = prep;
    const live = canvasPath(slug);
    const from = restoring ? `archive/${live}` : live;
    const to = restoring ? live : `archive/${live}`;
    if (!(await store.exists(from))) return fail('NOT_FOUND', `no ${restoring ? 'archived ' : ''}canvas ${slug}`);
    const before = await readBytes(store, from);
    const changed = stale(before, baseSha256, from);
    if (changed) return changed;
    return finish({ bookRoot, store, lb, op: restoring ? 'restoreCanvas' : 'archiveCanvas', args: { slug }, changes: [{ from, to, content: before, before }], dryRun, withDiff: false, extra: { slug, path: to } });
  });
}
