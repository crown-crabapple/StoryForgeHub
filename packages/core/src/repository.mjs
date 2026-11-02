// FileRepository: the read-only interface between the app and the project files.
// This module holds types only; implementations live in fs-repository.mjs.

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
 * @typedef {SceneSummary & { front_matter: Record<string, any>, body: string }} SceneDoc
 *   `body` is the text after the front matter, exactly as on disk.
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
 * }} FileRepository
 */

export {};
