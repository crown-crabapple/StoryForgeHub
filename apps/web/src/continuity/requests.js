// The requests the continuity review sends, and how a refusal is put into words. Nothing here writes anything but exception files.
import { explainFailure } from '../structure/helpers.js';

const enc = encodeURIComponent;
const base = (bookId) => `/api/books/${enc(bookId)}/continuity`;

/** GET: the findings. @param {string} bookId */
export const continuityUrl = (bookId) => base(bookId);

/** GET: the lines around a finding's evidence ({ lines: [{ n, text }] }). @param {string} bookId @param {{ file: string, line: number }} source @param {number} [radius] */
export const contextUrl = (bookId, source, radius = 3) => `${base(bookId)}/context?file=${enc(source.file)}&line=${source.line}&radius=${radius}`;

/** GET: a whole book file ({ path, body, sha256 }); `file` is book-relative. @param {string} bookId @param {string} file */
export const RAW_URL = (bookId, file) => `/api/books/${enc(bookId)}/raw?path=${enc(file)}`;

/** POST: write planning/continuity/<slug>.md for one finding. @param {string} bookId @param {{ fingerprint: string, rationale: string, title?: string, intentional?: boolean }} v */
export const acknowledgeRequest = (bookId, { fingerprint, rationale, title, intentional }) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/exceptions`,
  body: { fingerprint, rationale, ...(title ? { title } : {}), ...(intentional === true ? { intentional: true } : {}) },
});

/** DELETE: archive the exception (its finding comes back). @param {string} bookId @param {string} slug */
export const archiveExceptionRequest = (bookId, slug) => ({ method: /** @type {const} */ ('DELETE'), url: `${base(bookId)}/exceptions/${enc(slug)}`, body: {} });

/** POST: undo an archive from its trash copy. @param {string} bookId @param {string} opId */
export const undoOpRequest = (bookId, opId) => ({ method: /** @type {const} */ ('POST'), url: `/api/books/${enc(bookId)}/ops/${enc(opId)}/restore`, body: {} });

/** Send a request; never throws (a network failure is status 0). @param {{ method: string, url: string, body: unknown }} r @returns {Promise<{ status: number, json: any }>} */
export async function sendRequest(r) {
  try {
    const res = await fetch(r.url, {
      method: r.method,
      headers: { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' },
      body: JSON.stringify(r.body ?? {}),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // no body
    }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

/** The refusal of a continuity write, in words the author can act on. @param {number} status @param {any} json */
export function explainContinuityFailure(status, json) {
  switch (json?.code ?? json?.error) {
    case 'RATIONALE_REQUIRED':
      return 'Write why this is fine. The reason is kept with the exception.';
    case 'ALREADY_EXCEPTED':
      return 'This finding is already acknowledged. Reload the page.';
    case 'FINDING_NOT_FOUND':
      return 'This finding is gone: the text or the facts changed. Reload the page.';
    case 'REFUSED_PATH_TAKEN':
      return 'A file with that name is already there. Change the title and try again.';
    default:
      return explainFailure(status, json);
  }
}
