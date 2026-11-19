// The routes of M13-J04 (EPUBCheck): the per-machine tool settings and the validation jobs of an EPUB export. router.mjs hands these the request; policy.mjs classes them.
//   GET  /api/tools                                         admin  { java, epubcheckJar }
//   PUT  /api/tools                                         admin  { java?, epubcheckJar? } (each an absolute path or null)
//   GET  /api/tools/status                                  admin  { java: {state,path,version,reason}, epubcheck: {...} }
//   POST /api/books/:b/export/validations                   write  { sceneTitles?, excludeStatuses?, include?, scenes? } -> 202 { validationId } | 409 VALIDATION_RUNNING
//   GET  /api/books/:b/export/validations/:id               read   { state, result, explanations, sources, chapters, filename }
//   POST /api/books/:b/export/validations/:id/cancel        write  -> { ok, cancelled, state }
//   GET  /api/books/:b/export/validations/:id/file          read   the EPUB that was checked
//   GET  /api/books/:b/export/validations/:id/report        read   report.json
//   POST /api/books/:b/checks/epub                          write  { validate: boolean } -> { ok, epub }
import * as exportPackage from '@storyforge/export';
import { epubValidations } from './epub-validations.mjs';
import { tools } from './tools.mjs';

const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const badRequest = (/** @type {string} */ message, code = 'BAD_ARGS') => ({ status: 400, body: { error: 'bad_request', code, message } });
const STATUS_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SCENE_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_SCENES = 5000;
const MAX_STATUSES = 50;

/** Reject a body that has a key outside `allowed`. @param {Record<string, unknown>} body @param {string[]} allowed @returns {string | null} */
function unknownKey(body, allowed) {
  const k = Object.keys(body).find((x) => !allowed.includes(x));
  return k === undefined ? null : `unknown field ${k}${allowed.length > 0 ? ` (allowed: ${allowed.join(', ')})` : ' (this request takes no body)'}`;
}

/** GET /api/tools and GET /api/tools/status. @param {any} state @param {'settings' | 'status'} which */
export async function handleToolsRead(state, which) {
  const service = state?.tools ?? tools;
  if (which === 'status') return { status: 200, body: await service.status() };
  return { status: 200, body: await service.saved() };
}

/** PUT /api/tools: { java?, epubcheckJar? }, each an absolute path or null; at least one. @param {any} state @param {Record<string, unknown>} body */
export async function handleToolsWrite(state, body) {
  const bad = unknownKey(body, ['java', 'epubcheckJar']);
  if (bad) return badRequest(bad);
  if (Object.keys(body).length === 0) return badRequest('expected at least one of java, epubcheckJar');
  for (const k of ['java', 'epubcheckJar']) if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') return badRequest(`${k} must be a path or null`);
  const r = await (state?.tools ?? tools).save(/** @type {any} */ (body));
  return r.ok ? { status: 200, body: r.tools } : badRequest(r.message);
}

/** POST /api/books/:b/checks/epub: { validate: boolean }. @param {any} repository @param {string} bookId @param {Record<string, unknown>} body */
export async function handleEpubChecksWrite(repository, bookId, body) {
  const bad = unknownKey(body, ['validate']);
  if (bad) return badRequest(bad);
  if (typeof body.validate !== 'boolean') return badRequest('validate must be true or false');
  const r = await repository.setEpubChecks(bookId, { validate: body.validate });
  if (r.ok) return { status: 200, body: { ok: true, epub: r.epub, ...(r.unchanged ? { unchanged: true } : {}) } };
  if (r.code === 'NOT_FOUND') return NOT_FOUND;
  const conflicting = r.code === 'CONFLICT';
  return { status: conflicting ? 409 : 400, body: { error: conflicting ? 'conflict' : 'refused', code: r.code, ...(r.message ? { message: r.message } : {}) } };
}

/**
 * The export options of a validation request: only sceneTitles (boolean), excludeStatuses (list of status names), include ('manuscript') and scenes (list of scene ids).
 * @param {Record<string, unknown>} body @returns {{ options: { sceneTitles: boolean, excludeStatuses: string[], include: 'manuscript', sceneIds?: string[] } } | { error: string }}
 */
