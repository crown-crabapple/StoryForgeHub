// The write requests the Codex page sends, and how a refusal is put into words. Pure: nothing is sent here.
// A request is { method: 'POST', url, body }; the page sends each with `dryRun: true` first (the preview) and then for real.

const enc = encodeURIComponent;
const base = (bookId) => `/api/books/${enc(bookId)}`;

/**
 * New entry. For a type that does not exist yet (`newType`), the type file is created first and the entry gets the type's default field
 * labels with empty values (what the server would take from the type file).
 * @param {string} bookId
 * `where: 'series'` (M07-J01b) makes a shared entry in the book's series (and, for a new type, the type file in the series); the default is the book.
 * Fields of a new type are labels, or typed items `{ label, kind, choices? }`; the entry starts with each label empty.
 * @param {{ type: string, name: string, slug?: string, status?: string, where?: 'book' | 'series', newType?: { name: string, plural?: string, fields: (string | { label: string })[] } | null }} f
 * @returns {{ method: 'POST', url: string, body: Record<string, unknown> }[]}
 */
export function newEntryRequests(bookId, { type, name, slug, status = 'seed', where = 'book', newType = null }) {
  const out = [];
  const here = where === 'series' ? { where: 'series' } : {};
  if (newType) {
    out.push({
      method: /** @type {const} */ ('POST'),
      url: `${base(bookId)}/codex/types`,
      body: { type, name: newType.name, ...(newType.plural ? { plural: newType.plural } : {}), fields: newType.fields, ...here },
    });
  }
  out.push({
    method: 'POST',
    url: `${base(bookId)}/entries`,
    body: {
      type,
      name,
      ...(slug ? { slug } : {}),
      status,
      ...(newType && newType.fields.length > 0 ? { fields: newType.fields.map((f) => ({ label: typeof f === 'string' ? f : f.label, value: '' })) } : {}),
      ...here,
    },
  });
  return out;
}

/** Move a book's entry into its series' codex (the id is kept). @param {string} bookId @param {string} entryId */
export const moveToSeriesRequest = (bookId, entryId) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/entries/${enc(entryId)}/move-to-series`, body: {} });

/** Copy a shared entry into the book (a new id, the same slug). @param {string} bookId @param {string} entryId */
export const copyToBookRequest = (bookId, entryId) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/entries/${enc(entryId)}/copy-to-book`, body: {} });

/** A new type on its own; its fields are labels or typed `{ label, kind, choices? }` items. @param {string} bookId @param {{ type: string, name: string, plural?: string, fields: (string | { label: string, kind: string, choices?: string[] })[] }} t */
export const newTypeRequest = (bookId, t) => ({
  method: /** @type {const} */ ('POST'),
  url: `${base(bookId)}/codex/types`,
  body: { type: t.type, name: t.name, ...(t.plural ? { plural: t.plural } : {}), fields: t.fields },
});

/** @param {string} bookId @param {string} entryId @param {Record<string, unknown>} patch only what changed */
export const fieldsRequest = (bookId, entryId, patch) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/entries/${enc(entryId)}/fields`, body: patch });

/** @param {string} bookId @param {string} entryId @param {string} slug */
export const slugRequest = (bookId, entryId, slug) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/entries/${enc(entryId)}/slug`, body: { slug } });

/** @param {string} bookId @param {string} entryId */
export const archiveRequest = (bookId, entryId) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/entries/${enc(entryId)}/archive`, body: {} });

/** @param {string} bookId @param {string} entryId */
export const restoreRequest = (bookId, entryId) => ({ method: /** @type {const} */ ('POST'), url: `${base(bookId)}/entries/${enc(entryId)}/restore`, body: {} });

/** GET <this> is the entry with its `body` and `sha256`; PUT <this>/body saves the text. @param {string} bookId @param {string} entryId */
export const entryUrl = (bookId, entryId) => `${base(bookId)}/entries/${enc(entryId)}`;

/**
 * The refusal of a write, in words the author can act on.
 * @param {number} status @param {any} json
 */
export function explainCodexFailure(status, json) {
  if (status === 0) return 'The server could not be reached.';
  if (status === 403) return 'The server refused the request.';
  const message = typeof json?.message === 'string' && json.message !== '' ? json.message : null;
  switch (json?.code) {
    case 'SLUG_TAKEN':
      // Move to series and Copy into this book say which side already has the slug
      if (message && /^(the series|this book already)/i.test(message)) return `${message.charAt(0).toUpperCase()}${message.slice(1)}. Nothing was changed.`;
      return 'That slug is already used by another entry, thread or event. Choose a different one.';
    case 'REFUSED_NO_SERIES':
      return 'This book is not in a series, so there is no shared codex to use.';
    case 'TYPE_EXISTS':
      return 'That type already exists.';
    case 'REFUSED_UNSIMPLE_FIELD':
      return `${message ?? 'A line of this file is too complex to edit safely.'} Nothing was changed.`;
    case 'REFUSED_PATH_TAKEN':
      return 'A file with that name already exists. Nothing was changed.';
    case 'ROLLED_BACK':
      return `${message ?? 'The change would have broken the book'}${Array.isArray(json?.diagnostics) && json.diagnostics.length > 0 ? ` (${json.diagnostics.map((d) => `${d.code} ${d.location || ''}`.trim()).slice(0, 3).join(', ')})` : ''}; nothing was changed.`;
    default:
      break;
  }
  if (status === 409 || json?.error === 'conflict') return 'The file changed on disk since it was read. Reload the page and try again; nothing was changed.';
  if (status === 404) return 'That entry is not there any more. Reload the page.';
  return message ?? `The change was not made (${json?.code ?? status}).`;
}
