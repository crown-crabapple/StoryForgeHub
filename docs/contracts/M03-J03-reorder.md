# M03-J03 contract — drag-and-drop scene organisation

Binding: DECISIONS 4 (ordering lives with content), 6; FORMAT-v1 §4.2–§4.3; `packages/manuscript/CONTRACT.md` (`moveScene`, rules 1–7: bodies untouched, minimal line edits, atomic, refuse on broken book, verify + rollback, dry run); contracts M03-J01 (preview dialog, toasts) and M03-J02 (save controller: flush before structural ops).

## 1. Move operation (server + core)

`POST /api/books/:b/scenes/:s/move` (write-guarded) `{ chapter, act?, after: sceneId | null, dryRun? }` → `moveScene`.

- `after: null` = first in that chapter. Target chapter may be empty (scene-less chapter from J01) — then `act` comes from its `chapter.md` folder/act.
- Response: `{ ok, code, changes: [{ from, to, before_sha256, after_sha256, diff }], undo: { chapter, act, after } }` where `undo` is the scene's original position (its original chapter/act and the id of the scene that preceded it, or null) — so the client can undo by issuing the inverse move.
- **Expected state (amendment 2026-11-01):** the request may carry `expect: [{ path, sha256 }]` — the `from` paths and `before_sha256` values from the dry run the author saw (direct drops send the mover's path + sha the client loaded). Before writing, the server checks every listed file still has that sha; any difference → `409 { code: 'CONFLICT', changed: [paths] }`, nothing written. The UI always sends `expect`, so what is applied is exactly what was previewed.
- Conflict during the operation itself: the mover or any renumbered neighbour changed on disk since it was read → `409 { code: 'CONFLICT' }`, nothing written (the store's base-sha check).
- **Undo (amendment 2026-11-01):** the response also carries `opId`. Undo = `POST /api/books/:b/ops/:opId/restore` (J01 `restoreOp`), extended to moves: for every change of the op, if the file at `to` still has `after_sha256` and nothing is at `from` (or `from` === `to`), put the trash copy (`before` bytes) back at `from` and move the `to` file into the trash. All-or-nothing in one store batch; any mismatch → refused with the reason. This restores exact paths, sequences and bytes. The `undo` position object stays in the response for information only. Book with manuscript errors (e.g. duplicate sequence E204) → `409 { code: 'REFUSED_INVALID_BOOK', diagnostics }` — the UI says "Fix the problems first (Repair…)" with a link to the J04 Repair dialog. **Never guess**: no automatic renumber of someone else's duplicates.
- Before a move, the client **flushes** the editor's save controller (J02); if the open scene is in `conflict`, moves are blocked with a message.

## 2. Tidy file names (deliberate, reviewable)

`moveScene` already gives the **moved** scene its canonical filename/folder. Neighbours renumbered to make room are renamed in place. Separately, a **"Tidy file names…"** command (book menu in the rail header) runs `planRepair` restricted to `rename` actions (W201/W202) → Preview (list of `from → to`, no body diffs because bodies don't change) → Apply. Never automatic.

## 3. Drag and drop (rail)

- Scenes are draggable (HTML5 DnD, `draggable` on the scene row; the row's link and menu button still work on click).
- While dragging over the rail: a 2px accent **insertion line** shows the drop position **between** scenes ("before X" / "after X" from the pointer's vertical half of the row); hovering a **chapter row** (including empty chapters) shows "end of <chapter>"; hovering a collapsed chapter for 600 ms expands it. Drop on the dragged scene itself or its current slot = no-op.
- An `aria-live` region announces the target ("Move The Key after Low Tide in Chapter 3").
- Drop → if the move only changes the mover's `chapter`/`act`/`sequence` and filename (no neighbour renumber) → apply directly with a toast "Moved <title>. **Undo**". If neighbours must be renumbered → **Preview** dialog first (files list + diffs), Apply/Cancel.
- Undo = `restoreOp(opId)` (exact; see §1 amendment). If it is refused (something changed since), the toast explains why.
- Dragging across acts works through chapters in the other act.

## 4. Keyboard and non-drag alternatives (required)

- Scene menu → **Move…** dialog: Act/Chapter select (all chapters incl. empty ones), Position select ("At the start", "After <scene>" for each scene in that chapter), Move/Cancel; shows the same preview rules.
- Shortcut on a focused scene row: **Alt+↑ / Alt+↓** moves the scene up/down one slot in book order (crossing chapter boundaries: moving down from the last scene of a chapter puts it first in the next chapter); focus stays on the moved row; announced via `aria-live`.

## 5. Acceptance (test-author)

1. **Move semantics:** every combination — within a chapter (first/middle/last), to another chapter in the same act, to another act, into an empty chapter, with and without a sequence gap — gives the expected order, `chapter`/`act`/`sequence`, canonical path; `validate()` clean.
2. **Survives restart, projection deletion and independent parsing:** after a series of moves: restart the server (child process), delete every `.storyforge/`, reopen → same order; the M00-J02 independent reader approach (a test-local parser using only front matter + `(chapter, sequence)` sort) gives the same order.
3. **Git diff shows only expected changes:** in a temp copy initialised as a **git repo** (commit before), do moves via the API, then `git diff -M100%`-style check (use `git diff --name-status -M` and `git diff -M --word-diff=porcelain` or parse the patch): every changed file is either a pure rename (100% similar) or a rename/edit whose only changed lines are `chapter:`, `act:`, `sequence:` front-matter lines; **zero changed lines below the closing `---`**. Skip with a clear reason if `git` isn't on PATH.
4. **Undo:** move then `restoreOp(opId)` → every file byte-identical and at its original path (including renumbered neighbours and non-canonical original names); after an external edit to any touched file → refused, nothing written.
5b. **Expected state:** dry run → external edit to the mover or to a neighbour that the dry run renumbers → apply with `expect` from the dry run → `409 CONFLICT` listing the changed path, nothing written.
5. **No guessing:** a book with a duplicate sequence → move returns `REFUSED_INVALID_BOOK`, nothing written; an external edit to the mover or a neighbour between dry run and apply → `CONFLICT`, nothing written.
6. **Tidy file names:** on the spec-example (W201/W202) → preview lists exactly the renames; apply → warnings gone; bodies identical.
7. **Keyboard helper** (pure function computing the target for Alt+↑/↓ from the book tree, incl. chapter boundaries and empty chapters) table-tested.
8. **Web render tests:** draggable rows, insertion-line element states, chapter-row drop target, Move… dialog fields/options, aria-live text.
9. **Manual (coordinator, real browser):** drag a scene within a chapter, into another chapter, into an empty chapter, and across acts; Undo; Alt+↓ across a chapter boundary; a move needing renumber shows the preview.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
