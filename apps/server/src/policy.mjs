// Shared-mode route policy (contract M07-J03 section 3). Every API route has exactly one class; a route without one is refused in shared mode.
// Personal mode never consults this file (one implicit owner).
//
//   read     viewer and up; a share link for that one book
//   export   viewer and up; a share link whose scope includes 'export', for that one book
//   comment  reviewer and up            suggest  reviewer and up
//   write    editor and up              ai       editor and up, and only when the owner allows AI for members
//   admin    owner only                 auth     anyone (the login, logout, setup and invite-accept routes; they check what they need themselves)

const RANK = { viewer: 1, reviewer: 2, editor: 3, owner: 4 };
const NEEDS = { read: 1, export: 1, comment: 2, suggest: 2, write: 3, ai: 3, admin: 4 };

/** Write routes (matchWriteRoute names) and their class. Anything not listed is refused in shared mode. */
export const WRITE_CLASSES = Object.freeze({
  // manuscript, structure and planning edits
  'act-create': 'write', 'act-fields': 'write', 'activity-session': 'write', archive: 'write', 'attachment-upload': 'write', body: 'write',
  'chapter-archive': 'write', 'chapter-create': 'write', 'chapter-fields': 'write', 'chapters-renumber': 'write', 'check-scene': 'write',
  'codex-type-create': 'write', 'continuity-exception-archive': 'write', 'continuity-exception-create': 'write', create: 'write',
  'entry-archive': 'write', 'entry-body': 'write', 'entry-create': 'write', 'entry-fields': 'write', 'entry-restore': 'write', 'entry-slug': 'write',
  'event-archive': 'write', 'event-body': 'write', 'event-create': 'write', 'event-fields': 'write', 'event-restore': 'write', goal: 'write',
  'index-rebuild': 'write', 'note-archive': 'write', 'note-body': 'write', 'note-create': 'write', 'note-fields': 'write', 'note-restore': 'write',
  'op-restore': 'write', 'receipts-flush': 'write', restore: 'write', 'revision-restore': 'write', 'revision-save': 'write', 'scene-fields': 'write',
  'scene-merge': 'write', 'scene-move': 'write', 'scene-raw': 'write', 'scene-split': 'write', 'suggestion-decide': 'write',
  'suggestion-hunk-decide': 'write', 'thread-body': 'write', 'thread-create': 'write', 'thread-fields': 'write',
  // M07-J03b: comments and a reviewer's suggestion are open to reviewers; the presence heartbeat is advisory and read-only (it records nothing in the library)
  'comment-create': 'comment', 'comment-reply': 'comment', 'comment-resolve': 'comment', 'suggestion-create': 'suggest', presence: 'read',
  // AI workshop: sending is 'ai'; applying a result changes prose, so it also needs write (ai already implies editor)
  'ai-context': 'ai', 'ai-send': 'ai', 'ai-apply': 'ai', 'ai-discard': 'ai',
  // library-level and machine-level operations
  'library-open': 'admin', 'recent-remove': 'admin', recover: 'admin', repair: 'admin', 'backup-restore': 'admin', 'book-create': 'admin',
  'ai-profile-create': 'admin', 'ai-profile-update': 'admin', 'ai-profile-delete': 'admin', 'ai-profile-test': 'admin', 'ai-book-profile': 'admin',
  'ai-records': 'admin',
  // shared-mode administration (shared-routes.mjs)
  'shared-member-role': 'admin', 'shared-member-remove': 'admin', 'shared-invite-create': 'admin', 'shared-invite-revoke': 'admin',
  'shared-share-create': 'admin', 'shared-share-revoke': 'admin', 'shared-settings': 'admin',
});

/**
 * Class of a GET /api/... path, and the book it is about (for share links). Unknown paths → null (refused in shared mode).
 * @param {string} pathname
 * @returns {{ cls: string, book?: string } | null}
 */
export function classifyRead(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return null;
  const [, a, b, c, d] = parts;
  if (a === 'health' && parts.length === 2) return { cls: 'read' };
  if (a === 'status' && parts.length === 2) return { cls: 'read' };
  if (a === 'auth') return { cls: 'auth' };
  if (a === 'shared') return { cls: 'admin' }; // members, invites, shares, audit
  if (a === 'recover' || (a === 'ai' && b === 'profiles') || (a === 'library' && b === 'recent')) return { cls: 'admin' };
  if (a === 'library' && parts.length === 2) return { cls: 'read' };
  if ((a === 'search' || a === 'templates') && parts.length === 2) return { cls: 'read' };
  if (a === 'index' && b === 'status' && parts.length === 3) return { cls: 'read' };
  if (a === 'books') {
    if (b === undefined) return { cls: 'read' };
    if (c === 'backup' || (c === 'repair' && d === 'plan')) return { cls: 'admin', book: b };
    if (c === 'export') return { cls: 'export', book: b };
    return { cls: 'read', book: b };
  }
  return null;
}

/**
 * The book a write route is about, from its match.
 * @param {{ bookId?: string }} match
 */
export const bookOfWrite = (match) => match.bookId;

/**
 * May `principal` use a route of class `cls` (about `book`, when it is about one)?
 * @param {import('@storyforge/shared/src/shared-data.mjs').Principal | null} principal
 * @param {string} cls
 * @param {{ book?: string, aiForMembers?: boolean, path?: string }} [ctx]
 */
export function allowed(principal, cls, ctx = {}) {
  if (cls === 'auth') return true;
  if (!principal) return false;
  if (principal.kind === 'share') {
    // a share reads one book (and exports it when its scope says so); the top-level reads the reader page needs are allowed, nothing else
    if (cls === 'read' && ctx.book === undefined) return ctx.path === '/api/health' || ctx.path === '/api/status';
    if (ctx.book !== principal.book) return false;
    if (cls === 'read') return true;
    if (cls === 'export') return principal.scope.includes('export');
    return false;
  }
  const rank = RANK[/** @type {keyof typeof RANK} */ (principal.role)] ?? 0;
  const need = NEEDS[/** @type {keyof typeof NEEDS} */ (cls)];
  if (need === undefined || rank < need) return false;
  if (cls === 'ai' && principal.role !== 'owner' && !ctx.aiForMembers) return false;
  return true;
}
