# M12 contract — An AI can work through a book

Binding: contract M08-J02 (tokens, permissions, API v1, the policy decided before the member policy); contract M11 (the `plan` permission and the planner write tools); M07-J04 (preferences and modules); M05-J01 (continuity rules and exceptions); the Insights and writing log of M07-J02.

M12 adds an AI level per book that caps every token, two more writing permissions (`workspace` and `draft`), workspace docs, ledgers, a chapter cast, state events, AI tasks, an AI words column in the writing log, three continuity rules with author settings, a chapter context pack, and AI Activity. A v1 write is run by the app's own route; M12 adds no second write path.

## 1. AI levels

- `AI_LEVELS` is `off`, `advisor`, `planner`, `cowriter`, lowest to highest (`packages/format/src/preferences.mjs`). `DEFAULT_AI_LEVEL` is `planner`: what an AI connection could already do before M12 (suggest, canvas, plan). A book that sets nothing has `planner`.
- The level is the project preference `ai.level`: `preferences: { ai: { level: <level> } }` in `book.md`, or the library default in `library.md`. `ai` is a project key (built-in, then profile, then `library.md`, then `book.md`; the last wins). A level that is not one of the four, or an `ai` key other than `level`, is `E102` at `preferences.ai.level` or `preferences.ai.<key>`.
- `aiLevelOf` (`apps/server/src/preferences.mjs`) resolves it for a book; an unknown value counts as `planner`.

| Level | A token may (when it also holds the permission) |
|---|---|
| `off` | Read only. |
| `advisor` | `POST proposals` (permission `propose`) and create a task (`workspace`). |
| `planner` | Plan writes (`plan`), canvas writes (`canvas`), workspace docs, ledger threads, scene cast, knowledge, state events, task status, AI words, continuity dismiss and restore (`workspace`). |
| `cowriter` | New chapters, new scenes and AI draft body replacement (`draft`). |

Each higher level includes the ones below it.

### Enforcement

- Every row of `V1` in `apps/server/src/plugin-policy.mjs` has a `need` (permission) and, for a write, a `level`. A row with no `level` (every read, and the webhook routes) needs no level, so a book at `off` is still readable.
- Order in `handlePluginRequest` (`apps/server/src/api-v1.mjs`): token, route, permission and granted book (`decidePlugin`); the `integrations` module; the AI level; then the route and its own module gate. A refused request writes nothing.
- A request above the book's level is `403`:

```json
{ "error": "forbidden", "code": "AI_LEVEL", "level": "advisor", "needs": "planner", "message": "the AI level of this book is \"advisor\"; this needs \"planner\" or higher (the author sets it in the book's settings); nothing was written" }
```

- The level caps tokens only. It is not checked on the app's own routes, which the author uses.
- A token needs both: the permission and the level. Missing the permission is `403 PLUGIN_SCOPE`; missing the level is `403 AI_LEVEL`.
- `GET /api/v1/books` gives each listed book an `ai_level` field. The `codex_status` and `codex_list_books` tools report it (§8).

### Setting the level

- `POST /api/books/:b/ai-level`, body `{ level: "off" | "advisor" | "planner" | "cowriter" | null, scope?: "book" | "library" }`. `scope` is `book` (default: writes `book.md`) or `library` (writes the default in `library.md`). `null` removes the setting so the layer above applies. Answer `200 { ok: true, level, scope }`. A bad `level` or `scope` is `400`; `scope: "library"` on a library with no `library.md` is `404`.
- The route's policy class is `admin` (`apps/server/src/policy.mjs`): in shared mode only the owner. There is no v1 route for it, so a token cannot change its own level.
- `GET /api/preferences?book=<id>` shows the level in effect (`effective.ai.level`) and the layer it came from (`sources["ai.level"]`).
- Settings has an **AI level** section: one select per book and one for the library default, with the layer shown next to each.

## 2. Permissions

`PLUGIN_PERMISSIONS` is `read`, `propose`, `events`, `canvas`, `plan`, `workspace`, `draft` (`packages/shared/src/plugin-tokens.mjs`, `packages/format/src/plugins.mjs`). A token or plugin manifest may name `workspace` and `draft`. Neither implies `read`.

| Permission | Writes | Level |
|---|---|---|
| `workspace` | Workspace docs, ledger threads, scene cast, knowledge, state events, tasks, AI words, continuity dismiss and restore. Planning material only: never prose, scenes or Codex entries. | `advisor` (create a task), `planner` (the rest) |
| `draft` | New chapters, new scenes, and the body of an AI draft: a scene with `origin: ai` and `status: drafting` (§6). | `cowriter` |

