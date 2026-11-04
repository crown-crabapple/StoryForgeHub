# M09-J01 contract — Canvas (visual moodboard and planning board)

Binding: FORMAT-v1 §1 (book folder, files are canonical), §6.3 (planning), §9 (`.storyforge/` is disposable); contracts M01-J01 (layer rule), M04-J03 (board patterns),
M04-J04 §4 (attachments: upload, serve, allowlist), M07-J03 §3 (route policy), M07-J04 (modules).

Inspiration: Storyflow-style infinite canvases (notes, image walls, colour swatches, connectors, columns). StoryForge's version keeps every canvas a plain file in the book
folder, in an open format, and makes the book itself (scenes, Codex entries, threads, events, research notes) something you can drop onto the canvas.

## 1. Format

- One canvas = one file: `planning/canvases/<slug>.canvas`, UTF-8 JSON in the **JSON Canvas 1.0** format (jsoncanvas.org; the format Obsidian uses). Opening the book
  folder as an Obsidian vault shows the same canvas; every StoryForge extra degrades to a plain JSON Canvas node.
- Top level: `{ "nodes": [...], "edges": [...], "storyforge": { "schema": "storyforge.canvas/v1", "title": "..." } }`. `storyforge` is optional; without it the title is the
  slug. Unknown keys (top level, node, edge) are kept on save.
- Node types (JSON Canvas `type`) and the StoryForge kinds layered on them (`node.storyforge.kind`):

| What the author sees | JSON Canvas | `storyforge` extra | Without StoryForge |
|---|---|---|---|
| Note | `text` (Markdown) | — | a text card |
| To-do list | `text` with `- [ ]` / `- [x]` lines | `{ kind: "todo" }` | a task list |
| Colour swatch | `text`, `color: "#rrggbb"`, text `**Name**` + hex | `{ kind: "swatch", name, hex }` | a coloured text card |
| Image | `file` → `assets/canvas/<name>` | — | an image |
| Story card | `file` → the object's book-relative `.md` path | `{ ref: "<id>" }` | a file embed |
| Web link | `link` (`url`) | — | a link card |
| Group | `group` (`label`) | — | a group |
| Column ("wall") | `group` (`label`) | `{ kind: "column" }` | a group |

- Edges: JSON Canvas edges (`fromNode`, `fromSide`, `toNode`, `toSide`, `fromEnd`, `toEnd`, `color`, `label`). Default `toEnd: "arrow"`.
- **Story cards are by id.** `storyforge.ref` is the permanent id of a scene, entry, thread, event or note; `file` is a convenience copy that StoryForge refreshes to the
  object's current path on every save (a scene that moves chapters keeps its card). A ref that no longer resolves is shown as a broken card, never removed.
- Not canon: a canvas is planning material. It is never exported, never counted, never read by continuity. It is in backups (it is a file in the book).

### 1.1 Validation (`parseCanvas`, `@storyforge/format`, pure)

Refused on save with `REFUSED_BAD_CANVAS` (400, `message` names the node or edge and the rule); a file on disk that breaks a rule is listed with its `problem` and opens read-only.

- The document is a JSON object; `nodes` and `edges` are arrays (missing = empty). At most 2,000 nodes, 4,000 edges, 5 MB serialised.
- `id`: string, 1–64 characters, unique across nodes and edges.
- `x`, `y`, `width`, `height`: finite numbers (saved rounded to integers); `width`, `height` ≥ 1.
- `color`: `"1"`–`"6"` or `#rgb` / `#rrggbb`.
- `text`: string ≤ 100,000 characters. `link.url`: `http:`, `https:` or `mailto:` only. `file`: book-relative, forward slashes, no `..`, no leading `/`, no `\`, no NUL.
- `storyforge.ref`: string ≤ 80. `storyforge.hex`: `#rrggbb`. `storyforge.kind`: any short string; `todo`, `swatch`, `column` are understood, others shown as their base type.
- Edge `fromNode` / `toNode` name a node; sides `top|right|bottom|left`; ends `none|arrow`.

## 2. API

| Route | Class | Answer |
|---|---|---|
| `GET /api/books/:b/canvases` | read | `{ canvases: [{ slug, title, path, nodes, edges, sha256, updated_at, problem }], archived: [...] }` |
| `GET /api/books/:b/canvases/:slug` | read | `{ slug, title, path, sha256, canvas, problem, refs: { <nodeId>: { state, kind, id, title, summary, path } }, targets: [...] }` |
| `POST /api/books/:b/canvases` `{ title, slug?, dryRun? }` | write | 201 `{ slug, path }`; `REFUSED_PATH_TAKEN` 409 |
| `PUT /api/books/:b/canvases/:slug` `{ canvas, base_sha256 }` | write | 200 `{ sha256 }`; 409 `{ current: { sha256, canvas } }`; 400 `REFUSED_BAD_CANVAS` |
| `POST /api/books/:b/canvases/:slug/archive` / `restore` `{ base_sha256?, dryRun? }` | write | moves to / from `archive/planning/canvases/` |
| `POST /api/books/:b/attachments?name=…&for=canvas` | write | as M04-J04 §4, stored under `assets/canvas/` |

