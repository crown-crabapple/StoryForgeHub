# StoryForge API v1

A small, versioned HTTP API for programs you run yourself: a plugin that reads a book, a script that proposes edits, a receiver that listens for webhooks. It is
served by the same StoryForge process as the app, under `/api/v1`.

The principle: **StoryForge never runs plugin code, and no token can write a canonical file.** A plugin reads what you let it read, and it can *propose* a change. The one exception is canvases (planning boards, `planning/canvases/*.canvas`): a token with the `canvas` permission can change those directly, and nothing else.
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
| `events` | Its own webhook subscriptions (`/api/v1/webhooks`). |

Rules:

- A request with an `Authorization` header is a plugin request. It is decided only by its token: **cookies are never read**, a session cookie adds nothing to a
  plugin call, and a token placed in a cookie is never accepted. `/api/v1` without a bearer token is `401`.
- Personal mode answers loopback clients only. Shared mode checks the `Host` like every request. The browser write header and the `Origin` check do not apply to a
  bearer request, because it carries no ambient authority.
- A token reaches `/api/v1` only. Every other route, every write to a book, admin, AI, export, backup and receipts answer `403 PLUGIN_SCOPE`.
- Shared mode audits every plugin call (`plugin.<route>`, token id, status). A plugin token is not a member and has no role.
- Turning the **Integrations** module off (Settings, Modules, or `modules: { integrations: false }` in `library.md` / `book.md`) stops all API v1 access and webhook
  delivery: every call is `403 MODULE_OFF`.

