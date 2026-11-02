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
 * }} BookSummary  `path` is relative to the library root, forward slashes ('' for a one-book root).
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
 * @typedef {{ root: string, title: string | null, diagnostics: Diagnostic[] }} LibraryInfo
 */

/**
 * @typedef {{
 *   libraryInfo(): Promise<LibraryInfo>,
 *   listBooks(): Promise<BookSummary[]>,
 *   getBook(bookId: string): Promise<BookDetail | null>,
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
 * }} FileRepository
 */

export {};
