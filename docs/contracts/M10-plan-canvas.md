# M10 contract — The Plan tab is a canvas

Binding: contract M09-J01 (the canvas file, its routes and its validation, all unchanged unless stated here); FORMAT-v1 §6.3 (planning files stay canonical); M05-J01 (findings); M07-J03 (read-only roles); M07-J04 (modules). The design and decisions are in [docs/plans/canvas-plan-integration.md](../plans/canvas-plan-integration.md).

The planner files (`planning/story.md`, `structures/`, `arcs/`, `relationships/`, `synopses/`, `clues/`, `links/`, `scene-plans/`) stay the only copy of the plan. The canvas holds positions and refs; everything else it shows is read from the planner routes and drawn over the cards. Every edit goes through the planner's existing write routes. M10 adds no write route.

## 1. One Plan tab

- The project tabs have **Plan** (`/books/:id/plan`) and no Canvas tab. `/books/:id/canvas` (with any query) is replaced by `/books/:id/plan` with the same query (`redirectFor`, `routes.js`).
- The Plan tab is shown when the `planner` module **or** the `board` module is on (`tabVisible`). With both off the page says so and links to Settings.
- With only `board` on, the page is the free canvas of M09-J01: no plan rail, no plan tools, no Inspector, no List mode, no Tidy to plan. Everything below marked "plan" needs `planner`.
- Left: the canvas list (as M09-J01 §3: New canvas, card counts, Archive, Restore) and, with `planner` on, the plan rail (§6). Middle: the open canvas. Right: the Inspector (§5). The canvas that opens is the one in `?canvas=<slug>`, else the one opened last in this book (kept in the browser), else the first.
- A canvas bar has the title, the file path, the **Canvas | List** switch (§9), the save state and Archive.

## 2. Placed cards and overlays

**Placed** (saved in the `.canvas` file): position, size, `storyforge.ref`. A story card for a planner object is a story card like any other (M09-J01 §1) with a plan ref kind (§3).

**Overlay** (never saved; drawn from planner data by `planOverlay`, `canvas/plan/overlay.js`): link filtering and dashing, beat-column hiding, clue and relationship edges, badges on scene cards, finding marks. Turning a layer, the branch or the structure on or off does not change the file; the overlay function returns new sets and never changes the nodes or edges it is given.

Plan cards show the planner object read-only and read it live from the planner: a story plan card (logline, premise, theme question, central conflict, stakes), synopsis (excerpt, word count against target, a Stale chip), arc, relationship, clue (kind, or Red herring), beat, structure. A card whose object is not loaded shows the title and summary the server gave. Missing or archived targets stay as broken or archived cards (M09-J01 §1).

## 3. Ref kinds

Refs stay bare permanent ids. `packages/core/src/fs-canvas.mjs` resolves, besides the M09-J01 kinds, `story-plan`, `structure`, `arc`, `relationship`, `synopsis`, `clue` and `beat`.

- `targets` (the story-card picker) lists the planner items after the book's own kinds, in that order: the story plan, each structure followed by its beats, arcs, relationships, synopses, clues. A beat target has `structure` (the structure id) and `slug: null`. The picker groups by kind, the book's kinds first.
- A `beat` ref is a beat's own id (`beats[].id` of a structure). It resolves to `kind: 'beat'`, `state` `ok` (live structure) or `archived`, `structure`, `path` (the structure file), `summary` (the beat's question, else the structure's title). An id no file holds is `broken`.
- Titles: a clue by its `fact`; an arc by its character's name; a relationship as `A & B`; the story plan as `Story plan`.
- Subtitles: a clue by its kind (plus ` · red herring`); a structure by its beat count; a synopsis by its type (plus ` · N words`); an arc by its `arc_type`.

## 4. Beat columns

A **beat column** is a saved column node (`storyforge.kind: "column"`) whose `storyforge.ref` is a beat id. The M09-J01 column layout applies unchanged.

