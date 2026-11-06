# ADR 0003 — Story Planner: storage, API and UI foundations

**Status:** accepted 2026-11-05 (maintainer: "proceed with M1"). **Job:** Story Planner M0 / SP-001 ("Inspect current contracts and select data model"). Spec: `StoryForgeHub_Novel_Planning_Feature_Specification.md` (Draft 1.0, not in the repo).

M0 makes no product change. It decides how the first Story Planner slice is stored and served, so M1 can build it without inventing patterns. It keeps four things apart: **manuscript order** (`act`, `chapter`, `sequence`), **chronology** (timeline events), **causality** (link records, below) and **view layout** (x/y). Nothing in this ADR lets one of them change another.

## Evidence (v2 at 95ce807)

| Area | What the code does today | Where |
|---|---|---|
| Front matter read | `yaml` library, YAML 1.2 core schema; aliases, anchors and tags rejected (E101) | `packages/format/src/frontmatter.mjs` |
| Front matter write | Never re-serialised. Byte edits of one single-line scalar (`editFrontMatterLine`) or one whole key block (`replaceFrontMatterBlock`); collections, comments and block scalars are refused | `packages/manuscript/src/frontmatter.mjs`, `codex.mjs` |
| Unknown keys | Kept on disk; each gives info `I401` (an `x-` prefix is exempt) | `packages/format/src/schema.mjs` |
| Scene field writes | `setSceneFields` handles title, status, pov and summary only, one case each | `packages/manuscript/src/structure.mjs` |
| IDs | `ID_PREFIXES` registry; every secondary kind (task, doc, research, continuity-exception…) uses `note_` + ULID | `packages/format/src/ids.mjs` |
| Schema names | `SCHEMA_RE` accepts `storyforge.<[a-z]+>/vN` plus four listed hyphenated names; any other hyphenated name is E102 | `packages/format/src/load.mjs` |
| New typed kind | A `KINDS` entry (+ `REFERENCES` for id fields); files are found by `walkMarkdown` with no registration | `schema.mjs`, `links.mjs`, `fs.mjs` |
| Guarded writes | op → `finish()` (dry run returns `changes` with diffs) → `commit()` → `store.batch` (journal, atomic write, trash, receipts, verify "no new errors", `opId` for Undo); `CONFLICT` on `base_sha256` mismatch | `packages/manuscript/src/ops.mjs`, `commit.mjs`, `packages/store` |
| Archive | A move to `archive/<same path>`; ids stay unique; references into archive give W303, not an error | `canvas.mjs`, `links.mjs` |
| Read routes | `handleApi` refuses GET paths longer than `/api/books/:b/<c>/<d>` (two exceptions) | `apps/server/src/router.mjs` |
| Write routes | `matchWriteRoute` + `handleWrite` case + `WRITE_CLASSES` class + `moduleOfRoute` prefix + `SAMPLES` row in `m07-proof.test.mjs` (the test fails if any one is missing) | `router.mjs`, `policy.mjs`, `packages/format/src/preferences.mjs` |
| Plugins | `/api/v1` is a whitelist; any `/api/books/...` path is refused to bearer tokens (`PLUGIN_SCOPE`) | `apps/server/src/plugin-policy.mjs` |
| Graph UI | Canvas is a custom DOM + SVG renderer: labelled edges, no edge type, edges `aria-hidden`, no list fallback, no auto-layout. No graph library in the lockfile | `apps/web/src/canvas/` |
| Dismissals | Continuity findings carry a fingerprint; an exception file in `planning/continuity/` suppresses one, and a stale one is reported | `packages/continuity`, `core/src/continuity-exceptions.mjs` |
| Backup | Walks the whole book folder (skips only `.storyforge*`), so new `planning/` files are backed up with no change | `packages/export/src/backup.mjs` |

## Decisions

### D01 — Scene planning fields live in a sidecar, not in the scene file

