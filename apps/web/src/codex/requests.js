// The write requests the Codex page sends, and how a refusal is put into words. Pure: nothing is sent here.
// A request is { method: 'POST', url, body }; the page sends each with `dryRun: true` first (the preview) and then for real.

const enc = encodeURIComponent;
const base = (bookId) => `/api/books/${enc(bookId)}`;

/**
 * New entry. For a type that does not exist yet (`newType`), the type file is created first and the entry gets the type's default field
 * labels with empty values (what the server would take from the type file).
 * @param {string} bookId
 * @param {{ type: string, name: string, slug?: string, status?: string, newType?: { name: string, plural?: string, fields: string[] } | null }} f
 * @returns {{ method: 'POST', url: string, body: Record<string, unknown> }[]}
 */
export function newEntryRequests(bookId, { type, name, slug, status = 'seed', newType = null }) {
  const out = [];
  if (newType) {
    out.push({
      method: /** @type {const} */ ('POST'),
      url: `${base(bookId)}/codex/types`,
      body: { type, name: newType.name, ...(newType.plural ? { plural: newType.plural } : {}), fields: newType.fields },
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
      ...(newType && newType.fields.length > 0 ? { fields: newType.fields.map((label) => ({ label, value: '' })) } : {}),
    },
  });
  return out;
}

/** A new type on its own. @param {string} bookId @param {{ type: string, name: string, plural?: string, fields: string[] }} t */
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
      return 'That slug is already used by another entry, thread or event. Choose a different one.';
    case 'TYPE_EXISTS':
      return 'That type already exists.';
    case 'REFUSED_UNSIMPLE_FIELD':
      return `${message ?? 'A line of this file is too complex to edit safely.'} Nothing was changed.`;
    case 'REFUSED_PATH_TAKEN':
      return 'A file with that name already exists. Nothing was changed.';
    case 'ROLLED_BACK':
      return `${message ?? 'The change would have broken the book'}; nothing was changed.`;
    default:
      break;
  }
  if (status === 409 || json?.error === 'conflict') return 'The file changed on disk since it was read. Reload the page and try again; nothing was changed.';
  if (status === 404) return 'That entry is not there any more. Reload the page.';
  return message ?? `The change was not made (${json?.code ?? status}).`;
}
