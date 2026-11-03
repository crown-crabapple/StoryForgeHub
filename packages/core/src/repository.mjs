// FileRepository: the interface between the app and the project files.
// This module holds types only; implementations live in fs-repository.mjs (reads) and fs-writes.mjs (writes).

/**
 * @typedef {{
 *   code: string,
 *   severity: 'error' | 'warning' | 'info',
 *   file: string,
 *   location: string,
 *   message: string,
 * }} Diagnostic  The `@storyforge/format` diagnostic shape.
 */

/**
 * @typedef {{
 *   id: string,
 *   slug: string | null,
 *   title: string | null,
 *   series: string | null,
 *   series_number: number | null,
 *   status: string | null,
 *   path: string,
 *   scene_count: number,
 *   word_count: number,
 *   error_count: number,
 *   warning_count: number,
 *   subtitle: string | null,
 *   pen_name: string | null,
 *   pen_name_display: string | null,
 *   genre: string[],
 *   word_target: number | null,
 *   language: string | null,
 *   series_title: string | null,
 *   archived: boolean,
 *   cover_color: string | null,
 *   cover_state: 'image' | 'none' | 'missing' | 'unsupported' | 'outside',
 *   cover_url: string | null,
 *   blurb: string,
 *   index_state: 'invalid' | 'ok',
 * }} BookSummary  `path` is relative to the library root, forward slashes ('' for a one-book root).
 *   `cover_url` is /api/books/:id/cover?v=<first 8 hex of the image's sha256> when cover_state is 'image'.
 *   `index_state` is 'invalid' while the book has manuscript-structure errors (J04), else 'ok'.
 */

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   position: number,
 *   act: number,
 *   chapter: number,
 *   sequence: number,
 *   status: string | null,
 *   pov: string | null,
 *   word_count: number,
 *   path: string,
 * }} SceneSummary
 */

/**
 * @typedef {{
 *   chapter: number,
 *   label: string,
 *   title: string | null,
 *   scenes: SceneSummary[],
 * }} ChapterNode
 */

/**
 * @typedef {{ act: number, label: string, title?: string | null, chapters: ChapterNode[] }} ActNode  `title` comes from act.md (null if none).
 */

/**
 * @typedef {{
 *   id: string | null,
 *   path: string,
 *   reason: 'variant' | 'archived' | 'outside-manuscript' | 'unsupported-schema',
 * }} Excluded
 */

/**
 * @typedef {BookSummary & { acts: ActNode[], excluded: Excluded[] }} BookDetail
 */

/**
 * @typedef {SceneSummary & { front_matter: Record<string, any>, body: string, sha256: string | null }} SceneDoc
 *   `body` is the text after the front matter, exactly as on disk. `sha256` is the hash of the whole file.
 */

/**
 * @typedef {{ opId: string, op: string | null, files: string[], reason?: string, book?: string }} RecoverItem
 * @typedef {{ completed: RecoverItem[], rolledBack: RecoverItem[], needsAttention: RecoverItem[] }} RecoverReport
 */

/**
 * @typedef {{ ok: boolean, code: string, message?: string, diagnostics?: Diagnostic[] }} WriteResult
 *   Write methods never throw on expected failures. Codes: OK, CONFLICT (with `current`), NOT_FOUND,
 *   EXISTS, ROLLED_BACK, BAD_ARGS, NOT_A_SCENE, or a manuscript REFUSED_* code.
 */

/**
 * @typedef {WriteResult & { dryRun?: boolean, opId?: string, changes?: { from: string | null, to: string, before_sha256: string | null, after_sha256: string, diff?: string }[], [extra: string]: any }} StructureResult
 *   M03-J01 structure commands (see @storyforge/manuscript). `dryRun: true` writes nothing and returns `changes` with a unified `diff` each;
 *   paths are relative to the book root. Unknown scene / chapter / act / op is NOT_FOUND.
 */

/**
 * @typedef {{ slug: string, title: string | null, status: string | null, book_ids: string[] }} SeriesInfo
 * @typedef {{ root: string, title: string | null, diagnostics: Diagnostic[], series: SeriesInfo[] }} LibraryInfo
 */