- **Drop in = add to the beat.** Moving a scene card into a beat column adds the scene to that beat's `scenes` (at the end) with the planner's beat save (`onSaveBeats`, one write per structure). The card stays on the canvas.
- **Drag out = remove.** Moving it out of the column removes the scene from that beat. Moving it from one beat column to another does both in one gesture.
- A card that stays in the same column, or in no beat column, writes nothing.
- A refused write puts the cards back where they were; the planner's words for the refusal show in the page banner. A drop is one undoable canvas change once the write is accepted.
- A scene in several beats shows each as a badge on its card (at most three badges per card).
- **Tidy to plan** (button in the canvas toolbar, `planner` on, not read-only): every scene card that is in a beat of the chosen structure but not inside that beat's column moves into the column of its **first** beat in structure order, then the columns are laid out. It only moves cards that have such a column on the canvas, never adds or removes a node or an edge, and is one undo step.
- Turning the **Beats** layer off hides the beat columns and the beat badges.

## 5. Clues

- With the **Clues** layer on, a scene card gets a `Plants · <fact>` badge for each clue it plants and a `Reveals · <fact>` badge for each clue it reveals.
- If the canvas has the clue's card, an edge `plants` runs from the scene card to the clue card and an edge `reveals` from the clue card to the scene card.
- A clue with a PL6 finding (revealed before it is planted) draws its reveal edge in the warn colour labelled `reveals · too early`, and its reveal badge in the warn tone.
- **Connect a scene to a clue** (Connect tool, `A`, either order; planner on, not read-only) asks "Does <scene> plant or reveal <clue>?" with **Plants** and **Reveals**. Plants adds the scene to the clue's `planted`; Reveals sets it as the clue's `revealed` scene. This writes the clue file, not an edge into the canvas. Connect between two scenes still makes a Flow link (`useCanvasLinks.js`).
- **Relationships** layer: an edge `develops` from a relationship card to each scene card where it has a development, drawn only when both cards are on the canvas.
- **Arcs** layer: a scene card with a milestone of an arc gets an `Arc · <name>` badge. There is no arc lanes layer; arcs on the canvas are arc cards plus these badges.

## 6. Layers, structure and the what-if branch

The plan rail (left, `planner` on) has:

- **Plan layers:** Links, Beats, Arcs, Clues, Relationships, each a toggle (`aria-pressed`) with its count (live links; beats of the chosen structure; arcs; clues; relationships). All start on. The choice is kept per book in the browser.
- **Structure:** a select over the structures (the primary one marked). The default is the primary one, else the first. It decides which beats the Beats count, Tidy to plan, the beat tool, the beat checkboxes in the Inspector and the beats of the built canvas follow.
- **Branch:** a radio group, Main plan and one entry per what-if branch. Main plan hides every branch link. A named branch shows the main links plus that branch's links, the branch's drawn dashed and labelled `<relation> · what-if`. A link made on the canvas while a branch is shown gets that branch; with Main plan shown it is a main-plan link.
- **Series:** a **Series plan** button when the book is in a series; it opens the series plan in a drawer (§8).
- **Plan check:** see §7.

## 7. Plan check rail and `related`

- The rail lists the findings of rules PL1 to PL6 from `GET /api/books/:b/continuity` (none with the `continuity` module off), each as a button with its rule code and title, and a count. With none it says "No plan problems found."
- A finding has `related: string[]` (M05-J01): PL1 `[scene]`; PL2 `[scene, next scene]`; PL3 `[beat id]`; PL4 `[]`; PL5 the planted scenes; PL6 `[revealing scene, first planting scene]`. It is not part of the fingerprint.
- **Click a finding:** the cards whose ref id is the finding's `subject.id` or any `related` id are selected and brought into view. A finding with no card on the open canvas says "Not on this canvas" and does nothing.
- **Marks:** a card whose ref is a finding's subject or a `related` id gets the finding's title as a warn mark (tooltip and screen-reader text `Plan check: …`). Marks show with every layer off.

## 8. Inspector and drawer

