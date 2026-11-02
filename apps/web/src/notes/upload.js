// Upload one file to the book (POST /api/books/:b/attachments). The file goes to the server and nowhere else; the answer holds the Markdown link to insert.
import { explainUploadFailure } from './requests.js';

/** The most one upload may carry; the server refuses more with 413. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The `accept` list of the file picker (the server's allowlist). */
export const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv';

/**
 * @param {string} bookId @param {File} file @param {string | null} noteId the note the link will be inserted in (the link is made relative to its folder)
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: true, path: string, markdown: string } | { ok: false, message: string }>}
 */
export async function uploadAttachment(bookId, file, noteId = null, fetchImpl = (...a) => globalThis.fetch(...a)) {
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, message: explainUploadFailure(413, null) };
  const query = `name=${encodeURIComponent(file.name)}${noteId ? `&note=${encodeURIComponent(noteId)}` : ''}`;
  let status = 0;
  let json = null;
  try {
    const res = await fetchImpl(`/api/books/${encodeURIComponent(bookId)}/attachments?${query}`, {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-storyforge': '1', accept: 'application/json' },
      body: file,
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    // no answer at all: status stays 0
  }
  if (status === 201 && typeof json?.markdown === 'string' && typeof json?.path === 'string') return { ok: true, path: json.path, markdown: json.markdown };
  return { ok: false, message: explainUploadFailure(status, json) };
}