One file per planned scene: `planning/scene-plans/<scene-slug>.md`, kind `scene-plan`. The `scene:` field (the scene's id) is the key; the file name is only a readable label and may go stale after a rename without breaking anything.

Why not the scene's own front matter: every planning edit would change the scene file's bytes and sha, so an author with the prose open would get `CONFLICT` on their next save from an edit they made in another panel. Every scene would also gain `I401` notes, and `setSceneFields` would need a case per field. The sidecar keeps prose bytes untouched by construction (spec 0.1.2, S03 acceptance).

Existing scene fields (title, summary, status, pov, labels, plot_threads) stay in the scene file and stay authoritative. The UI shows one composite view; no field exists in both places. A scene with no sidecar simply has no plan; nothing is created until the author saves a field.

```yaml
---
schema: storyforge.scene-plan/v1
id: note_01JD0000000000000000000001
scene: scene_01S50000000000000000000003
goal: Prove the harbour key opens the sea gate.
opposition: The harbourmaster wants the key returned before dusk.
conflict: Maren must choose between the gate and her apprenticeship.
turn: The key opens a different door.
outcome: Maren is locked out of the guild.
consequence: She has to ask the ferryman for passage.
stakes: Her place in the town.
emotional_start: hopeful
emotional_end: cornered
purpose: Close off the safe path.
characters: [maren-hollis, pell]
---

Free planning notes for this scene.
```

Every planning field is an optional single-line string (max 2,000 characters, like `summary`), so the existing `editFrontMatterLine` writer covers every edit with no new YAML code. `characters` is a flat list written with the existing flow-list helper. Longer thinking goes in the body. Rules: E-level error if `scene` does not resolve to a scene; a warning if two sidecars name the same scene (codes chosen in M1).

### D02 — One Markdown record per causal link

`planning/links/<slug>.md`, kind `link`. One link per file, rationale in the body.

```yaml
---
schema: storyforge.link/v1
id: note_01JD0000000000000000000002
slug: key-therefore-ferry
from: scene_01S50000000000000000000003
to: scene_01S50000000000000000000005
relation: therefore
created: 2026-11-05
---

The key failing forces Maren onto the ferry.
```

- `relation` is one of: `therefore`, `but`, `enables`, `reveals`, `motivates`, `prevents`, `foreshadows`, `pays_off`, `parallel`, `other`.
- `from` and `to` resolve through `REFERENCES` (target kinds: `scene` in M1; beats join in M4). A missing target is an error the author can see and fix; nothing is deleted.
- `(from, to, relation)` should be unique: a duplicate is a warning, not a refusal, so a hand-edited folder still loads. A self-link (`from` = `to`) is an error.
- The slug is generated from the scene slugs and relation, cut to 60 characters, with a number added on a clash. It is not shown as an identity anywhere; the `id` is.
- Archive and restore move the file to and from `archive/planning/links/`, like canvases and notes. Undo, receipts and conflict checks come from the existing pipeline.

Why not one file holding a YAML list of all links: no existing writer can edit one item of a list of mappings, any two edits in a session would conflict on the same sha, and a hand edit could break every link at once. Per-file records reuse the store, archive, Undo and receipts with no new machinery, and give clean diffs in git.

AI-proposed links are not a link `status`. If AI ever suggests a link, it goes through the existing suggestion workflow and becomes a link file only when the author accepts it. A link file on disk always means the author made it.

### D03 — Graph view: own DOM + SVG component, list view first

No new dependency (React Flow, dagre, elkjs). The Flow view is a new component that borrows the canvas geometry helpers (`edgeGeometry`) but not its data: canvas edges are free-form and must never become causal assertions (spec 8.4).

The accessible **list of relationships** is built first and is a full equivalent: every link as a row with from, relation (as text), to and rationale, each openable, editable and archivable by keyboard. The graph is a second view of the same data. Edges carry the relation as a text label and a line style, never colour alone. Below 768px only the list is shown.

The first layout is deterministic: x from manuscript order, rows by chapter. Saved positions are presentation only; they are deferred to M2 and, when added, live in `planning/layouts/flow.json` behind their own route. They are not a canvas file, because canvas files are writable by plugins with the `canvas` permission.

### D04 — New module `planner`, on by default

Add `planner` to `MODULE_IDS`. All planner write routes start with `planner-` and map to it in `moduleOfRoute`. Turning it off hides the Plan views and refuses writes with `MODULE_OFF`; the files stay on disk and are still validated, as for every other module.

### D05 — Internal API: flat routes under the book

Because GET paths are limited to `/api/books/:b/<c>/<d>`, the spec's `/api/books/:b/planner/...` prefix does not fit routes such as `/planner/scene-plans/:id`. Routes sit directly under the book instead:

| Verb | Path | Route name | Class |
|---|---|---|---|
| GET | `/api/books/:b/links` | — | read |
| GET | `/api/books/:b/links/:slug` | — | read |
| GET | `/api/books/:b/scene-plans/:sceneId` | — | read |
| GET | `/api/books/:b/flow` | — | read (nodes + edges projection) |
| POST | `/api/books/:b/links` | `planner-link-create` | write |
| POST | `/api/books/:b/links/:slug` | `planner-link-update` | write |
| POST | `/api/books/:b/links/:slug/archive` | `planner-link-archive` | write |
| POST | `/api/books/:b/links/:slug/restore` | `planner-link-restore` | write |
| POST | `/api/books/:b/scene-plans/:sceneId` | `planner-scene-plan-save` | write |

All writes accept `dryRun` and follow `handleStructure` conventions: preview `{ok, changes}`, success with `opId` and `undo`, `CONFLICT` 409 with `current`, `REFUSED_*` 400. Edits that change an existing file require `base_sha256`. The story-level plan (`planning/story.md`, S01) and its route come in M2 with the Overview.

### D06 — Plugins, MCP and AI: nothing new

These routes are under `/api/books/...`, so plugin bearer tokens cannot reach them (`decidePlugin` refuses all of `/api/books`). No `/api/v1` route, MCP tool or plugin permission is added before M8. Planner data is sent to an AI provider only through the existing preview-and-Send flow, and only from M7.

### D07 — Planner checks reuse the continuity engine and its exceptions

Deterministic planner checks (spec 7.1) become continuity rules in their own family, so they use the existing finding shape, fingerprints, dismissal files and stale-exception reporting. They are suggestions and warnings about what the plan says, never claims about the prose. M1 adds only the format-level errors (missing target, self-link, duplicate); the rule family comes in M6.

### D08 — No ID prefix or schema name outside the existing patterns

New kinds use `note_` ids, like every other secondary kind, so `ID_PREFIXES` and the tools that copy it (legacy import, templates) do not change. `link` fits `SCHEMA_RE` as it is; `scene-plan` is added to its list of hyphenated names, the same way `continuity-exception` was.

## Mismatches with the spec

- **Route prefix:** `/planner/...` does not fit the router's GET depth limit; see D05.
- **AI link status:** the spec's `status: confirmed | proposed` on a link is dropped; see D02.
- **"Proposed edge preview"** (S02): writes already preview via `dryRun`. No separate proposal object.
- **Repository findings (spec §1):** they match the code. Canvas edges have labels but no type, keyboard access or list view, so the Flow view cannot simply reuse Canvas.
- **ID prefixes** such as `plan_`, `causal_` and `beat_` in the spec's examples are replaced by `note_` (D08).

## Rejected

- **Planning fields in scene front matter:** prose-file conflicts and `I401` noise; see D01.
- **Both sidecar and front matter writable:** two sources for one field; the spec forbids it.
- **All links in one YAML list:** no safe writer, constant conflicts; see D02.
- **Links as JSON Canvas edges:** free-form, plugin-writable, no relation type.
- **React Flow / elkjs:** extra dependency and bundle size, and they still need a separate accessible list. Revisit only if the M2 graph is too slow at 500 scenes / 1,000 edges.
- **A new `link_` ID prefix:** touches the id registry and three tools that copy it, for no gain.

## Risks

- **Many small files.** 1,000 links means 1,000 files in `planning/links/`. Load time must be measured in M1 against the 500-scene / 1,000-edge target (spec §2.3). If it is too slow, the fallback is an index projection, not a format change.
- **Stale sidecar names.** A scene renamed after its plan was saved leaves the sidecar's file name stale. Harmless (the key is `scene:`), but it may confuse someone browsing the folder. M1 decides whether to rename the sidecar along with the scene.
- **Scene archive.** Links into an archived scene give W303 (by the current rules). That is the intended visible-but-not-deleted behaviour, but the Flow view must show those edges clearly, not hide them.

## Migration and rollback

There is no migration. An old book has no `planning/links/` or `planning/scene-plans/` and opens unchanged. Rollback means removing the code: the files stay readable Markdown. An older StoryForge loads them as plain notes (`link`) or reports E102 for `scene-plan` (unknown hyphenated schema name), and changes nothing on disk. Checked on v2 95ce807: the two examples above, added to a copy of salt-orchard, give exactly one new diagnostic (E102 on the scene-plan file) and nothing for the link file.

## M1 work (proposed, for approval)

1. **Format:** `KINDS.link` and `KINDS['scene-plan']`, `SCHEMA_RE`, `REFERENCES` for `from`/`to`/`scene`, and the checks for self-link, duplicate link, unknown relation and duplicate sidecar. Fixtures: add `planning/links/` and `planning/scene-plans/` files to a copy of salt-orchard as a new valid fixture, plus one invalid fixture per new code.
2. **Manuscript ops:** `createLink`, `updateLink` (relation, from/to, rationale), `archiveLink`, `restoreLink`, and `saveScenePlan` (create, or edit fields with `editFrontMatterLine`), all through `finish()`.
3. **Core:** wrap them in `fs-writes.mjs`; read methods `listLinks`, `getLink`, `getScenePlan`, `flowGraph`.
4. **Server:** the routes in D05, `WRITE_CLASSES`, `moduleOfRoute`, the `planner` module, and `SAMPLES` rows.
5. **Tests:** round trip, dry run writes nothing, `CONFLICT`, Undo, archive and restore, plugin token refused, module off refused, and a byte snapshot showing no scene file changes after planning actions. A load-time benchmark at 500 scenes / 1,000 links.
6. **Docs:** `docs/format.md` (two new kinds), `docs/api.md` (new routes), `CHANGELOG.md`.

## Resolved at acceptance

1. Sidecars (D01) and one file per link (D02): approved with the ADR.
2. Relation list: kept as in D02; it can shrink later without a format change, because unused values cost nothing.
3. Sidecar rename: not in M1. The sidecar keeps its first file name; `scene:` is the key. Revisit if authors find stale names confusing.

New diagnostic codes chosen in M1: `E211` (link from a scene to itself), `W316` (duplicate live link with the same from, to and relation), `W317` (two live scene plans for one scene). A missing `from`, `to` or `scene` target is the existing `E301`.

## M2 decisions (2026-11-05)

- **Story plan:** `planning/story.md`, kind `story-plan` (`storyforge.story-plan/v1`), one per book. Fields: `premise`, `logline`, `theme_question`, `central_conflict`, `protagonist` (Codex entry slug), `protagonist_goal`, `stakes`; free notes in the body. `W318` flags a story plan anywhere else. It is never written into `book.md`. Routes: `GET`/`POST /api/books/:b/story-plan` (`planner-story-plan-save`) and `GET /api/books/:b/plan-overview` (story plan + counts).
- **Where it lives in the app:** a new project tab **Plan** (`/books/:id/plan`, module `planner`) with Overview and Flow. Board and Outline stay in the Manuscript tab; Plan links to them rather than copying them.
- **Scene planning fields** appear as a **Plan** section of the scene inspector (`INSPECTOR_SECTIONS` id `plan`), so they sit next to the prose in Write and next to the graph in Flow.
- **No dragging in the graph yet.** Layout is by manuscript order (one column per chapter). Saved positions (D03) wait until an author asks to arrange the graph by hand.

## M3 decisions (2026-11-06): character arcs

- **Where arcs live:** `planning/arcs/<slug>.md`, kind `arc` (`storyforge.arc/v1`), one live arc per character per book (`W319` flags a second). The arc is book-local and points at the Codex entry by **id** (`character: entry_…`), so a series-shared character keeps one identity while each book has its own arc. The Codex entry file is never written by arc edits.
- **Why not Codex custom fields (spec D07):** the `fields:` map belongs to the library's Codex types, and changing a type changes every entry of that type in every book. Arc fields are per book and per story, so they belong in the plan, keyed by the entry id.
- **Arc fields** (all optional, single line): `arc_type` (`positive`, `negative`, `flat`, `custom`), `want`, `need`, `false_belief`, `fear`, `wound`, `start_state`, `end_state`. Free notes in the body. No scores or numbers (spec S07).
- **Milestones** are an ordered list of mappings in the arc's front matter: `scene` (a scene id, required), and optional single-line `pressure`, `choice`, `belief_before`, `belief_after`, `cost`. The list is written whole, as one block, by the app (the existing `replaceFrontMatterBlock` writer); a hand-edited block with comments or anchors is refused, never rewritten. A milestone whose scene is unknown is `E301`; a malformed item is `E102`. Moving a scene never changes a milestone (it points at the id).
- **Routes:** `GET /api/books/:b/arcs`, `GET /api/books/:b/arcs/:slug`, `POST /api/books/:b/arcs` (`planner-arc-create`), `POST /api/books/:b/arcs/:slug` (`planner-arc-update`, fields), `POST /api/books/:b/arcs/:slug/milestones` (`planner-arc-milestones`, the whole ordered list), `POST …/archive` and `…/restore`. Same rules as links: dry run, `base_sha256`, Undo, module `planner`, not in plugin API v1.
- **Screens:** an **Arc** panel on a character's Codex page (create, edit fields, edit milestones); an **Arcs** view in the Plan tab (one lane per arc across the scenes in reading order, with a list equivalent); the scene inspector's Plan section lists the arc milestones set in that scene. Clicking a milestone opens its scene.
- **Deferred:** relationship developments (spec S07 "Relationships", S08 relationship lanes) move to M5 with the other lanes, so M3 stays one coherent change.

## M4 decisions (2026-11-06): structures and beat sheets

- **Templates are built-in data, not files.** `STRUCTURE_TEMPLATES` in `packages/manuscript/src/structure-templates.mjs`: `three-act`, `five-act`, `heros-journey`, `seven-point`, `story-circle`, `mystery`, `romance` and `custom` (no beats). Each has an `id`, an integer `version`, a name, a one-line description and ordered beats (`name`, `purpose`, `question`, optional `position` such as "about 25%"). All wording is our own; method names are used only as references (spec D06). No proprietary worksheet text, and no branded templates such as Save the Cat. Importing user-made templates waits for an author to ask.
- **A structure is one file**, `planning/structures/<slug>.md`, kind `structure` (`storyforge.structure/v1`). Its fields are `slug`, `name`, `template` and `template_version`, plus `beats`: an ordered list of mappings. Notes go in the body. A book can have any number of structures, or none.
- **Applying a template copies its beats** into the new file, each with a fresh `note_` id. The file records `template` and `template_version` once and never follows the template again, so changing a template never changes a book.
- **Each beat** has `id` (required), `name` (required), and the optional single-line `purpose`, `question` and `position`. `state` is `open`, `done` or `omitted`; if absent it means open. `scenes` is a flow list of scene ids (at most 50).
  - One scene can sit in any number of beats and structures.
  - The app writes the whole list at once, as for arc milestones.
  - A malformed beat, or two beats with one id, is `E102`. An unknown scene is `E301`. There are no new codes.
- **Beats stay inside the structure file**, not one file per beat. One file means one sha, one Undo and one archive per structure. Applying a 15-beat template is a single write. Removing a structure is archiving one file, and no scene is ever touched.
  - The cost: a link cannot point at a beat yet. D02's "beats join in M4" moves to M5, which can resolve beat ids inside structures.
- **Primary structure:** the story plan gets the field `primary_structure` (a structure id), set from the Overview or the Structure view. An archived primary gives `W303`, as other links do.
- **Routes** (module `planner`, not in plugin API v1):
  - `GET /api/books/:b/structure-templates`;
  - `GET /api/books/:b/structures` and `GET /api/books/:b/structures/:slug`;
  - `POST /api/books/:b/structures` (`planner-structure-create`, `{template, name}`);
  - `POST …/structures/:slug` (`planner-structure-update`, name and body);
  - `POST …/structures/:slug/beats` (`planner-structure-beats`, the whole ordered list; a beat without an `id` gets a new one);
  - `…/archive` and `…/restore`.
  - The rules match arcs: dry run, `base_sha256`, Undo.
- **Screens:**
  - **The Structure view in the Plan tab.** It has one tab per structure, with the primary one marked, and a New structure dialog that previews a template's beats before you apply it.
  - **The beat sheet editor.** Edit, reorder, add, remove and mark beats as omitted. Assign scenes by search.
  - **Elsewhere.** The scene inspector's Plan section lists "Beats in this scene". The Overview shows the structure count and the primary structure.
  - Comparing structures side by side, and showing beats on the Board, Outline and Flow, come in M5.
