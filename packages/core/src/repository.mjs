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
 * @typedef {{ act: number, label: string, chapters: ChapterNode[] }} ActNode
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
 * @typedef {{ slug: string, title: string | null, status: string | null, book_ids: string[] }} SeriesInfo
 * @typedef {{ root: string, title: string | null, diagnostics: Diagnostic[], series: SeriesInfo[] }} LibraryInfo
 */

/**
 * @typedef {{
 *   libraryInfo(): Promise<LibraryInfo>,
 *   listBooks(): Promise<BookSummary[]>,
 *   getBook(bookId: string): Promise<BookDetail | null>,
 *   getCover(bookId: string): Promise<{ bytes: Buffer, contentType: string, sha256: string } | { error: 'too_large' } | null>,
 *   getScene(bookId: string, sceneId: string): Promise<SceneDoc | null>,
 *   getDiagnostics(bookId?: string): Promise<Diagnostic[]>,
 *   updateSceneBody(bookId: string, sceneId: string, body: string, opts: { baseSha256: string }):
 *     Promise<WriteResult & { sha256?: string, current?: SceneDoc | null }>,
 *   createScene(bookId: string, args: { chapter: number, act?: number, after: string | null, title: string, slug: string, body: string }):
 *     Promise<WriteResult & { id?: string, path?: string }>,
 *   archiveScene(bookId: string, sceneId: string, opts: { baseSha256: string }):
 *     Promise<WriteResult & { path?: string, current?: SceneDoc | null }>,
 *   restoreScene(bookId: string, archivedPath: string, opts: { baseSha256: string }):
 *     Promise<WriteResult & { path?: string }>,
 *   recover(): Promise<RecoverReport>,
 *   search(q: string, opts?: { bookId?: string, kinds?: string[], limit?: number }):
 *     Promise<{ book_id: string | null, id: string, kind: string, title: string, path: string | null, snippet: string }[]>,
 *   getBacklinks(bookId: string, id: string): Promise<any[] | null>,
 *   getMentions(bookId: string, opts?: { entryId?: string, sceneId?: string }): Promise<{ entry_id: string, scene_id: string, count: number }[] | null>,
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
