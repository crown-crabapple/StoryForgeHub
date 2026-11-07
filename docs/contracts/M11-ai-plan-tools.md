# M11 contract — An AI can change the Story Plan

Binding: contract M08-J02 (tokens, permissions, API v1, the policy decided before the member policy); contract M09-J01 and M10 (canvases and the Plan tab); the Story Planner routes in [docs/api.md](../api.md) (validation, sha checks, Undo); M07-J04 (modules).

M11 adds a second writing permission, `plan`, and the plugin API v1 and MCP tools that go with it. It adds no new planner behaviour: a v1 plan write is run by the app's own planner route.

## 1. The `plan` permission

- `PLUGIN_PERMISSIONS` is `read`, `propose`, `events`, `canvas`, `plan` (`packages/shared/src/plugin-tokens.mjs`, `packages/format/src/plugins.mjs`). A token or plugin manifest may name `plan`.
- `plan` writes only Story Planner files under `planning/`: links, scene plans, `story.md`, structures, arcs, relationships, clues and synopses. It never writes prose, scenes or Codex entries, and it does not write canvases (that is `canvas`).
- It is opt-in. The **Connect Claude** form has the checkbox "Change the plan: the AI may write your Story Planner items (planning material, never your prose; you can Undo each change)", unticked at first. **Settings, then Plugins** lists `plan` as "Change the plan: read and write the Story Planner (scene plans, links, structures, arcs, relationships, clues, synopses). You can Undo each change. It never touches your prose."
- `plan` does not imply `read`. A token that should read the plan and write it has both. The plan reads below need `read`.

## 2. Routes

All routes sit under `/api/v1/books/:b/plan` and are decided by `apps/server/src/plugin-policy.mjs` before anything runs. A book outside the grant is `403 PLUGIN_SCOPE`; a token without the permission in the table is `403 PLUGIN_SCOPE` naming it.

Writes (permission `plan`, method `POST`). The body is the body of the app's own route in [docs/api.md](../api.md), "Story Planner routes", "Writes".

| v1 path (after `/plan`) | Runs the app's route | Body |
|---|---|---|
| `/story` | `POST /api/books/:b/story-plan` | `{ fields?, body?, base_sha256? }` |
| `/scene-plans/:sceneId` | `POST /api/books/:b/scene-plans/:sceneId` | `{ fields?, characters?, base_sha256? }` |
| `/links`, `/links/:slug` | `.../links`, `.../links/:slug` | create, update |
| `/arcs`, `/arcs/:slug`, `/arcs/:slug/milestones` | `.../arcs...` | create, update, set milestones |
| `/structures`, `/structures/:slug`, `/structures/:slug/beats` | `.../structures...` | create, update, set beats |
| `/relationships`, `/relationships/:slug`, `/relationships/:slug/developments` | `.../relationships...` | create, update, set developments |
| `/clues`, `/clues/:slug`, `/clues/:slug/knowers` | `.../clues...` | create, update, set knowers |
| `/synopses`, `/synopses/:slug` | `.../synopses...` | create, update |
| `/<collection>/:slug/archive`, `/<collection>/:slug/restore` | `.../<collection>/:slug/archive` and `restore` | optional `{ base_sha256 }`; `<collection>` is `links`, `arcs`, `structures`, `relationships`, `clues` or `synopses` |

- A slug in the path is lower-case letters, digits and hyphens, 1 to 120 characters; a scene id is 1 to 120 characters without `/`. Anything else is `403 PLUGIN_SCOPE` ("not a plugin API route").
- The v1 path is mapped onto the app's route and run by the same `handleWrite` as the Plan tab. Only routes the app names `planner-*` are reachable this way; any other match is `404`. The request body must be a JSON object (else `400 BAD_ARGS`).
- Validation, refusal codes, the sha check, the write itself and the op journal are the app's. The answers are the app's too (`opId`, `undo`, `id`, `slug`, `path` and so on; a stale `base_sha256` is `409` with `current: { sha256, text }`).
- The plugin and its token id are recorded as the actor of the write (`principal` kind `plugin`).

Reads (permission `read`, method `GET`). The answers are the app's planner reads with `path`, `file`, `rel` and `base_sha256` left out (§3).

