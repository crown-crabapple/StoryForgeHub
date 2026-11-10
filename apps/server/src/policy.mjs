// Shared-mode route policy (contract M07-J03 section 3). Every API route has exactly one class; a route without one is refused in shared mode.
// Personal mode never consults this file (one implicit owner).
//
//   read     viewer and up; a share link for that one book
//   export   viewer and up; a share link whose scope includes 'export', for that one book
//   comment  reviewer and up            suggest  reviewer and up
//   write    editor and up              ai       editor and up, and only when the owner allows AI for members
//   admin    owner only                 auth     anyone (the login, logout, setup and invite-accept routes; they check what they need themselves)
//   public   anyone (only /api/health, the liveness probe; a signed-out caller gets { ok: true } and nothing else)

const RANK = { viewer: 1, reviewer: 2, editor: 3, owner: 4 };
const NEEDS = { read: 1, export: 1, comment: 2, suggest: 2, write: 3, ai: 3, admin: 4 };

/** Write routes (matchWriteRoute names) and their class. Anything not listed is refused in shared mode. */
export const WRITE_CLASSES = Object.freeze({
  // manuscript, structure and planning edits
  'act-create': 'write', 'act-fields': 'write', 'activity-session': 'write', archive: 'write', 'attachment-upload': 'write', body: 'write',
  'chapter-archive': 'write', 'chapter-create': 'write', 'chapter-fields': 'write', 'chapter-move': 'write', 'chapters-renumber': 'write', 'check-scene': 'write',
  'codex-type-create': 'write', 'continuity-exception-archive': 'write', 'continuity-exception-create': 'write', 'continuity-settings-save': 'write', create: 'write',
  'entry-archive': 'write', 'entry-body': 'write', 'entry-create': 'write', 'entry-fields': 'write', 'entry-restore': 'write', 'entry-slug': 'write',
  'event-archive': 'write', 'event-body': 'write', 'event-create': 'write', 'event-fields': 'write', 'event-restore': 'write', goal: 'write',
  'index-rebuild': 'write', 'note-archive': 'write', 'note-body': 'write', 'note-create': 'write', 'note-fields': 'write', 'note-restore': 'write',
  'op-restore': 'write', 'receipts-flush': 'write', restore: 'write', 'revision-restore': 'write', 'revision-save': 'write', 'scene-fields': 'write',
  'scene-merge': 'write', 'scenes-archive': 'write', 'scene-move': 'write', 'scene-raw': 'write', 'scene-split': 'write', 'suggestion-decide': 'write',
  'suggestion-hunk-decide': 'write', 'thread-body': 'write', 'thread-create': 'write', 'thread-fields': 'write',
  // M07-J03b: comments and a reviewer's suggestion are open to reviewers; the presence heartbeat is advisory and read-only (it records nothing in the library)
  'comment-create': 'comment', 'comment-reply': 'comment', 'comment-resolve': 'comment', 'suggestion-create': 'suggest', presence: 'read',
  // AI workshop: sending is 'ai'; applying a result changes prose, so it also needs write (ai already implies editor)
  'ai-context': 'ai', 'ai-send': 'ai', 'ai-apply': 'ai', 'ai-discard': 'ai',
  // M08-J03: stopping a streamed reply and asking for a cover draft are AI use; choosing or deleting a draft is an ordinary edit of the book
  'ai-cancel': 'ai', 'ai-cover-generate': 'ai', 'ai-cover-use': 'write', 'ai-cover-delete': 'write',
  // library-level and machine-level operations
  'library-open': 'admin', 'recent-remove': 'admin', recover: 'admin', repair: 'admin', 'backup-restore': 'admin', 'book-create': 'admin',
  'ai-profile-create': 'admin', 'ai-profile-update': 'admin', 'ai-profile-delete': 'admin', 'ai-profile-test': 'admin', 'ai-book-profile': 'admin',
  'ai-records': 'admin', 'ai-profile-secure': 'admin', 'ai-profile-discover': 'admin',
  // M07-J01b series worlds: shared-entry moves and labels are ordinary edits; saving a library template writes library-level files
  'entry-move-to-series': 'write', 'entry-copy-to-book': 'write', 'labels-set': 'write', 'template-save': 'admin',
  // M09-J01 canvases (planning/canvases/*.canvas; planning material, never prose)
  'canvas-create': 'write', 'canvas-save': 'write', 'canvas-archive': 'write', 'canvas-restore': 'write',
  // M12 W2 workspace docs (planning/workspace, planning/state, planning/development; planning material, never prose). Lock and unlock are write too: owner and editor.
  'workspace-doc-save': 'write', 'workspace-doc-append': 'write', 'workspace-doc-lock': 'write', 'workspace-doc-archive': 'write', 'workspace-doc-restore': 'write', 'workspace-setup': 'write',
  // Story Planner M1 (ADR 0003): planning/links/*.md and planning/scene-plans/*.md only; never a scene file
  'planner-link-create': 'write', 'planner-link-update': 'write', 'planner-link-archive': 'write', 'planner-link-restore': 'write', 'planner-scene-plan-save': 'write', 'planner-story-plan-save': 'write',
  'planner-arc-create': 'write', 'planner-arc-update': 'write', 'planner-arc-milestones': 'write', 'planner-arc-archive': 'write', 'planner-arc-restore': 'write',
  'planner-structure-create': 'write', 'planner-structure-update': 'write', 'planner-structure-beats': 'write', 'planner-structure-archive': 'write', 'planner-structure-restore': 'write',
  'planner-relationship-create': 'write', 'planner-relationship-update': 'write', 'planner-relationship-developments': 'write', 'planner-relationship-archive': 'write', 'planner-relationship-restore': 'write',
  'planner-clue-create': 'write', 'planner-clue-update': 'write', 'planner-clue-knowers': 'write', 'planner-clue-archive': 'write', 'planner-clue-restore': 'write',
  'planner-synopsis-create': 'write', 'planner-synopsis-update': 'write', 'planner-synopsis-archive': 'write', 'planner-synopsis-restore': 'write',
  // M07-J02 goals and revision tasks (book files; never prose)
  'goal-set': 'write', 'goal-remove': 'write', 'task-create': 'write', 'task-status': 'write',
  // M12 W3: a scene's chapter cast (its `cast` key only), knowledge and state items on a chapter's state event, the AI words of the writing log (never prose)
  'scene-cast': 'write', 'ledger-knowledge-record': 'write', 'ledger-state-record': 'write', 'activity-ai-log': 'write',
  // M12 W6: the body of a scene the AI made and the author has not accepted (origin: ai, status drafting); anything else is refused by the route itself
  'scene-ai-draft': 'write',
  // M07-J04 profiles: per-machine appearance settings of the server process, so in shared mode only the owner changes them
  'profile-save': 'admin', 'profile-switch': 'admin', 'profile-delete': 'admin',
  // shared-mode administration (shared-routes.mjs)
  'shared-member-role': 'admin', 'shared-member-remove': 'admin', 'shared-invite-create': 'admin', 'shared-invite-revoke': 'admin',
  'shared-share-create': 'admin', 'shared-share-revoke': 'admin', 'shared-settings': 'admin',
  // M08-J02 plugin access tokens and webhook subscriptions: a token or a webhook reaches the author's book, so in shared mode only the owner grants them
  'plugin-grant': 'admin', 'plugin-revoke': 'admin', 'webhook-create': 'admin', 'webhook-revoke': 'admin',
  // OAuth for MCP (oauth-routes.mjs): approving a client makes an AI connection, so it is the owner's, like plugin-grant
  'oauth-approve': 'admin', 'oauth-deny': 'admin',
  // M12: how much AI a book allows (it caps every token), so in shared mode only the owner sets it
  'book-ai-level': 'admin',
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
  // liveness probe: anyone (server.mjs answers a signed-out caller with only { ok: true })
  if (a === 'health' && parts.length === 2) return { cls: 'public' };
  if (a === 'status' && parts.length === 2) return { cls: 'read' };
  if (a === 'auth') return { cls: 'auth' };
  if (a === 'shared') return { cls: 'admin' }; // members, invites, shares, audit
  if (a === 'oauth' && b === 'request' && parts.length === 3) return { cls: 'admin' }; // the OAuth consent page: only the owner connects an AI app
  if ((a === 'plugins' || a === 'webhooks') && parts.length === 2) return { cls: 'admin' }; // M08-J02: the manifests, grants and subscriptions (never a token or a secret)
  if (a === 'recover' || (a === 'ai' && b === 'profiles') || (a === 'library' && b === 'recent')) return { cls: 'admin' };
  if (a === 'library' && parts.length === 2) return { cls: 'read' };
  if ((a === 'search' || a === 'templates') && parts.length === 2) return { cls: 'read' };
  // M07-J04: the effective preferences (layers, modules) and the library's prompt components
  if ((a === 'preferences' || a === 'prompts') && parts.length === 2) return { cls: 'read' };
  if (a === 'index' && b === 'status' && parts.length === 3) return { cls: 'read' };
  if (a === 'books') {
    if (b === undefined) return { cls: 'read' };
    if (c === 'backup' || (c === 'repair' && d === 'plan')) return { cls: 'admin', book: b };
    // Story Planner M8: the planning export is private project data (members only, never a share link), like the planner reads
    if (c === 'export' && d === 'planning') return { cls: 'read', book: b, shareable: false };
    if (c === 'export') return { cls: 'export', book: b };
    if (c === 'ai' && d === 'stream') return { cls: 'ai', book: b }; // M08-J03: a reply in progress is AI use (editor, and only when the owner allows AI for members)
    // what a share link may read of its book: the book, a scene's text, the cover. Notes, receipts, suggestions, comments, revisions, raw
    // files, activity and AI state are private project data (DECISIONS 12) and stay member-only.
    const shareable = c === undefined || c === 'cover' || (c === 'scenes' && d !== undefined && parts.length === 5);
    return { cls: 'read', book: b, shareable };
  }
  return null;
}

/**
 * Does this member reach only some books? Owners never are limited.
 * @param {any} principal @returns {boolean}
 */
export const isLimited = (principal) => principal?.kind === 'user' && principal.role !== 'owner' && principal.books !== null && principal.books !== undefined;

/**
 * The member's role on one book: their library role when not limited, else the role listed for that exact book id, else null (no access).
 * @param {any} principal @param {string} bookId @returns {string | null}
 */
export function roleOnBook(principal, bookId) {
  if (!isLimited(principal)) return principal?.kind === 'user' ? principal.role : null;
  return typeof bookId === 'string' && Object.hasOwn(principal.books, bookId) ? principal.books[bookId] : null;
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
 * @param {{ book?: string, shareable?: boolean, aiForMembers?: boolean, path?: string }} [ctx]  `shareable`: a read a share link may make (classifyRead)
 */
export function allowed(principal, cls, ctx = {}) {
  if (cls === 'auth' || cls === 'public') return true;
  if (!principal) return false;
  if (principal.kind === 'share') {
    // a share reads one book (and exports it when its scope says so); the top-level reads the reader page needs are allowed, nothing else
    if (cls === 'read' && ctx.book === undefined) return ctx.path === '/api/health' || ctx.path === '/api/status';
    if (ctx.book !== principal.book) return false;
    if (cls === 'read') return ctx.shareable === true;
    if (cls === 'export') return principal.scope.includes('export');
    return false;
  }
  // per-book access: a member with a book list has a role only on those books. A route about a book uses that book's role (none = refused); a route about
  // no book is open to such a member only as a read (and server.mjs narrows those reads to the member's books via book-scope.mjs). Fail closed: the book in
  // the path must equal a listed id exactly (an encoded or slug form simply finds no role).
  let role = principal.role;
  if (isLimited(principal)) {
    if (ctx.book !== undefined) {
      role = roleOnBook(principal, ctx.book);
      if (role === null) return false;
    } else if (cls === 'read') role = 'viewer';
    else return false;
  }
  const rank = RANK[/** @type {keyof typeof RANK} */ (role)] ?? 0;
  const need = NEEDS[/** @type {keyof typeof NEEDS} */ (cls)];
  if (need === undefined || rank < need) return false;
  if (cls === 'ai' && principal.role !== 'owner' && !ctx.aiForMembers) return false;
  return true;
}