- Both are opt-in. The **Connect Claude** form has the checkboxes "Workspace docs and ledgers: the AI may write your book and style docs, state notes and ledgers (never your prose; you can Undo each change)" and "Create chapters and scenes: the AI may add new chapters and scenes as drafts (it never changes a scene you already have)", unticked at first, and the note "The book's AI level (Settings, AI level) still limits what is allowed: a permission above the book's level is refused."
- **Settings, then Plugins** lists them as "Workspace docs and ledgers: write the workspace docs (book, style, state) and ledgers. You can Undo each change. It never touches your prose. The book's AI level still limits what is allowed." and "Create chapters and scenes: add new chapters and scenes as drafts. It never changes a scene you already have. The book's AI level still limits what is allowed."

## 3. The `workspace` module

- `workspace` is in `MODULE_IDS`, on by default, shown in Settings as **AI Workspace**.
- `moduleOfRoute` puts these app routes in it: `workspace-*`, `scene-cast`, `ledger-*` and `activity-ai-log`. Off, they answer `403 MODULE_OFF` (`module: "workspace"`) and write nothing, for the author and for tokens.
- The v1 routes under `/api/v1/books/:b/workspace` (read and write) are gated by it too.
- Other routes a workspace write runs keep their own module: thread writes need `threads`, task writes need `tasks`, continuity dismiss, restore and settings need `continuity` (the v1 `/continuity` routes, read and write, are refused with it off). Chapter and scene creation and the AI draft route have no module.
- Files of a module that is off stay in the book.

## 4. File shapes

All additive within format v1 (`packages/format/src/schema.mjs`). Nothing here changes a scene's prose.

### Workspace docs

`planning/workspace/<name>.md`, `planning/state/chapter-NN/<name>.md` and `planning/development/<name>.md`, kind `doc` (`schema: storyforge.doc/v1`).

```yaml
---
schema: storyforge.doc/v1
id: note_01…
title: Chapter 04 knowledge
workspace: state
chapter: 4
locked: true
---
Free markdown.
```

- A doc's address is its path under `planning/` without `.md`. It must match one of: `workspace/<name>`, `state/chapter-NN/<name>` with `<name>` one of `situation`, `characters`, `knowledge`, `inventory` (`NN` is 2 or 3 digits), or `development/<name>`. `<name>` is lower-case letters, digits and hyphens, 1 to 60 characters. Any other address is `REFUSED_BAD_ARGS`.
- `title` is required. `workspace` is `book` (for `workspace/book`), `style` (for `workspace/style`), `state` (for `state/chapter-NN/…`) or `other`. `chapter` is the chapter number of a state doc. `locked` is a boolean. Writes made through StoryForge set `workspace` and `chapter` from the address.
- `development/` is for proposals that are never canon. `workspace/book`, `workspace/style` and the state docs are the book's working records.
- Archive moves a doc to `archive/planning/<address>.md`; restore moves it back. A save or append for an address that is archived is `REFUSED_PATH_TAKEN`.
- Setup (`workspace-setup`) creates the starter docs that do not exist: `workspace/book`, `workspace/style` and `state/chapter-00/situation`, `characters`, `knowledge`, `inventory`. An existing or archived address is skipped, and the answer lists `created` and `existing`.
- Locks: `locked: true` makes save, append, archive and restore refuse with `409 LOCKED`. A lock call takes one `path` or a `prefix` of the form `state/chapter-NN` (every state doc of that chapter) and `locked: true | false`. A token may lock but never unlock: `locked: false` on the v1 route is `403 AUTHOR_ONLY` and nothing runs. The author unlocks in the app.
- Saving an existing doc needs `base_sha256` (the sha256 of the whole file as read); a stale or missing one is `409 CONFLICT` with `current: { sha256, body }`. A new doc needs none. Append needs none and creates the doc when missing.

### Scene cast

A scene's front matter gains `cast`, a list of `{ entry, role }`. `entry` is a Codex entry id or slug; `role` is `pov`, `appears` or `mentioned`.

```yaml
cast:
  - entry: maren-hollis
    role: pov
  - entry: pell
    role: appears
```

