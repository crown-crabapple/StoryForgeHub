// Pure projections for comments, reviewer mode and presence (M07-J03b): who may do what in the UI, the requests, and the words. No network here.
// The UI only hides what a role cannot do; the server is the authority and refuses it anyway.

const enc = encodeURIComponent;

/** How often the open editor says it is here (the server forgets a person 60 s after the last one). */
export const HEARTBEAT_MS = 20_000;

/**
 * What the current session may do. `session` is useSession(): personal mode (no accounts) has one implicit owner; in shared mode the role decides; a share link only reads.
 * @param {{ mode?: string, user?: { role?: string } | null, share?: unknown } | null | undefined} session
 */
export function abilities(session) {
  const shared = session?.mode === 'shared';
  const role = shared ? session?.user?.role ?? null : 'owner';
  const rank = { viewer: 1, reviewer: 2, editor: 3, owner: 4 }[/** @type {'viewer'} */ (role ?? '')] ?? 0;
  return {
    role,
    /** the editor is read-only (reviewers, viewers and share links) */
    readOnly: shared && rank < 3,
    /** comment, reply and resolve */
    comment: rank >= 2,
    /** "Suggest change" is how a reviewer proposes text; editors and owners just edit */
    suggest: shared && role === 'reviewer',
    /** Accept / Decline on a suggestion, and every other write */
    decide: rank >= 3,
    /** the advisory "also in this scene" */
    present: shared && Boolean(session?.user),
  };
}

/** GET: the comments of one scene. @param {string} bookId @param {string} sceneId */
export const commentsUrl = (bookId, sceneId) => `/api/books/${enc(bookId)}/comments?target=${enc(sceneId)}`;

/** POST: a comment on lines of the file (1-based, front matter counted). @param {string} bookId @param {{ target: string, line: number, lines: number, quote?: string, text: string }} c */
export const commentCreateRequest = (bookId, { target, line, lines, quote, text }) => ({
  method: /** @type {const} */ ('POST'),
  url: `/api/books/${enc(bookId)}/comments`,
  body: { target, line, lines, ...(quote ? { quote } : {}), text },
});

/** POST: a reply. @param {string} bookId @param {string} commentId @param {string} text */
export const commentReplyRequest = (bookId, commentId, text) => ({ method: /** @type {const} */ ('POST'), url: `/api/books/${enc(bookId)}/comments/${enc(commentId)}/replies`, body: { text } });

/** POST: resolve or reopen. @param {string} bookId @param {string} commentId @param {'open' | 'resolved'} status */
export const commentStatusRequest = (bookId, commentId, status) => ({ method: /** @type {const} */ ('POST'), url: `/api/books/${enc(bookId)}/comments/${enc(commentId)}`, body: { status } });

/** POST: a reviewer's suggestion for the selected text (editor offsets into the body). @param {string} bookId @param {{ target: string, from: number, to: number, replacement: string, rationale?: string }} s */
export const suggestRequest = (bookId, { target, from, to, replacement, rationale }) => ({
  method: /** @type {const} */ ('POST'),
  url: `/api/books/${enc(bookId)}/suggestions`,
  body: { target, proposedRange: { from, to, replacement }, ...(rationale?.trim() ? { rationale: rationale.trim() } : {}) },
});

/** POST: "I have this scene open" (`scene: null`: I closed it). @param {string} bookId @param {string | null} sceneId */
export const presenceRequest = (bookId, sceneId) => ({ method: /** @type {const} */ ('POST'), url: `/api/books/${enc(bookId)}/presence`, body: { scene: sceneId } });

/** "Ilse is also in this scene" and the plural forms; '' when nobody else is. @param {{ name: string }[]} users */
export function alsoHereText(users) {
  const names = [...new Set((users ?? []).map((u) => String(u.name)))];
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is also in this scene`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are also in this scene`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are also in this scene`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others are also in this scene`;
}

/** One comment as the rail shows it (defaults for anything missing). @param {any} c */
export function readComment(c) {
  return {
    id: String(c?.id ?? ''),
    status: c?.status === 'resolved' ? 'resolved' : 'open',
    by: c?.by && typeof c.by.name === 'string' ? c.by.name : null,
    created: typeof c?.created === 'string' ? c.created : '',
    text: String(c?.text ?? ''),
    quote: String(c?.anchor?.quote ?? ''),
    line: Number.isInteger(c?.line) ? c.line : null,
    anchored: c?.anchored === true,
    replies: Array.isArray(c?.replies) ? c.replies.map((r) => ({ name: String(r?.name ?? ''), at: String(r?.at ?? ''), text: String(r?.text ?? '') })) : [],
  };
}

/** Open comments first (in file order), then resolved ones. @param {ReturnType<typeof readComment>[]} list */
export function splitComments(list) {
  const byLine = (a, b) => (a.line ?? Infinity) - (b.line ?? Infinity) || (a.created < b.created ? -1 : 1);
  return { open: list.filter((c) => c.status === 'open').sort(byLine), resolved: list.filter((c) => c.status === 'resolved').sort(byLine) };
}

/** A refusal in plain words. @param {number} status @param {any} json */
export function explainCommentFailure(status, json) {
  if (status === 0) return 'The server could not be reached. Nothing was saved.';
  if (status === 401) return 'You have been signed out. Sign in again; nothing was saved.';
  if (status === 403) return 'Your role cannot do this.';
  if (status === 404) return 'That scene or comment is not there any more.';
  if (status === 409 && json?.code === 'NO_CHANGE') return 'That is the same text as now: nothing to suggest.';
  if (status === 409) return 'The scene changed in the meantime. Select the text again.';
  return json?.message ?? `That did not work (${status}).`;
}
