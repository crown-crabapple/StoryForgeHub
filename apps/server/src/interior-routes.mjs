// The routes of M13-J05 (Book interior preview): the layout settings, snapshots of the rendered interior, the fingerprint that says a preview is out of date, and the preview document.
// router.mjs hands these the request; policy.mjs classes them.
//   POST /api/books/:b/interior/layout                        write  { <any interior key> } -> 200 { ok, interior, unchanged? }
//   POST /api/books/:b/interior/snapshots                     read   { layout? } -> 201 { snapshotId, fingerprint, report }
//   GET  /api/books/:b/interior/fingerprint                   read   -> { fingerprint }
//   GET  /api/books/:b/interior/snapshots/:id/preview.html    read   the preview document (never shareable); 404 when the snapshot expired
import { createHash } from 'node:crypto';
import * as exportPackage from '@storyforge/export';
import { preferenceProblems } from '@storyforge/format';
import { interiorOf } from './preferences.mjs';
import { interiorSnapshots } from './interior-snapshots.mjs';
import { readInteriorCoverageCss } from './static.mjs';

const NOT_FOUND = { status: 404, body: { error: 'not_found' } };
const badRequest = (/** @type {string} */ message, code = 'BAD_ARGS') => ({ status: 400, body: { error: 'bad_request', code, message } });
const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The keys of the interior layout (contract section 2). */
export const INTERIOR_KEYS = ['version', 'template', 'trim', 'font', 'fontSize', 'lineHeight', 'margins', 'chapterStart', 'sceneBreak', 'runningHeads', 'pageNumbers', 'frontMatter', 'backMatter'];

/** The exact Content-Security-Policy of the preview document (contract section 5). */
export const PREVIEW_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/** Test hooks: a renderer and coverage that replace the real ones (null puts the real ones back). */
const hooks = { renderInterior: /** @type {null | ((manuscript: any, layout: any, options: any) => any)} */ (null), coverage: /** @type {any} */ (null) };
/** @param {{ renderInterior?: ((manuscript: any, layout: any, options: any) => any) | null, coverage?: any }} next */
export function setInteriorHooks(next) {
  hooks.renderInterior = next.renderInterior ?? null;
  hooks.coverage = next.coverage ?? null;
}

/** @type {Promise<Record<string, Array<[number, number]>>> | null} */
let coverageOnce = null;
/** The glyph coverage of each interior font (font id -> unicode ranges), read from the fontsource CSS once per process. */
function coverageOf() {
  if (hooks.coverage) return Promise.resolve(hooks.coverage);
  coverageOnce ??= (async () => {
    const pkg = /** @type {any} */ (exportPackage);
    if (typeof pkg.parseUnicodeRanges !== 'function') return {};
    const css = await readInteriorCoverageCss();
    return Object.fromEntries(Object.entries(css).map(([font, text]) => [font, pkg.parseUnicodeRanges(text, { files: pkg.INTERIOR_FONT_FILES })]));
  })();
  return coverageOnce;
}

/** POST /api/books/:b/interior/layout. @param {any} repository @param {string} bookId @param {Record<string, unknown>} body */
export async function handleInteriorLayout(repository, bookId, body) {
  const unknown = Object.keys(body).find((k) => !INTERIOR_KEYS.includes(k));
  if (unknown !== undefined) return badRequest(`unknown interior setting ${unknown} (allowed: ${INTERIOR_KEYS.join(', ')})`);
  if (Object.keys(body).length === 0) return badRequest('expected at least one interior setting');
  const r = await repository.setInteriorLayout(bookId, body);
  if (r.ok) return { status: 200, body: { ok: true, interior: r.interior, ...(r.unchanged ? { unchanged: true } : {}) } };
  if (r.code === 'NOT_FOUND') return NOT_FOUND;
  const conflicting = r.code === 'CONFLICT';
  return { status: conflicting ? 409 : 400, body: { error: conflicting ? 'conflict' : 'refused', code: r.code, ...(r.message ? { message: r.message } : {}) } };
}

/**
 * Assemble the manuscript once (default export options) and render the interior with `layout`.
 * @param {string} root @param {Record<string, any>} layout
 * @returns {Promise<{ html: string, css: string, report: Record<string, any>, fingerprint: string, language: string, title: string }>}
 */
