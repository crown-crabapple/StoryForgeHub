# M03-J01 contract — manuscript navigation model and structure commands

Binding: DECISIONS 1–6, FORMAT-v1 §4 (scenes, ordering, prefixes, act/chapter metadata), §8 (archive), contracts M00-J04 (`@storyforge/manuscript` rules 1–7), M01-J02 (single writer), M01-J04 (reconcile), M02-J01 (shell, Editor layout). Reference: `storyforge-v2-production-plan/design/screens/Editor.dc.html` (left manuscript outline).

## 1. Tree (left rail)

Driven only by `getBook()` (files/index). Shows, per row:

| Level | Shows |
|---|---|
| Act | label + title, total words, collapse toggle |
| Chapter | label + title, total words, scene count, collapse toggle |
| Scene | title (or "Untitled scene"), status as a small coloured dot with text label for screen readers (`outline`/`drafting`/`revised`/`final` — four distinct lightness steps, not hue only), POV initial chip (if `pov`), word count, current selection (accent), "can't be read" marker (J04) |

- An **Archived** section at the bottom of the rail (collapsed by default) lists archived scenes for this book (`excluded` with reason `archived`), each with **Restore**.
- Collapse state per act/chapter is remembered per book in `localStorage` (wrapped in try/catch; UI works without it).
- Keyboard: the tree is a list of links/buttons (no ARIA tree widget needed). Up/Down already move between scenes; Left/Right on a chapter/act row collapse/expand.

## 2. Structure commands

All go through `@storyforge/manuscript` + `@storyforge/store`; all have a **dry run** returning the exact file changes; the UI shows that preview and applies only on confirm. All refuse on a book with manuscript errors (existing rule 5) and roll back on any new error (rule 6).

| Command | Effect on files |
|---|---|
| **New scene** (`createScene`, exists) | new scene file; UI entry points: "+" on a chapter row (end of chapter) and "Add scene after" on a scene's menu |
| **Rename scene** (`setSceneFields(sceneId, { title?, status?, pov? })`) | single-line front-matter edits only (§3); filename slug **not** changed unless the author ticks "Also rename the file" → then also a `move` to `NNNN-<new-slug>.md` |
| **Archive scene** (exists) / **Restore** (exists) | move to/from `archive/` |
| **New chapter** (`createChapter({ act, after?: chapterNumber | null, title })`) | new folder `ch-NNN-<slug>/` with `chapter.md` + one empty scene; chapter number = next free number in book order **only if it doesn't require renumbering later chapters**; if inserting between existing chapter numbers with no gap → refuse with `NO_CHAPTER_GAP` and offer "Renumber chapters" (below) |
| **Rename chapter** (`setChapterFields(chapter, { title?, label? })`) | edit `chapter.md` lines (create `chapter.md` if missing, via `create`) |
| **Renumber chapters** (`renumberChapters({ step: 1 })`) | rewrite every scene's `chapter:` line and every `chapter.md`'s `chapter:` line so chapters run 0/1…N in current order; folder names renamed to match; bodies untouched. Preview lists every file. |
| **New act** / **Rename act** (`createAct`, `setActFields`) | `act.md` create/edit; new act gets the next act number |
| **Archive chapter** | archives every scene of the chapter + `chapter.md` in one batch |
| **Split scene** (`splitScene(sceneId, { atLine })`) | `atLine` = 1-based line within the **body**; body lines before stay in the original file (front matter untouched); lines from `atLine` become a **new scene file** right after it (new id, title = original title + " (part 2)", same act/chapter/status/pov/characters/locations, sequence = midpoint). A line inside a fenced code block or an HTML comment can't be a split point → `BAD_SPLIT_POINT`. Concatenating the two bodies gives back the original body byte-for-byte (tested). |
| **Merge scenes** (`mergeScenes(firstId, secondId)`) | only adjacent scenes in the same chapter; first file's body becomes `firstBody + separator + secondBody` where separator is exactly one blank line if needed (never removes characters); the second file is **archived** (not deleted) with an HTML comment `<!-- merged into <firstId> on <date> -->` appended to its body before archiving. Front matter of the first is kept; the second's `characters`/`locations`/`plot_threads` are **not** auto-merged — preview lists them so the author can copy them. |

