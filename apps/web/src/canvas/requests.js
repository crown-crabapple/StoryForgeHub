// The Canvas page's writes (M09-J01): new canvas, save, archive / restore, image upload. Each returns { status, json } (status 0 = no answer).
import { putJson } from '../api.js';
import { send } from '../structure/helpers.js';
import { canvasUrl } from './model.js';

const enc = encodeURIComponent;
const base = (bookId) => `/api/books/${enc(bookId)}/canvases`;

/** @param {string} bookId @param {{ title: string, slug?: string }} v */
export const createCanvas = (bookId, v) => send(base(bookId), v);
/** @param {string} bookId @param {string} slug @param {string} sha */
export const archiveCanvas = (bookId, slug, sha) => send(`${base(bookId)}/${enc(slug)}/archive`, sha ? { base_sha256: sha } : {});
/** @param {string} bookId @param {string} slug */
export const restoreCanvas = (bookId, slug) => send(`${base(bookId)}/${enc(slug)}/restore`, {});

/** PUT the whole canvas. @param {string} bookId @param {string} slug @param {any} canvas @param {string} sha the file as last seen */
export async function saveCanvas(bookId, slug, canvas, sha) {
  try {
    return await putJson(canvasUrl(bookId, slug), { canvas, base_sha256: sha });
  } catch {
    return { status: 0, json: null };
  }
}

export const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif';
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Upload one image for a canvas (stored under assets/canvas/). @param {string} bookId @param {File} file @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: true, path: string } | { ok: false, message: string }>}
 */
export async function uploadCanvasImage(bookId, file, fetchImpl = (...a) => globalThis.fetch(...a)) {
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, message: 'That file is too large. Images can be at most 25 MB.' };
  if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name)) return { ok: false, message: 'Only PNG, JPEG, WebP and GIF images can go on a canvas.' };
  try {
    const res = await fetchImpl(`/api/books/${enc(bookId)}/attachments?name=${enc(file.name)}&for=canvas`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-storyforge': '1', accept: 'application/json' },
      body: file,
    });
    const json = await res.json().catch(() => null);
    if (res.status === 201 && typeof json?.path === 'string') return { ok: true, path: json.path };
    return { ok: false, message: typeof json?.message === 'string' ? json.message : `The image was not added (${json?.code ?? res.status}).` };
  } catch {
    return { ok: false, message: 'The server could not be reached. Nothing was added.' };
  }
}

/** A refusal in words. @param {number} status @param {any} json */
export function explainCanvasFailure(status, json) {
  if (status === 0) return 'The server could not be reached.';
  if (json?.code === 'REFUSED_PATH_TAKEN') return 'A canvas (or an archived one) already has that name. Choose another title.';
  if (json?.code === 'REFUSED_BAD_CANVAS') return `The canvas could not be saved: ${json.message}`;
  if (json?.code === 'MODULE_OFF') return 'The board module is off, so canvases cannot be changed.';
  if (status === 403) return 'You cannot change canvases in this book.';
  if (status === 404) return 'That canvas is not there any more. Reload the page.';
  return typeof json?.message === 'string' ? json.message : `The change was refused (${json?.code ?? status}).`;
}
