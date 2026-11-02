# M04-J04 contract — timeline, research, notes and attachments

Binding: FORMAT-v1 §1.6 (paths relative to the file; E103), §1.8 (links incl. `[@cite]`, Markdown links), §6.2 (events: `order`, `when`, `date`, `scenes`, `characters`, `locations`; scene `events`), §6.3 (planning docs), §7 (research + sources), §9 (`.storyforge/`); contracts M01-J04 (watcher/reconcile), M02-J02 (safe image route), M03-J02 (editor reuse), M03-J04 (editor rail), M04-J01 (graph, `extractLinks`), M04-J02 (entry editing patterns, block replacement), M04-J03 (thread patterns).

## 1. Validation additions

- Event `date`: `""` or ISO `YYYY`, `YYYY-MM`, `YYYY-MM-DD` → else `E102 date`.
- Event `order`: finite number (exists); events with identical `order` are allowed (simultaneous).
- Research `links` resolve like other slug references (E301/E302 — any entry/thread/event allowed); `sources` must name an existing `cite_key` (E301 at `sources[i]`).
- Body Markdown links to local files: existing rules (relative to the containing file; escape → E103; missing → E301). **Absolute local paths** (`C:\…`, `/…`, `file://…`) → `E103`. `http(s)://` links are external and never checked or fetched.

## 2. Timeline tab — `/books/:id/timeline` (replaces placeholder)

- **Two orders, one page:** toggle **Story time** (chronological: `order`, then id; grouped by `when` label runs) / **Book order** (narrative position; unplaced events in a separate "Not in the book yet" group).
- **Event card:** title, `when` (and `date` if set), participants (characters → names), locations, scenes (links to the manuscript, with chapter label), "told early/late" badge when its narrative position is before an event that happens earlier in story time (flashforward/flashback — **information only**).
- **Story vs. book chart:** a compact SVG plot, x = narrative position, y = chronological rank, one dot per placed event, labelled on hover/focus; accessible as a table toggle ("Show as table").
- **Filters:** character, location, thread (events whose scenes are in that thread's lists), "unplaced only", "has problems".
- **Problems panel:** diagnostics on event files (E301 broken scene/entry refs, E102 bad date, W-codes), unplaced events, events whose scenes are archived — each with a link to fix (open the event).
- **Edit:** New event (title, slug, when, order — default: after the selected/last event as `last + 10`, date), Edit fields (title, when, order, date, characters, locations — block replacement for lists), add/remove scenes (edits the event's `scenes` list; also offers to add the event to the scene's `events` for two-sided links — optional checkbox), event text via the editor component, Archive/Restore.
- **Drag to reorder in Story time:** dropping an event between two others sets its `order` to the midpoint of their orders (decimals allowed — no renumbering of others ever); single-line edit with Undo; keyboard Alt+↑/↓ equivalent.
- Editor rail (M03-J04): an **Events** section listing the scene's events (from both sides) with links to the timeline.

## 3. Notes tab — `/books/:id/notes` (replaces placeholder)

- **Sidebar:** All · Research · Planning docs · Sources · Scene notes; tag list with counts (research `tags`).
- **List:** title, kind, tags, linked entries, updated; search (title/tags/body via `/api/search` kinds research/doc).
- **Note view:** rendered Markdown (read-only display rules as the editor's reading view; external links open in a new tab with `rel="noopener noreferrer"`, shown with an external-link icon and the host name; local attachment links open the attachment route), fields (tags, canon flag with a short explanation, links to entries/threads/events as chips, sources as citations), **Edit text** (editor component), Edit fields, Archive/Restore.
- **New research note** (`research/<slug>.md`), **New planning doc** (`planning/<slug>.md`, `storyforge.doc/v1`), **New source** (`research/sources/<cite-key>.md`; `cite_key` unique → `CITE_KEY_TAKEN`).
- **Scene notes:** every `<!-- note: … -->` across the book, grouped by chapter/scene, each jumping to the line in the editor (read-only list).
- **Associations shown elsewhere:** Codex inspector gets a **Research** section (notes whose `links` name the entry); editor rail gets **Research** (notes linking any entry/thread in the scene).

## 4. Attachments

- **Upload** `POST /api/books/:b/attachments?name=<file name>` (write-guarded, raw bytes body, `content-type` of the file): stored through the store at `assets/research/<safe-name>` (lower-case, `[a-z0-9._-]`, collisions get `-2`, `-3`); max 25 MB → 413; allowed extensions: `png jpg jpeg webp gif pdf txt md csv` (others → 415). Returns `{ path, markdown }` where `markdown` is the link to insert, **relative to the note's own folder** (e.g. `../assets/research/map.pdf` from `research/x.md`).
- **Serve** `GET /api/books/:b/attachments?path=assets/...`: only files under `assets/` (realpath containment), allowed extensions only, `x-content-type-options: nosniff`; images inline, everything else `content-disposition: attachment`; SVG never; 404 otherwise.
- In the note editor: **Attach file…** button uploads and inserts the returned link at the caret; drag-and-drop of a file onto the editor does the same.
- Attachments are never fetched from elsewhere; nothing is copied outside the book.

## 5. Reconciliation

External edits to event, research, doc or source files go through the watcher (M01-J04) → reconcile → the Timeline/Notes pages and the Codex/editor inspectors refresh on the next status poll (≤ 3 s) without a reload. Invalid edits show in the Problems panel (last valid projection kept, as for scenes).

## 6. Acceptance

1. **Validation:** event `date` cases; absolute local link → E103; research `links`/`sources` resolution; invalid fixture cases added (`E102-event-date`, `E103-absolute-link`, `E301-research-source`).
2. **Timeline data:** chronological and narrative orders on salt-orchard (5 events incl. one unplaced, one simultaneous pair if present — add to a copy if not) match FORMAT §6.2 rules; "told early/late" flags exact; filters by character/location/thread correct; problems list exact.
3. **Reorder by `order` midpoint:** only the moved event's `order` line changes (decimal allowed); Undo byte-identical.
4. **Event/note editing:** exact file effects for create/edit fields/lists/scenes (incl. optional two-sided scene `events` edit)/archive/restore; refusals write nothing; 403 guards; dry runs.
5. **External change → UI data:** with the watcher on, `fs.writeFile` to an event and to a research note → within 5 s the timeline API and the entry/editor inspector data reflect it; an invalid edit → problem listed, last valid data kept.
6. **Attachments portable:** upload → file under `assets/research/`, returned link relative to the note, `validate()` clean when inserted; serve route rules (types, nosniff, disposition, SVG/escape/absolute refused, 413/415); after copying the whole book folder elsewhere, every attachment link still resolves (validate on the copy).
7. **Render tests:** timeline cards/toggles/chart table fallback/filters/problems; notes sidebar/list/note view (external link attributes, attachment links), sources, scene-notes list; Codex/editor Research sections; Places tab renders the Codex filtered to locations.
8. **Manual (coordinator, real browser):** create an event, place it in story time by dragging (or Alt+↑), link a scene, see it in Book order; create a research note, attach a PDF/image, link it to Maren, see it on Maren's Codex page; edit an event file outside the app and watch the timeline update.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