async function render(root, layout) {
  const pkg = /** @type {any} */ (exportPackage);
  const renderInterior = hooks.renderInterior ?? pkg.renderInterior;
  if (typeof renderInterior !== 'function') throw new exportPackage.ExportError('NOT_SUPPORTED', 'this build cannot lay out a book interior');
  const manuscript = await pkg.assembleManuscript(root, { excludeStatuses: [], sceneTitles: false });
  const out = await renderInterior(manuscript, layout, { coverage: await coverageOf() });
  const fingerprint = createHash('sha256').update(out.html).update(out.css).digest('hex');
  return { html: out.html, css: out.css, report: out.report, fingerprint, language: typeof manuscript.language === 'string' ? manuscript.language : 'en', title: typeof manuscript.title === 'string' ? manuscript.title : '' };
}

/**
 * Render for a book: its effective layout, optionally changed by `given` (validated, never saved).
 * @param {any} repository @param {any} state @param {string} bookId @param {Record<string, any> | null} given
 */
async function renderBook(repository, state, bookId, given) {
  const root = await repository.bookRoot(bookId);
  const effective = root ? await interiorOf(repository, state, bookId) : null;
  if (!root || !effective) return { response: NOT_FOUND };
  const layout = given ? { ...effective, ...given } : effective;
  if (given) {
    const problems = preferenceProblems('interior', layout);
    if (problems.length > 0) return { response: badRequest(`${problems[0].location}: ${problems[0].message}`) };
  }
  try {
    return { rendered: { ...(await render(root, layout)), layout } };
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err instanceof exportPackage.ExportVerificationError) return { response: { status: 500, body: { error: 'export_failed', problems: err.problems } } };
    if (err instanceof exportPackage.ExportError) {
      if (err.code === 'NOT_A_BOOK') return { response: NOT_FOUND };
      return { response: err.code === 'NOT_SUPPORTED' ? { status: 501, body: { error: 'not_supported', message: err.message } } : badRequest(err.message) };
    }
    throw e;
  }
}

/** POST /api/books/:b/interior/snapshots. @param {any} repository @param {any} state @param {string} bookId @param {Record<string, unknown>} body */
export async function handleInteriorSnapshot(repository, state, bookId, body) {
  const unknown = Object.keys(body).find((k) => k !== 'layout');
  if (unknown !== undefined) return badRequest(`unknown field ${unknown} (allowed: layout)`);
  if (body.layout !== undefined && !isObject(body.layout)) return badRequest('layout must be an object of interior settings');
  const badKey = body.layout === undefined ? undefined : Object.keys(/** @type {object} */ (body.layout)).find((k) => !INTERIOR_KEYS.includes(k));
  if (badKey !== undefined) return badRequest(`unknown interior setting ${badKey} (allowed: ${INTERIOR_KEYS.join(', ')})`);
  const r = await renderBook(repository, state, bookId, /** @type {Record<string, any> | null} */ (body.layout ?? null));
  if (!r.rendered) return /** @type {any} */ (r.response);
  const { html, css, layout, fingerprint, report, language, title } = r.rendered;
  const jobs = state?.interiorSnapshots ?? interiorSnapshots;
  const { snapshotId } = jobs.add(bookId, { html, css, layout, fingerprint, report, language, title });
  return { status: 201, body: { snapshotId, fingerprint, report } };
}

/** GET /api/books/:b/interior/fingerprint. @param {any} repository @param {any} state @param {string} bookId */
export async function handleInteriorFingerprint(repository, state, bookId) {
  const r = await renderBook(repository, state, bookId, null);
  return r.rendered ? { status: 200, body: { fingerprint: r.rendered.fingerprint } } : /** @type {any} */ (r.response);
}

const escapeHtml = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The preview document of a snapshot (contract section 5): no inline script, the two allowed scripts by src. @param {Record<string, any>} s */
export function previewDocument(s) {
  const lang = typeof s.language === 'string' && /^[A-Za-z0-9-]{2,35}$/.test(s.language) ? s.language : 'en';
  // a `<` can only be in a CSS string or comment: escape it so the stylesheet can never close its element or open a tag
  const css = String(s.css).replace(/</g, String.raw`\3c `);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(String(s.title ?? ''))}</title><style>${css}</style><script src="/interior-assets/paged.js"></script><script src="/interior-assets/interior-boot.js"></script></head><body>${s.html}</body></html>`;
}

/** GET /api/books/:b/interior/snapshots/:id/preview.html. @param {any} state @param {string} bookId @param {string} snapshotId */
export function handleInteriorPreview(state, bookId, snapshotId) {
  const s = (state?.interiorSnapshots ?? interiorSnapshots).get(bookId, snapshotId);
  if (!s) return NOT_FOUND;
  return {
    status: 200,
    body: null,
    raw: {
      bytes: Buffer.from(previewDocument(s), 'utf8'),
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': PREVIEW_CSP,
      },
    },
  };
}
