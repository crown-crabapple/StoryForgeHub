# M04-J03 contract — corkboard, outline, matrix and plot-thread lifecycle

Binding: FORMAT-v1 §4 (scenes), §6.1 (threads, **extended today**: states `planned|planted|developed|paid|dropped|unresolved` + legacy `open|abandoned`; new `develop` list; `W306`), DECISIONS 4; contracts M03-J01 (structure commands, preview, `editFrontMatterLine`), M03-J03 (moves: `expect`, exact Undo, DnD rules), M04-J02 (block replacement for lists, entry editing patterns).

## 1. Format and validation

- Validator: thread `status` enum extended; `develop` list of scene IDs (E301/E302 like `setup`/`payoff`); `W306` when `planted` has empty `setup` or `developed` has empty `develop` (location `status`). Existing fixtures keep their current diagnostics.
- Scene `summary` becomes editable through `setSceneFields` (single-line string; refuse multi-line input — the UI keeps it to one paragraph).

## 2. Views — Manuscript tab gains a view switch: **Write · Board · Outline · Threads**

URL: `/books/:id?view=board|outline|threads` (Write = current editor, default). All views are projections of files (index or files fallback); nothing stored only in the DB.

### 2.1 Board (corkboard)

- One column per chapter (act headings above), cards in book order. Card: title, summary (or "No summary yet" muted), status dot + label, POV initial, word count, thread tags (thread titles from `plot_threads` and from threads listing the scene in `setup`/`develop`/`payoff`, with a small S/D/P marker).
- **Drag and drop** between and within columns = the M03-J03 move (same route, `expect`, preview when neighbours renumber, exact Undo). Keyboard: Alt+←/→ moves a card to the previous/next chapter (end of it), Alt+↑/↓ as in the rail; Move… dialog from the card menu.
- **New card** in a column = `createScene` with `status: outline` (title + optional summary). **Edit card** dialog: title, summary, status, POV (J01 `setSceneFields`).
- Empty chapters show an empty column with "Add a card".

### 2.2 Outline

- Table: Chapter · Scene · Summary · POV · Status · Words · Threads; grouped by act and chapter with chapter totals; rows link to the scene in Write view. Inline edit of summary and status (single-line edits, Undo toast).
- Filters: status, POV, thread.

### 2.3 Threads and matrix

- **Threads list:** title, kind, state (chip with text), counts S/D/P, "last touched in Ch N". Filter by state; sort by book position of first setup.
- **Thread inspector:** body text (rendered read-only, editable via the J02 editor component as for entries), state select (all six states + legacy shown if present), setup/develop/payoff lists of scenes (each a link; add via a scene picker; remove), characters.
- **Matrix:** rows = scenes in book order (grouped by chapter), columns = threads; cell shows **S / D / P** (from the thread lists), or a dot if the scene lists the thread only in its own `plot_threads`; clicking an empty cell opens a small menu "Mark as setup / development / payoff" (edits the **thread** file's list), clicking a filled cell offers "Remove". Header shows each thread's state chip.
- **Lifecycle helpers (warnings, never auto-changes):** `planned` thread whose `setup` gained a scene → suggest "Mark as planted"; `planted` with develop scenes → "Mark as developed"; any with payoff → "Mark as paid". Suggestions are buttons; nothing changes without a click.
- **New thread** dialog: title, slug, kind, state (default `planned`) → `planning/threads/<slug>.md` (`SLUG_TAKEN` across entries/threads/events).

### 2.4 Write view tie-in

The editor rail's "In this scene" threads list gains "Mark this scene as setup / development / payoff" per thread (same thread-file edit).

## 3. Writes

| Action | File change |
|---|---|
| Card/scene move | M03-J03 move (front-matter position lines + path) |
| New card | new scene file (`status: outline`) |
| Edit card / inline outline edit | `setSceneFields` single lines (`title`, `summary`, `status`, `pov`) |
| Thread state | `editFrontMatterLine(status)` on the thread file |
| Add/remove scene in setup/develop/payoff | block replacement of that list key only (M04-J02 pattern; insert key after `setup` if missing) |
| New thread | new file under `planning/threads/` |

All: dry run + preview (or direct apply + Undo for single-line edits), refuse on new errors, never delete, reconcile after; write-guarded routes.

## 4. Acceptance

1. **Board changes are represented in Markdown:** each board operation (move within/between chapters, new card, edit card, thread mark/unmark, state change, new thread) → exactly the expected file lines change (diff check; CRLF file included); `validate()` clean (apart from expected warnings).
2. **Survive cache loss:** after a sequence of board/thread operations, delete `.storyforge/`, reopen → board, outline, threads and matrix data identical (from files fallback and after rebuild).
3. **Outline shows linked scenes/threads accurately:** outline rows' Threads column == union of scene `plot_threads` and threads listing the scene (with S/D/P role); matrix cells == thread lists exactly; thread S/D/P counts correct — on salt-orchard and codex-graph.
4. **Same ordering guarantees as manuscript scenes:** board DnD uses the move route with `expect` (409 on stale), exact Undo byte-identical, git-diff test pattern from M03-J03 shows only position lines/paths changed.
5. **Thread validation:** new states valid; legacy `open`/`abandoned` still valid; `develop` references resolved; W306 cases; invalid fixture cases added.
6. **Render tests:** board columns/cards (incl. empty chapter), card fields, thread tags with S/D/P; outline table and filters; matrix cells and menus; lifecycle suggestion buttons appear only when applicable; no dead controls.
7. **Manual (coordinator, real browser):** Board — move a card with Alt+→ and with the Move… dialog, create a card, edit its summary; Outline — inline status edit; Threads — create a thread, mark a scene as setup in the matrix, accept the "Mark as planted" suggestion; delete `.storyforge/` and reload — everything still there.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