**Inspector** (right, `planner` on): one picked card (in List mode, one picked item) shows its plan as sections of rows, read from the planner, not copied.

- Scene: Scene plan (fields, emotional start → end, characters; "No plan yet" in the warn style), Causal links (Leads to / Comes from), Beats, Clues (planted and revealed here), Arc milestones. The Beats section has a checkbox per beat of the chosen structure; ticking adds the scene to the beat, unticking removes it, with the same beat save as a drop. The checkboxes are disabled while read-only or while a save is running.
- Clue (kind, fact, planted, revealed, any PL6 finding, who knows), arc, relationship, synopsis, story plan, beat, structure.
- Other kinds: title and summary. A card that is missing or archived says so; a card with no ref says it is not part of the plan. Nothing picked or several picked: "Pick a card to see its plan".
- **Open** (scene and Codex cards) goes to the scene or the entry. **Edit plan** (scene, story plan, structure, beat, arc, relationship, synopsis, clue; hidden when read-only) opens the drawer.

**Drawer** (wide, right, non-modal): reuses the planner's own editors, not new ones. Focus moves in on open; Escape or **Close** shuts it and focus goes back to where it was, else the board. A save refreshes the plan and the Inspector.

| Card | Drawer holds |
|---|---|
| Scene | the scene plan section |
| Story plan | the story plan fields and notes (the Overview component) |
| Structure, beat | the beat sheet editor of the structure |
| Arc | the arc editor (milestones) |
| Relationship | the relationship editor |
| Synopsis | the synopsis editor with Build from plan and its review |
| Clue | the clue editor (with the list and new-clue form) and who-knows |

The series plan has its own drawer of the same kind (Series plan button, §6).

## 9. Plan tools

The toolbar (bottom, not read-only, `planner` on) has, after a separator, **Cause**, **Clue**, **Arc**, **Relationship** and **Beat**, labelled buttons with no keys of their own.

- **Cause:** switches the board to the Connect tool.
- **Clue:** a dialog (fact, kind: clue, reveal or secret) creates the clue with the planner's clue write.
- **Arc:** the new-arc dialog.
- **Relationship:** the new-relationship dialog (two entries).
- **Beat:** a dialog (name; position and question optional) adds a beat at the end of the chosen structure; it needs a structure.
- Each of the last four makes the planner item first, then puts its card on the canvas at the drop point (a beat column for a beat). If the new item is not found in the re-read plan within 15 seconds, the page says so and suggests a story card.

## 10. Build your plan canvas

With the `planner` module on, a book with no open canvas and a writer session offers **Build your plan canvas**. It creates `planning/canvases/story-plan.canvas` (title "Story plan") and lays the plan out (`buildPlanCanvas`, `canvas/plan/build.js`) from the primary structure, else the first:

1. Row 1: the story plan card, then a card per synopsis.
2. A column per beat of the structure (a beat column with `ref` = beat id), each scene's card in the column of its **first** beat; scenes in no beat in a last column "Not in a beat" (no ref), in book order.
3. A row of clue cards (archived ones left out), then a row of arc and relationship cards.
4. An edge for each main-plan link between two scenes that have cards, tied to the link and labelled with its relation. Branch, archived and broken links are left out.

The result is built from the plan and passes `parseCanvas`. If the new file cannot be read back to lay the plan out, the page says so and the empty canvas stays open; if the layout cannot be saved, the page gives the reason. The plan is not otherwise built on its own: a book that already has a canvas opens it.

## 11. List mode

The **Canvas | List** switch (`planner` on) shows the same plan as plain headed lists in place of the board. The choice is kept per book; with none kept, a window under 720 px wide starts in List.