| v1 path | Answer |
|---|---|
| `/plan` | `{ story: { fields, body, sha256 }, counts, primary_structure }`; `story.sha256` is `null` when the book has no story plan file |
| `/plan/links`, `/arcs`, `/structures`, `/relationships`, `/synopses`, `/clues` | as in M08, now with `sha256` on each item |
| `/plan/scene-plans/:sceneId` | The scene plan: `{ scene_id, sha256, fields, characters, body }`; `404` when the repository has no such scene plan (a scene with no plan file is the app's empty answer with `sha256: null`) |
| `/plan/check` | `{ findings: [{ rule, severity, title, message, subject, related }] }`: the continuity findings whose rule starts with `PL` (PL1 to PL6), as the Plan tab's plan check shows them |
| `/plan/templates` | `{ templates }`: the structure templates and their beats |

## 3. sha256 rules

- A plan read keeps `sha256`. Pass it back as `base_sha256` on the write. A write to an existing file needs it; a write that creates a file does not. A stale value is `409` and writes nothing.
- The story plan has one file per book: its sha256 is `story.sha256` on `GET /plan` (and `sha256` on the app's own story-plan read). With no story plan file, send `base_sha256: null` (or none) to create it.
- A scene plan's sha256 comes from `GET /plan/scene-plans/:sceneId`. A scene with no plan has `sha256: null`; send none to create it.
- `path`, `file`, `rel` and `base_sha256` keys never appear in a v1 plan read. Line breaks in text are `\n`.

## 4. Gates

- **Integrations** module off for the book: every v1 route, plan reads and writes included, is `403 MODULE_OFF`.
- **Story Planner** (`planner`) module off for the book: every `/plan` route, read or write, is `403 MODULE_OFF` (`module: "planner"`) and nothing is written.
- The `GET /plan/check` and `/plan/templates` answers are built from the same repository data as the app; they write nothing.

## 5. Audit and Undo

- Shared mode audits each call as `plugin.<route>` (`apps/server/src/api-v1.mjs`, `v1RouteOf`). A plan write is `plugin.plan-<kind>-write`, where `<kind>` is the segment after `/plan`: `plan-story-write`, `plan-scene-plans-write`, `plan-links-write`, `plan-arcs-write`, `plan-structures-write`, `plan-relationships-write`, `plan-clues-write`, `plan-synopses-write`. Sub-paths (milestones, beats, developments, knowers, archive, restore) share their collection's name. A plan read is `plugin.plan` (the overview) or `plugin.plan-<kind>` (`plan-links`, `plan-check`, `plan-templates`, `plan-scene-plans`, ...). The audit target of a write is `<book slug>/plan/<path after /plan>`.
- Every write goes through the op journal like a write from the Plan tab. The answer carries `opId`. The author undoes it in the app (`POST /api/books/:b/ops/:opId/restore`, a route a token cannot reach). The MCP plan tools say so in their reply.

## 6. MCP tools

`packages/mcp/src/tools.mjs`. Each plan write tool posts to the v1 route in §2 and returns the answer with the note "This changed the planning file directly (planning material, not prose); the author can Undo it in StoryForge." Every plan write tool is annotated non-destructive and not read-only. A token without `plan` does not see them in `tools/list`; calling one anyway is refused naming the permission.

Read tools (permission `read`; with the `planner` module on):

| Tool | |
|---|---|
| `codex_get_scene_plan` | One scene plan (`scene`: a scene id) with its sha256. |
| `codex_get_plan_check` | The plan check: PL1 to PL6 findings with `related` ids. |
| `codex_list_structure_templates` | The structure templates and their beats. |

Plan write tools (permission `plan`; 30):

| Tool | |
|---|---|
| `codex_save_story_plan` | Set some story plan fields and/or the notes (`fields`, `notes`, `base_sha256`). |
| `codex_save_scene_plan` | Set some planning fields and/or the characters of one scene (`scene`, `fields`, `characters`, `base_sha256`). |
| `codex_create_link`, `codex_update_link`, `codex_archive_link`, `codex_restore_link` | Causal links between scenes or beats, with an optional what-if `branch`. |
| `codex_create_structure`, `codex_update_structure`, `codex_set_beats`, `codex_archive_structure`, `codex_restore_structure` | Structures; `codex_set_beats` writes the whole beat list, including each beat's scenes. |
| `codex_create_arc`, `codex_update_arc`, `codex_set_arc_milestones`, `codex_archive_arc`, `codex_restore_arc` | Character arcs; milestones are the whole ordered list. |
| `codex_create_relationship`, `codex_update_relationship`, `codex_set_relationship_developments`, `codex_archive_relationship`, `codex_restore_relationship` | Relationships between two entries; developments are the whole ordered list. |
| `codex_create_clue`, `codex_update_clue`, `codex_set_clue_knowers`, `codex_archive_clue`, `codex_restore_clue` | Clues; knowers are the whole list. |
| `codex_create_synopsis`, `codex_update_synopsis`, `codex_archive_synopsis`, `codex_restore_synopsis` | Synopses. |

`base_sha256` is required on every update and set tool and optional on the story plan, scene plan, archive and restore tools. A tool's `notes` argument is sent as the route's `body`.

Canvas tool added (permission `canvas`):

- `codex_add_plan_cards` (`canvas`, `refs`: 1 to 100 ids). Reads the canvas, skips every ref that already has a story card, and places a story card (a `file` node with `storyforge.ref`) for each of the rest in a grid of 4 columns below the existing nodes. It saves with the sha256 it read, so a concurrent change is a conflict. With nothing new to add it changes nothing and says so. It places cards only; it never changes the plan.

The description of `codex_get_canvas` and the canvas tools now name the planner item kinds a story card can link to, and that a beat column is a group node with `storyforge.kind` "column" and `storyforge.ref` a beat id.

## 7. Not offered

- A scene plan's notes body: `codex_save_scene_plan` sends `fields`, `characters` and `base_sha256` only.
- `dryRun`: no MCP plan tool sends it.
- Planner writes with `canvas` or `propose`, and any write to prose, scenes or Codex entries.
- Reading a path, file name or `base_sha256` key in a plan read.

## 8. Checks that exist

- `apps/server/test/plugin-plan.test.mjs`: a read-only token is refused every plan write; reads carry sha256 and no path; create, update, stale 409, archive and restore for each collection; the story sha256 on the overview; the plan check; path safety; planner and integrations modules off; the audit route names.
- `packages/mcp/test/plan-tools.test.mjs`: the 30 plan tools are listed only with `plan`, their annotations, the request each makes, and `codex_add_plan_cards`.