- `refs[nodeId].state`: `ok` | `archived` | `broken`. `kind`: `scene` | `entry` | `thread` | `event` | `research` | `doc` | `source`.
- `targets`: everything a story card may point at (scenes in book order, live entries, threads, events, research notes): `{ ref, kind, title, subtitle }`.
- Writes go through the store (single writer). Create, archive and restore are one batch with a dry run and never delete. The save is a whole-file write guarded by `base_sha256`.
- Module: the canvas routes and tab belong to the `board` module (off → tab hidden, writes 403 `MODULE_OFF`).

## 3. UI — `/books/:id/canvas`

- **Canvas list** (left): canvases with card counts, New canvas, Archive, archived canvases with Restore.
- **Board:** infinite pan/zoom (the scroll wheel zooms around the pointer; drag empty space or Shift+wheel to pan; the zoom buttons; Fit), select (click, Shift+click), move (drag; arrow keys nudge by 8, Shift by 40),
  resize (corner handle), delete (Delete / Backspace), duplicate (Ctrl/⌘+D), Undo / Redo (Ctrl/⌘+Z / Ctrl/⌘+Shift+Z, in memory).
- **Toolbar** (bottom, Storyflow-style), each with a key: Note `N`, To-do `T`, Swatch `S`, Image `I` (upload), Story card `C` (picker over `targets`), Link `L`,
  Column `W`, Group `G`, Connect `A` (click a card, then another).
- **Cards:** notes render Markdown safely (escaped; http(s) links open in a new tab; nothing is fetched); double-click or Enter edits. To-do boxes toggle in place.
  Swatches show the colour, name, hex and RGB. Story cards show kind, title, summary and Open (goes to the scene in Write view or the object's page). Images use the
  attachment route. Links show host and URL and open in a new tab.
- **Columns:** a card dropped inside a column is stacked into it (top to bottom, the column's width, 12 px gaps); the column grows to fit. Dragging the column moves its cards.
- **Saving:** every change saves itself (debounced 800 ms) with `base_sha256`. A 409 shows "This canvas changed on disk" with **Load the file** / **Keep mine** (saves over
  it with the new `base_sha256`). Status line: Saved / Saving / Not saved (with Retry).
- Accessibility: every card is focusable with a name ("Note: …", "Swatch: Pearl Bush #E8DDD4"); Tab walks cards in reading order (top-left first); the toolbar is a labelled
  toolbar; Enter edits, Escape leaves editing.

## 4. Acceptance

1. **Plain file, open format:** a canvas made through the API is `planning/canvases/<slug>.canvas`, valid JSON Canvas; a canvas written by hand in JSON Canvas (no
   `storyforge` keys) opens and saves without losing unknown keys.
2. **Story cards follow the book:** after a scene move (M03-J03) the canvas `refs` resolve to the new path, and the next save rewrites `file`; an archived target is
   `archived`, a missing one `broken`, and neither is removed.
3. **Refusals write nothing:** a bad canvas is 400 `REFUSED_BAD_CANVAS` and the file is byte-identical; a stale `base_sha256` is 409 with the current canvas.
4. **Survive cache loss:** delete `.storyforge/`, reload: the canvas list and every canvas are identical (they are read from the files).
5. **Validation is unchanged:** adding canvases adds no diagnostics to `validate()`.
6. **Policy:** every new write route has a class in `WRITE_CLASSES`; a share link reads no canvas.
7. **Tests:** `parseCanvas` rules; route tests for 1–5; web model tests for column layout, edge geometry, Markdown rendering and the history stack; render tests for the
   page, each card kind, a broken story card and the conflict banner.
8. **Manual (real browser):** make a canvas; add a note, a to-do (tick it), a swatch, an uploaded image, a story card for a character and a scene, a link, a column with
   three cards, an arrow with a label; reload — all there; open the file in a text editor — it is readable JSON Canvas.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.

## 5. Not in this job (follow-ups)

AI image cards (M05 AI workshop, preview and Send), freehand drawing, tables, nested canvases (a card that opens another canvas), marquee selection, real-time multi-user
editing in shared mode (today: the last writer gets the 409 banner), search over canvas text, MCP / API v1 canvas tools, Present mode.
