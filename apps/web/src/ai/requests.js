// Calls to the AI routes (all through the local server; the browser never talks to a provider). Same write-guard header as the other write calls.

/** @param {string} method @param {string} url @param {unknown} [body] @returns {Promise<{ status: number, json: any }>} */
export async function aiRequest(method, url, body = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-storyforge': '1', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, json };
}

/** @param {string} url @returns {Promise<{ status: number, json: any }>} */
export async function aiGet(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, json };
}

const enc = encodeURIComponent;
export const aiUrl = {
  profiles: '/api/ai/profiles',
  profile: (id) => `/api/ai/profiles/${enc(id)}`,
  test: (id) => `/api/ai/profiles/${enc(id)}/test`,
  discover: (id) => `/api/ai/profiles/${enc(id)}/discover`,
  secure: (id) => `/api/ai/profiles/${enc(id)}/secure`,
  bookStatus: (bookId) => `/api/books/${enc(bookId)}/ai/status`,
  bookProfile: (bookId) => `/api/books/${enc(bookId)}/ai/profile`,
  bookRecords: (bookId) => `/api/books/${enc(bookId)}/ai/records`,
  context: (bookId) => `/api/books/${enc(bookId)}/ai/context`,
  send: (bookId) => `/api/books/${enc(bookId)}/ai/send`,
  apply: (bookId) => `/api/books/${enc(bookId)}/ai/apply`,
  discard: (bookId) => `/api/books/${enc(bookId)}/ai/discard`,
  cancel: (bookId) => `/api/books/${enc(bookId)}/ai/cancel`,
  stream: (bookId, contextId, from) => `/api/books/${enc(bookId)}/ai/stream?context=${enc(contextId)}&from=${from}`,
  cover: (bookId) => `/api/books/${enc(bookId)}/ai/cover`,
  coverGenerate: (bookId) => `/api/books/${enc(bookId)}/ai/cover-generate`,
  coverUse: (bookId) => `/api/books/${enc(bookId)}/ai/cover-use`,
  coverDelete: (bookId) => `/api/books/${enc(bookId)}/ai/cover-delete`,
  coverDraft: (bookId, name) => `/api/books/${enc(bookId)}/ai/cover-draft?name=${enc(name)}`,
  undo: (bookId, opId) => `/api/books/${enc(bookId)}/ops/${enc(opId)}/restore`,
};

/** A short, human reading of a failed AI call. @param {{ status: number, json: any }} r */
export function problemText(r) {
  const j = r.json ?? {};
  if (j.code === 'AI_NOT_CONFIGURED') return 'AI is not set up for this book. Nothing was sent.';
  if (j.code === 'SCENE_CHANGED') return 'The scene changed after the preview, so nothing was written. Preview again to rewrite the current text.';
  if (j.code === 'KEYS_LOCKED') return `${j.message} Enter the key again in Settings, or restore the key file. Nothing was sent.`;
  if (j.code === 'CONTEXT_NOT_FOUND') return 'That preview expired (they last 15 minutes). Preview again.';
  if (typeof j.message === 'string') return j.message;
  return `The request failed (${r.status}).`;
}
