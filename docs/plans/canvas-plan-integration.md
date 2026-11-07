# Plan on the canvas (M10, implemented)

Implemented on branch `feature/m10-plan-canvas`. What the code does is in [docs/contracts/M10-plan-canvas.md](../contracts/M10-plan-canvas.md); the text below is the design as decided, with the deviations listed at the end. Where they differ, the contract wins.

Goal: the canvas **is** the Plan tab. You plan by working on the canvas, as in the "Story canvas (plan on the canvas)" design artboard.
The planner files stay the single source of truth. The canvas never holds a copy of plan data.

## What existed before M10

- Canvas tab (`board` module): `planning/canvases/<slug>.canvas` (JSON Canvas 1.0 + `storyforge` extras). Story cards point at scenes by `storyforge.ref`. Edges between scene cards can be Flow links (`useCanvasLinks.js`).
- Plan tab (`planner` module, route `/plan`): views Overview, Flow, Structure, Lanes, Synopsis, Clues, plus the relationship graph, in `apps/web/src/planner/`.
- Plan check: PL1–PL6 in `packages/continuity/src/planner.mjs`. Each finding has `subject.id`.

## Core decisions

1. **One tab.** The Plan tab (route `/plan`) opens the canvas. The separate Canvas tab goes away; its route redirects to `/plan`.
   - Shown when the `planner` or `board` module is on.
   - Plan layers, plan tools and plan sections of the inspector need `planner`. With only `board`, it is today's free canvas.
2. **A plan canvas per book.** First open with no canvas builds `story-plan.canvas` from the plan: beat columns of the main structure, scene cards in them, clue cards in a row, links drawn. More canvases can be added from the left rail.
3. **Placed cards vs overlays.**
   - Placed cards (saved in the `.canvas` file): position, size, `storyforge.ref`. Beat columns are saved column nodes whose `ref` is the beat id, so the existing column layout works.
   - Dropping a scene card into a beat column adds the scene to that beat; dragging it out removes it. A scene in several beats shows them as badges. "Tidy to plan" moves cards into their first beat's column.
   - Overlays (never saved): clue plant/reveal edges, arc and clue badges, finding marks. Drawn from planner data.
4. **New ref kinds.** Refs stay bare permanent ids, as the canvas contract says. Planner files already carry `id: note_…`.
   - New target kinds: `story-plan`, `structure`, `beat` (an id inside a structure), `arc`, `relationship`, `synopsis`, `clue`.
5. **Edits use the existing planner routes.** No new write routes.
6. **Every old Plan view gets a home on the canvas.** Long forms reuse the existing components in a wide side drawer, not rewritten.

| Old Plan view | New home |
|---|---|
| Overview | Story plan card + inspector; counts in the left rail |
| Flow | Links layer (cause edges with relation labels) |
| Structure | Beat columns; structure picker in the rail; drop a scene in a column to assign it |
| Lanes (arcs) | Arc cards, milestone badges on scenes, optional "Arc lanes" layer under the columns |
| Synopsis | Synopsis card with stale flag; drawer reuses `SynopsisView` for writing and extract review |
| Clues | Clue cards; plants/reveals edges; knowers in the inspector |
| Relationships | Relationship cards; "develops" edges to scenes; drawer reuses `RelationshipGraph` |

7. **A list mode.** A "List" toggle shows the same plan as plain keyboard-friendly lists (built from today's Overview, Flow and Clues lists). A canvas alone is hard to use with a keyboard or screen reader, and on a phone.
8. **Deep links.** Anything that linked to `/plan/<view>` (findings, continuity page, Write tab) now goes to `/plan?select=<ref>`, which opens the canvas with that card picked and in view.
9. **What-if branch** is a view filter in the rail. Branch links draw dashed. New links made while a branch is on get that branch.

## Jobs

| Job | What | Who |
|---|---|---|
| C1 | Ref kinds + `storyIndex`/`resolve` + format contract update + server tests | implementer + test-author |
| C2 | Findings: add `related: [ids]` to PL3 (beat) and PL6 (plant and reveal scenes) | implementer |
| C3 | Canvas cards: story plan, synopsis, arc, relationship, clue / secret / red herring | implementer |
| C4 | Left rail: canvases, layers with counts, structure picker, what-if toggle, plan counts | implementer |
| C5 | Overlays: beat columns with drop-to-assign, clue edges, arc lanes, badges | implementer |
| C6 | Inspector + wide drawer reusing Synopsis, Relationship, arc and clue editors | implementer |
| C7 | Plan check rail: PL findings; click picks the card; warn color on card or edge | implementer |
| C8 | Plan tools in the toolbar + "build from plan" for the first canvas | implementer |
| C9 | Tab merge: `/plan` opens the canvas, Canvas tab removed, redirects, `?select=` deep links, module gating | implementer |
| C10 | List mode | implementer |
| C11 | Delete old Plan views no longer used; web tests; docs; full `npm run ci` | refactorer, test-author, scribe, verifier |

Order: C1 → C2 → (C3, C4) → C5 → (C6, C7, C8) → C9 → C10 → C11.
C11 only runs when every row of the "new home" table works. One PR into `v2`. Deploy only on your OK.

## Access rules (I write these myself)

- Viewers: canvas, layers, inspector and list mode, read only. No drop-to-assign, no plan tools, no card moves saved.
- Limited shared members: `book-scope.mjs` still guards shared series data. The canvas calls only existing routes, so the server already refuses what it should. The UI hides edits that would be refused.

## Out of scope

- Series plan on the canvas (read-only today; stays on its own page).
- Moving planner data into the `.canvas` file.
- MCP tools: unchanged, they use the server routes.

## Done when

- `/plan` opens the canvas. A new book gets a plan canvas built from its plan.
- Each row of the "new home" table can be done on the canvas without the old views.
- A scene dropped in a beat column is in that beat's `scenes`.
- A clue revealed before its plant shows a PL6 warn edge and a rail item.
- Layer toggles leave the saved `.canvas` file unchanged.
- List mode shows scenes, links and clues and can be used with a keyboard only.
- Old `/plan/<view>` and Canvas tab links land on the canvas.
- `npm run ci` passes.

## Deviations from this design

Found by reading the code on the branch.

- **No "Arc lanes" layer.** The Arcs layer is arc cards plus an `Arc · <name>` badge on each scene card with a milestone. There are no lanes under the columns.
- **No relationship graph, no SVG download.** The relationship card's drawer holds the relationship editor only (`RelationshipEditor`); `RelationshipGraph` and the Flow and graph "Download SVG" are not reachable from the Plan tab.
- **The Synopsis, Clue, Overview and series sections are in drawers** (`PlanDrawer.jsx`, `SeriesDrawer.jsx`) as designed; the series plan is opened from a **Series plan** button in the rail and by `?view=series`.
- **Old Plan views:** the unreachable ones are deleted; the editors the drawer reuses stay in `apps/web/src/planner/`.
- **Legacy deep links:** `view=flow&node=`, the slug forms (`structure`, `clue`, `arc`, `relationship`, `synopsis`), `branch` and `view=series` map to a pick. Other old `view`, `link`, `mode` and `filter` values only open the canvas.
- **Access:** read-only follows the session abilities (viewers, reviewers, share links) and an unreadable canvas file.
- **Module gate:** canvas writes are allowed when `board` or `planner` is on, in the app routes and in the plugin API v1 canvas routes.
