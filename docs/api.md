# StoryForge API v1

A small, versioned HTTP API for programs you run yourself: a plugin that reads a book, a script that proposes edits, a receiver that listens for webhooks. It is
served by the same StoryForge process as the app, under `/api/v1`.

The principle: **StoryForge never runs plugin code, and no token can change prose you wrote or accepted.** A plugin reads what you let it read, and it can *propose* a change. The exceptions are planning material and AI drafts: a token with `canvas` can change canvases (`planning/canvases/*.canvas`), with `plan` the Story Planner files, with `workspace` the workspace docs, ledgers, a scene's cast, state events, tasks and the writing log, and with `draft` it can add new chapters and scenes marked as AI drafts. It cannot change a scene you wrote or accepted, or a Codex entry. The book's [AI level](#ai-level) caps all of them.
A proposal is a suggestion; nothing in your book changes until you accept it in the normal review (and accepting writes receipts, as for any suggestion).

The other `/api/*` routes are the app's own and are not part of this API. A token cannot reach them.

## Access tokens

You grant access in **Settings, then Plugins**: choose a plugin (or name one), tick the permissions and books, confirm. StoryForge shows the token once. Only its
SHA-256 is stored (personal mode: `plugin-tokens.json` in your user config folder; shared mode: in the shared-data folder, and only the owner can grant). You can
revoke a token at any time; a revoked token stops working at once.

Send it on every request:

```http
Authorization: Bearer <token>
```

Permissions (a token has one or more):

| Permission | Gives |
|---|---|
| `read` | The read routes below, for the granted books only. |
| `propose` | `POST /api/v1/books/:book/proposals`. |
| `canvas` | Create, save, archive and restore canvases (`/api/v1/books/:book/canvases`, below). Reading canvases needs only `read`. |
| `plan` | Create, change, archive and restore Story Planner items (`POST /api/v1/books/:book/plan/...`, below). Reading the plan needs only `read`. Each change can be undone by the author in the app. |
| `workspace` | Write workspace docs, ledger threads, a scene's cast, knowledge, state events, tasks, the AI writing log, and dismiss or restore continuity findings (below). Reading them needs only `read`. Each change can be undone by the author in the app. |
| `draft` | Create chapters and scenes (always AI drafts) and replace the body of such a draft the author has not accepted (below). |
| `events` | Its own webhook subscriptions (`/api/v1/webhooks`). |

Rules:

- A request with an `Authorization` header is a plugin request. It is decided only by its token: **cookies are never read**, a session cookie adds nothing to a
  plugin call, and a token placed in a cookie is never accepted. `/api/v1` without a bearer token is `401`.
- Personal mode answers loopback clients only. Shared mode checks the `Host` like every request. The browser write header and the `Origin` check do not apply to a
  bearer request, because it carries no ambient authority.
- A token reaches `/api/v1` only. Every other route, every write to a book, admin, AI, export, backup and receipts answer `403 PLUGIN_SCOPE`.
- Shared mode audits every plugin call (`plugin.<route>`, token id, status). A plugin token is not a member and has no role.
- <a id="ai-level"></a>**AI level.** Every book has an AI level, `off`, `advisor`, `planner` or `cowriter` (default `planner`), set by the author in Settings, **AI level**. It caps what any token may do in that book, whatever the token was granted: a write above the level is `403 AI_LEVEL` with `level` (the book's) and `needs` (the lowest level the route needs), and nothing is written. Reads need no level. `advisor` reaches `POST proposals` and `POST tasks`; `planner` reaches the `plan`, `canvas` and `workspace` writes; `cowriter` reaches the `draft` writes. A token cannot change the level. See [contracts/M12-ai-workspace.md](contracts/M12-ai-workspace.md).
- Turning the **Integrations** module off (Settings, Modules, or `modules: { integrations: false }` in `library.md` / `book.md`) stops all API v1 access and webhook
  delivery: every call is `403 MODULE_OFF`.

Books are named by slug in the path (the book's id works too). A book outside the grant is `403 PLUGIN_SCOPE`, whether or not it exists.

## Errors

Every error is JSON: `{ "error": "<kind>", "code": "<CODE>", "message": "<words>" }`.

| Status | Meaning |
|---|---|
| `400` | The request is malformed (`BAD_ARGS`). |
| `401` | No valid token: missing, malformed, unknown or revoked (`TOKEN`). |
| `403` | `PLUGIN_SCOPE` (not this route, permission or book), `MODULE_OFF`, `AI_LEVEL` (the book's AI level is below what the route needs), `NOT_AI_DRAFT` (the scene is not an unaccepted AI draft) or `AUTHOR_ONLY` (unlocking a doc). |
| `404` | No such scene, entry, canvas or webhook. |
| `409` | The proposal changes nothing (`NO_CHANGE`) or the file moved on (`CONFLICT` for a canvas, plan, workspace doc, cast or draft write, `REFUSED_PATH_TAKEN` for a taken canvas or doc name), or a workspace doc is locked (`LOCKED`). |
| `413` / `415` | The body is too large (5 MB) / is not `application/json`. |
| `503` | The token file cannot be read (it is never replaced; fix or move it). |

## Read routes (permission `read`)

All answers are JSON. Line breaks in text are `\n`. A `sha256` is the hash of the file's bytes.

| Route | Answer |
|---|---|
| `GET /api/v1` | `{ api: 1, server: "<version>" }` |
| `GET /api/v1/books` | `{ books: [{ id, slug, title, status, series, series_number, language, scenes, words, ai_level }] }`, granted books only; `ai_level` is the book's AI level |
| `GET /api/v1/books/:b` | The book with `acts: [{ act, label, chapters: [{ chapter, label, title, scenes: [{ id, title, order, act, chapter, sequence, status, pov, words, path }] }] }]` |
| `GET /api/v1/books/:b/scenes/:id` | One scene: the scene fields above plus `sha256`, `front_matter` (the parsed YAML) and `body` |
| `GET /api/v1/books/:b/entries` | `{ entries: [{ id, slug, type, name, status, role, aliases, archived, path }] }` |
| `GET /api/v1/books/:b/entries/:id` | `{ id, slug, type, name, status, path, sha256, fields, body }` |
| `GET /api/v1/books/:b/threads` | `{ threads: [{ id, slug, title, kind, status, setup, develop, payoff, characters, path }] }` |
| `GET /api/v1/books/:b/events` | `{ events: [{ id, slug, title, order, when, date, scenes: [id], characters, locations, path }] }` |
| `GET /api/v1/books/:b/search?q=&limit=` | `{ query, hits: [{ id, kind, title, path, snippet }] }` (`q` 1 to 200 characters, `limit` 1 to 100, default 20) |
| `GET /api/v1/books/:b/graph` | `{ nodes: [{ id, kind, type, name }], edges: [{ from, to, kind, rel }] }` |
| `GET /api/v1/books/:b/diagnostics` | `{ diagnostics: [{ code, severity, file, location, message }] }` |
| `GET /api/v1/books/:b/plan` | `{ story: { fields, body, sha256 }, counts, primary_structure }`: the story plan and the planner counts (see `plan-overview` below); `story.sha256` is `null` when there is no story plan file |
| `GET /api/v1/books/:b/plan/links` | `{ links: [Link], archived: [Link] }` |
| `GET /api/v1/books/:b/plan/arcs` | `{ arcs: [Arc], archived: [Arc] }` |
| `GET /api/v1/books/:b/plan/structures` | `{ structures: [Structure], archived: [{ slug, name }] }` |
| `GET /api/v1/books/:b/plan/relationships` | `{ relationships: [Relationship], archived: [{ slug, name }] }` |
| `GET /api/v1/books/:b/plan/synopses` | `{ synopses: [Synopsis], archived: [Synopsis] }` |
| `GET /api/v1/books/:b/plan/clues` | `{ clues: [Clue], archived: [{ slug, fact }] }` |
| `GET /api/v1/books/:b/plan/scene-plans/:sceneId` | One scene plan: `{ scene_id, sha256, fields, characters, body }`; `404` when there is none to read |
| `GET /api/v1/books/:b/plan/check` | `{ findings: [{ rule, severity, title, message, subject, related }] }`: the plan check (rules `PL1` to `PL6` of the continuity answer) |
| `GET /api/v1/books/:b/plan/templates` | `{ templates }`: the structure templates with their beats |
| `GET /api/v1/books/:b/workspace/docs` | `{ docs: [{ path, title, workspace, chapter, locked, sha256, updated_at }], archived: [...] }`. With `?path=<address>`: one doc, `{ path, title, workspace, chapter, locked, sha256, body }` (`404` if none). `403 MODULE_OFF` when the `workspace` module is off |
| `GET /api/v1/books/:b/ledger` | `{ promises, questions, clues, counts }`: threads of kind `promise` or `question` (with `open`, `setup`, `develop`, `payoff` scene ids and their chapters, `sha256`) and the planner clues |
| `GET /api/v1/books/:b/cast` | `{ cast: [{ scene, title, chapter, cast: [{ entry, id, slug, name, role }] }] }`; `?chapter=N` keeps one chapter |
| `GET /api/v1/books/:b/knowledge?character=&at=` | `{ character, at, facts: [{ fact, text, how, chapter, event, event_id }] }`; `character` is an entry id or slug and is required; `at` is a chapter number |
| `GET /api/v1/books/:b/state-events` | `{ events: [{ event, event_id, chapter, subject, kind, value? }] }`; `?chapter=N` keeps one chapter |
| `GET /api/v1/books/:b/tasks` | `{ tasks, counts }`; `?status=open\|doing\|done\|dropped` and `?for=ai\|author` filter |
| `GET /api/v1/books/:b/continuity` | `{ findings, suppressed, stale_exceptions, settings }`; `?chapter=N` keeps the findings that touch that chapter, `&cast=<entry>:<role>,...` also checks a planned cast (see [Continuity review](#continuity-review-the-apps-own-not-api-v1)). `403 MODULE_OFF` when `continuity` is off |
| `GET /api/v1/books/:b/context?chapter=N&budget=C` | The chapter context pack: `{ chapter, budget, chars, workspace, story, scene_plans, cast, knowledge, open_ledger, state_events, state_docs, previous_tail, continuity, truncated }`. `chapter` is required; `budget` is 500 to 200000 characters (default 24000) |

The `plan` routes return the same objects as the app's own planner reads ([Story Planner routes](#story-planner-routes-the-apps-own-not-api-v1)), with every `path`, `file`, `rel` and `base_sha256` key left out. A `sha256` is kept: it is the value to send back as `base_sha256` in a plan write. They need the `read` permission and a granted book, and answer `403 MODULE_OFF` when the `planner` module is off for the book. The app's own `/api/books/:b/` planner routes stay `403 PLUGIN_SCOPE` for a token.

## Plan writes (permission `plan`)

A token with `plan` can write Story Planner files under `planning/` (links, scene plans, `story.md`, structures, arcs, relationships, clues, synopses) and nothing else. Each route runs the app's own planner route with the same body, validation, sha check and Undo, so the body and the answer are as in [Story Planner routes](#story-planner-routes-the-apps-own-not-api-v1), "Writes". All are `POST` with a JSON object. The `planner` and `integrations` modules must be on for the book (else `403 MODULE_OFF`).

| Route | Runs |
|---|---|
| `POST /api/v1/books/:b/plan/story` | `POST /api/books/:b/story-plan` |
| `POST /api/v1/books/:b/plan/scene-plans/:sceneId` | `POST /api/books/:b/scene-plans/:sceneId` |
| `POST /api/v1/books/:b/plan/{links,arcs,structures,relationships,clues,synopses}` | the create route of that collection |
| `POST /api/v1/books/:b/plan/<collection>/:slug` | its update route |
| `POST /api/v1/books/:b/plan/<collection>/:slug/{archive,restore}` | its archive and restore routes |
| `POST /api/v1/books/:b/plan/arcs/:slug/milestones` | set milestones |
| `POST /api/v1/books/:b/plan/structures/:slug/beats` | set beats |
| `POST /api/v1/books/:b/plan/relationships/:slug/developments` | set developments |
| `POST /api/v1/books/:b/plan/clues/:slug/knowers` | set knowers |

A slug is lower-case letters, digits and hyphens (up to 120); anything else is `403 PLUGIN_SCOPE`, not a route. Pass `base_sha256` from the read; a stale one is `409` with `current: { sha256, text }` and nothing is written. A real write answers with `opId`, which the author can undo in the app. A shared server audits a plan write as `plugin.plan-<kind>-write` (for example `plugin.plan-links-write`). See [contracts/M11-ai-plan-tools.md](contracts/M11-ai-plan-tools.md).

## Workspace writes (permission `workspace`)

A token with `workspace` can write workspace docs (`planning/workspace/`, `planning/state/chapter-NN/`, `planning/development/`), ledger threads, a scene's `cast` key, state items of a chapter's state event, tasks, the AI words of the writing log, and continuity exceptions. Never prose, scene text or Codex entries. Each route runs the app's own route with the same body, validation, sha check and Undo; all are `POST` with a JSON object, and a real write answers with `opId`. The book's AI level must be `planner` (`advisor` for creating a task), else `403 AI_LEVEL`. The `workspace` module must be on for the routes marked **workspace**; `threads`, `tasks` and `continuity` for the others as marked, else `403 MODULE_OFF`.

| Route | Body | Runs |
|---|---|---|
| `POST /api/v1/books/:b/workspace/docs` | `{ path, body, title?, base_sha256? }` | create a doc, or replace an existing one's body (**workspace**) |
| `POST /api/v1/books/:b/workspace/docs/append` | `{ path, text }` | append (creates the doc) |
| `POST /api/v1/books/:b/workspace/docs/lock` | `{ path }` or `{ prefix }`, `locked: true` | lock one doc, or every state doc of `state/chapter-NN`; `locked: false` is `403 AUTHOR_ONLY` |
| `POST /api/v1/books/:b/workspace/docs/archive`, `.../restore` | `{ path, base_sha256? }` | move to or from `archive/planning/` |
| `POST /api/v1/books/:b/workspace/setup` | `{}` | create the starter docs that do not exist; answers `{ created, existing }` |
| `POST /api/v1/books/:b/ledger/threads` | `{ title, kind: "promise" \| "question", status? }` | create a thread (**threads**) |
| `POST /api/v1/books/:b/ledger/threads/:slug` | `{ status?, setup?, develop?, payoff?, characters?, base_sha256? }` | change a thread (**threads**) |
| `POST /api/v1/books/:b/scenes/:sceneId/cast` | `{ cast: [{ entry, role }], base_sha256? }` | set the whole cast of a scene; `role` is `pov`, `appears` or `mentioned`, at most one `pov` (**workspace**) |
| `POST /api/v1/books/:b/knowledge` | `{ character, fact, chapter }` | a character learns a fact in a chapter (**workspace**) |
| `POST /api/v1/books/:b/state-events` | `{ chapter, items: [{ subject, kind, value? }] }` | `kind`: `died`, `revived`, `destroyed`, `lost`, `found`, `holder`, `location` (**workspace**) |
| `POST /api/v1/books/:b/tasks` | `{ title, notes?, labels?, for? }` | create a task (**tasks**); level `advisor` |
| `POST /api/v1/books/:b/tasks/:id/status` | `{ status, for? }` | set the status and/or `for` (**tasks**) |
| `POST /api/v1/books/:b/activity/ai-words` | `{ words, chapter?, note? }` | add AI words to today's row of the writing log (**workspace**) |
| `POST /api/v1/books/:b/continuity/exceptions` | `{ fingerprint, reason }` | dismiss a finding; `reason` is required (**continuity**) |
| `POST /api/v1/books/:b/continuity/exceptions/:slug/archive` | `{}` | restore a dismissed finding (**continuity**) |

A doc `path` is `workspace/<name>`, `state/chapter-NN/(situation|characters|knowledge|inventory)` or `development/<name>`. Changing an existing doc needs `base_sha256` (the `sha256` you read); a stale or missing one is `409 CONFLICT` with `current: { sha256, body }`. A locked doc is `409 LOCKED`. A cast, knowledge or state-event write needs the chapter or scene to exist in the book. The author's continuity settings have no v1 route. See [contracts/M12-ai-workspace.md](contracts/M12-ai-workspace.md).

## Draft writes (permission `draft`)

A token with `draft` can add chapters and scenes to a book at AI level `cowriter`. A scene it creates is always an AI draft (`origin: ai`, `status: drafting`), whatever the body says, and its words are added to the AI words of the writing log.

| Route | Body | Answer |
|---|---|---|
| `POST /api/v1/books/:b/chapters` | `{ title, after?, act? }`: after chapter `after`, or first in act `act` | `201`, with the new chapter, its act and its one empty placeholder scene |
| `POST /api/v1/books/:b/scenes` | `{ chapter, title, body, summary?, after? }`: `after` is a scene id, `null` for the start; omitted, the end of the chapter | `201 { id, path }` |
| `PUT /api/v1/books/:b/scenes/:sceneId/draft` | `{ body, base_sha256 }` | `200 { sha256, words }` |

`PUT .../draft` replaces the whole body of a scene only while it has `origin: ai` and `status: drafting`; any other scene is `403 NOT_AI_DRAFT`. The author accepts a draft by changing its status; after that a token can only propose an edit. A stale `base_sha256` is `409`. Undo does not remove a created chapter or scene: the author archives it (AI Activity shows **Archive**).

## Proposals (permission `propose`)

```http
POST /api/v1/books/:b/proposals
Content-Type: application/json

{ "target": "scene_01…", "text": "<the whole new body>", "rationale": "why" }
```

`target` is the id of a scene, entry, thread or event. Give exactly one of:

- `text`: the whole new body of the target (its front matter is kept as it is);
- `hunks`: `[{ "from": 120, "to": 125, "replacement": "boat" }, …]`, ranges of the body as `GET` returned it (counted in characters, a line break is one). Ranges must not overlap.

`rationale` is optional text (up to 20 000 characters). `base_sha256` is optional: give the `sha256` the target had when you read it, and the proposal is refused (`409 SCENE_CHANGED`) if the file has changed since, so your ranges are never applied to text you have not seen. Answer `201`:

```json
{ "suggestion": { "id": "note_01…", "path": "suggestions/2026/…md", "target": "scene_01…", "status": "pending",
                  "source": "plugin", "plugin": "word-frequency", "by": { "name": "Word frequency" },
                  "created": "2026-11-02T14:03:22Z", "rationale": "why",
                  "hunks": [{ "id": "h1", "line": 17, "lines": 1, "status": "pending" }] } }
```

The suggestion is an ordinary one (`source: plugin`, FORMAT §9.3). The author sees it in the review rail, accepts or declines each hunk, and an accepted hunk writes a
receipt that names the plugin. The target file is not touched by the proposal. `by.name` is the plugin's name from its manifest (else its slug). A proposal that equals
the current text is `409 NO_CHANGE`. The `suggestions` module must be on for the book.

## Canvases (permissions `read` and `canvas`)

A canvas is a JSON Canvas file, `planning/canvases/<slug>.canvas`. A canvas slug is lower-case letters, digits and hyphens (up to 60); anything else is `403 PLUGIN_SCOPE`, not a route. The **Board** or the **Story Planner** module must be on for the book (else `403 MODULE_OFF`, `module: "board"`). Writes go through the same store and sha check as the app and are never dry runs.

| Route | Permission | Answer |
|---|---|---|
| `GET /api/v1/books/:b/canvases` | `read` | `{ canvases: [{ slug, title, path, nodes, edges, sha256, updated_at, problem }], archived: [...] }` |
| `GET /api/v1/books/:b/canvases/:slug` | `read` | `{ slug, title, path, sha256, canvas, problem, refs, targets }`; `targets` are what a story card can link to: scenes, entries, threads, events, research notes, and the planner items (story plan, structures with their beats, arcs, relationships, synopses, clues) |
| `POST /api/v1/books/:b/canvases` | `canvas` | body `{ title (1 to 200 characters), slug? }`; `201 { slug, path, sha256 }` |
| `PUT /api/v1/books/:b/canvases/:slug` | `canvas` | body `{ canvas: { nodes, edges, storyforge? }, base_sha256 }`; `200 { slug, path, sha256 }` |
| `POST /api/v1/books/:b/canvases/:slug/archive` | `canvas` | optional body `{ base_sha256 }`; `200 { ok: true, slug, path }` |
| `POST /api/v1/books/:b/canvases/:slug/restore` | `canvas` | optional body `{ base_sha256 }`; `200 { ok: true, slug, path }` |

`base_sha256` (64 hex characters) is required to save: it is the `sha256` you read. Status codes: `409 { error: "conflict", code: "CONFLICT", current: { sha256, canvas } }` when the file changed since (read `current`, merge, save again); `409 REFUSED_PATH_TAKEN` when a create or restore would overwrite another canvas; `400 REFUSED_BAD_CANVAS` with a `message` when the canvas breaks the format rules (the file is not touched); `400 BAD_ARGS` for a malformed body; `404` for no such canvas; `403 PLUGIN_SCOPE` for a token without `canvas`.

## Story Planner routes (the app's own, not API v1)

These routes store causal links between scenes, per-scene planning fields, the book's story plan, character arcs, story structures with their beat sheets, relationships between Codex entries, synopses, and clues (see [format.md](format.md), "Story Planner files"). They sit under `/api/books/:b/`, are **not part of plugin API v1**, and a bearer token is refused on these paths (`403 PLUGIN_SCOPE`). They are for the StoryForge app itself; a plugin token with the `plan` permission reaches the same writes through `/api/v1/books/:b/plan/...` ([Plan writes](#plan-writes-permission-plan)).

A link, an arc, a structure, a relationship, a synopsis or a clue is named by its `slug`. A scene plan is named by its scene's id. The story plan is one file per book and has no name in the route. Reads are not gated by a module.

### Reads

| Route | Answer |
|---|---|
| `GET /api/books/:b/links` | `{ links: [Link], archived: [Link] }` |
| `GET /api/books/:b/links/:slug` | `Link` plus `archived` (true when only the archived file exists); `404` if neither exists |
| `GET /api/books/:b/scene-plans/:sceneId` | `{ scene_id, path, sha256, fields, characters, body }`; `404` for an unknown book or a scene that is not live |
| `GET /api/books/:b/flow` | `{ nodes, edges }`, below |
| `GET /api/books/:b/story-plan` | `{ path, sha256, fields, body }`; `404` for an unknown book |
| `GET /api/books/:b/plan-overview` | `{ story, counts, unlinked }`; `404` for an unknown book |
| `GET /api/books/:b/arcs` | `{ arcs: [Arc], archived: [Arc] }` |
| `GET /api/books/:b/arcs/:slug` | `Arc` plus `archived` (true when only the archived file exists); `404` if neither exists |
| `GET /api/books/:b/structure-templates` | `{ templates: [Template] }` |
| `GET /api/books/:b/structures` | `{ structures: [Structure], archived: [{ slug, name }] }`; `404` for an unknown book |
| `GET /api/books/:b/structures/:slug` | `Structure` plus `archived` (true when only the archived file exists); `404` if neither exists |
| `GET /api/books/:b/relationships` | `{ relationships: [Relationship], archived: [{ slug, name }] }`; `404` for an unknown book |
| `GET /api/books/:b/relationships/:slug` | `Relationship` plus `archived` (true when only the archived file exists); `404` if neither exists |
| `GET /api/books/:b/synopses` | `{ synopses: [Synopsis], archived: [Synopsis] }`; `404` for an unknown book |
| `GET /api/books/:b/synopses/:slug` | `Synopsis` plus `body` and `archived` (true when only the archived file exists); `404` if neither exists |
| `GET /api/books/:b/synopses/:slug/extract` | `{ text, basis, skipped }`, below; `404` for an unknown book or synopsis. Offline; writes nothing |
| `GET /api/books/:b/plan-badges` | `{ scenes, arcs, structures }`, below; `404` for an unknown book |
| `GET /api/books/:b/clues` | `{ clues: [Clue], archived: [{ slug, fact }] }`; `404` for an unknown book |
| `GET /api/books/:b/clues/:slug` | `Clue` plus `archived` (true when only the archived file exists); `404` if neither exists |
| `GET /api/books/:b/series-plan` | `{ series, books, characters, hidden }`, below; `404` for an unknown book. Offline; writes nothing |
| `GET /api/books/:b/export/planning` | A zip of Markdown files, below. Not a share-link read |

`Link` is `{ id, slug, path, from, to, relation, rationale, branch, created, sha256, from_title, to_title, from_kind, to_kind, problems: [{ code, message }] }`. `rationale` is the body. `branch` is the what-if branch slug, or `null` for a link of the main plan. `from_title` and `to_title` are `null` when the end does not resolve; for a beat the title is `<structure name>: <beat name>`. `from_kind` and `to_kind` are `scene` or `beat` (an end that does not resolve is `scene`). `problems` are the diagnostics on that file.

A scene plan's `fields` has all ten keys (`goal`, `opposition`, `conflict`, `turn`, `outcome`, `consequence`, `stakes`, `emotional_start`, `emotional_end`, `purpose`), each a string or `null`. A scene with no plan answers `path: null`, `sha256: null`, all fields `null`, `characters: []`, `body: ""`.

`flow`: the answer is `{ nodes, edges, branches }`. `nodes` are the live scenes in reading order, `{ id, kind: "scene", title, summary, status, pov, act, chapter, sequence, plan }` (`plan` is true when the scene has a plan). `edges` are the live links, `{ id, slug, from, to, relation, branch, rationale, sha256, broken }`; `broken` is true when an end is neither a live scene nor a beat of a live structure. After the scenes, `nodes` also has one beat node, `{ id, kind: "beat", title, structure: { slug, name }, chapter: null, sequence: null }`, for each beat of a live structure that is an end of a live link. `title` is the beat's name. `branches` is the sorted list of the distinct non-null `branch` values of the live links.

A story plan's `fields` has all eight keys (`premise`, `logline`, `theme_question`, `central_conflict`, `protagonist_goal`, `stakes`, `protagonist`, `primary_structure`), each a string or `null`. A book with no story plan answers `path: null`, `sha256: null`, all fields `null`, `body: ""`. Only a live file at `planning/story.md` counts.

`plan-overview`: the answer is `{ story, counts, primary_structure, unlinked }`. `story` is the same object as `story-plan`. `counts` is `{ scenes, planned_scenes, links, linked_scenes, unlinked_scenes, broken_links, archived_links, threads, arcs, structures, relationships }`: `scenes` is the number of flow nodes, `planned_scenes` those with a plan, `links` the live links, `linked_scenes` the scenes at an end of a live link, `unlinked_scenes` the rest, `broken_links` the live links with an end that is neither a live scene nor a beat of a live structure, `archived_links` the archived links, `threads` the live plot threads, `arcs` the live arcs, `structures` the live structures, `relationships` the live relationships. `primary_structure` is `{ id, slug, name }` of the live structure the story plan names, or `null`. `unlinked` is `[{ id, title }]`: the scenes at no end of a live link, in reading order, at most 50.

`Arc` is `{ id, slug, path, sha256, character, character_id, arc_type, fields, milestones, body, problems: [{ code, message }] }`. `character` is `{ id, slug, name, shared }` (`shared` is true for an entry of the series' shared world), or `null` when the id names no entry; `character_id` is the id as written in the file. `arc_type` is a string or `null`. `fields` has all seven keys (`want`, `need`, `false_belief`, `fear`, `wound`, `start_state`, `end_state`), each a string or `null`. `milestones` is `[{ index, scene, scene_title, chapter, sequence, pressure, choice, belief_before, belief_after, cost }]` in file order; `scene_title`, `chapter` and `sequence` are `null` when the scene is not live, and an empty text is `null`. `body` is the free notes. `arcs` is sorted by character name (arcs whose character is unresolved last), then slug.

`Template` is `{ id, version, name, description, beats: [{ name, purpose, question, position? }] }`. The eight ids are listed in [format.md](format.md). The answer is the same for every book.

`Structure` is `{ id, slug, name, template, template_version, primary, sha256, body, beats, counts }`. `primary` is true when the story plan's `primary_structure` is this structure's id. `beats` is `[{ id, name, purpose, question, position, state, scenes: [{ id, title, chapter, sequence }] }]` in file order; `state` is `open`, `done` or `omitted` (a beat with no state is `open`); an empty text is `null`; `title`, `chapter` and `sequence` are `null` when the scene is not live. `counts` is `{ beats, assigned, omitted }`: all beats, beats with at least one scene, and beats that are omitted. `structures` is sorted with the primary one first, then by name, then slug.

`Relationship` is `{ id, slug, path, name, a, b, baseline, end_state, sha256, body, developments, problems: [{ code, message }] }`. `a` and `b` are `{ id, slug, name, type }`, one per entry; an entry can be of any type, in the book or its series. When the id names no entry, `slug`, `name` and `type` are `null` and the `id` stays. `name` is `<A name> & <B name>`. `baseline` and `end_state` are a string or `null`. `body` is the free notes. `developments` is `[{ scene, scene_title, chapter, sequence, change, a_view, b_view }]` in file order; `scene_title`, `chapter` and `sequence` are `null` when the scene is not live, and an empty text is `null`. `relationships` is sorted by name, then slug.

`Synopsis` is `{ id, slug, path, type, name, target_words, words, basis, stale, sha256 }`. `name` is the type's label when the file has none. `target_words` and `basis` are `null` when absent. `words` is the word count of the body. `stale` is true when the file has a `basis` and the text extracted today hashes differently; archived synopses are never stale. Both lists are sorted by type (`premise`, `logline`, `elevator-pitch`, `short`, `one-page`, `long`, `chapter-treatment`, `custom`), then name, then slug.

`extract`: `text` is built from structured records only (the story plan, scene summaries, the primary structure's beats), never from prose, for the type of the synopsis (live or archived). `basis` is the sha256 (hex) of `text` as UTF-8. `skipped` counts the scenes without a summary that the type would have used. The rules, per type:
- `premise`: the story plan's `premise`, a space, then `central_conflict`. `logline`: the `logline`. `elevator-pitch`: `logline`, `protagonist_goal`, `central_conflict` and `stakes`, in that order, each ended with a full stop when it has no `.`, `!`, `?` or `…`, joined by spaces. Empty fields are left out.
- `short`: one paragraph per beat of the primary structure, `**<beat name>.** ` and the summaries of the beat's live scenes joined by a space; a beat with no summarised scene is left out. With no primary structure it is built as `one-page`.
- `one-page`: one paragraph per act, the scene summaries joined by a space, in reading order. `long` and `custom`: one paragraph per chapter.
- `chapter-treatment`: `## Chapter <n>` per chapter (`## No chapter` for scenes with none), then `**<title>.** <summary>` as a paragraph for each scene with a summary.
- Paragraphs are separated by one blank line and the text ends with one line break; `text` is `""` when there is nothing to use.

`plan-badges`: the planner data of every live scene in one read, for the Board, Outline and Matrix. The answer is `{ scenes, arcs, structures }`.
- `scenes` is an object keyed by scene id, with one entry for every live scene: `{ plan, goal, purpose, links_in, links_out, beats, milestones, relationships }`. `plan` is true when the scene has a live plan. `goal` and `purpose` come from that plan and are `null` when there is none. `links_in` and `links_out` count the live links that end or start at the scene and whose other end also resolves (a live scene or a beat of a live structure). `beats` is `[{ structure_slug, structure_name, primary, beat_id, beat_name }]`, one per beat of a live structure that holds the scene. `milestones` is `[{ arc_slug, name }]`, one per arc milestone set in the scene (`name` is the character's name, else the arc's slug). `relationships` is `[{ slug, name, change }]`, one per development set in the scene.
- `arcs` is `[{ slug, name }]`: the live arcs, sorted as in `GET /arcs`.
- `structures` is `[{ slug, name, primary, beats: [{ id, name, state, scenes: [sceneId] }] }]`: the live structures, primary first. `scenes` lists the beat's live scenes.

`Clue` is `{ id, slug, path, fact, kind, planted, revealed, red_herring, knowers, sha256, body, problems: [{ code, message }] }`. `kind` is `clue`, `reveal` or `secret` (`clue` when the file has none). `planted` is `[{ id, title, position }]` in file order and `revealed` is one `{ id, title, position }` or `null`; `position` is the scene's 1-based number in reading order, and `title` and `position` are `null` when the scene is not live. `red_herring` is a boolean (`false` when absent). `knowers` is `[{ who, scene, how, reliable }]` in file order: `who` is `{ id: "reader", name: null, reader: true }` for the reader, else `{ id, name, reader: false, shared }` (`name` is `null` when the id names no entry; `shared` is true for an entry of the series' shared world); `scene` is `{ id, title, position }`; `how` is a string or `null`; `reliable` is `false` only when the file says so. `body` is the free notes. `clues` is sorted by fact, then slug.

`series-plan`: for a book that is in no series the answer is `{ series: null }`. Otherwise it is `{ series: { slug, title }, books, characters, hidden }`.
- `books` has every book of the series, in `series_number` order (then title): `{ id, slug, title, series_number, logline, premise, synopsis, arcs }`. `logline` and `premise` come from the book's story plan (`null` when empty). `synopsis` is `{ type, name, body }` for the first live synopsis of type `one-page` (by name, then slug), else of type `short`, else `null`. `arcs` is `[{ character: { id, name, shared: true }, start, end, milestones }]`: the book's live arcs whose character is a series-shared entry, sorted by character name; `start` and `end` are the arc's `start_state` and `end_state` (or `null`), `milestones` is how many it has.
- `characters` is `[{ id, name, books: [{ id, title, arc_slug }] }]`: each series-shared entry that has an arc in at least one book, sorted by name, with the books in book order.
- `hidden` is the number of books left out because the requester may not read them: `0` unless a member of a shared server has access to only some books of the series. A member then sees only their own books in `books` and in each character's `books` (a character left with no book is dropped).

`export/planning`: a zip named `<book-slug>-planning.zip`, with every file inside a folder `<book-slug>-planning/`, built from the planner reads and written nowhere. It is separate from `export` (Markdown, DOCX, EPUB and PDF), which never includes planning. The policy class is `read`, not `export`, and a share link cannot use it. The files:
- `story-plan.md`: the story plan fields and notes.
- `outline.md`: the live scenes by act and chapter, each with its summary and plan fields.
- `characters.md`: the arcs with their milestones, then the relationships with their developments.
- `structure.md`: the beat sheet of the primary structure (`No primary structure.` when there is none).
- `synopses/<slug>.md`: one per live synopsis.
- `clues.md`: each live clue with its kind, where it is planted and revealed, whether it is a red herring and who learns it.
- `links.md`: the live links as `from → relation → to`, grouped as `Main plan` and one `Branch: <slug>` group per branch.

An empty section reads `Nothing planned yet.`

### Writes

All are `POST` with a JSON body. The module is `planner`: with it off, every write is `403 MODULE_OFF` (`module: "planner"`) and nothing is written. Every write accepts `"dryRun": true` and then returns `{ ok: true, dryRun: true, changes, … }` without writing. A real write answers with `opId` and `undo`. `base_sha256` is the `sha256` you read; if the file has changed, the answer is `409 { error: "conflict", current: { sha256, text } }` (the file as it is now) and nothing is written.

| Route | Body | Answer |
|---|---|---|
| `POST /api/books/:b/links` | `{ from, to, relation, rationale?, branch? }` (scene ids or beat ids; `relation` as in [format.md](format.md)) | `201`, with `id`, `slug`, `path` |
| `POST /api/books/:b/links/:slug` | `{ base_sha256, relation?, from?, to?, rationale?, branch? }`, at least one of the five | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/links/:slug/archive` | optional `{ base_sha256 }` | `200`, with `slug`, `path` (now under `archive/`) |
| `POST /api/books/:b/links/:slug/restore` | optional `{ base_sha256 }` | `200`, with `slug`, `path` |
| `POST /api/books/:b/scene-plans/:sceneId` | `{ fields?, characters?, base_sha256? }` | `200`, with `id`, `scene_id`, `path`, `created` |
| `POST /api/books/:b/story-plan` | `{ fields?, body?, base_sha256? }` | `200`, with `id`, `path`, `created` |
| `POST /api/books/:b/arcs` | `{ character, arc_type?, fields? }` (`character` is an entry id) | `201`, with `id`, `slug`, `path` |
| `POST /api/books/:b/arcs/:slug` | `{ base_sha256, arc_type?, fields?, body? }`, at least one of the three | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/arcs/:slug/milestones` | `{ base_sha256, milestones }` | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/arcs/:slug/archive` | optional `{ base_sha256 }` | `200`, with `slug`, `path` (now under `archive/`) |
| `POST /api/books/:b/arcs/:slug/restore` | optional `{ base_sha256 }` | `200`, with `slug`, `path` |
| `POST /api/books/:b/structures` | `{ template, name }` | `201`, with `id`, `slug`, `path` |
| `POST /api/books/:b/structures/:slug` | `{ base_sha256, name?, body? }`, at least one of the two | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/structures/:slug/beats` | `{ base_sha256, beats }` | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/structures/:slug/archive` | optional `{ base_sha256 }` | `200`, with `slug`, `path` (now under `archive/`) |
| `POST /api/books/:b/structures/:slug/restore` | optional `{ base_sha256 }` | `200`, with `slug`, `path` |
| `POST /api/books/:b/relationships` | `{ a, b, fields? }` (`a` and `b` are entry ids) | `201`, with `id`, `slug`, `path` |
| `POST /api/books/:b/relationships/:slug` | `{ base_sha256, fields?, body? }`, at least one of the two | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/relationships/:slug/developments` | `{ base_sha256, developments }` | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/relationships/:slug/archive` | optional `{ base_sha256 }` | `200`, with `slug`, `path` (now under `archive/`) |
| `POST /api/books/:b/relationships/:slug/restore` | optional `{ base_sha256 }` | `200`, with `slug`, `path` |
| `POST /api/books/:b/synopses` | `{ type, name?, target_words?, body?, dryRun? }` | `201`, with `id`, `slug`, `path` |
| `POST /api/books/:b/synopses/:slug` | `{ base_sha256, name?, target_words?, body?, basis?, dryRun? }`, at least one of the four | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/synopses/:slug/archive` | optional `{ base_sha256 }` | `200`, with `slug`, `path` (now under `archive/`) |
| `POST /api/books/:b/synopses/:slug/restore` | optional `{ base_sha256 }` | `200`, with `slug`, `path` |
| `POST /api/books/:b/clues` | `{ fact, kind?, fields? }` | `201`, with `id`, `slug`, `path` |
| `POST /api/books/:b/clues/:slug` | `{ base_sha256, fields?, body? }`, at least one of the two | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/clues/:slug/knowers` | `{ base_sha256, knowers }` | `200`, with `id`, `slug`, `path` |
| `POST /api/books/:b/clues/:slug/archive` | optional `{ base_sha256 }` | `200`, with `slug`, `path` (now under `archive/`) |
| `POST /api/books/:b/clues/:slug/restore` | optional `{ base_sha256 }` | `200`, with `slug`, `path` |

- A dry run answers `200` where a real write would answer `201`.
- `rationale` is up to 20,000 characters. `branch` is a slug (`a-z`, `0-9`, single hyphens, at most 40 characters) that marks a what-if link; `null` or `""` on update removes it, and a link with no branch is part of the main plan. `branch` must be a string or `null` (else `400 BAD_ARGS`) and a bad slug is `REFUSED_BAD_ARGS`. The file name and slug of a link never change on update. The body is replaced only when `rationale` is sent.
- `fields` holds any of the ten planning keys. A string sets the key; `null` or `""` removes it. A value is one line, up to 2,000 characters, without control characters. `characters` is a list of up to 100 entry slugs; `[]` removes the key.
- A scene with no plan: send no `base_sha256` (or `null`); the file `planning/scene-plans/<scene-slug>.md` is created, and `created` is `true`. If every value is empty nothing is created (`REFUSED_BAD_ARGS`). A scene with a plan: `base_sha256` is required.
- `POST .../story-plan`: `fields` holds any of the seven story keys, with the same rules as a scene plan's (a string sets, `null` or `""` removes, one line, up to 2,000 characters). `protagonist` must be the slug of a live entry. `body` is up to 20,000 characters, may have several lines, and replaces the body only when sent. At least one of `fields` and `body` is needed.
- No `planning/story.md` yet: send no `base_sha256` (or `null`); the file is created, and `created` is `true`. If every value is empty nothing is created (`REFUSED_BAD_ARGS`). A story plan exists: `base_sha256` is required. If `planning/story.md` exists but is not a story plan, the write is `REFUSED_PATH_TAKEN`.
- Arcs: `character` must be the id of a live entry of type `character`, in the book or its series (another type is `REFUSED_BAD_ARGS`, an unknown id `REFUSED_UNKNOWN_ENTRY`). A book has one live arc per character. The file `planning/arcs/<character-slug>.md` is created (`-2`, `-3` … when a live or archived file has the name). The Codex entry is never written.
- Arcs: `arc_type` is `positive`, `negative`, `flat` or `custom`. `fields` holds any of the seven arc keys, with the same rules as a scene plan's (a string sets, `null` or `""` removes, one line, up to 2,000 characters). On update, `arc_type` set to `null` or `""` removes it, and `body` (up to 20,000 characters) replaces the notes only when sent. Update never changes the milestones, the file name or the slug.
- Arc milestones: `milestones` is the whole ordered list, up to 200 items, each `{ scene, pressure?, choice?, belief_before?, belief_after?, cost? }` (texts one line, up to 2,000 characters; an empty text is left out). `scene` must be a live scene (`REFUSED_UNKNOWN_SCENE`, `field: "milestones[i].scene"`). Every value in an item must be a string, else `400 BAD_ARGS`. `[]` removes the `milestones` block. If the block in the file has a comment, anchor or alias, the write is `400 REFUSED_UNSIMPLE_FIELD` (`field: "milestones"`) and nothing is written.
- Restoring an arc: `REFUSED_PATH_TAKEN` if a live file has that name, `REFUSED_DUPLICATE_ARC` if a live arc already has the same character.
- `POST .../story-plan` also accepts `primary_structure` in `fields`: a string up to 2,000 characters, with the same rules as the other keys. The value must be the id of a structure in the book: a value that names no structure would add `E301`, so the write is refused and nothing changes. Naming an archived structure is allowed and gives `W303`.
- Structures: `template` must be one of the eight template ids (else `REFUSED_BAD_ARGS`, `field: "template"`). `name` is one line of 1 to 200 characters. The file `planning/structures/<name-slug>.md` is created (`-2`, `-3` … when a live or archived file has the name), with the template's beats copied in, each with a new id, no scenes and no state. Any number of structures can use the same template. The template is never changed.
- Structure update: `name` replaces the name; `body` (up to 20,000 characters) replaces the notes only when sent. Update never changes the template, `template_version`, beats, file name or slug.
- Structure beats: `beats` is the whole ordered list, up to 200 items, each `{ id?, name, purpose?, question?, position?, state?, scenes? }`. `name` is required, one line, 1 to 200 characters. `purpose`, `question` and `position` are one line, up to 2,000 characters (an empty text is left out). `state` is `open`, `done` or `omitted`; `open` is written as no key. `scenes` is a list of up to 50 scene ids; repeats are dropped and the order is kept. Every value in an item must be a string or `null` (`scenes` a list of strings), else `400 BAD_ARGS`. A key other than those seven is `REFUSED_BAD_ARGS`. An `id` must be a `note_` id and not repeated in the list; a beat without an `id` gets a new one, so send the ids you read to keep a beat. Each scene must be a live scene (`REFUSED_UNKNOWN_SCENE`, `field: "beats[i].scenes[j]"`). Errors on an item carry its `index`. `[]` removes the `beats` block. If the block in the file has a comment, anchor or alias, the write is `400 REFUSED_UNSIMPLE_FIELD` (`field: "beats"`) and nothing is written.
- Link ends: `from` and `to` of a create or update are the id of a live scene or of a beat inside a live structure; anything else is `REFUSED_UNKNOWN_SCENE` (`field` is `from` or `to`). A beat id is the `id` of a beat in `GET /structures/:slug`.
- Structure beats: a save that removes a beat which is the `from` or `to` of a link is refused with `400 REFUSED_BEAT_LINKED` and nothing is written. The answer carries `message`, `links: [slug]` (live links) and `archived_links: [slug]` (archived links). Archived links count, because an archived link to a beat that is gone would be `E301`. Re-point the links first; an archived link has to be restored before it can be changed.
- Relationships: `a` and `b` must be the ids of live entries of any type, in the book or its series (an unknown id is `REFUSED_UNKNOWN_ENTRY`, `field` is `a` or `b`). The same entry twice is `REFUSED_BAD_ARGS`. A book has one live relationship per pair of entries, in either order. The file `planning/relationships/<a-slug>-and-<b-slug>.md` is created (`-2`, `-3` … when a live or archived file has the name). A new file has no developments. The Codex entries are never written.
- Relationships: `fields` holds `baseline` and `end_state`: a string sets, `null` or `""` removes on update, one line, up to 2,000 characters; any other key is `REFUSED_BAD_ARGS`. On update, `body` (up to 20,000 characters) replaces the notes only when sent. Update never changes `a`, `b`, the developments, the file name or the slug.
- Relationship developments: `developments` is the whole ordered list, up to 200 items, each `{ scene, change, a_view?, b_view? }`. `change` is required. The three texts are one line, up to 2,000 characters (an empty `a_view` or `b_view` is left out). `scene` must be a live scene (`REFUSED_UNKNOWN_SCENE`, `field: "developments[i].scene"`). A key other than those four is `REFUSED_BAD_ARGS`. Every value in an item must be a string or `null`, else `400 BAD_ARGS`. Errors on an item carry its `index`. `[]` removes the `developments` block. If the block in the file has a comment, anchor or alias, the write is `400 REFUSED_UNSIMPLE_FIELD` (`field: "developments"`) and nothing is written.
- Restoring a relationship: `REFUSED_PATH_TAKEN` if a live file has that name, `REFUSED_DUPLICATE_RELATIONSHIP` if a live relationship already has the same pair.
- Synopses: `type` is one of the eight types above (else `REFUSED_BAD_ARGS`, `field: "type"`). `name` is one line. `target_words` is a whole number of 1 or more. `body` is up to 200,000 characters without control characters. A bad value is `REFUSED_BAD_ARGS` with `field` (`type`, `name`, `target_words` or `body`; a non-string `type` or `name`, or a `target_words` that is not an integer, is `400 BAD_ARGS`). The file `planning/synopses/<slug>.md` is created, the slug taken from the name, else from the type's label (`-2`, `-3` … when a live or archived file has the name). More than one synopsis of a type is allowed. A synopsis always covers the whole book.
- Synopsis update: `base_sha256` is required. `name` set to `null` or `""` removes it, `target_words` set to `null` removes it, `basis` is 64 lowercase hex characters or `null` to remove it. `body` replaces the text only when sent; with only `basis` or `target_words` the body bytes are untouched. Update never changes the type, file name or slug. Nothing to change is `REFUSED_BAD_ARGS`.
- Synopsis `basis`: the sha256 of the extracted text the author last reviewed (the `basis` of an `extract` answer). Saving a reviewed proposal stores its `basis` with the new `body`; sending only a new `basis` ("Keep my text") marks the sources as reviewed without touching the text.
- Restoring a synopsis: `REFUSED_PATH_TAKEN` if a live file has that name.
- Clues: `fact` is required: one line of text without control characters, up to 2,000 characters. `kind` (also accepted inside `fields`) is `clue`, `reveal` or `secret`. `fields` holds `planted` (a list of up to 100 scene ids), `revealed` (a scene id) and `red_herring` (`true` or `false`); a key other than those and `kind` is `REFUSED_BAD_ARGS` (`field` names it), and a bad value is `REFUSED_BAD_ARGS` with `field`. Every scene must be a live scene (`REFUSED_UNKNOWN_SCENE`, `field: "planted[i]"` or `"revealed"`). The file `planning/clues/<fact-slug>.md` is created (the slug is cut to 56 characters; `-2`, `-3` … when a live or archived file has the name), with no body and no knowers. Any number of clues may share a fact.
- Clue update: `base_sha256` is required. `fields` may hold `fact` (cannot be removed), `kind`, `planted`, `revealed` and `red_herring`; a value sets the key and `null` removes it (`planted: []` removes it too). `body` (up to 20,000 characters) replaces the notes only when sent. Update never changes the knowers, the file name or the slug. Nothing to change is `REFUSED_BAD_ARGS`.
- Clue knowers: `knowers` is the whole ordered list, up to 200 items, each `{ who, scene, how?, reliable? }`. `who` is the word `reader` or the id of a live entry of any type, in the book or its series (`REFUSED_UNKNOWN_ENTRY`, `field: "knowers[i].who"`, with `index` and `entry`). `scene` must be a live scene (`REFUSED_UNKNOWN_SCENE`, `field: "knowers[i].scene"`, with `index`). `how` is one line (an empty one is left out); `reliable` is a boolean, and `false` marks misinformation the character believes. A key other than those four is `REFUSED_BAD_ARGS`. Values must be strings, booleans or `null`, else `400 BAD_ARGS`. `[]` removes the `knowers` block. If the block in the file has a comment, anchor or alias, the write is `400 REFUSED_UNSIMPLE_FIELD` (`field: "knowers"`) and nothing is written. Knowers are kept apart from a scene's `knows` and `learns` on the timeline, which no clue write touches.
- Restoring a clue: `REFUSED_PATH_TAKEN` if a live file has that name. A missing clue is `404` (`NOT_FOUND`).
- Restoring a structure: `REFUSED_PATH_TAKEN` if a live file has that name. Archiving or restoring never changes a scene or the story plan; a story plan that names an archived structure shows `W303`.
- Scene files, `book.md` and the story text are never read for writing or changed.
- Undo: `POST /api/books/:b/ops/:opId/restore`. Undo may remove a link, scene plan, story plan, arc, structure, relationship, synopsis or clue that the write created.

Errors:

| Status | Code | When |
|---|---|---|
| `400` | `BAD_ARGS` | The body is malformed (wrong type, a `body` that is not a string, missing `from` / `to` / `relation`, missing `base_sha256` on an update). |
| `400` | `REFUSED_BAD_ARGS` | A value is out of range (unknown `relation`, a bad `branch`, unknown planning key, over-long text or body, nothing to change, `base_sha256` where none is allowed or missing where required). |
| `400` | `REFUSED_UNKNOWN_SCENE` | A link's `from` or `to` is neither a live scene nor a beat of a live structure, or a milestone's, beat's, development's, clue's or knower's scene is not a live scene (`field` says which). |
| `400` | `REFUSED_UNKNOWN_ENTRY` | A `characters` slug, the story plan's `protagonist`, an arc's `character`, a relationship's `a` or `b`, or a clue knower's `who` (other than `reader`) is not an entry (`entry` names it). |
| `400` | `REFUSED_UNSIMPLE_FIELD` | An arc's, structure's, relationship's or clue's front matter cannot be read as plain YAML, or its `milestones`, `beats`, `developments` or `knowers` block has a comment, anchor or alias (`field` names the key). |
| `400` | `REFUSED_SELF_LINK` | `from` and `to` are the same scene or beat. |
| `400` | `REFUSED_BEAT_LINKED` | A beats save removes a beat that is the `from` or `to` of a link. The answer carries `links` and `archived_links` (slugs). |
| `404` | | No such book, link, arc, structure, relationship, synopsis, clue, or live scene. |
| `409` | `REFUSED_DUPLICATE_LINK` | A live link already has the same `from`, `to`, `relation` and `branch` (also on restore). The answer carries `existing: { slug }`. |
| `409` | `REFUSED_DUPLICATE_ARC` | A live arc already names the same `character` (also on restore). The answer carries `existing: { slug }`. |
| `409` | `REFUSED_DUPLICATE_RELATIONSHIP` | A live relationship already names the same pair of entries, in either order (also on restore). The answer carries `existing: { slug }`. |
| `409` | `REFUSED_PATH_TAKEN` | A restore would overwrite a live link, arc, structure, relationship, synopsis or clue file, or `planning/story.md` exists but is not a story plan. |
| `409` | `CONFLICT` | The file changed since `base_sha256`. |
| `403` | `MODULE_OFF` | The `planner` module is off. |

A write that would add a validation error to the book is refused and nothing is written.

## AI workspace routes (the app's own, not API v1)

The routes behind the plugin routes above, plus the ones only the author reaches. They sit under `/api/books/:b/`; a bearer token is refused on them (`403 PLUGIN_SCOPE`). Answers are the app's: a list is the list itself, not wrapped as on v1.

| Route | Body or answer |
|---|---|
| `GET /api/books/:b/ledger`, `/cast`, `/knowledge`, `/state-events`, `/context` | As the v1 reads above (same query strings). `state-events` also takes `?chapter=all` |
| `GET /api/books/:b/workspace/docs[?path=]` | As the v1 read |
| `GET /api/books/:b/tasks` | Also takes `?for=ai\|author`; each task has `for` |
| `GET /api/books/:b/ai-activity` | `{ activity: [{ opId, at, actor, route, summary, files, undone, undoable, archivable, target }] }`, newest first, at most 200: what plugin tokens changed, from the op journal |
| `GET /api/books/:b/continuity/settings` | `{ exists, file, overdue_chapters, severity }` |
| `POST /api/books/:b/ai-level` | `{ level: "off" \| "advisor" \| "planner" \| "cowriter" \| null, scope?: "book" \| "library" }` gives `200 { ok, level, scope }`. Owner only in shared mode |
| `POST /api/books/:b/workspace/docs`, `.../append`, `.../lock`, `.../archive`, `.../restore`, `POST .../workspace/setup` | As the v1 writes. `.../lock` with `locked: false` unlocks (the author only) |
| `POST /api/books/:b/scenes/:sceneId/cast`, `POST .../knowledge`, `POST .../state-events`, `POST .../activity/ai-words` | As the v1 writes |
| `PUT /api/books/:b/scenes/:sceneId/ai-draft` | `{ body, base_sha256 }`; `403 NOT_AI_DRAFT` for any scene that is not an unaccepted AI draft |
| `POST /api/books/:b/scenes` | Also takes `origin: "ai" \| "author"` (anything else is `400`) |
| `POST /api/books/:b/continuity/settings` | `{ overdue_chapters?, severity?, dryRun? }`: `overdue_chapters` a whole number of 1 or more, `severity` an object of rule id to `error`, `warning`, `info` or `off` |

Writes to `workspace-*`, `scene-cast`, `ledger-*` and `activity-ai-log` belong to the `workspace` module (`403 MODULE_OFF` when it is off). To undo a change in AI Activity, `POST /api/books/:b/ops/:opId/restore`; to archive an AI chapter or scene, `POST /api/books/:b/chapters/:n/archive` or `POST /api/books/:b/scenes/:sceneId/archive` (`{ base_sha256 }`).

## Continuity review (the app's own, not API v1)

`GET /api/books/:b/continuity` answers `{ engine_version, findings, suppressed, stale_exceptions, skipped, settings }`, where `settings` is `{ overdue_chapters, severity }`; `404` for an unknown book. `?chapter=N` keeps the findings that touch chapter N; `&cast=<entry>:<role>,...` (needs `chapter`; role `pov`, `appears` or `mentioned`) also checks that planned cast as if it were in chapter N, for rules `CS1` and `CS2`. A bad `chapter` or `cast` is `400`. The Story Planner rules are part of the same answer. They read only structured records, never prose, and they work with exceptions and "Make a task" like the other rules.

| Rule | Severity | Finds |
|---|---|---|
| `PL1` | info | A scene with no live link in or out. Runs only when the book has at least one live link. |
| `PL2` | info | Two scenes next to each other in reading order, each with a live link, and no direct live link between them. The message says "not documented in the planner". |
| `PL3` | info | A beat in a live structure with no scenes. A beat whose `state` is `omitted` is skipped. |
| `PL4` | warning | A plot thread with `payoff` scenes and no `setup` scenes. |
| `PL5` | info | A live clue of kind `clue` (or with no kind) with planted scenes, no `revealed` scene and `red_herring` not `true`. Fingerprint detail: `unrevealed|<clue id>`. |
| `PL6` | warning | A clue whose `revealed` scene comes before its first planted scene in reading order. Fingerprint detail: `order|<clue id>`; the revealed scene and the first planted scene are the two scenes. |
| `CS1` | error | A character entry has a `died` state item with no later `revived`, and then is the `pov` or `appears` in the `cast` of a scene in a later chapter. |
| `CS2` | error | An entry has a `destroyed` or `lost` state item with no later `found`, and then is the `pov` or `appears` in the `cast` of a scene in a later chapter. |
| `TH2` | warning | A `promise` or `question` thread is set up in chapter X, is not `paid` or `dropped`, and the last chapter with scenes is more than `overdue_chapters` (default 12) after X. |

`PL1` and `PL2` read only the main plan: a link with a `branch` is left out, so a what-if branch never adds a finding. PL5 and PL6 read the clue's own `planted` and `revealed` fields, not the timeline's `knows` and `learns`; a `reader` knower never changes either.

`POST /api/books/:b/continuity/exceptions` accepts `{ fingerprint, rationale, title?, intentional?, dryRun? }`. `intentional` is optional and must be a boolean, else `400`. `true` writes `intentional: true` in the exception file ("This is on purpose"); `false` or no value writes no flag ("Acknowledged"). Both suppress the finding the same way. See [format.md](format.md), "Continuity exceptions".

In `suppressed`, each item is `{ finding, exception }`, and `exception` is `{ file, slug, intentional }`. `intentional` is a boolean, `false` when the file has no flag.

## Webhooks

Webhooks send events *out*. The author creates them in **Settings, then Webhooks**; a plugin with the `events` permission can create its own (for its own URL only).

### Subscriptions made by a plugin (permission `events`)

| Route | |
|---|---|
| `GET /api/v1/webhooks` | `{ webhooks: [...] }`: this plugin's own subscriptions (never a secret) |
| `POST /api/v1/webhooks` | `{ url, events: [...], books?: [slug, …] }` gives `201 { webhook, secret }`. The secret is shown once. `books` defaults to the token's books and can never be wider. |
| `DELETE /api/v1/webhooks/:id` | Revoke one of its own |

A plugin cannot set `include_content` or `allow_local`; asking for either is `400`. Only the author does that, in Settings. A plugin also cannot subscribe an address on this computer (`localhost`, `127.0.0.0/8`, `::1`): `400 LOCAL_NOT_ALLOWED`. Plugins send only to public `https://` addresses.

### Events

`scene.saved`, `scene.created`, `scene.moved`, `entry.changed`, `suggestion.created`, `suggestion.decided`, `export.done`, `backup.done`.

### Delivery

A `POST` with `Content-Type: application/json`, this body and these headers:

```json
{ "event": "scene.saved", "at": "2026-11-02T14:03:22.000Z", "book_id": "book_01…", "target_id": "scene_01…",
  "path": "manuscript/act-01/ch-001/0010-arrival.md", "sha256": "<hash of the file as saved>", "by": { "name": "Ilse" } }
```

- `by` is present when a signed-in person (shared mode) or a plugin did it. `target_id` is `null` for an export or a backup, whose `path` is the file name and `sha256` its hash.
- **There is no text** unless the author ticked "Include the scene text" for that webhook; then scene events also carry `content`, the scene body. The warning in Settings says so in plain words.
- `x-storyforge-signature: sha256=<hex>` is the HMAC-SHA-256 of the **exact request body bytes**, keyed with the webhook's secret. Verify it over the raw bytes, in constant time, before you parse anything. `x-storyforge-event` and `x-storyforge-delivery` (a unique id) are also sent.
- The secret is generated by StoryForge and shown once at creation. It is kept in your user config folder (shared mode: the shared-data folder), never in a library, a backup, a log or an answer.
- Timeout 5 seconds. A failure that could pass (a timeout, a network error, `5xx`, `408`, `429`) is retried 3 times with growing waits (1, 4 and 16 seconds). Other answers (`4xx`) are not retried. After 20 deliveries in a row that failed, the webhook is disabled; create it again to resume.
- Redirects are never followed (a `3xx` is a failure).
- Address rules: `http://` only for this computer (`localhost`, `127.0.0.0/8`, `::1`); `https://` for everything else. An address on a private network (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, unique-local IPv6, or a host name that resolves to one) is refused unless the author ticked "allow local network". No user name or password in the address.
- With no webhook, StoryForge makes no outbound connection at all.

## Compatibility policy

- **Within API major 1, fields are only added.** Existing fields keep their names, types and meaning. Write your plugin to ignore fields it does not know.
- Removing or renaming a field, or changing what one means, is a new major version (`/api/v2`). v1 keeps being served for at least one minor StoryForge release after v2 ships.
- New routes, new optional request fields, new event names and new permissions can appear in v1. A plugin must ignore an event it does not know.
- `GET /api/v1` tells you the API major (`api`) and the server version. A plugin manifest says which major it targets (`api: 1`); a manifest for a newer major shows "needs a newer StoryForge" (`W315`) and cannot be granted.
- Error `code` values are stable; the `message` words are not.
