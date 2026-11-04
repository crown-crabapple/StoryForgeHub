// The MCP tool table (M08 MCP service). Each tool is a name, a JSON Schema for its arguments, the permission it needs ('read' or 'propose') and a run() that talks to the
// plugin API /api/v1 only, through the `api` helper the protocol layer builds over the server's `call`. Nothing here touches a file or the network, and no tool can change a
// canonical file: the propose tools create a suggestion the author accepts or rejects in StoryForge. plugin-policy.mjs still decides every underlying request.

/** A failure whose message is safe to show the model (becomes an isError tool result). */
export class ToolError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * @typedef {{ get: (path: string, query?: Record<string, string>) => Promise<any>, post: (path: string, body?: unknown) => Promise<any> }} Api
 * @typedef {{ content: { type: 'text', text: string }[], structuredContent: Record<string, unknown> }} ToolResult
 * @typedef {{ name: string, title: string, description: string, need: 'read' | 'propose', inputSchema: Record<string, any>,
 *   annotations: { readOnlyHint: boolean, destructiveHint: false, idempotentHint: boolean, openWorldHint: false },
 *   run: (args: Record<string, any>, api: Api) => Promise<ToolResult> }} Tool
 */

const BOOK_DOC = 'The book is its slug or its id (see codex_list_books).';
const NOTE = 'Nothing was changed. The author reviews this suggestion in StoryForge and accepts or rejects it.';
const seg = (/** @type {string} */ s) => encodeURIComponent(s);
const bookPath = (/** @type {string} */ book) => `/api/v1/books/${seg(book)}`;

/** @param {unknown} obj @param {string} [text] @returns {ToolResult} */
const result = (obj, text) => ({ content: [{ type: 'text', text: text ?? JSON.stringify(obj, null, 2) }], structuredContent: /** @type {Record<string, unknown>} */ (obj) });

/** Result with the prose in a second content item. @param {Record<string, any>} obj the full object (with body) @param {string} bodyText @param {Record<string, any>} head */
const splitResult = (obj, bodyText, head) => ({ content: [{ type: 'text', text: JSON.stringify(head, null, 2) }, { type: 'text', text: bodyText }], structuredContent: obj });

const bookArg = { type: 'string', minLength: 1, maxLength: 200, description: `The book: its slug or its id.` };
const rationaleArg = { type: 'string', maxLength: 20000, description: 'Why the author should accept this change (shown in the review).' };
const shaArg = { type: 'string', minLength: 64, maxLength: 64, description: 'The sha256 of the file you read; the proposal is marked stale if the file changed since.' };

/** @param {Record<string, any>} properties @param {string[]} required */
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const READ = { readOnlyHint: true, destructiveHint: /** @type {const} */ (false), idempotentHint: true, openWorldHint: /** @type {const} */ (false) };
const PROPOSE = { readOnlyHint: false, destructiveHint: /** @type {const} */ (false), idempotentHint: false, openWorldHint: /** @type {const} */ (false) };

/** @param {Record<string, any>} args the optional proposal fields */
function proposalExtras(args) {
  return { ...(args.rationale !== undefined ? { rationale: args.rationale } : {}), ...(args.base_sha256 !== undefined ? { base_sha256: args.base_sha256 } : {}) };
}

/** @param {Api} api @param {string} book @param {Record<string, unknown>} payload */
async function propose(api, book, payload) {
  const res = await api.post(`${bookPath(book)}/proposals`, payload);
  return result({ suggestion: res.suggestion, note: NOTE });
}