- A cast item that is not a mapping with `entry` and `role`, a `role` outside the three, or a second `pov` in one scene is `E102`. An `entry` that does not resolve is `E301` or `E302`, like other entry references.
- Setting the cast replaces the whole list and changes only that key. An empty list removes it. The same entry twice is refused.

### Scene origin

A scene's front matter gains `origin`, `ai` or `author`. A scene made by a token has `origin: ai`; a scene with no `origin` is the author's. The index stores it (`scenes.origin`, index `schema_version` 4, so an older index is rebuilt). See §6.

### Task `for`

A task file (`planning/tasks/`) gains `for`, `ai` or `author`. `for: ai` marks a task the author wants the AI to do. Tasks with no `for` read as `author` in the filters.

### AI words in the writing log

`activity/writing-log.md` gets an optional trailing column `AI words`:

```text
| Date | Words added | Words removed | Minutes | Sessions | AI words |
|---|---|---|---|---|---|
| 2026-11-07 | 1200 | 80 | 95 | 2 | 640 |
```

- The column is added to the header and separator once, and only when a day has AI words. A row with none keeps its five cells. A file without the column reads as 0 AI words.
- AI words go in their own column; the author's `Words added` is never changed by them. Insights shows `progress.ai`: `{ human_words, ai_words, ai_share }`, where `ai_share` is ai / (human + ai), 0 when neither wrote. `GET /api/books/:b/activity` carries `ai_words` in `today` and in each day.

### Continuity settings

`planning/continuity/settings.md`, kind `continuity-settings` (`schema: storyforge.continuity-settings/v1`):

```yaml
---
schema: storyforge.continuity-settings/v1
id: note_01…
overdue_chapters: 12
severity:
  TH2: info
  CS1: error
---
```

- `overdue_chapters` is a whole number of 1 or more (default 12). `severity` maps a rule id (two capital letters and digits, such as `CS1`) to `error`, `warning`, `info` or `off`. Another key or word is `E102`; the engine ignores an invalid entry.
- A rule set to `off` produces no finding. Another word replaces the rule's severity. Fingerprints do not depend on severity, so existing dismissals still match.
- Only the author changes it: `POST /api/books/:b/continuity/settings` with `{ overdue_chapters?, severity?, dryRun? }`, answer `{ ok, file, opId, undo }`; `GET` of the same path answers `{ exists, file, overdue_chapters, severity }`. No v1 route and no MCP tool reaches it.

### A fact a character learns

A timeline event's `state` item `learns` (or `knows`) keeps its slug-shaped key in `value` and may carry `fact`, the full wording as one line of text (control characters are `E102`). `fact` on any other event word is `E102`. `codex_knowledge_at` returns the wording as `text` (the key for an item with no `fact`).

