// The write requests the Notes page sends, and how a refusal is put into words. Pure: nothing is sent here.
// A request is { method: 'POST', url, body }; the page sends each with `dryRun: true` first (the preview) and then for real.
import { explainCodexFailure } from '../codex/requests.js';
import { explainFailure } from '../structure/helpers.js';

const enc = encodeURIComponent;
const base = (bookId) => `/api/books/${enc(bookId)}`;

/**
 * New research note, planning doc or source. `kind`: 'research' (research/<slug>.md), 'doc' (planning/<slug>.md) or 'source' (research/sources/<cite-key>.md; needs `cite_key`).
 * @param {string} bookId @param {{ kind: 'research' | 'doc' | 'source', title: string, slug?: string, tags?: string[], cite_key?: string, [field: string]: unknown }} n
 */
export const newNoteRequest = (bookId, { kind, title, slug, tags, cite_key: citeKey, ...source }) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/notes`,
  body: {
    kind,
    title,
    ...(slug && kind !== 'source' ? { slug } : {}),
    ...(kind === 'research' && tags && tags.length > 0 ? { tags } : {}),
    ...(kind === 'source' ? { cite_key: citeKey, ...Object.fromEntries(Object.entries(source).filter(([, v]) => typeof v === 'string' && v.trim() !== '')) } : {}),
  },
});

/** Only what changed. @param {string} bookId @param {{ id: string, sha256?: string | null }} note @param {Record<string, unknown>} patch */
export const noteFieldsRequest = (bookId, note, patch) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/notes/${enc(note.id)}/fields`,
  body: { ...patch, ...(note.sha256 ? { base_sha256: note.sha256 } : {}) },
});

/** @param {string} bookId @param {{ id: string, sha256?: string | null }} note */
export const noteArchiveRequest = (bookId, note) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/notes/${enc(note.id)}/archive`,
  body: note.sha256 ? { base_sha256: note.sha256 } : {},
});

/** @param {string} bookId @param {{ id: string }} note */
export const noteRestoreRequest = (bookId, note) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/notes/${enc(note.id)}/restore`, body: {} });

/** GET <this> is the note with its `body` and `sha256`; PUT <this>/body saves the text. @param {string} bookId @param {string} noteId */
export const noteUrl = (bookId, noteId) => `${base(bookId)}/notes/${enc(noteId)}`;

/** The refusal of a note write, in words the author can act on. @param {number} status @param {any} json */
export function explainNotesFailure(status, json) {
  switch (json?.code) {
    case 'CITE_KEY_TAKEN':
      return 'Another source already uses that cite key. Choose a different one.';
    case 'REFUSED_PATH_TAKEN':
      return 'A file with that name already exists. Choose a different file name.';
    case 'REFUSED_UNKNOWN_NOTE':
      return 'That note is not there any more. Reload the page.';
    case 'REFUSED_UNKNOWN_LINK':
      return 'One of the linked entries, threads or events is not in the book any more. Reload the page.';
    case 'REFUSED_UNKNOWN_SOURCE':
      return 'One of the cited sources is not in the book any more. Reload the page.';
    default:
      break;
  }
  if (typeof json?.code === 'string' && (json.code.startsWith('REFUSED_UNSIMPLE') || json.code === 'ROLLED_BACK' || status === 409)) return explainCodexFailure(status, json);
  return explainFailure(status, json);
}

/** The refusal of an upload, in words the author can act on. @param {number} status @param {any} json */
export function explainUploadFailure(status, json) {
  if (status === 0) return 'The server could not be reached. Nothing was attached.';
  if (status === 403) return 'The server refused the upload.';
  if (status === 413) return 'That file is too large. Attachments can be at most 25 MB.';
  if (status === 415) return typeof json?.message === 'string' ? `That kind of file cannot be attached. ${json.message.replace(/^files of this type cannot be attached/, 'Allowed')}.` : 'That kind of file cannot be attached.';
  return typeof json?.message === 'string' ? json.message : `The file was not attached (${json?.code ?? status}).`;
}