/** @param {any} book @returns {any[]} every chapter with its act */
const chaptersOf = (book) => (book.acts ?? []).flatMap((/** @type {any} */ a) => (a.chapters ?? []).map((/** @type {any} */ c) => ({ ...c, act: a.act })));

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'codex_status',
    title: 'StoryForge status',
    description: 'Shows the StoryForge server and API version and lists the books in the library with their scene and word counts. Start here to find the book slugs.',
    need: 'read',
    inputSchema: schema({}, []),
    annotations: READ,
    async run(_args, api) {
      const root = await api.get('/api/v1');
      const { books } = await api.get('/api/v1/books');
      return result({ api: root.api, server: root.server, books: books.map((/** @type {any} */ b) => ({ slug: b.slug, title: b.title, scenes: b.scenes, words: b.words })) });
    },
  },
  {
    name: 'codex_list_books',
    title: 'List books',
    description: 'Lists every book in the StoryForge library: id, slug, title, status, series, language, scene count and word count.',
    need: 'read',
    inputSchema: schema({}, []),
    annotations: READ,
    async run(_args, api) {
      const { books } = await api.get('/api/v1/books');
      return result({ books });
    },
  },
  {
    name: 'codex_list_chapters',
    title: 'List chapters',
    description: `Lists a book's structure: its acts, the chapters in each act, and the scenes in each chapter (id, title, status, POV, word count). ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const b = await api.get(bookPath(args.book));
      return result({ book: { slug: b.slug, title: b.title }, acts: b.acts ?? [] });
    },
  },
  {
    name: 'codex_get_chapter',
    title: 'Read a chapter',
    description: `Reads every scene of one chapter in order, with each scene's markdown body and sha256. Match the chapter by its number, label or title (as shown by codex_list_chapters). If the same chapter number occurs in more than one act, pass act. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg, chapter: { type: 'string', minLength: 1, maxLength: 200, description: 'Chapter number, label or title.' }, act: { type: 'integer', description: 'Act number, to disambiguate.' } }, ['book', 'chapter']),
    annotations: READ,
    async run(args, api) {
      const b = await api.get(bookPath(args.book));
      const want = String(args.chapter);
      const matches = chaptersOf(b).filter((/** @type {any} */ c) => (args.act === undefined || c.act === args.act) && (String(c.chapter) === want || c.label === want || c.title === want));
      if (matches.length === 0) throw new ToolError(`no chapter matches "${want}"${args.act === undefined ? '' : ` in act ${args.act}`}; use codex_list_chapters to see the chapters`);
      if (matches.length > 1) throw new ToolError(`chapter "${want}" is ambiguous (${matches.length} matches, in acts ${matches.map((/** @type {any} */ c) => c.act).join(', ')}); give act`);
      const ch = matches[0];
      const scenes = [];
      for (const s of ch.scenes ?? []) {
        const full = await api.get(`${bookPath(args.book)}/scenes/${seg(s.id)}`);
        scenes.push({ id: s.id, title: s.title, order: s.order, status: s.status, pov: s.pov ?? null, words: s.words, sha256: full.sha256, path: s.path, body: full.body });
      }
      const obj = { book: b.slug, act: ch.act, chapter: ch.chapter, label: ch.label, title: ch.title, scenes };
      const head = { ...obj, scenes: scenes.map((s) => ({ ...s, body: undefined })) };
      const bodies = scenes.map((s) => `<!-- scene ${s.id} sha256 ${s.sha256} -->\n${s.body}`).join('\n\n');
      return splitResult(obj, bodies, head);
    },
  },
  {
    name: 'codex_get_scene',
    title: 'Read a scene',
    description: `Reads one scene: its metadata, front matter, sha256 and markdown body. ${BOOK_DOC} The scene is its id (scene_...).`,
    need: 'read',
    inputSchema: schema({ book: bookArg, scene: { type: 'string', minLength: 1, maxLength: 200, description: 'The scene id.' } }, ['book', 'scene']),
    annotations: READ,
    async run(args, api) {
      const scene = await api.get(`${bookPath(args.book)}/scenes/${seg(args.scene)}`);
      const { body, ...head } = scene;
      return splitResult(scene, String(body ?? ''), head);
    },
  },
  {
    name: 'codex_list_entries',
    title: 'List codex entries',
    description: `Lists the codex entries of a book (characters, places, items and so on): id, slug, type, name, status, role and aliases. Pass type to keep one kind. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg, type: { type: 'string', minLength: 1, maxLength: 100, description: 'Only entries of this type, for example "character".' } }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { entries } = await api.get(`${bookPath(args.book)}/entries`);
      return result({ entries: args.type === undefined ? entries : entries.filter((/** @type {any} */ e) => e.type === args.type) });
    },
  },
  {
    name: 'codex_get_entry',
    title: 'Read a codex entry',
    description: `Reads one codex entry: its fields, sha256 and markdown body. ${BOOK_DOC} The entry is its id (entry_...) or its slug.`,
    need: 'read',
    inputSchema: schema({ book: bookArg, entry: { type: 'string', minLength: 1, maxLength: 200, description: 'The entry id or slug.' } }, ['book', 'entry']),
    annotations: READ,
    async run(args, api) {
      const entry = await api.get(`${bookPath(args.book)}/entries/${seg(args.entry)}`);
      const { body, ...head } = entry;
      return splitResult(entry, String(body ?? ''), head);
    },
  },
  {
    name: 'codex_search',
    title: 'Search',
    description: 'Searches scenes and codex entries for text and returns hits with a snippet. Give book (slug or id) to search one book; leave it out to search every book (each hit then names its book).',
    need: 'read',
    inputSchema: schema({ query: { type: 'string', minLength: 1, maxLength: 200, description: 'The text to look for.' }, book: bookArg, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum hits to return (default 20).' } }, ['query']),
    annotations: READ,
    async run(args, api) {
      const limit = args.limit ?? 20;
      const q = { q: args.query, limit: String(limit) };
      if (args.book !== undefined) {
        const r = await api.get(`${bookPath(args.book)}/search`, q);
        return result({ query: args.query, hits: r.hits });
      }
      const { books } = await api.get('/api/v1/books');
      /** @type {any[]} */
      const hits = [];
      for (const b of books) {
        const r = await api.get(`${bookPath(b.slug)}/search`, q);
        for (const h of r.hits) hits.push({ ...h, book: b.slug });
      }
      return result({ query: args.query, hits: hits.slice(0, limit) });
    },
  },
  {
    name: 'codex_get_diagnostics',
    title: 'Book diagnostics',
    description: `Lists the problems StoryForge found in a book (broken references, missing fields and similar). ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { diagnostics } = await api.get(`${bookPath(args.book)}/diagnostics`);
      return result({ diagnostics });
    },
  },
  {
    name: 'codex_list_threads',
    title: 'List plot threads',
    description: `Lists the plot threads of a book. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { threads } = await api.get(`${bookPath(args.book)}/threads`);
      return result({ threads });
    },
  },
  {
    name: 'codex_get_timeline',
    title: 'Book timeline',
    description: `Lists the timeline events of a book. ${BOOK_DOC}`,
    need: 'read',
    inputSchema: schema({ book: bookArg }, ['book']),
    annotations: READ,
    async run(args, api) {
      const { events } = await api.get(`${bookPath(args.book)}/events`);
      return result({ events });
    },
  },
  {
    name: 'codex_save_chapter',
    title: 'Propose new scene text',
    description: `Proposes the whole new markdown body of one scene. Nothing changes until the author accepts the suggestion in StoryForge. Pass base_sha256 (from codex_get_scene or codex_get_chapter) so a stale proposal is detected. ${BOOK_DOC}`,
    need: 'propose',
    inputSchema: schema({ book: bookArg, scene: { type: 'string', minLength: 1, maxLength: 200, description: 'The scene id (scene_...).' }, markdown: { type: 'string', description: 'The complete new body of the scene.' }, rationale: rationaleArg, base_sha256: shaArg }, ['book', 'scene', 'markdown']),
    annotations: PROPOSE,
    async run(args, api) {
      return propose(api, args.book, { target: args.scene, text: args.markdown, ...proposalExtras(args) });
    },
  },
  {
    name: 'codex_save_entry',
    title: 'Propose new entry text',
    description: `Proposes the whole new markdown body of one codex entry. Nothing changes until the author accepts the suggestion in StoryForge. The entry is its id or slug. ${BOOK_DOC}`,
    need: 'propose',
    inputSchema: schema({ book: bookArg, entry: { type: 'string', minLength: 1, maxLength: 200, description: 'The entry id (entry_...) or slug.' }, markdown: { type: 'string', description: 'The complete new body of the entry.' }, rationale: rationaleArg, base_sha256: shaArg }, ['book', 'entry', 'markdown']),
    annotations: PROPOSE,
    async run(args, api) {
      let id = args.entry;
      if (!id.startsWith('entry_')) {
        const e = await api.get(`${bookPath(args.book)}/entries/${seg(id)}`);
        id = e.id;
      }
      return propose(api, args.book, { target: id, text: args.markdown, ...proposalExtras(args) });
    },
  },
  {
    name: 'codex_propose_edit',
    title: 'Propose an edit',
    description: `Proposes a change to a scene, entry, thread or event, either as the whole new text (text) or as targeted replacements (hunks, each {from, to, replacement} over character offsets into the body exactly as a get tool returned it; a line break counts as one character). Give exactly one of text and hunks. Nothing changes until the author accepts the suggestion in StoryForge. ${BOOK_DOC}`,
    need: 'propose',
    inputSchema: schema({
      book: bookArg,
      target: { type: 'string', minLength: 1, maxLength: 200, description: 'The id to change: scene_..., entry_..., thread_... or event_....' },
      text: { type: 'string', description: 'The complete new text of the target.' },
      hunks: { type: 'array', items: { type: 'object' }, description: 'Replacements: [{ "from": 0, "to": 5, "replacement": "text" }].' },
      rationale: rationaleArg,
      base_sha256: shaArg,
    }, ['book', 'target']),
    annotations: PROPOSE,
    async run(args, api) {
      if ((args.text === undefined) === (args.hunks === undefined)) throw new ToolError('give exactly one of "text" and "hunks"');
      const change = args.text !== undefined ? { text: args.text } : { hunks: args.hunks };
      return propose(api, args.book, { target: args.target, ...change, ...proposalExtras(args) });
    },
  },
];

/** Names an author of the original Codex MCP might ask for that v2 has no plugin route for. */
export const NOT_OFFERED = [
  'codex_create_chapter', 'codex_push_files', 'codex_list_docs', 'codex_get_doc', 'codex_save_doc', 'codex_append_doc', 'codex_lock_docs', 'codex_get_ledger',
  'codex_save_ledger_item', 'codex_delete_ledger_item', 'codex_get_cast', 'codex_set_chapter_cast', 'codex_knowledge_at', 'codex_record_knowledge', 'codex_delete_knowledge',
  'codex_continuity_check', 'codex_get_state_events', 'codex_record_state_events', 'codex_delete_state_event', 'codex_dismiss_finding', 'codex_restore_finding',
  'codex_set_continuity_thresholds', 'codex_get_tasks', 'codex_update_task', 'codex_complete_task', 'codex_create_task', 'codex_log_writing',
];
