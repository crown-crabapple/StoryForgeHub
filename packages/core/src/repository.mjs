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
 *   getGoals(bookId: string): Promise<WriteResult & { goals?: any[], skipped?: number, daily_word_goal?: number | null, effective?: any[], sha256?: string | null }>,
 *   setGoal(bookId: string, goal: { id?: string, kind: string, target: number, period: string, due?: string | null, scope?: string | null }): Promise<WriteResult & { goal?: any }>,
 *   removeGoal(bookId: string, id: string): Promise<WriteResult & { removed?: string }>,
 *   recordSessionRow(bookId: string, body: { start: string, end: string, kind: string, scenes?: string[] }): Promise<WriteResult & { row?: any, path?: string }>,
 *   getInsights(bookId: string, opts?: { from?: 'files' }): Promise<WriteResult & { insights?: any, source?: 'index' | 'files' }>,
 *   listTasks(bookId: string, filter?: { status?: string, label?: string, source?: string }): Promise<WriteResult & { tasks?: any[], counts?: any, labels?: string[] }>,
 *   getTask(bookId: string, ref: string): Promise<WriteResult & { task?: any, notes?: string, targets?: any[] }>,
 *   createTask(bookId: string, args: Record<string, any>): Promise<WriteResult & Record<string, any>>,
 *   setTaskStatus(bookId: string, ref: string, status: string): Promise<WriteResult & Record<string, any>>,
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
 *   getPreferences(which?: { bookId?: string, bookPath?: string }): Promise<{ library: object | null, book: object | null } | null>,  (M07-J04: the `preferences:` maps of library.md and book.md)
 *   listPrompts(): Promise<{ prompts: any[], workflows: any[], diagnostics: object[] }>,  (M07-J04: `_prompts/`)
 *   setModuleGate(fn: ((moduleId: string, ctx: { bookPath: string }) => boolean | Promise<boolean>) | null): void,  (M07-J04: receipts on or off per book)
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
 *   moveEntryToSeries(bookId: string, ref: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<WriteResult & Record<string, any>>,
 *   copyEntryIntoBook(bookId: string, ref: string, args?: { dryRun?: boolean }): Promise<WriteResult & { id?: string, path?: string, warnings?: { code: string, location: string, message: string }[] }>,
 *   getLabels(bookId: string): Promise<{ book: { labels: { name: string, color: string | null }[] }, series: { slug: string, title: string | null, labels: { name: string, color: string | null }[] } | null } | null>,
 *   setLabels(bookId: string, args: { scope?: 'book' | 'series', labels: { name: string, color: string }[], dryRun?: boolean }): Promise<StructureResult>,
 *   getLinkTargets(bookId: string): Promise<{ book: any[], series: { slug: string, title: string | null, items: any[] } | null, books: { id: string, slug: string, title: string | null, items: any[] }[] } | null>,
 *   saveAsTemplate(bookId: string, meta: { name?: string, title: string, description?: string }): Promise<WriteResult & { name?: string, path?: string }>,
 *   listCanvases(bookId: string): Promise<{ canvases: any[], archived: any[] } | null>,  (M09-J01: planning/canvases/*.canvas)
 *   getCanvas(bookId: string, slug: string): Promise<{ slug: string, title: string, path: string, sha256: string, canvas: any, problem: string | null, refs: Record<string, any>, targets: any[] } | null>,
 *   createCanvas(bookId: string, args: { title: string, slug?: string, dryRun?: boolean }): Promise<StructureResult>,
 *   saveCanvas(bookId: string, slug: string, args: { canvas: unknown, baseSha256: string }): Promise<WriteResult & { sha256?: string, current?: { sha256: string, canvas: any } }>,
 *   archiveCanvas(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   restoreCanvas(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   listLinks(bookId: string): Promise<{ links: Link[], archived: Link[] } | null>,  (Story Planner M1: planning/links/*.md; Link = { id, slug, path, from, to, relation, rationale, created, sha256, from_title, to_title, from_kind, to_kind, problems: { code, message }[] }, titles null when the end is not live; M5: an end may be a beat id of a live structure, then from_kind / to_kind is 'beat' (else 'scene') and the title is "<structure name>: <beat name>")
 *   getLink(bookId: string, slug: string): Promise<(Link & { archived: boolean }) | null>,  (live first, then archive)
 *   getScenePlan(bookId: string, sceneId: string): Promise<{ scene_id: string, path: string | null, sha256: string | null, fields: Record<string, string | null>, characters: string[], body: string } | null>,  (null for an unknown book or live scene; no sidecar: path and sha256 null, all fields null)
 *   flowGraph(bookId: string): Promise<{ nodes: { id: string, kind: 'scene', title: string | null, summary: string | null, status: string | null, pov: string | null, act: number, chapter: number, sequence: number, plan: boolean }[] (+ M5: after the scenes, { id, kind: 'beat', title, structure: { slug, name }, chapter: null, sequence: null } for each beat of a live structure that is an end of a live link), edges: { id: string | null, slug: string, from: string | null, to: string | null, relation: string | null, rationale: string, sha256: string | null, broken: boolean }[] } | null>,  (nodes: live scenes in reading order; edges: live links, broken when an end is neither a live scene nor a beat of a live structure)
 *   getStoryPlan(bookId: string): Promise<{ path: string | null, sha256: string | null, fields: { premise: string | null, logline: string | null, theme_question: string | null, central_conflict: string | null, protagonist_goal: string | null, stakes: string | null, protagonist: string | null, primary_structure: string | null }, body: string } | null>,  (Story Planner M2: planning/story.md; null for an unknown book; no file: path and sha256 null, every field null, body '')
 *   planOverview(bookId: string): Promise<{ story: (the getStoryPlan result), counts: { scenes: number, planned_scenes: number, links: number, linked_scenes: number, unlinked_scenes: number, broken_links: number, archived_links: number, threads: number, arcs: number, structures: number, relationships: number }, primary_structure: { id: string, slug: string, name: string | null } | null, unlinked: { id: string, title: string | null }[] } | null>,  (scenes = live non-variant scenes, as the flow nodes; linked = an end of a live link; unlinked in reading order, max 50; broken_links = a live link with an end that is not a live scene; threads = live plot threads; arcs = live character arcs; structures = live structures; primary_structure = the live structure the story plan names, else null)
 *   createLink(bookId: string, args: { from: string, to: string, relation: string, rationale?: string, dryRun?: boolean }): Promise<StructureResult>,  (codes: REFUSED_BAD_ARGS, REFUSED_UNKNOWN_SCENE, REFUSED_SELF_LINK, REFUSED_DUPLICATE_LINK, REFUSED_PATH_TAKEN)
 *   updateLink(bookId: string, slug: string, args: { relation?: string, from?: string, to?: string, rationale?: string, baseSha256: string, dryRun?: boolean }): Promise<StructureResult>,  (also CONFLICT, NOT_FOUND)
 *   archiveLink(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   restoreLink(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,  (also REFUSED_PATH_TAKEN, REFUSED_DUPLICATE_LINK)
 *   saveScenePlan(bookId: string, sceneId: string, args: { fields?: Record<string, string | null>, characters?: string[], baseSha256?: string | null, dryRun?: boolean }): Promise<StructureResult>,  (no sidecar: created, baseSha256 absent; else baseSha256 required; also REFUSED_UNKNOWN_ENTRY, CONFLICT)
 *   saveStoryPlan(bookId: string, args: { fields?: Record<string, string | null>, body?: string, baseSha256?: string | null, dryRun?: boolean }): Promise<StructureResult>,  (Story Planner M2: planning/story.md; fields premise, logline, theme_question, central_conflict, protagonist_goal, stakes, protagonist (a live entry slug, else REFUSED_UNKNOWN_ENTRY), primary_structure (a structure id; null or empty removes it); no file: created, baseSha256 absent; else baseSha256 required, CONFLICT with `current` when stale)
 *   listArcs(bookId: string): Promise<{ arcs: Arc[], archived: Arc[] } | null>,  (Story Planner M3: planning/arcs/*.md; Arc = { id, slug, path, sha256, character: { id, slug, name, shared: boolean } | null (null when the id names no entry; the id stays in character_id), character_id, arc_type, fields: { want, need, false_belief, fear, wound, start_state, end_state: string | null }, milestones: { index, scene, scene_title: string | null, chapter: number | null, sequence: number | null, pressure, choice, belief_before, belief_after, cost: string | null }[], body, problems: { code, message }[] }; live arcs sorted by character name; scene_title, chapter, sequence are null when the scene is not live; null for an unknown book)
 *   getArc(bookId: string, slug: string): Promise<(Arc & { archived: boolean }) | null>,  (live first, then archive)
 *   createArc(bookId: string, args: { character: string, arc_type?: string | null, fields?: Record<string, string | null>, dryRun?: boolean }): Promise<StructureResult>,  (character = the id of a live character entry of the book or its series; codes: REFUSED_BAD_ARGS (also an entry that is not a character), REFUSED_UNKNOWN_ENTRY, REFUSED_DUPLICATE_ARC with `existing: { slug }`; extra { id, slug, path })
 *   updateArc(bookId: string, slug: string, args: { arc_type?: string | null, fields?: Record<string, string | null>, body?: string, baseSha256: string, dryRun?: boolean }): Promise<StructureResult>,  (also CONFLICT with `current: { sha256, text }`, NOT_FOUND; null or '' removes a key)
 *   setArcMilestones(bookId: string, slug: string, args: { milestones: { scene: string, pressure?: string, choice?: string, belief_before?: string, belief_after?: string, cost?: string }[], baseSha256: string, dryRun?: boolean }): Promise<StructureResult>,  (the whole ordered list, max 200; REFUSED_UNKNOWN_SCENE with `index`; also CONFLICT, NOT_FOUND, REFUSED_UNSIMPLE_FIELD for a hand-edited block with comments)
 *   archiveArc(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   restoreArc(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,  (also REFUSED_PATH_TAKEN, REFUSED_DUPLICATE_ARC)
 *   listStructureTemplates(): { id: string, version: number, name: string, description: string, beats: { name: string, purpose: string, question: string, position?: string }[] }[],  (Story Planner M4: the built-in STRUCTURE_TEMPLATES, synchronous; same for every book)
 *   listStructures(bookId: string): Promise<{ structures: Structure[], archived: { slug: string, name: string | null }[] } | null>,  (planning/structures/*.md; Structure = { id, slug, name, template, template_version: number | null, primary: boolean (the story plan's primary_structure is its id), sha256, body, beats: { id, name, purpose, question, position: string | null, state: 'open' | 'done' | 'omitted' (absent = open), scenes: { id, title: string | null, chapter: number | null, sequence: number | null }[] (title, chapter and sequence null when the scene is not live) }[], counts: { beats, assigned (beats with a scene), omitted } }; live structures sorted primary first, then by name; null for an unknown book)
 *   getStructure(bookId: string, slug: string): Promise<(Structure & { archived: boolean }) | null>,  (live first, then archive)
 *   createStructure(bookId: string, args: { template: string, name: string, dryRun?: boolean }): Promise<StructureResult>,  (template = a STRUCTURE_TEMPLATES id, the beats are copied with new ids; codes: REFUSED_BAD_ARGS (field template or name); extra { id, slug, path })
 *   updateStructure(bookId: string, slug: string, args: { name?: string, body?: string, baseSha256: string, dryRun?: boolean }): Promise<StructureResult>,  (also CONFLICT with `current: { sha256, text }`, NOT_FOUND; template and template_version never change)
 *   setStructureBeats(bookId: string, slug: string, args: { beats: { id?: string, name: string, purpose?: string, question?: string, position?: string, state?: 'open' | 'done' | 'omitted', scenes?: string[] }[], baseSha256: string, dryRun?: boolean }): Promise<StructureResult>,  (the whole ordered list, max 200, scenes max 50 per beat; a beat without id gets a new one; REFUSED_UNKNOWN_SCENE with `index`; also CONFLICT, NOT_FOUND, REFUSED_UNSIMPLE_FIELD for a hand-edited block with comments)
 *   archiveStructure(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   restoreStructure(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,  (also REFUSED_PATH_TAKEN)
 *   listRelationships(bookId: string): Promise<{ relationships: Relationship[], archived: { slug: string, name: string }[] } | null>,  (Story Planner M5: planning/relationships/*.md; Relationship = { id, slug, path, name ("<A name> & <B name>"), a: { id, slug, name, type }, b: { id, slug, name, type } (slug, name and type null when the entry is not found), baseline, end_state: string | null, sha256, body, developments: { scene, scene_title: string | null, chapter: number | null, sequence: number | null, change: string | null, a_view: string | null, b_view: string | null }[], problems: { code, message }[] }; live relationships sorted by name; null for an unknown book)
 *   getRelationship(bookId: string, slug: string): Promise<(Relationship & { archived: boolean }) | null>,  (live first, then archive)
 *   createRelationship(bookId: string, args: { a: string, b: string, fields?: { baseline?: string | null, end_state?: string | null }, dryRun?: boolean }): Promise<StructureResult>,  (a and b = ids of live entries of any type in the book or its series; slug <a-slug>-and-<b-slug>; codes: REFUSED_BAD_ARGS (also a = b), REFUSED_UNKNOWN_ENTRY, REFUSED_DUPLICATE_RELATIONSHIP with `existing: { slug }` (the pair in either order); extra { id, slug, path })
 *   updateRelationship(bookId: string, slug: string, args: { fields?: { baseline?: string | null, end_state?: string | null }, body?: string, baseSha256: string, dryRun?: boolean }): Promise<StructureResult>,  (also CONFLICT with `current: { sha256, text }`, NOT_FOUND; null or '' removes a key; a and b never change)
 *   setRelationshipDevelopments(bookId: string, slug: string, args: { developments: { scene: string, change: string, a_view?: string, b_view?: string }[], baseSha256: string, dryRun?: boolean }): Promise<StructureResult>,  (the whole ordered list, max 200; change required, single line max 2000; REFUSED_UNKNOWN_SCENE with `index`; also CONFLICT, NOT_FOUND, REFUSED_UNSIMPLE_FIELD for a hand-edited block with comments)
 *   archiveRelationship(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,
 *   restoreRelationship(bookId: string, slug: string, args?: { dryRun?: boolean, baseSha256?: string }): Promise<StructureResult>,  (also REFUSED_PATH_TAKEN, REFUSED_DUPLICATE_RELATIONSHIP)
 *   planBadges(bookId: string): Promise<{ scenes: Record<string, { plan: boolean, goal: string | null, purpose: string | null, links_in: number, links_out: number, beats: { structure_slug: string, structure_name: string | null, primary: boolean, beat_id: string, beat_name: string | null }[], milestones: { arc_slug: string, name: string }[], relationships: { slug: string, name: string, change: string | null }[] }>, arcs: { slug: string, name: string }[], structures: { slug: string, name: string | null, primary: boolean, beats: { id: string, name: string | null, state: 'open' | 'done' | 'omitted', scenes: string[] }[] }[] } | null>,  (Story Planner M5: read-only projection for Board, Outline and Matrix; scenes has an entry for every live scene; links_in / links_out count live links whose other end also resolves (a live scene or a beat of a live structure); structures are live ones, primary first)
 *   close(): Promise<void>,
 * }} FileRepository
 *   While a book is `invalid` (a file broke outside the app) getBook serves the last valid structure plus `index_state`,
 *   `invalid_paths`, `diagnostics`, `unplaced`, and a `problem` on scenes whose file cannot be read; getScene returns
 *   the current file bytes raw (`raw: true`, `body` = the whole file) with a `problem`. `close()` stops the watchers.
 *   The index methods read the per-book SQLite index (see @storyforge/index); `getBacklinks` and `getMentions`
 *   return null for an unknown book and throw an error with code INDEX_NOT_READY while no index is readable.
 */

export {};
