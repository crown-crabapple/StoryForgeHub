// What the Export, Back up and Restore dialogs send, and how a refusal is put into words. The URL builders are pure; the two network helpers take a
// `fetchImpl` so tests can run them without a server.

const enc = encodeURIComponent;

/** The export formats, in the order the dialog lists them. `key` is the server's `format` value. */
export const EXPORT_FORMATS = [
  { key: 'markdown', label: 'Markdown', hint: 'One plain-text .md file' },
  { key: 'docx', label: 'Word', hint: 'A .docx file for Word or LibreOffice' },
  { key: 'epub', label: 'EPUB', hint: 'An e-book for readers and e-readers' },
  { key: 'pdf', label: 'PDF', hint: 'A print-ready .pdf file' },
];

export const PAGE_SIZES = [
  { key: 'letter', label: 'US Letter' },
  { key: 'a4', label: 'A4' },
];

/** The scene statuses the book format defines, in working order. Others found in a book are listed after these. */
export const STATUS_ORDER = ['outline', 'drafting', 'revised', 'final'];

/** The restore folder name the server accepts: one segment, a-z, 0-9 and hyphen, 1 to 60 characters. */
export const FOLDER_RE = /^[a-z0-9-]{1,60}$/;

/**
 * The statuses to offer for "Leave out scenes with status": those the book's scenes use (a book with none gets the standard ones).
 * @param {{ acts?: { chapters: { scenes: { status?: string | null }[] }[] }[] } | null | undefined} book the book detail from GET /api/books/:id
 * @returns {string[]}
 */
export function statusesOf(book) {
  const used = new Set((book?.acts ?? []).flatMap((a) => a.chapters.flatMap((c) => c.scenes.map((s) => s.status).filter((s) => typeof s === 'string' && s !== ''))));
  if (used.size === 0) return [...STATUS_ORDER];
  const known = STATUS_ORDER.filter((s) => used.has(s));
  return [...known, ...[...used].filter((s) => !STATUS_ORDER.includes(s)).sort()];
}

/** What to include (M05-J07). `key` is the server's `include` value. */
export const INCLUDE_OPTIONS = [
  { key: 'manuscript', label: 'Manuscript only', hint: 'Just your text. No provenance, provider or prompt data anywhere in the file.' },
  { key: 'summary', label: 'Manuscript + provenance summary', hint: 'Adds a "Provenance summary" chapter: for each scene, how its text came to be in plain words.' },
  { key: 'evidence', label: 'Complete private evidence package', hint: 'A .zip with the manuscript, the receipts and saved states behind it, an integrity check and a README.' },
];

/** Shown before an evidence package is downloaded. */
export const EVIDENCE_WARNING = 'This contains your full text history and any prompts you chose to keep.';

/** @param {string} bookId @param {{ format: string, sceneTitles?: boolean, excludeStatuses?: string[], page?: string, include?: string }} o */
export function exportUrl(bookId, { format, sceneTitles = false, excludeStatuses = [], page = 'letter', include = 'manuscript' }) {
  const q = [`format=${enc(format)}`, `sceneTitles=${sceneTitles ? 1 : 0}`];
  if (excludeStatuses.length > 0) q.push(`excludeStatuses=${excludeStatuses.map(enc).join(',')}`);
  if (format === 'pdf') q.push(`page=${enc(page)}`);
  if (include !== 'manuscript') q.push(`include=${enc(include)}`);
  return `/api/books/${enc(bookId)}/export?${q.join('&')}`;
}

/** @param {string} bookId @param {{ provenance?: boolean }} [o] */
export const backupUrl = (bookId, { provenance = false } = {}) => `/api/books/${enc(bookId)}/backup?provenance=${provenance ? 1 : 0}`;

/** The file name in a content-disposition header, or a fallback. @param {string | null} header @param {string} fallback */
export function filenameFrom(header, fallback) {
  const m = /filename="([^"]+)"/.exec(header ?? '');
  return m ? m[1] : fallback;
}

/** @param {number} status @param {any} json */
export function explainDownloadFailure(status, json) {
  if (status === 0) return 'StoryForge could not be reached. Try again in a moment.';
  if (status === 404) return 'That book is not in the library any more.';
  if (status === 400) return 'Those options are not allowed. Change them and try again.';
  if (status === 500 && json?.error === 'export_failed') {
    const first = Array.isArray(json.problems) && json.problems.length > 0 ? ` (${json.problems[0]})` : '';
    return `The file was built but did not match your manuscript, so it was not saved${first}. Nothing in your book was changed.`;
  }
  return `The file could not be made (${status}). Nothing in your book was changed.`;
}

/**
 * Fetch a file from the server.
 * @param {string} url @param {string} fallbackName @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: true, blob: Blob, filename: string } | { ok: false, message: string }>}
 */
export async function fetchDownload(url, fallbackName, fetchImpl = (...a) => globalThis.fetch(...a)) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: '*/*' } });
  } catch {
    return { ok: false, message: explainDownloadFailure(0, null) };
  }
  if (!res.ok) return { ok: false, message: explainDownloadFailure(res.status, await res.json().catch(() => null)) };
  return { ok: true, blob: await res.blob(), filename: filenameFrom(res.headers.get('content-disposition'), fallbackName) };
}

/** Hand a downloaded file to the browser's save flow. @param {Blob} blob @param {string} filename */
export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** A folder name to start from, made from a backup's file name ("salt-orchard-backup-20260102.zip" gives "salt-orchard"). @param {string} fileName */
export function suggestFolder(fileName) {
  const base = fileName.replace(/\.zip$/i, '').replace(/-backup-\d{8}$/i, '');
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** @param {number} status @param {any} json */
export function explainRestoreFailure(status, json) {
  if (status === 0) return 'StoryForge could not be reached. Try again in a moment.';
  if (status === 403) return 'The restore was not allowed from this page.';
  if (status === 413) return 'That backup is larger than 512 MB, which is more than StoryForge restores.';
  if (status === 409) return 'A folder with that name already exists and is not empty. Choose a different folder name.';
  if (status === 400 && json?.error === 'bad_request') return 'The folder name can only use a-z, 0-9 and hyphens (up to 60 characters).';
  if (status === 400 && json?.code === 'BACKUP_CORRUPT') return 'That file is not a complete StoryForge backup (it may be damaged or cut short). Nothing was restored.';
  if (status === 400) return 'That file was refused because it is not a safe StoryForge backup. Nothing was restored.';
  return `The backup could not be restored (${status}). Nothing was restored.`;
}

/**
 * Upload a backup zip to be restored into a new folder of the library.
 * @param {File} file @param {string} folder @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: true, bookId: string | null, diagnostics: any[] } | { ok: false, message: string }>}
 */
export async function uploadRestore(file, folder, fetchImpl = (...a) => globalThis.fetch(...a)) {
  let status = 0;
  let json = null;
  try {
    const res = await fetchImpl(`/api/library/restore?folder=${enc(folder)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-storyforge': '1', accept: 'application/json' },
      body: file,
    });
    status = res.status;
    json = await res.json().catch(() => null);
  } catch {
    // no answer at all: status stays 0
  }
  if (status === 200 && json && typeof json === 'object') return { ok: true, bookId: typeof json.bookId === 'string' ? json.bookId : null, diagnostics: json.diagnostics ?? [] };
  return { ok: false, message: explainRestoreFailure(status, json) };
}