State events written by an AI go on one event per chapter, titled `Chapter N (state)` (slug `chapter-N-state`, `order` N, scenes: the chapter's first scene), made when missing. Items are only added, never removed; an item already there is not added twice. A state ends only by a later item (`revived`, `found`, a new `holder`).

## 5. Routes

Method, path, the permission and level a token needs, and the body. Paths are under `/api/v1/books/:b` for a token (`:b` is a slug or id). The app's own route is named where it differs; both run the same code, so body, validation and answer are the app's. All writes answer with an `opId` where the app does.

### Reads (permission `read`, no level)

| v1 path | App route | Answer |
|---|---|---|
| `/workspace/docs` | `/api/books/:b/workspace/docs` | `{ docs, archived }`: rows `{ path, title, workspace, chapter, locked, sha256, updated_at }`. With `?path=<address>`: `{ path, title, workspace, chapter, locked, sha256, body }`, `404` if none. The `workspace` module must be on (v1). |
| `/ledger` | `/ledger` | `{ promises, questions, clues, counts }`. A promise or question is a thread of that kind with `open` (false for `paid`, `dropped`, `abandoned`), its setup, develop and payoff scene ids and their chapters, and `sha256`. |
| `/cast[?chapter=N]` | `/cast` | The cast of each scene in book order: `{ scene, title, chapter, cast: [{ entry, id, slug, name, role }] }`. v1 wraps the list as `{ cast }`; the app answers the list itself. |
| `/knowledge?character=<entry>[&at=N]` | `/knowledge` | `{ character, at, facts: [{ fact, text, how, chapter, event, event_id }] }`, the facts known by the end of chapter `at` (all without it). `character` is required. |
| `/state-events[?chapter=N]` | `/state-events` | `{ events: [{ event, event_id, chapter, subject, kind, value? }] }` on v1; the app answers the list itself. `chapter=all` is the whole book. |
| `/tasks[?status=&for=]` | `/tasks[?status&source&label&for]` | `{ tasks, counts }` (v1). |
| `/continuity[?chapter=N&cast=<entry>:<role>,…]` | same | v1: `{ findings, suppressed, stale_exceptions, settings }`. `cast` needs `chapter`; roles are `pov`, `appears`, `mentioned`; at most 200 entries. The `continuity` module must be on (v1). |
| `/context?chapter=N[&budget=C]` | same | The context pack (§7). `chapter` is required; `budget` is 500 to 200000 characters. |
| — | `/api/books/:b/ai-activity` | AI Activity (§6). App only. |
| — | `/api/books/:b/continuity/settings` | The author's settings. App only. |

A bad `chapter`, `at`, `status`, `for` or `cast` is `400`.

### Writes through the plugin API

| Method and v1 path | Permission, level | Body | Runs |
|---|---|---|---|
| `POST /workspace/docs` | `workspace`, planner | `{ path, body, title?, base_sha256? }` | `workspace-doc-save` |
| `POST /workspace/docs/append` | `workspace`, planner | `{ path, text }` | `workspace-doc-append` |
| `POST /workspace/docs/lock` | `workspace`, planner | `{ path }` or `{ prefix }`, and `locked: true` | `workspace-doc-lock` |
| `POST /workspace/docs/archive`, `/restore` | `workspace`, planner | `{ path, base_sha256? }` | `workspace-doc-archive`, `-restore` |
| `POST /workspace/setup` | `workspace`, planner | `{}` | `workspace-setup` |
| `POST /ledger/threads` | `workspace`, planner | `{ title, kind: "promise" \| "question", status? }` | `thread-create` |
| `POST /ledger/threads/:slug` | `workspace`, planner | `{ status?, setup?, develop?, payoff?, characters?, base_sha256? }` | `thread-fields` |
| `POST /scenes/:sceneId/cast` | `workspace`, planner | `{ cast: [{ entry, role }], base_sha256? }` | `scene-cast` |
| `POST /knowledge` | `workspace`, planner | `{ character, fact, chapter }` (`fact`: one line, up to 300 characters) | `ledger-knowledge-record` |
| `POST /state-events` | `workspace`, planner | `{ chapter, items: [{ subject, kind, value? }] }`; `kind` is `died`, `revived`, `destroyed`, `lost`, `found`, `holder` or `location` | `ledger-state-record` |
| `POST /tasks` | `workspace`, **advisor** | `{ title, notes?, labels?, for? }` | `task-create` |
| `POST /tasks/:id/status` | `workspace`, planner | `{ status, for? }`; `status` is `open`, `doing`, `done` or `dropped`; `for` is `ai` or `author` | `task-status` |
| `POST /activity/ai-words` | `workspace`, planner | `{ words, chapter?, note? }` (`words`: a whole number of 1 or more) | `activity-ai-log` |
| `POST /continuity/exceptions` | `workspace`, planner | `{ fingerprint, reason }` (`reason` becomes the exception's rationale) | `continuity-exception-create` |
| `POST /continuity/exceptions/:slug/archive` | `workspace`, planner | `{}` | `continuity-exception-archive` |
| `POST /chapters` | `draft`, cowriter | `{ title, after?, act? }` | `chapter-create` |
| `POST /scenes` | `draft`, cowriter | `{ chapter, title, body, summary?, after? }` | `create` (§6) |
| `PUT /scenes/:sceneId/draft` | `draft`, cowriter | `{ body, base_sha256 }` | `scene-ai-draft` (§6) |

- The v1 path is mapped onto the app's route by `memberWrite` in `api-v1.mjs`, which reaches only routes whose name starts with `workspace-`, `thread-`, `scene-cast`, `ledger-`, `task-`, `activity-ai-log`, `continuity-exception-`, `chapter-create`, `create` or `scene-ai-draft`. Nothing else is reachable. Scene prose, scene fields, entries and the author's continuity settings have no v1 write route.
- A cast, knowledge or state-event write names a chapter or scene that must exist in the book: a chapter with no scenes is `REFUSED_UNKNOWN_CHAPTER` (state events, knowledge), an unknown scene is `REFUSED_UNKNOWN_SCENE`.
- The body of every app write may carry `dryRun: true`, which previews and writes nothing. No MCP tool sends it.
- Shared mode audits a call as `plugin.<route>` (`v1RouteOf`). Writes: `workspace-doc-save`, `workspace-doc-append`, `workspace-doc-lock`, `workspace-doc-archive`, `workspace-doc-restore`, `workspace-setup`, `ledger-thread-create`, `ledger-thread-update`, `scene-cast`, `knowledge-record`, `state-record`, `task-create`, `task-status`, `activity-ai-log`, `continuity-dismiss`, `continuity-restore`, `chapter-create`, `scene-create`, `scene-draft`. Reads: `workspace-docs`, `ledger`, `cast`, `knowledge`, `state-events`, `tasks`, `continuity`, `context`.

### Routes only the app has

| Method and path | Who | Body |
|---|---|---|
| `POST /api/books/:b/ai-level` | owner (class `admin`) | `{ level, scope? }` (§1) |
| `POST /api/books/:b/continuity/settings` | owner and editor (class `write`) | `{ overdue_chapters?, severity?, dryRun? }` |
| `POST /api/books/:b/workspace/docs/lock` | owner and editor | `{ path \| prefix, locked: false }` to unlock |
| `PUT /api/books/:b/scenes/:sceneId/ai-draft` | owner and editor | the app's name for the draft route (v1: `…/draft`) |
| `POST /api/books/:b/scenes` | owner and editor | also takes `origin: "ai" \| "author"` (anything else is `400`) |

## 6. AI drafts, AI Activity, Undo and Archive

### The AI draft rule

- A token creates a scene with `POST /scenes`. Whatever the token sends, the server makes the scene `origin: ai` and `status: drafting`. It passes on only `chapter`, `act`, `after`, `title`, `slug`, `body`, `summary` and `dryRun`: no id and no other front matter. Without `slug`, one is made from the title. Without `after`, the scene goes at the end of its chapter; `after: null` is the start.
- `POST /chapters` makes a new empty chapter with one empty placeholder scene, after chapter `after` or as the first of act `act`. Nothing existing changes.
- `PUT /scenes/:sceneId/draft` replaces the whole body, and only while the scene has `origin: ai` and `status: drafting`. Any other scene (an author's scene, or an AI scene whose status the author changed from `drafting`) is `403 NOT_AI_DRAFT` and nothing is written. `base_sha256` is required; a stale one is `409 CONFLICT`.
- The author accepts an AI draft by changing its status from `drafting`. From then on a token can only propose edits to it (`POST proposals`, permission `propose`).
- Created and replaced words are added to today's AI words by the server. A dry run logs nothing; a failure of the log never changes the answer.
- No v1 route deletes anything.

### AI Activity

- Every write made through a plugin token records an actor, `{ kind: "plugin", id: <token id>, name: <plugin name> }`, in the op journal. An MCP connection's plugin name is `mcp-<name>` (the app shows it without the prefix). Reads record nothing. The author's own writes record no actor.
- `GET /api/books/:b/ai-activity` answers `{ activity: [{ opId, at, actor, route, summary, files, undone, undoable, archivable, target }] }`, newest first, at most 200. `route` is the journal's operation name; `summary` is one line such as "Changed: planning/workspace/style.md"; `files` leaves out `provenance/`; `undone` is true when a later undo restored it; `target` is `{ kind: "scene", id }` or `{ kind: "chapter", id: <number> }` for something the AI created, else `null`.
- **Undo**: `POST /api/books/:b/ops/:opId/restore` puts the files back, as long as they have not been edited since (the server refuses otherwise, in its own words). `undoable` says whether it can work.
- **Archive**: a file a token created cannot be restored by Undo, so an item that created a scene or chapter and is not undone has `archivable: true` and `undoable: false`. The author archives it with `POST /api/books/:b/scenes/:sceneId/archive` (`{ base_sha256 }`) or `POST /api/books/:b/chapters/:n/archive`. Nothing is deleted.
- Undo and Archive are routes the author uses; a token cannot reach them.

## 7. Continuity rules

The rules read only structured records (state items, scene cast, threads), never prose. Each works with exceptions, **Make a task** and the settings in §4.

| Rule | Default severity | Finds |
|---|---|---|
| `CS1` | error | A character entry has a `died` state item with no later `revived`, and then is the `pov` or `appears` in the cast of a scene in a later chapter. Fingerprint detail `dead|<slug>|<scene id>`. |
| `CS2` | error | An entry has a `destroyed` or `lost` item with no later `found`, and then is the `pov` or `appears` in the cast of a scene in a later chapter. Fingerprint detail `gone|<slug>|<scene id>`. |
| `TH2` | warning | A promise or question thread is set up in chapter X, is not `paid` or `dropped`, and the last chapter of the book with scenes is more than `overdue_chapters` (default 12) after X. Fingerprint detail `overdue|<thread id>`. |

- `mentioned` never triggers CS1 or CS2: a memory, letter or flashback is `mentioned`.
- Pre-flight: `GET /continuity?chapter=N&cast=…` also checks the planned cast as if it were in chapter N (CS1 and CS2 only), for a chapter not written yet. The fingerprint of such a finding uses `planned-chapter-N` in place of the scene id. With `chapter` only, the findings are those that touch that chapter.
- Dismissing a finding creates a continuity exception file (`planning/continuity/<slug>.md`) whose body is the reason; restoring archives it. Neither deletes anything. Errors: `404 FINDING_NOT_FOUND`, `409 ALREADY_EXCEPTED`, `400 RATIONALE_REQUIRED`.

## 8. MCP tools

`packages/mcp/src/tools.mjs`. Every tool takes `book` (slug or id). A token without a tool's permission does not see it in `tools/list`; calling one anyway is refused naming the permission. A write tool answers with the app's result and a note: for workspace tools "This changed the workspace files directly (a workspace doc, ledger, cast, state, task or writing log; planning material, not prose); the author can Undo it in StoryForge."; for draft tools "New chapters and scenes are drafts marked as AI; the author can archive them in StoryForge (AI Activity). The author accepts a draft by changing its status from drafting. Scenes the author wrote or accepted can only be changed with codex_propose_edit."

`codex_status` and `codex_list_books` list each book with `ai_level`.

Read tools (permission `read`; 9 new):

| Tool | Arguments | |
|---|---|---|
| `codex_list_docs` | | Workspace docs and archived docs: path, title, workspace, chapter, locked, sha256. |
| `codex_get_doc` | `path` | One doc: title, locked, body, sha256. |
| `codex_get_ledger` | | Promises, questions and clues. |
| `codex_get_cast` | `chapter?` | The cast of each scene. |
| `codex_knowledge_at` | `character`, `at?` | What a character knows by the end of a chapter. |
| `codex_get_state_events` | `chapter?` | State events with chapter, subject, kind and value. |
| `codex_get_tasks` | `status?`, `for?` | Tasks and counts. |
| `codex_continuity_check` | `chapter?`, `cast?` | Findings, dismissed findings, stale dismissals. `cast` is `[{ entry, role }]` and needs `chapter`. |
| `codex_get_context` | `chapter`, `budget?` | The context pack. |

Workspace tools (permission `workspace`, 14):

| Tool | Arguments | |
|---|---|---|
| `codex_save_doc` | `path`, `body`, `title?`, `base_sha256?` | Create a doc or replace the whole body of one. `base_sha256` required for an existing doc. |
| `codex_append_doc` | `path`, `text` | Append to the end; creates the doc when missing. |
| `codex_lock_docs` | `path` or `prefix` | Lock a doc or a chapter's state docs. No unlock tool. |
| `codex_setup_workspace` | | Create the starter docs that do not exist. |
| `codex_save_ledger_item` | `slug?`, `title?`, `kind?`, `status?`, `setup?`, `develop?`, `payoff?`, `characters?`, `base_sha256?` | Create a promise or question (`title` and `kind` required, `slug` left out) or update one (`slug`). Each list replaces the old one. Retire by `status: paid` or `dropped`. |
| `codex_set_chapter_cast` | `scene`, `cast`, `base_sha256?` | The whole cast of one scene. |
| `codex_record_knowledge` | `character`, `fact`, `chapter` | A character learns a fact in a chapter. |
| `codex_record_state_events` | `chapter`, `items` | Items `{ subject, kind, value? }`. |
| `codex_create_task` | `title`, `notes?`, `labels?`, `for?` | Create a task (`for` defaults to `author`). Level advisor. |
| `codex_update_task` | `task`, `status?`, `for?` | Change status and/or `for`; give at least one. |
| `codex_complete_task` | `task` | Set status `done`. |
| `codex_log_writing` | `words`, `chapter?`, `note?` | Add words to today's AI words. |
| `codex_dismiss_finding` | `fingerprint`, `reason` | Dismiss a finding with the reason. |
| `codex_restore_finding` | `finding` | Bring a dismissed finding back (fingerprint or dismissal slug). |

Draft tools (permission `draft`, 3):

| Tool | Arguments | |
|---|---|---|
| `codex_create_chapter` | `title`, `after?`, `act?` | A new empty chapter. `act` is required when `after` is left out. Answers `chapter`, `act`, `scene`, `opId`. |
| `codex_create_scene` | `chapter`, `title`, `body`, `summary?`, `after?` | A new AI draft scene. Answers `id`, `path`. |
| `codex_save_draft` | `scene`, `body`, `base_sha256` | Replace the body of an unaccepted AI draft (origin ai, status drafting). Answers `sha256`, `words`. |

The workspace tools are annotated non-destructive and not read-only. The workspace tools run only at the level shown in §5; the draft tools need `cowriter`.

### Not offered

`NOT_OFFERED` names legacy tools v2 has no plugin route for; calling one answers "is not available in StoryForge v2's MCP service … do this in the StoryForge app instead."

- `codex_push_files`: a token never writes files by path.
- `codex_delete_ledger_item`, `codex_delete_knowledge`, `codex_delete_state_event`: nothing is deleted. Retire a ledger item by status; end a state with a later item.
- `codex_set_continuity_thresholds`: thresholds and severities are the author's (§4).

No tool unlocks a doc, changes the AI level, changes an accepted scene or touches Codex entries.

## 9. The context pack

`GET /context?chapter=N[&budget=C]` and `codex_get_context` (`chapter`, `budget?`). Read only; `chapter` is required.

The answer is `{ chapter, budget, chars, <sections>, truncated }`. The sections, in priority order:

| Section | Holds |
|---|---|
| `workspace` | `workspace/book` and `workspace/style`, as `{ path, title, body }`, when they have text. |
| `story` | `logline`, `premise`, `protagonist_goal` of the story plan. |
| `scene_plans` | Each scene of chapter N with a plan: fields, notes, and the beats it sits in. |
| `cast` | Chapter N's scene casts (the plan's characters, then the protagonist, when there are none): id, slug, name, type, role, one-line summary. |
| `knowledge` | What each `pov` or `appears` character knows at the end of chapter N-1. |
| `open_ledger` | Open promises and questions set up before N, and clues planted before N and not yet revealed. |
| `state_events` | State events up to chapter N-1 (events before the story first). |
| `state_docs` | The latest state docs. |
| `previous_tail` | The last about 1500 characters of the chapter before N, from a paragraph or sentence break when one is near; `null` when none. |
| `continuity` | Findings that touch chapter N. |

- `budget` is a number of characters: 500 to 200000, default 24000. The sections together take at most `budget`; `chars` is what they took.
- Priority is strict. When a section does not fit, whole items are kept while they fit, then (for `workspace`, `story` and `state_docs`) the next item's text is cut short with an ellipsis, and every later section is left out. Each later section keeps its empty form.
- `truncated` lists every section that was cut or left out while it had content.

## 10. Gates and limits

- `integrations` off for the book: every v1 route is `403 MODULE_OFF`.
- `workspace` off: §3. `continuity` off: the v1 `/continuity` routes are `403 MODULE_OFF`.
- `body` of a request is at most 5 MB; a doc body at most 2 MB; an `append` text at most 200000 characters.
- A write that would add a validation error to the book is refused and nothing is written (`ROLLED_BACK` for state items).
- The AI Workspace tab shows the sections Overview, Docs, Chapter state, Ledgers, AI tasks and AI Activity.

## 11. Checks that exist

- `apps/web/test/ai-level.test.mjs`, `apps/server/test/ai-activity.test.mjs`: the level setting and AI Activity.
- `apps/server/test/workspace-routes.test.mjs`, `ledger-routes.test.mjs`, `plugin-ledger.test.mjs`, `plugin-cowriter.test.mjs`: the app and v1 routes.
- `packages/mcp/test/workspace-tools.test.mjs`, `ledger-tools.test.mjs`, `cowriter-tools.test.mjs`: the tools.
- `packages/core/test/workspace.test.mjs`, `ledger.test.mjs`, `cowriter.test.mjs`, `context-pack.test.mjs`, `writing-log.test.mjs`; `packages/continuity/test/workspace-rules.test.mjs`; `packages/format/test/cast-format.test.mjs`.