## 3. Safe front-matter string edit

New in `@storyforge/manuscript`: `editFrontMatterLine(bytes, key, value)`.
- Replaces exactly one top-level line `key: …` whose value is a single-line scalar; writes the value as a YAML double-quoted string when it isn't a plain safe word (escape `\` and `"`; reject control characters and newlines).
- If the key is absent, inserts the new line **after** a fixed anchor key (`title` after `id`; `status` after `sequence`; `pov` after `status`); if the anchor is missing → `REFUSED_UNSIMPLE_FIELD`.
- If the existing value is multi-line, a flow/block collection, has an anchor/tag/comment → `REFUSED_UNSIMPLE_FIELD`. Never re-serialises YAML. Every other byte identical (tested with CRLF and LF).

## 4. Server routes (write-guarded, JSON)

`PATCH`-like actions are POSTs to keep the existing guard simple:

`POST /api/books/:b/scenes/:s/fields` · `/split` · `POST /api/books/:b/scenes/merge` · `POST /api/books/:b/scenes/archive` (`{ scenes: [sceneId, ...] }`: several scenes to `archive/` in one operation, one Undo) · `POST /api/books/:b/scenes/restore` (`{ paths: [archivedPath, ...] }`: several archived scenes back in one operation, one Undo) · `POST /api/books/:b/chapters` · `/chapters/:n/fields` · `/chapters/:n/archive` · `POST /api/books/:b/chapters/renumber` · `POST /api/books/:b/acts` · `/acts/:n/fields`. Each accepts `{ ..., dryRun?: true }`; dry run returns `{ ok, changes: [{ from, to, before_sha256, after_sha256, diff }] }` where `diff` is a unified diff of text changes (front-matter only, except split/merge which show body moves).

## 5. UI

- Row menus (a real `button` "More actions for <name>" → menu with real `button`s; Escape closes, focus returns): Scene → Rename…, Status ▸, Add scene after, Split here… (in the editor, at the caret line — until J02, a line-number field), Merge with next, Archive. Chapter → Rename…, Add scene, Add chapter after, Archive chapter. Act → Rename…, Add chapter.
- Every write opens a **Preview** dialog: list of files with a short diff, "Apply" / "Cancel". Rename and status-change may apply directly (single-line edit) but still show what changed in a toast with **Undo** (undo = restore from the op's trash copy via a new `restoreOp(opId)` that only works if files still match the op's after-hashes; else explain why not).
- No drag and drop yet (J03).

## 6. Acceptance (test-author)

1. **Tree == parser:** for salt-orchard and every template book: tree data (acts → chapters → scenes, labels, statuses, POV, word counts) equals `validate()` order; same after deleting `.storyforge/` and rebuilding.
2. **No body ever lost:** for every command (create, rename incl. file rename, archive/restore scene, archive chapter, new/rename chapter and act, renumber chapters, split, merge), every scene body that existed before exists byte-for-byte afterwards in the book or `archive/` or `.storyforge/trash/` — split/merge checked by concatenation.
3. **Split round trip:** split at several lines (first, middle, last, around CRLF, Unicode lines) → body1 + body2 == original; split point in code/comment → `BAD_SPLIT_POINT`, nothing written.
4. **Merge:** non-adjacent or cross-chapter → refused; adjacent → first body = concat, second archived with the comment, nothing deleted.
5. **Front-matter edit:** `editFrontMatterLine` table tests (quote/escape rules, insert-after-anchor, CRLF, refusals); `setSceneFields` changes only those lines (diff check).
6. **Chapters:** new chapter with a gap; `NO_CHAPTER_GAP` when none; renumber chapters → contiguous numbers, folder names match, bodies identical, `validate()` clean, order unchanged.
7. **Dry run:** every route with `dryRun: true` writes nothing and returns non-empty `changes` with diffs.
8. **Undo:** rename then `restoreOp` → files back byte-for-byte; after an external edit → refused with a reason.
9. **Server guards:** every new route 403 without `x-storyforge`, 404 unknown book/scene.
10. **Web render tests:** tree shows statuses (with text labels), POV chips, word counts, Archived section with Restore, row menus as buttons, Preview dialog list/diff rendering.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
