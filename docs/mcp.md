# Connecting Claude (MCP)

StoryForge speaks the Model Context Protocol (MCP), so Claude Code and Claude Desktop can read your books and suggest changes. MCP is a front for the [plugin API](api.md): it uses the same access tokens, the same permissions and the same book grants. Nothing Claude does changes a file, with these exceptions: with the `canvas` permission it can create and edit canvases (planning boards); with the `plan` permission it can change your Story Plan (the Story Planner files under `planning/`); with the `workspace` permission it can write workspace docs, ledgers, a scene's cast, state events, tasks and the writing log; and with the `draft` permission it can add new chapters and scenes as AI drafts. None of them ever changes a scene you wrote or accepted, or a Codex entry. Every other write is a suggestion you accept or decline in StoryForge. The book's [AI level](#ai-level) limits all of these.

## 1. Sign in or get a token

There are two ways to give an AI client access, and both make an entry in Settings, **AI connections (MCP)**, with its own books and permissions:

- **Sign in with OAuth** (claude.ai and ChatGPT connectors, Claude Code, and any client that follows the MCP authorization spec). Give the client the address `https://<your domain>/mcp` and nothing else. It opens a StoryForge page where you (the owner, in shared mode) choose the connection's name, books and permissions, then click **Allow**. See [section 4](#4-oauth).
- **A key** made in Settings, pasted into the client. Every client that can send an `Authorization` header can use one.

### A key

Open Settings, then **AI connections (MCP)**. Pick the AI client (Claude Code, Claude Desktop on your own computer, or any other MCP client), give the connection a name, pick the books, and choose whether the AI may suggest changes, whether it may edit canvases, whether it may change the plan, whether it may write workspace docs and ledgers, and whether it may create chapters and scenes (all but the first are off by default). The token is shown once, with ready-to-copy setup for that client: the Claude Code command, the Claude Desktop config, or the address and `Authorization` header for any other client that speaks MCP over Streamable HTTP.

Make one connection per client or computer, as many as you like. Each has its own token, books and permissions, and the list shows when each was last used. Revoke cuts one off at once without affecting the others. Two live connections cannot share a name (the server answers 409 `NAME_TAKEN`); revoke the old one first to reuse its name. In shared mode only the owner sees this section.

You can also make a token by hand: Settings, then Plugins, then **Grant access to another plugin** (see [plugins.md](plugins.md)).

- `read` allows the 34 read tools (32 `codex_*` tools plus `search` and `fetch`).
- `propose` allows the 3 propose tools.
- `canvas` allows the 6 canvas write tools. It changes only canvas files (`planning/canvases/*.canvas`), never prose.
- `plan` allows the 30 plan write tools. It changes only Story Planner files under `planning/` (links, scene plans, the story plan, structures, arcs, relationships, clues, synopses), never prose, scenes or Codex entries. Each change can be undone in StoryForge. Off by default.
- `workspace` allows the 14 workspace write tools. It changes only workspace docs, ledger threads, a scene's cast, state events, tasks, the writing log and continuity dismissals, never prose, scenes or Codex entries. Each change can be undone in StoryForge. Off by default.
- `draft` allows the 3 draft tools. It creates new chapters and scenes, always marked as AI drafts, and replaces the body of an AI draft (a scene marked as AI whose status is still `drafting`). Off by default.

The **Integrations** module must be on for the book. If it is off, every call is refused.

### ChatGPT

ChatGPT's regular connectors and deep research use only two tools, by these exact names: `search` and `fetch`. StoryForge offers both, read-only:

- `search` takes `query` and looks in every book the token may read. It returns `{"results": [{"id", "title", "text", "url"}]}`, where `text` is a snippet and `url` opens the item in StoryForge. It returns scenes, codex entries, plot threads and timeline events.
- `fetch` takes an `id` from `search` (`<book slug>/<item id>`). It returns `{"id", "title", "text", "url", "metadata"}`: the full text of a scene or entry, or the details of a thread or event.

Add the connector with the address `https://<your domain>/mcp` and choose OAuth: ChatGPT signs in through StoryForge (section 4). In ChatGPT's developer mode every tool is offered, as for Claude.

## 2. Pick a way in

StoryForge must be running in both cases.

| | Streamable HTTP | stdio bridge |
|---|---|---|
| Works with | personal and shared servers | the StoryForge running on this computer |
| Token goes in | `Authorization: Bearer <token>` header | `STORYFORGE_TOKEN` environment variable |
| Address | `http://127.0.0.1:4317/mcp` or `https://<your domain>/mcp` | none; it finds the local server |

### Streamable HTTP

`POST /mcp` takes one JSON-RPC message and answers with JSON. There is no SSE stream and no session. A notification gets `202` and no body.

```sh
claude mcp add --transport http storyforge http://127.0.0.1:4317/mcp --header "Authorization: Bearer <token>"
```

For a shared server, use its public address:

```sh
claude mcp add --transport http storyforge https://<your domain>/mcp --header "Authorization: Bearer <token>"
```

### stdio bridge

The bridge is `storyforge mcp`. It reads JSON-RPC lines on stdin and forwards each one to `POST /mcp` of the StoryForge already running on this computer. It only talks to `127.0.0.1`.

```sh
STORYFORGE_TOKEN=<token> node <install>/apps/server/src/main.mjs mcp [--library <path>] [--port <n>]
```

Run it through `node ... main.mjs`. `StoryForge.cmd` and `storyforge.sh` always start the server (they put `--open` before your arguments), so they cannot run `mcp`.

The bridge picks the port in this order:

1. `--port <n>`, a whole number from 1 to 65535.
2. The port the running server wrote into the library's lock file (`--library <path>` chooses the library).
3. `STORYFORGE_PORT`, else `4317`.

The token comes from the environment only, never from a flag, because flags show in the process list. Without a valid `STORYFORGE_TOKEN` the bridge exits with code 2. Messages for people go to stderr; stdout carries only protocol messages.

Claude Code:

```sh
claude mcp add storyforge --env STORYFORGE_TOKEN=<token> -- node <path>/apps/server/src/main.mjs mcp
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "storyforge": {
      "command": "node",
      "args": ["<path>/apps/server/src/main.mjs", "mcp"],
      "env": { "STORYFORGE_TOKEN": "<token>" }
    }
  }
}
```

Restart Claude Desktop after you edit the file.

### claude.ai

In claude.ai, open Settings, Connectors, **Add custom connector**, and give it the address `https://<your domain>/mcp`. Leave the OAuth client ID and secret empty: Claude registers itself. Claude opens StoryForge to sign in (section 4).

## 3. The tools

Names match the legacy StoryForgeHub `codex_*` tools wherever v2 has the same idea. A book is named by its slug or its id; start with `codex_status` or `codex_list_books` to find it.

| Tool | What it does | Permission |
|---|---|---|
| `codex_status` | Server and API version, and the books with scene and word counts and each book's `ai_level`. | read |
| `codex_list_books` | Every book: id, slug, title, status, series, language, counts, `ai_level`. | read |
| `codex_list_chapters` | A book's acts, chapters and scenes. | read |
| `codex_get_chapter` | Every scene of one chapter, with body and sha256. Takes `chapter`, and `act` if the number repeats. | read |
| `codex_get_scene` | One scene: metadata, front matter, sha256, body. | read |
| `codex_list_entries` | Codex entries of a book; `type` keeps one kind. | read |
| `codex_get_entry` | One codex entry by id or slug, with sha256 and body. | read |
| `codex_search` | Text search over scenes and entries; `book` is optional, `limit` is 1 to 100 (default 20). | read |
| `codex_get_diagnostics` | The problems StoryForge found in a book. | read |
| `codex_list_threads` | The plot threads of a book. | read |
| `codex_get_timeline` | The timeline events of a book. | read |
| `codex_list_canvases` | The canvases of a book (and the archived ones): slug, title, counts, sha256. | read |
| `codex_get_plan` | A book's story plan fields and notes, and the planner counts. | read |
| `codex_list_plan_links` | The causal links between scenes (and beats): from, to, relation, optional what-if `branch`, rationale. | read |
| `codex_list_arcs` | The character arcs, with their milestones. | read |
| `codex_list_structures` | The story structures, with their beats and the scenes assigned to each. | read |
| `codex_list_relationships` | The relationships between two entries, with their developments. | read |
| `codex_list_synopses` | The synopses: type, name, word count, target, and whether the plan sources changed. | read |
| `codex_list_clues` | The clues: fact, kind, where planted and revealed, red herrings, and who learns it where. | read |
| `codex_get_scene_plan` | The plan of one scene (`scene` is its id): planning fields, characters, notes, sha256. | read |
| `codex_get_plan_check` | The plan check, rules PL1 to PL6: rule, severity, title, message, subject, `related` ids. | read |
| `codex_list_structure_templates` | The structure templates (three-act and so on) with their beats. | read |
| `codex_get_canvas` | One canvas (`canvas` is its slug): the JSON Canvas, sha256, `refs` and `targets` (what a story card can link to). | read |
| `codex_list_docs` | The workspace docs of a book (and archived ones): path, title, kind, chapter, locked, sha256. | read |
| `codex_get_doc` | One workspace doc by `path`: title, locked, body, sha256. | read |
| `codex_get_ledger` | The promises, questions and clues ledger. | read |
| `codex_get_cast` | The cast of each scene (pov, appears, mentioned); `chapter` keeps one chapter. | read |
| `codex_knowledge_at` | What a `character` knows by the end of chapter `at` (all of it without `at`). | read |
| `codex_get_state_events` | The state events (died, revived, destroyed, lost, found, holder, location); `chapter` keeps one chapter. | read |
| `codex_get_tasks` | The revision tasks and counts; filter by `status` or `for` (`ai` or `author`). | read |
| `codex_continuity_check` | The continuity findings, the dismissed ones and stale dismissals. `chapter` keeps one chapter; with `chapter` and `cast` (`[{ entry, role }]`) it also checks a planned cast. | read |
| `codex_get_context` | The context pack for writing chapter `chapter`, trimmed to `budget` characters (default 24000). | read |
| `codex_save_chapter` | Propose the whole new body of one scene (`scene`, `markdown`). | propose |
| `codex_save_entry` | Propose the whole new body of one codex entry (`entry`, `markdown`). | propose |
| `codex_propose_edit` | Propose a change to a scene, entry, thread or event, as `text` or as `hunks`, not both. | propose |
| `codex_create_canvas` | Create an empty canvas (`title`, optional `slug`). | canvas |
| `codex_save_canvas` | Replace a whole canvas (`canvas`, `content`, `base_sha256` required). A stale `base_sha256` is a conflict: read it again. | canvas |
| `codex_edit_canvas` | Change a canvas by operations: `add_nodes`, `update_nodes`, `remove_nodes` (edges touching them go too), `add_edges`, `remove_edges`; optional `base_sha256`. | canvas |
| `codex_add_plan_cards` | Put a story card on a canvas for each id in `refs` (1 to 100) that is not on it yet, in a grid below the existing cards. Places cards only; never changes the plan. | canvas |
| `codex_archive_canvas` | Move a canvas to the archive. | canvas |
| `codex_restore_canvas` | Move an archived canvas back. | canvas |
| `codex_save_story_plan` | Set some story plan fields and/or the notes. | plan |
| `codex_save_scene_plan` | Set some planning fields and/or the characters of one scene. | plan |
| `codex_create_link`, `codex_update_link` | Create or change a causal link between scenes or beats (`from`, `to`, `relation`, optional `branch`). | plan |
| `codex_archive_link`, `codex_restore_link` | Archive a link or bring it back. | plan |
| `codex_create_structure`, `codex_update_structure` | Start a structure from a template, or change its name and notes. | plan |
| `codex_set_beats` | Write the whole beat list of a structure, including each beat's scenes. | plan |
| `codex_archive_structure`, `codex_restore_structure` | Archive a structure or bring it back. | plan |
| `codex_create_arc`, `codex_update_arc` | Start a character arc (`character` is an entry id), or change its type, fields and notes. | plan |
| `codex_set_arc_milestones` | Write the whole milestone list of an arc. | plan |
| `codex_archive_arc`, `codex_restore_arc` | Archive an arc or bring it back. | plan |
| `codex_create_relationship`, `codex_update_relationship` | Start a relationship between two entries (`a`, `b`), or change its fields and notes. | plan |
| `codex_set_relationship_developments` | Write the whole development list of a relationship. | plan |
| `codex_archive_relationship`, `codex_restore_relationship` | Archive a relationship or bring it back. | plan |
| `codex_create_clue`, `codex_update_clue` | Start a clue, reveal or secret, or change it. | plan |
| `codex_set_clue_knowers` | Write the whole list of who learns a clue, and where. | plan |
| `codex_archive_clue`, `codex_restore_clue` | Archive a clue or bring it back. | plan |
| `codex_create_synopsis`, `codex_update_synopsis` | Start a synopsis of a type, or change its name, target and text. | plan |
| `codex_archive_synopsis`, `codex_restore_synopsis` | Archive a synopsis or bring it back. | plan |
| `codex_save_doc` | Create a workspace doc, or replace the whole body of one (`path`, `body`, `title?`; `base_sha256` required for an existing doc). A locked doc is refused (`LOCKED`). | workspace |
| `codex_append_doc` | Append `text` to a doc (created when missing). No `base_sha256` needed. | workspace |
| `codex_lock_docs` | Lock one doc (`path`) or a chapter's state docs (`prefix`, for example `state/chapter-04`). There is no unlock tool. | workspace |
| `codex_setup_workspace` | Create the starter docs that do not exist yet. | workspace |
| `codex_save_ledger_item` | Create a promise or question (`title`, `kind`), or update one by `slug` (`status`, `setup`, `develop`, `payoff`, `characters`). Retire it with status `paid` or `dropped`. | workspace |
| `codex_set_chapter_cast` | Set the whole cast of one scene (`scene`, `cast`: `[{ entry, role }]`). | workspace |
| `codex_record_knowledge` | Record that a `character` learns a `fact` in a `chapter`. | workspace |
| `codex_record_state_events` | Record state events of a `chapter` (`items`: `[{ subject, kind, value? }]`). | workspace |
| `codex_create_task` | Create a task (`title`, `notes?`, `labels?`, `for?`). | workspace |
| `codex_update_task` | Change a task's `status` and/or `for`. | workspace |
| `codex_complete_task` | Mark a task done. | workspace |
| `codex_log_writing` | Add `words` an AI wrote to today's AI words in the writing log. | workspace |
| `codex_dismiss_finding` | Dismiss a continuity finding (`fingerprint`) with a `reason`. | workspace |
| `codex_restore_finding` | Bring a dismissed finding back (`finding`: fingerprint or dismissal slug). | workspace |
| `codex_create_chapter` | Create a new empty chapter (`title`, `after` or `act`). | draft |
| `codex_create_scene` | Create a new AI draft scene (`chapter`, `title`, `body`, `summary?`, `after?`). | draft |
| `codex_save_draft` | Replace the body of an unaccepted AI draft (`scene`, `body`, `base_sha256`). | draft |

The propose tools also take `rationale` (shown in the review) and `base_sha256`. Pass the sha256 you read: if the file changed since, the suggestion is marked stale instead of landing on the wrong text. A propose tool answers with the suggestion and a note that nothing was changed. The suggestion appears in the normal review with `source: plugin`.

The canvas tools change the canvas file directly (there is no review step) and answer with a note saying so. Story cards are nodes of type `file` with `storyforge.ref` set to an id from `targets` (a scene, entry, thread or event, or a planner item: story plan, structure, beat, arc, relationship, synopsis or clue). The **Board** or the **Story Planner** module must be on for the book.

The planner read tools (`codex_get_plan`, `codex_get_scene_plan`, `codex_get_plan_check`, `codex_list_structure_templates` and the `codex_list_*` tools for links, arcs, structures, relationships, synopses and clues) need the **Story Planner** module on for the book, and are refused when it is off. Their answers carry each item's `sha256` but no file paths.

The plan write tools (permission `plan`) run the app's own planner routes, so they follow the same rules as the Plan tab: a stale `base_sha256` is a conflict (read the item again), and a refused value is refused with the app's words. Pass `base_sha256` from the get or list tool: it is required to change an existing item (the story plan and a scene plan need none while they have no file yet). The `set_*` tools (`codex_set_beats`, `codex_set_arc_milestones`, `codex_set_relationship_developments`, `codex_set_clue_knowers`) replace the whole list, so read it first and send it back with your change; keep each beat's `id`. The plan tools offer no dry run and no scene plan notes. They answer with the app's result (including `opId`) and a note that the author can Undo the change in StoryForge. They need the **Story Planner** module on too.

The workspace tools (permission `workspace`) run the app's own routes too. A doc address is `workspace/<name>` (`workspace/book` and `workspace/style` are the book settings and style guide), `state/chapter-NN/<name>` where `<name>` is `situation`, `characters`, `knowledge` or `inventory`, or `development/<name>` for proposals that are never canon. Changing an existing doc needs the `base_sha256` from `codex_get_doc` or `codex_list_docs`; a stale one is a conflict, so read it again. A locked doc is refused; only you unlock it, in StoryForge. Nothing is deleted: retire a ledger item by status, end a state with a later state event, dismiss a finding with a reason (you can restore it). The **AI Workspace** module must be on for the book for docs, cast, knowledge, state events and the writing log; ledger threads also need **Threads**, tasks need **Tasks**, and finding dismissals need **Continuity**.

The draft tools (permission `draft`, book level `cowriter`) make scenes that are drafts marked as AI (`origin: ai`, status `drafting`) whatever the call says, and add the words to the AI words of the writing log. `codex_save_draft` works only on such a scene while its status is still `drafting`; otherwise it is refused (`NOT_AI_DRAFT`) and the change must go through `codex_propose_edit`. You accept a draft by changing its status. A chapter or scene an AI created is archived, not undone: AI Activity shows an **Archive** button for it.

### AI level

Each book has an AI level that caps every connection, whatever permissions its token holds: `off` (read only), `advisor` (suggest edits, create tasks), `planner` (also plan, canvases, workspace docs, ledgers, state, the writing log, finding dismissals) and `cowriter` (also create chapters and scenes). A book that sets none is `planner`. Only you set it, in Settings, **AI level**, or as `preferences: { ai: { level: ... } }` in `book.md` (or `library.md` for the default). A call above the level is refused with `AI_LEVEL` and nothing is written; a call whose permission the token lacks is refused with `PLUGIN_SCOPE`. `codex_status` shows each book's `ai_level`. See [contracts/M12-ai-workspace.md](contracts/M12-ai-workspace.md).

### Example: a canvas for a character

With the `read`, `canvas` and `plan` permissions, "make a canvas for a character" is:

1. `codex_list_entries` (`book`, `type: "character"`) to find the character's entry id.
2. `codex_create_canvas` (`book`, `title: "Protagonist"`) answers with the new `slug`.
3. `codex_add_plan_cards` (`book`, `canvas`: that slug, `refs`: the entry id plus the scene, arc, relationship and clue ids to show) places a story card for each. `codex_get_canvas` lists the valid ids as `targets`.
4. Arrange or label them with `codex_edit_canvas` (`add_nodes`, `update_nodes`, `add_edges`).

Steps 2 to 4 need only `canvas`; `plan` is for changing the plan itself (for example `codex_create_arc` for that character first).

### Not offered

These legacy names have no plugin route in v2. Calling one returns a clear "not available" message that tells the caller to do it in the StoryForge app.

`codex_push_files`, `codex_delete_ledger_item`, `codex_delete_knowledge`, `codex_delete_state_event`, `codex_set_continuity_thresholds`.

Nothing is deleted through MCP (retire or end instead, see above). The continuity thresholds and severities, the AI level and unlocking a doc are yours alone.

## 4. OAuth

StoryForge is its own OAuth 2.1 authorization server for the MCP service, as the MCP authorization spec describes. It is meant for a shared server with a public `https` address (`STORYFORGE_PUBLIC_URL`); in personal mode it answers on this computer only.

1. The client calls `POST /mcp` without a token and gets `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`.
2. It reads that document (RFC 9728), which names the resource `<origin>/mcp` and this server as its authorization server, then `/.well-known/oauth-authorization-server` (RFC 8414).
3. It registers itself at `POST /oauth/register` (RFC 7591). Redirect URIs must be `https`, or `http` to `127.0.0.1`, `[::1]` or `localhost`. Registration is limited to 10 an hour per address and 30 an hour in all, and at most 200 clients are kept; registering grants nothing.
4. It sends you to `/oauth/authorize`. You sign in if needed. The page names the app and the site you return to, and you choose the connection's name, books and permissions (`read` always; `propose` is ticked; `canvas`, `plan`, `workspace` and `draft` are off unless you tick them). In shared mode only the owner can see or answer it. **Deny** returns `access_denied` to the app.
5. **Allow** makes an ordinary AI connection (`mcp-<name>`) and sends the browser back with a one-time code (10 minutes). The client exchanges it at `POST /oauth/token` with its PKCE verifier; only `S256` is accepted.
6. The access token lasts one hour and works only at `/mcp` (API v1 refuses it). The refresh token lasts 90 days and is replaced at each refresh; a used one stops working.

Revoke the connection in Settings and every token of it stops at once. When the app disconnects and revokes its refresh token (`POST /oauth/revoke`, RFC 7009), the connection is revoked too. The book's AI level and the Integrations module apply exactly as for a key.

Public clients (no secret, the usual case) and clients with a secret (`client_secret_post` or `client_secret_basic`) are both accepted. Clients, and the hashes of access and refresh tokens, are kept in `oauth.json` next to `plugin-tokens.json`; codes are kept in memory only, so a restart in the middle of a sign-in means signing in again. Shared mode audits registrations, token issues and refreshes, and revocations (`oauth.*`) and the owner's answer (`admin.oauth-approve`, `admin.oauth-deny`).

## Security

- Only a plugin bearer token is accepted. Cookies are never read on `/mcp`.
- A request with an `Origin` header is refused (`403`), so a web page cannot call `/mcp`. Only `POST` is allowed; the body must be `application/json`.
- The token is checked again on every tool call, and each call goes through the same rules as the plugin API: permission, granted books, the Integrations module and the book's AI level. A book outside the grant is not visible.
- A shared server audits each tool's underlying call as `plugin.<route>`.
- Revoke the token in Settings, then Plugins, and access stops at once.
- Store the token like a password. Claude's config files hold it in plain text.