Books are named by slug in the path (the book's id works too). A book outside the grant is `403 PLUGIN_SCOPE`, whether or not it exists.

## Errors

Every error is JSON: `{ "error": "<kind>", "code": "<CODE>", "message": "<words>" }`.

| Status | Meaning |
|---|---|
| `400` | The request is malformed (`BAD_ARGS`). |
| `401` | No valid token: missing, malformed, unknown or revoked (`TOKEN`). |
| `403` | `PLUGIN_SCOPE` (not this route, permission or book), or `MODULE_OFF`. |
| `404` | No such scene, entry, canvas or webhook. |
| `409` | The proposal changes nothing (`NO_CHANGE`) or the file moved on (`CONFLICT` for a canvas, `REFUSED_PATH_TAKEN` for a taken canvas name). |
| `413` / `415` | The body is too large (5 MB) / is not `application/json`. |
| `503` | The token file cannot be read (it is never replaced; fix or move it). |

## Read routes (permission `read`)

All answers are JSON. Line breaks in text are `\n`. A `sha256` is the hash of the file's bytes.

| Route | Answer |
|---|---|
| `GET /api/v1` | `{ api: 1, server: "<version>" }` |
| `GET /api/v1/books` | `{ books: [{ id, slug, title, status, series, series_number, language, scenes, words }] }`, granted books only |
| `GET /api/v1/books/:b` | The book with `acts: [{ act, label, chapters: [{ chapter, label, title, scenes: [{ id, title, order, act, chapter, sequence, status, pov, words, path }] }] }]` |
| `GET /api/v1/books/:b/scenes/:id` | One scene: the scene fields above plus `sha256`, `front_matter` (the parsed YAML) and `body` |
| `GET /api/v1/books/:b/entries` | `{ entries: [{ id, slug, type, name, status, role, aliases, archived, path }] }` |
| `GET /api/v1/books/:b/entries/:id` | `{ id, slug, type, name, status, path, sha256, fields, body }` |
| `GET /api/v1/books/:b/threads` | `{ threads: [{ id, slug, title, kind, status, setup, develop, payoff, characters, path }] }` |
| `GET /api/v1/books/:b/events` | `{ events: [{ id, slug, title, order, when, date, scenes: [id], characters, locations, path }] }` |
| `GET /api/v1/books/:b/search?q=&limit=` | `{ query, hits: [{ id, kind, title, path, snippet }] }` (`q` 1 to 200 characters, `limit` 1 to 100, default 20) |
| `GET /api/v1/books/:b/graph` | `{ nodes: [{ id, kind, type, name }], edges: [{ from, to, kind, rel }] }` |
| `GET /api/v1/books/:b/diagnostics` | `{ diagnostics: [{ code, severity, file, location, message }] }` |

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

A canvas is a JSON Canvas file, `planning/canvases/<slug>.canvas`. A canvas slug is lower-case letters, digits and hyphens (up to 60); anything else is `403 PLUGIN_SCOPE`, not a route. The **Board** module must be on for the book (else `403 MODULE_OFF`, `module: "board"`). Writes go through the same store and sha check as the app and are never dry runs.

| Route | Permission | Answer |
|---|---|---|
| `GET /api/v1/books/:b/canvases` | `read` | `{ canvases: [{ slug, title, path, nodes, edges, sha256, updated_at, problem }], archived: [...] }` |
| `GET /api/v1/books/:b/canvases/:slug` | `read` | `{ slug, title, path, sha256, canvas, problem, refs, targets }`; `targets` are the scenes, entries, threads and events a story card can link to |
| `POST /api/v1/books/:b/canvases` | `canvas` | body `{ title (1 to 200 characters), slug? }`; `201 { slug, path, sha256 }` |
| `PUT /api/v1/books/:b/canvases/:slug` | `canvas` | body `{ canvas: { nodes, edges, storyforge? }, base_sha256 }`; `200 { slug, path, sha256 }` |
| `POST /api/v1/books/:b/canvases/:slug/archive` | `canvas` | optional body `{ base_sha256 }`; `200 { ok: true, slug, path }` |
| `POST /api/v1/books/:b/canvases/:slug/restore` | `canvas` | optional body `{ base_sha256 }`; `200 { ok: true, slug, path }` |

`base_sha256` (64 hex characters) is required to save: it is the `sha256` you read. Status codes: `409 { error: "conflict", code: "CONFLICT", current: { sha256, canvas } }` when the file changed since (read `current`, merge, save again); `409 REFUSED_PATH_TAKEN` when a create or restore would overwrite another canvas; `400 REFUSED_BAD_CANVAS` with a `message` when the canvas breaks the format rules (the file is not touched); `400 BAD_ARGS` for a malformed body; `404` for no such canvas; `403 PLUGIN_SCOPE` for a token without `canvas`.

## Story Planner routes (the app's own, not API v1)

These routes store causal links between scenes, per-scene planning fields, the book's story plan, character arcs and story structures with their beat sheets (see [format.md](format.md), "Story Planner files"). They sit under `/api/books/:b/`, are **not part of plugin API v1**, and a bearer token is refused (`403 PLUGIN_SCOPE`). They are for the StoryForge app itself.

A link, an arc or a structure is named by its `slug`. A scene plan is named by its scene's id. The story plan is one file per book and has no name in the route. Reads are not gated by a module.

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

`Link` is `{ id, slug, path, from, to, relation, rationale, created, sha256, from_title, to_title, problems: [{ code, message }] }`. `rationale` is the body. `from_title` and `to_title` are `null` when the scene is not live. `problems` are the diagnostics on that file.

A scene plan's `fields` has all ten keys (`goal`, `opposition`, `conflict`, `turn`, `outcome`, `consequence`, `stakes`, `emotional_start`, `emotional_end`, `purpose`), each a string or `null`. A scene with no plan answers `path: null`, `sha256: null`, all fields `null`, `characters: []`, `body: ""`.

`flow`: `nodes` are the live scenes in reading order, `{ id, kind: "scene", title, summary, status, pov, act, chapter, sequence, plan }` (`plan` is true when the scene has a plan). `edges` are the live links, `{ id, slug, from, to, relation, rationale, sha256, broken }`; `broken` is true when an end is not a live scene.

A story plan's `fields` has all eight keys (`premise`, `logline`, `theme_question`, `central_conflict`, `protagonist_goal`, `stakes`, `protagonist`, `primary_structure`), each a string or `null`. A book with no story plan answers `path: null`, `sha256: null`, all fields `null`, `body: ""`. Only a live file at `planning/story.md` counts.

`plan-overview`: the answer is `{ story, counts, primary_structure, unlinked }`. `story` is the same object as `story-plan`. `counts` is `{ scenes, planned_scenes, links, linked_scenes, unlinked_scenes, broken_links, archived_links, threads, arcs, structures }`: `scenes` is the number of flow nodes, `planned_scenes` those with a plan, `links` the live links, `linked_scenes` the scenes at an end of a live link, `unlinked_scenes` the rest, `broken_links` the live links with an end that is not a live scene, `archived_links` the archived links, `threads` the live plot threads, `arcs` the live arcs, `structures` the live structures. `primary_structure` is `{ id, slug, name }` of the live structure the story plan names, or `null`. `unlinked` is `[{ id, title }]`: the scenes at no end of a live link, in reading order, at most 50.

`Arc` is `{ id, slug, path, sha256, character, character_id, arc_type, fields, milestones, body, problems: [{ code, message }] }`. `character` is `{ id, slug, name, shared }` (`shared` is true for an entry of the series' shared world), or `null` when the id names no entry; `character_id` is the id as written in the file. `arc_type` is a string or `null`. `fields` has all seven keys (`want`, `need`, `false_belief`, `fear`, `wound`, `start_state`, `end_state`), each a string or `null`. `milestones` is `[{ index, scene, scene_title, chapter, sequence, pressure, choice, belief_before, belief_after, cost }]` in file order; `scene_title`, `chapter` and `sequence` are `null` when the scene is not live, and an empty text is `null`. `body` is the free notes. `arcs` is sorted by character name (arcs whose character is unresolved last), then slug.

`Template` is `{ id, version, name, description, beats: [{ name, purpose, question, position? }] }`. The eight ids are listed in [format.md](format.md). The answer is the same for every book.

`Structure` is `{ id, slug, name, template, template_version, primary, sha256, body, beats, counts }`. `primary` is true when the story plan's `primary_structure` is this structure's id. `beats` is `[{ id, name, purpose, question, position, state, scenes: [{ id, title, chapter, sequence }] }]` in file order; `state` is `open`, `done` or `omitted` (a beat with no state is `open`); an empty text is `null`; `title`, `chapter` and `sequence` are `null` when the scene is not live. `counts` is `{ beats, assigned, omitted }`: all beats, beats with at least one scene, and beats that are omitted. `structures` is sorted with the primary one first, then by name, then slug.

### Writes

All are `POST` with a JSON body. The module is `planner`: with it off, every write is `403 MODULE_OFF` (`module: "planner"`) and nothing is written. Every write accepts `"dryRun": true` and then returns `{ ok: true, dryRun: true, changes, … }` without writing. A real write answers with `opId` and `undo`. `base_sha256` is the `sha256` you read; if the file has changed, the answer is `409 { error: "conflict", current: { sha256, text } }` (the file as it is now) and nothing is written.

| Route | Body | Answer |
|---|---|---|
| `POST /api/books/:b/links` | `{ from, to, relation, rationale? }` (scene ids; `relation` as in [format.md](format.md)) | `201`, with `id`, `slug`, `path` |
| `POST /api/books/:b/links/:slug` | `{ base_sha256, relation?, from?, to?, rationale? }`, at least one of the four | `200`, with `id`, `slug`, `path` |
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

- A dry run answers `200` where a real write would answer `201`.
- `rationale` is up to 20,000 characters. The file name and slug of a link never change on update. The body is replaced only when `rationale` is sent.
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
- Restoring a structure: `REFUSED_PATH_TAKEN` if a live file has that name. Archiving or restoring never changes a scene or the story plan; a story plan that names an archived structure shows `W303`.
- Scene files, `book.md` and the story text are never read for writing or changed.
- Undo: `POST /api/books/:b/ops/:opId/restore`. Undo may remove a link, scene plan, story plan, arc or structure that the write created.

Errors:

| Status | Code | When |
|---|---|---|
| `400` | `BAD_ARGS` | The body is malformed (wrong type, a `body` that is not a string, missing `from` / `to` / `relation`, missing `base_sha256` on an update). |
| `400` | `REFUSED_BAD_ARGS` | A value is out of range (unknown `relation`, unknown planning key, over-long text or body, nothing to change, `base_sha256` where none is allowed or missing where required). |
| `400` | `REFUSED_UNKNOWN_SCENE` | `from`, `to`, a milestone's scene, a beat's scene or the scene is not a live scene (`field` says which). |
| `400` | `REFUSED_UNKNOWN_ENTRY` | A `characters` slug, the story plan's `protagonist`, or an arc's `character` is not an entry (`entry` names it). |
| `400` | `REFUSED_UNSIMPLE_FIELD` | An arc's or structure's front matter cannot be read as plain YAML, or its `milestones` or `beats` block has a comment, anchor or alias (`field` names the key). |
| `400` | `REFUSED_SELF_LINK` | `from` and `to` are the same scene. |
| `404` | | No such book, link, arc, structure, or live scene. |
| `409` | `REFUSED_DUPLICATE_LINK` | A live link already has the same `from`, `to` and `relation` (also on restore). The answer carries `existing: { slug }`. |
| `409` | `REFUSED_DUPLICATE_ARC` | A live arc already names the same `character` (also on restore). The answer carries `existing: { slug }`. |
| `409` | `REFUSED_PATH_TAKEN` | A restore would overwrite a live link, arc or structure file, or `planning/story.md` exists but is not a story plan. |
| `409` | `CONFLICT` | The file changed since `base_sha256`. |
| `403` | `MODULE_OFF` | The `planner` module is off. |

A write that would add a validation error to the book is refused and nothing is written.

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