- Sections: Story plan (logline, premise, primary structure); Scenes by beat of the chosen structure (a group per beat and "Not in a beat", scenes in book order with chapter, goal and turn when the scene has a plan, and its outgoing links); Clues (kind, planted, revealed, the PL6 warning); Arcs; Relationships; Synopses (with a stale note and an excerpt).
- It follows the layers, structure and branch of the rail: Beats off gives one "Scenes" group; Links off hides the links; Clues, Arcs, Relationships off drop their sections; links of a branch show only when that branch is chosen, marked "(what-if)".
- Every item is a button that picks it (`aria-pressed`); a link in a scene's list picks the scene it leads to. The Inspector shows the picked item, with the same Open, Edit plan and beat checkboxes. No custom widget role; Tab and Enter or Space are all it takes.
- Switching to List carries over a single picked card; switching back clears the pick. A deep link or a plan-check click picks the matching item (beats and structures have no list item).

## 12. Deep links

- `/books/:id/plan?select=<id>`: the canvas opens with the card for that ref id picked and in view (in List mode, the item). `?branch=<slug>` turns that what-if branch on. `planHref` builds these.
- Older Plan-tab forms still resolve (`legacyPlanTarget`, `canvas/plan/deepLink.js`): `view=flow&node=<scene id>` picks that scene; `structure=`, `clue=`, `arc=`, `relationship=`, `synopsis=` with a slug pick that object (the id looked up in the loaded plan; `structure=` also chooses that structure); `branch=<slug>` as above (`branch=*` is ignored); `view=series` opens the series drawer. Any other query (other `view` values, `link`, `mode`, `filter`) just opens the canvas.
- A slug the plan does not know opens the canvas with nothing picked. A link is applied once per address, after the plan and the canvas have loaded, and only with `planner` on.
- `/books/:id/canvas?...` redirects to `/books/:id/plan?...` (§1).

## 13. Modules and roles

- Tab: `planner` or `board` (§1). Plan data, rail, plan cards' live data, Inspector, drawer, tools, Tidy to plan, Build, List mode: `planner`.
- Canvas writes (the canvas write routes): allowed when `board` **or** `planner` is on (`checkModule`, `apps/server/src/preferences.mjs`; the plugin API v1 canvas routes use the same rule). Both off: 403 `MODULE_OFF`, `module: "board"`.
- The planner writes the canvas makes (beats, clue fields, links, new items) use the planner's routes and their own module rules; a refusal shows in the page banner.
- **Read-only** for viewers, reviewers and share links (`abilities().readOnly`) and for a file that cannot be read as a canvas: the toolbar, plan tools and Tidy to plan are absent, Undo and Redo and the title field are disabled, drops write nothing, Edit plan is hidden, the beat checkboxes are disabled, and the drawer does not open. The canvas, layers, rail, Inspector and List mode still work. The page says "You can look at this canvas and its plan. Ask the owner for an editor role to change them." The server refuses their writes regardless.

## 14. Not in this job

- Arc lanes as a layer or as lanes under the beat columns.
- The relationship graph and the Flow and graph "Download SVG" on the canvas. The relationship card opens the relationship editor only.
- The series plan on the canvas (read-only, in its drawer).
- Moving planner data into the `.canvas` file.
- MCP and plugin tools for the plan: unchanged in M10 (read-only planner tools; canvas tools edit the file only). M11 adds the `plan` permission and the plan write tools: see [M11-ai-plan-tools.md](M11-ai-plan-tools.md).

## 15. Checks that exist

- `apps/web/test/canvas-build.test.mjs`: build and Tidy to plan.
- `apps/web/test/canvas-overlay.test.mjs`: layers, branch, badges, clue edges, marks, beat moves.
- `apps/web/test/canvas-inspector.test.mjs`: Inspector rows and beat membership.
- `apps/web/test/canvas-plan.test.mjs`: plan item lookup, counts, layers, finding-to-card matching, picker grouping.
- `apps/web/test/plan-tab.test.mjs`: one Plan tab, the redirect, deep links, List mode model and render, the Build button.
- `apps/server/test/canvas-routes.test.mjs`, `plugin-canvas.test.mjs`, `packages/continuity/test/planner-rules.test.mjs`: ref kinds and targets, module gate, `related`.