function validationOptions(body) {
  const bad = unknownKey(body, ['sceneTitles', 'excludeStatuses', 'include', 'scenes']);
  if (bad) return { error: bad };
  if (body.sceneTitles !== undefined && typeof body.sceneTitles !== 'boolean') return { error: 'sceneTitles must be true or false' };
  if (body.include !== undefined && body.include !== 'manuscript') return { error: 'include must be manuscript: only the manuscript EPUB is checked' };
  if (body.excludeStatuses !== undefined && (!Array.isArray(body.excludeStatuses) || body.excludeStatuses.length > MAX_STATUSES || body.excludeStatuses.some((x) => typeof x !== 'string' || !STATUS_RE.test(x)))) {
    return { error: 'excludeStatuses must be a list of status names' };
  }
  if (body.scenes !== undefined && (!Array.isArray(body.scenes) || body.scenes.length > MAX_SCENES || body.scenes.some((x) => typeof x !== 'string' || !SCENE_RE.test(x)))) return { error: 'scenes must be a list of scene ids' };
  const scenes = /** @type {string[] | undefined} */ (body.scenes);
  return { options: { sceneTitles: body.sceneTitles === true, excludeStatuses: /** @type {string[]} */ (body.excludeStatuses ?? []), include: 'manuscript', ...(scenes && scenes.length > 0 ? { sceneIds: scenes } : {}) } };
}

/**
 * Build the EPUB once and its source map (where each scene sits in the chapter files). The map is made from the manuscript read before and after the build: if the book changed in
 * between they differ and the map is left empty (links are then to nothing rather than to a guess).
 * @param {string} root @param {Record<string, any>} options
 */
async function buildEpub(root, options) {
  const pkg = /** @type {any} */ (exportPackage);
  const mapOf = async () => (typeof pkg.epubSourceMap === 'function' && typeof pkg.assembleManuscript === 'function' ? pkg.epubSourceMap(await pkg.assembleManuscript(root, options)) : {});
  const before = await mapOf();
  const file = await pkg.exportBook(root, 'epub', options);
  const after = await mapOf();
  return { file: { bytes: file.bytes, filename: file.filename }, sourceMap: JSON.stringify(before) === JSON.stringify(after) ? before : {} };
}

/**
 * POST /api/books/:b/export/validations: build the EPUB (as GET /export?format=epub does) and start checking exactly those bytes.
 * 202 { validationId }; 400 bad options; 404 unknown book; 409 VALIDATION_RUNNING; 500 export_failed when the built file does not match the manuscript.
 * @param {any} repository @param {any} state @param {string} bookId @param {Record<string, unknown>} body
 */
export async function handleValidationStart(repository, state, bookId, body) {
  const parsed = validationOptions(body);
  if ('error' in parsed) return badRequest(parsed.error);
  const root = await repository.bookRoot(bookId);
  if (!root) return NOT_FOUND;
  const jobs = state?.epubValidations ?? epubValidations;
  const busy = jobs.running(bookId);
  const running = (/** @type {string} */ id) => ({ status: 409, body: { error: 'VALIDATION_RUNNING', code: 'VALIDATION_RUNNING', message: 'an EPUB check of this book is already running; cancel it or wait', validationId: id } });
  if (busy !== null) return running(busy);
  let built;
  try {
    built = await buildEpub(root, parsed.options);
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err instanceof exportPackage.ExportVerificationError) return { status: 500, body: { error: 'export_failed', problems: err.problems } };
    if (err instanceof exportPackage.ExportError) return err.code === 'NOT_A_BOOK' ? NOT_FOUND : badRequest(err.message);
    throw e;
  }
  const started = jobs.start({ repository, bookId, file: built.file, sourceMap: built.sourceMap });
  if (!started.ok) return running(started.validationId);
  return { status: 202, body: { validationId: started.validationId } };
}

/** POST /api/books/:b/export/validations/:id/cancel. @param {any} state @param {string} bookId @param {string} id @param {Record<string, unknown>} body */
export function handleValidationCancel(state, bookId, id, body) {
  const bad = unknownKey(body, []);
  if (bad) return badRequest(bad);
  const r = (state?.epubValidations ?? epubValidations).cancel(bookId, id);
  return r ? { status: 200, body: { ok: true, cancelled: r.cancelled, state: r.state } } : NOT_FOUND;
}

/**
 * GET /api/books/:b/export/validations/:id[/file|/report]. `download` builds a download response (the same headers as an export) from { bytes, filename, mime }.
 * @param {any} state @param {string} bookId @param {string} id @param {'status' | 'file' | 'report'} which @param {(file: { bytes: Buffer, filename: string, mime: string }) => any} download
 */
export function handleValidationRead(state, bookId, id, which, download) {
  const jobs = state?.epubValidations ?? epubValidations;
  if (which === 'status') {
    const s = jobs.status(bookId, id);
    return s ? { status: 200, body: s } : NOT_FOUND;
  }
  if (which === 'file') {
    const f = jobs.file(bookId, id);
    return f ? download({ ...f, mime: 'application/epub+zip' }) : NOT_FOUND;
  }
  const r = jobs.report(bookId, id);
  if (!r) return NOT_FOUND;
  if ('running' in r) return { status: 409, body: { error: 'VALIDATION_RUNNING', code: 'VALIDATION_RUNNING', message: 'the check has not finished yet' } };
  return download({ ...r, mime: 'application/json; charset=utf-8' });
}