/**
 * @typedef {{
 *   libraryInfo(): Promise<LibraryInfo>,
 *   listBooks(): Promise<BookSummary[]>,
 *   getBook(bookId: string): Promise<BookDetail | null>,
 *   bookRoot(bookId: string): Promise<string | null>,
 *   rescan(): Promise<void>,
 *   getCover(bookId: string): Promise<{ bytes: Buffer, contentType: string, sha256: string } | { error: 'too_large' } | null>,
 *   getScene(bookId: string, sceneId: string): Promise<SceneDoc | null>,
 *   getDiagnostics(bookId?: string): Promise<Diagnostic[]>,
 *   getContinuity(bookId: string): Promise<import('@storyforge/continuity').ContinuityResult | null>,
 *   createContinuityException(bookId: string, args: { fingerprint: string, rationale: string, title?: string, dryRun?: boolean }): Promise<WriteResult & Record<string, any>>,
 *   archiveContinuityException(bookId: string, slug: string, args?: { dryRun?: boolean }): Promise<WriteResult & Record<string, any>>,
 *   getContinuityContext(bookId: string, args: { file?: unknown, line?: unknown, radius?: unknown }): Promise<WriteResult & { lines?: { n: number, text: string }[] }>,
 *   createSuggestion(bookId: string, args: { target: string, proposedText?: string, proposedRange?: { from: number, to: number, replacement: string }, source: 'ai' | 'claude-book' | 'author', mode?: 'suggest' | 'state' | 'canon', rationale?: string, ai?: Record<string, any>, expectSha256?: string }): Promise<WriteResult & Record<string, any>>,
 *   listSuggestions(bookId: string, args?: { target?: string, state?: 'open' | 'decided' }): Promise<WriteResult & { suggestions?: Record<string, any>[] }>,
 *   getSuggestion(bookId: string, suggestionId: string): Promise<WriteResult & { suggestion?: Record<string, any> }>,
 *   decideSuggestion(bookId: string, suggestionId: string, args: { decision: 'accept' | 'decline', hunkId?: string }): Promise<WriteResult & Record<string, any>>,
 *   suggestFromStaleSave(bookId: string, sceneId: string, body: string): Promise<WriteResult & { suggestion?: { id: string, path: string, hunks: any[] } | null }>,
 *   createComment(bookId: string, args: { target: string, line: number, lines?: number, quote?: string, text: string, by?: { id?: string, name: string } }): Promise<WriteResult & Record<string, any>>,
 *   replyToComment(bookId: string, commentId: string, args: { text: string, by?: { id?: string, name: string } }): Promise<WriteResult & Record<string, any>>,
 *   setCommentState(bookId: string, commentId: string, args: { status: 'open' | 'resolved' }): Promise<WriteResult & Record<string, any>>,
 *   listComments(bookId: string, args?: { target?: string, status?: 'open' | 'resolved' }): Promise<WriteResult & { comments?: Record<string, any>[] }>,
 *   checkScene(bookId: string, sceneId: string): Promise<WriteResult & Record<string, any>>,
 *   continuityBooks(): Promise<{ id: string, slug: string | null, path: string, title: string | null }[]>,
 *   updateSceneBody(bookId: string, sceneId: string, body: string, opts: { baseSha256: string }):
 *     Promise<WriteResult & { sha256?: string, current?: SceneDoc | null }>,
 *   writeSceneRaw(bookId: string, sceneId: string, content: string, opts: { baseSha256: string }):
 *     Promise<WriteResult & { sha256?: string, current?: SceneDoc | null }>,
 *   createScene(bookId: string, args: { chapter: number, act?: number, after: string | null, title: string, slug: string, body: string, status?: string, summary?: string, dryRun?: boolean }):
 *     Promise<WriteResult & { id?: string, path?: string }>,
 *   archiveScene(bookId: string, sceneId: string, opts: { baseSha256: string }):
 *     Promise<WriteResult & { path?: string, current?: SceneDoc | null }>,
 *   restoreScene(bookId: string, archivedPath: string, opts: { baseSha256: string }):
 *     Promise<WriteResult & { path?: string }>,
 *   setSceneFields(bookId: string, sceneId: string, args: { title?: string, status?: string, pov?: string, summary?: string, renameFile?: boolean, dryRun?: boolean }): Promise<StructureResult>,
 *   moveScene(bookId: string, sceneId: string, args: { chapter: number, act?: number, after: string | null, dryRun?: boolean }): Promise<StructureResult & { undo?: { chapter: number, act: number, after: string | null } }>,
 *   splitScene(bookId: string, sceneId: string, args: { atLine: number, dryRun?: boolean }): Promise<StructureResult>,
 *   mergeScenes(bookId: string, args: { first: string, second: string, dryRun?: boolean }): Promise<StructureResult>,
 *   createChapter(bookId: string, args: { act?: number, after?: number | null, title: string, dryRun?: boolean }): Promise<StructureResult>,
 *   setChapterFields(bookId: string, chapter: number, args: { title?: string, label?: string, dryRun?: boolean }): Promise<StructureResult>,
 *   archiveChapter(bookId: string, chapter: number, args?: { dryRun?: boolean }): Promise<StructureResult>,
 *   renumberChapters(bookId: string, args?: { step?: number, dryRun?: boolean }): Promise<StructureResult>,
 *   createAct(bookId: string, args: { title: string, dryRun?: boolean }): Promise<StructureResult>,
 *   setActFields(bookId: string, act: number, args: { title: string, dryRun?: boolean }): Promise<StructureResult>,
 *   restoreOp(bookId: string, opId: string, args?: { dryRun?: boolean }): Promise<StructureResult>,
 *   getActivity(bookId: string, opts?: { days?: number }): Promise<WriteResult & { goal?: number | null, today?: any, days?: any[], streak?: number }>,
 *   recordSession(bookId: string, minutes: number): Promise<WriteResult>,
 *   flushActivity(): Promise<void>,
 *   setDailyGoal(bookId: string, goal: number | null): Promise<WriteResult & { daily_word_goal?: number }>,
 *   listRevisions(bookId: string, sceneId: string): Promise<WriteResult & { revisions?: any[] }>,
 *   getRevision(bookId: string, sceneId: string, file: string): Promise<WriteResult & { revision?: any }>,
 *   saveRevision(bookId: string, sceneId: string, opts?: { label?: string, reason?: 'manual' | 'external' }): Promise<WriteResult & { stored?: boolean, revision?: any }>,
 *   restoreRevision(bookId: string, sceneId: string, file: string, opts: { mode: 'into' | 'new', baseSha256?: string, dryRun?: boolean }): Promise<WriteResult & Record<string, any>>,
 *   getEntry(bookId: string, ref: string): Promise<{ id: string, slug: string, name: string, type: string, status: string, fields: Record<string, any>, sections: { heading: string, text: string }[],
 *     appears_in: { scene_id: string, title: string, position: number, rel: string, kind: 'explicit' | 'inferred' }[],
 *     related: { id: string, name: string | null, as: string | null, direction: 'out' | 'in' }[] } | null>,
 *   listCodexEntries(bookId: string): Promise<{ entries: any[], chapters: { chapter: number, label: string }[] } | null>,
 *   listThreads(bookId: string): Promise<{ threads: { id: string, slug: string | null, title: string | null, kind: string | null, status: string | null, setup: string[], develop: string[], payoff: string[], characters: string[], previous_slugs: string[], path: string, sha256: string | null, problems: any[] }[],
 *     scenes: (SceneSummary & { summary: string, plot_threads: string[], sha256: string | null })[] } | null>,
 *   getThread(bookId: string, ref: string): Promise<(Awaited<ReturnType<FileRepository['listThreads']>>['threads'][number] & { body: string }) | null>,
 *   createThread(bookId: string, args: { title: string, slug?: string, kind?: string, status?: string, dryRun?: boolean }): Promise<StructureResult>,
 *   setThreadFields(bookId: string, ref: string, args: { status?: string, setup?: string[], develop?: string[], payoff?: string[], characters?: string[], add?: Record<string, string[]>, remove?: Record<string, string[]>, dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   updateThreadBody(bookId: string, ref: string, body: string, opts: { baseSha256: string }): Promise<WriteResult & { sha256?: string, current?: { sha256: string, body: string } }>,
 *   getEntryImage(bookId: string, ref: string): Promise<{ bytes: Buffer, contentType: string, sha256: string } | null>,
 *   createEntry(bookId: string, args: { type: string, name: string, slug?: string, status?: string, fields?: any, dryRun?: boolean }): Promise<StructureResult>,
 *   setEntryFields(bookId: string, ref: string, args: { name?: string, status?: string, role?: string, aliases?: string[], fields?: any, related?: { to: string, as?: string }[], dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   changeEntrySlug(bookId: string, ref: string, args: { slug: string, dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   archiveEntry(bookId: string, ref: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   restoreEntry(bookId: string, ref: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   createCodexType(bookId: string, args: { type: string, name: string, plural?: string, fields?: string[], dryRun?: boolean }): Promise<StructureResult>,
 *   updateEntryBody(bookId: string, ref: string, body: string, opts: { baseSha256: string }): Promise<WriteResult & { sha256?: string, current?: { sha256: string, body: string } }>,
 *   getGraph(bookId: string, opts?: { node?: string, kinds?: string[] }): Promise<{ nodes: { id: string, kind: string, type: string | null, name: string | null }[], edges: any[] } | null>,
 *   getCodexTypes(bookId: string): Promise<{ type: string, name: string, plural: string, fields: string[], description: string, builtin: boolean, defined: boolean, count: number }[] | null>,
 *   recover(): Promise<RecoverReport>,
 *   root: string,
 *   listTemplates(): Promise<{ name: string, title: string, description: string, beats: string[], acts: number, chapters: number, scenes: number }[]>,
 *   createBook(input: { title: string, slug?: string, template: string, seriesSlug?: string, seriesNumber?: number, penName?: string }):
 *     Promise<{ ok: true, bookId: string, path: string } | { ok: false, code: string, field: string | null, message: string, diagnostics?: any[] }>,
 *   search(q: string, opts?: { bookId?: string, kinds?: string[], limit?: number }):
 *     Promise<{ book_id: string | null, id: string, kind: string, title: string, path: string | null, snippet: string }[]>,
 *   getBacklinks(bookId: string, id: string): Promise<any[] | null>,
 *   getMentions(bookId: string, opts?: { entryId?: string, sceneId?: string }): Promise<{ entry_id: string, scene_id: string, count: number }[] | null>,
 *   getObjects(bookId: string, kinds?: string[]): Promise<{ id: string, kind: string, slug: string | null, title: string | null, type: string | null }[] | null>,
 *   indexStatus(bookId?: string): Promise<any>,
 *   rebuildIndex(bookId?: string): Promise<{ ok: boolean, code?: string, books: any[] }>,
 *   ensureIndexes(): Promise<{ ok: boolean, books: any[] }>,
 *   getStatus(): Promise<{ watch: { mode: 'watch' | 'poll', reason: string | null, last_event_at: string | null, pending: number }, books: any[] }>,
 *   getRawFile(bookId: string, bookRelPath: string): Promise<{ path: string, body: string, sha256: string, problem?: { code: string, message: string } } | null>,
 *   planRepair(bookId: string): Promise<{ ok: boolean, code: string, actions: any[], unrepairable: any[] } | null>,
 *   repairPlans(): Promise<any[]>,
 *   applyRepair(bookId: string, actions: any[]): Promise<WriteResult & { changes?: any[], opId?: string }>,
 *   close(): Promise<void>,
 * }} FileRepository
 *   While a book is `invalid` (a file broke outside the app) getBook serves the last valid structure plus `index_state`,
 *   `invalid_paths`, `diagnostics`, `unplaced`, and a `problem` on scenes whose file cannot be read; getScene returns
 *   the current file bytes raw (`raw: true`, `body` = the whole file) with a `problem`. `close()` stops the watchers.
 *   The index methods read the per-book SQLite index (see @storyforge/index); `getBacklinks` and `getMentions`
 *   return null for an unknown book and throw an error with code INDEX_NOT_READY while no index is readable.
 */

export {};
