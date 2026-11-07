# Connecting Claude (MCP)

StoryForge speaks the Model Context Protocol (MCP), so Claude Code and Claude Desktop can read your books and suggest changes. MCP is a front for the [plugin API](api.md): it uses the same access tokens, the same permissions and the same book grants. Nothing Claude does changes a file, with one exception: with the `canvas` permission it can create and edit canvases (planning boards, never your prose). Every other write is a suggestion you accept or decline in StoryForge.

## 1. Get a token

Open Settings, then **Connect Claude**. Give the connection a name, pick the books, and choose whether Claude may suggest changes and whether it may edit canvases (off by default). The token is shown once, with the address and ready-to-copy setup for Claude Code (and, on your own computer, Claude Desktop). The card lists your Claude connections; Revoke cuts one off at once. In shared mode only the owner sees it.

You can also make a token by hand: Settings, then Plugins, then **Grant access to another plugin** (see [plugins.md](plugins.md)).

- `read` allows the 20 read tools.
- `propose` allows the 3 propose tools.
- `canvas` allows the 5 canvas write tools. It changes only canvas files (`planning/canvases/*.canvas`), never prose.

The **Integrations** module must be on for the book. If it is off, every call is refused.

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

claude.ai custom connectors are not supported yet. They need an OAuth sign-in, and plugin tokens are static bearer tokens.

## 3. The tools

Names match the legacy StoryForgeHub `codex_*` tools wherever v2 has the same idea. A book is named by its slug or its id; start with `codex_status` or `codex_list_books` to find it.

| Tool | What it does | Permission |
|---|---|---|
| `codex_status` | Server and API version, and the books with scene and word counts. | read |
| `codex_list_books` | Every book: id, slug, title, status, series, language, counts. | read |
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
| `codex_get_canvas` | One canvas (`canvas` is its slug): the JSON Canvas, sha256, `refs` and `targets` (what a story card can link to). | read |
| `codex_save_chapter` | Propose the whole new body of one scene (`scene`, `markdown`). | propose |
| `codex_save_entry` | Propose the whole new body of one codex entry (`entry`, `markdown`). | propose |
| `codex_propose_edit` | Propose a change to a scene, entry, thread or event, as `text` or as `hunks`, not both. | propose |
| `codex_create_canvas` | Create an empty canvas (`title`, optional `slug`). | canvas |
| `codex_save_canvas` | Replace a whole canvas (`canvas`, `content`, `base_sha256` required). A stale `base_sha256` is a conflict: read it again. | canvas |
| `codex_edit_canvas` | Change a canvas by operations: `add_nodes`, `update_nodes`, `remove_nodes` (edges touching them go too), `add_edges`, `remove_edges`; optional `base_sha256`. | canvas |
| `codex_archive_canvas` | Move a canvas to the archive. | canvas |
| `codex_restore_canvas` | Move an archived canvas back. | canvas |

The propose tools also take `rationale` (shown in the review) and `base_sha256`. Pass the sha256 you read: if the file changed since, the suggestion is marked stale instead of landing on the wrong text. A propose tool answers with the suggestion and a note that nothing was changed. The suggestion appears in the normal review with `source: plugin`.

The canvas tools change the canvas file directly (there is no review step) and answer with a note saying so. Story cards are nodes of type `file` with `storyforge.ref` set to a scene, entry, thread or event id from `targets`. The **Board** module must be on for the book.

The seven planner tools (`codex_get_plan` and the `codex_list_*` tools for links, arcs, structures, relationships, synopses and clues) only read. They need the **Story Planner** module on for the book, and are refused when it is off. There is no tool that writes planner data.

### Not offered

These legacy names have no plugin route in v2. Calling one returns a clear "not available" message that tells the caller to do it in the StoryForge app.

`codex_create_chapter`, `codex_push_files`, `codex_list_docs`, `codex_get_doc`, `codex_save_doc`, `codex_append_doc`, `codex_lock_docs`, `codex_get_ledger`, `codex_save_ledger_item`, `codex_delete_ledger_item`, `codex_get_cast`, `codex_set_chapter_cast`, `codex_knowledge_at`, `codex_record_knowledge`, `codex_delete_knowledge`, `codex_continuity_check`, `codex_get_state_events`, `codex_record_state_events`, `codex_delete_state_event`, `codex_dismiss_finding`, `codex_restore_finding`, `codex_set_continuity_thresholds`, `codex_get_tasks`, `codex_update_task`, `codex_complete_task`, `codex_create_task`, `codex_log_writing`.

## Security

- Only a plugin bearer token is accepted. Cookies are never read on `/mcp`.
- A request with an `Origin` header is refused (`403`), so a web page cannot call `/mcp`. Only `POST` is allowed; the body must be `application/json`.
- The token is checked again on every tool call, and each call goes through the same rules as the plugin API: permission, granted books and the Integrations module. A book outside the grant is not visible.
- A shared server audits each tool's underlying call as `plugin.<route>`.
- Revoke the token in Settings, then Plugins, and access stops at once.
- Store the token like a password. Claude's config files hold it in plain text.
