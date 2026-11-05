# Changelog

All notable changes to StoryForge are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in [docs/compatibility.md](docs/compatibility.md).

## [Unreleased]

### Added

- **Canvases for plugins and Claude:** a new token permission `canvas` lets API v1 and MCP list, read, create, edit, archive and restore canvases (`/api/v1/books/:b/canvases`, 7 new `codex_*_canvas` tools); writes use the same sha check as the app, and Connect Claude has a new "may edit canvases" option (off by default). See [docs/mcp.md](docs/mcp.md) and [docs/api.md](docs/api.md).
- **MCP service:** `POST /mcp` (Streamable HTTP, bearer plugin token, JSON replies, no SSE or session) and `storyforge mcp`, a stdio bridge to the running server, for Claude Code and Claude Desktop. 14 tools named like the legacy `codex_*` tools (11 read, 3 propose); writes are proposals the author accepts or rejects. See [docs/mcp.md](docs/mcp.md).
- **Connect Claude** in Settings: create an MCP token for Claude (name, books, may suggest), shown once with ready-to-copy setup; list and revoke connections.
- **Canvas** (`/books/:id/canvas`): infinite visual boards for mood images, colour swatches, Markdown notes, to-do lists, web links, columns, groups and labelled arrows, plus live story cards for scenes, Codex entries, threads, events and notes that follow the book. Each canvas is a JSON Canvas file (`planning/canvases/<slug>.canvas`, Obsidian-compatible) saved through the store; the scroll wheel zooms; keys are in the shortcut registry. Contract: [docs/contracts/M09-J01-canvas.md](docs/contracts/M09-J01-canvas.md).
- **Per-book access for members** (shared mode): All books with one role, or Only these books with a role per book, for members and invites. A limited member cannot open, search or list other books; shared series data needs all-books access to change.

## [0.1.0]

The first release: milestones M00 to M08, grouped by feature family (F01 to F20 in the feature register). Known limits are in [docs/release-notes/0.1.0.md](docs/release-notes/0.1.0.md).

### Added

- **F01 Projects and library:** a library of book folders, series and pen names, new-book templates, covers (an image or a generated colour cover), book metadata and archiving; portable project and series files; a library view that finds every book under the library folder.
- **F02 Editor and reading surfaces:** a Markdown editor with a live preview, themes (including light and high contrast), focus mode, keyboard-first operation, comments, revision history, an offline save queue in shared mode, and layouts that work from a phone to a wide desktop screen.
- **F03 Structure:** series, book, act, chapter and scene, boards, an outline, a matrix view and scene metadata; deterministic order that comes back the same after an index rebuild; safe scene insert, move and renumber.
- **F04 Codex:** characters, places and things with types, custom fields, images, aliases, relations and mentions; entries shared across the books of a series; readable entity files and an indexed graph.
- **F05 Characters and arcs:** appearance, point of view, knowledge and state tracking per scene, with charts and findings that point back to their source files.
- **F06 Worldbuilding:** maps, systems and history as Codex material and shared world templates, portable as plain files.
- **F07 Plot and timelines:** beats, threads with setup and payoff, and narrative and chronological timelines as linkable records.
- **F08 AI provider management:** optional provider profiles for a local or cloud model, token and context controls, a disclosure of whether a provider is local or cloud, credentials kept in a key store, and zero network traffic until a provider is configured.
- **F09 AI writing assistance:** rewrites shown as selectable before-and-after diffs; nothing is written until the author accepts.
- **F10 AI workshop:** chat scoped to the project, a book, a scene or a selection, with an exact context preview, Send, and saved local history.
- **F11 Analysis and revision tasks:** scene, chapter and manuscript checks and revision tasks whose findings carry evidence.
- **F12 Continuity engine:** five rule families (fact conflicts, timeline, knowledge, possession and location, threads) that open the exact source lines, with stable fingerprints and exceptions kept as Markdown files.
- **F13 Notes and research:** notes, research, assets, links, tags and non-canon material kept apart from the manuscript, with relative file links and search.
- **F14 Goals and sessions:** word goals, sessions, streaks, timers and a progress dashboard from project-local activity records.
- **F15 Analytics:** rebuildable charts and an Insights dashboard computed from the files and the index.
- **F16 Import, export and backup:** export to Markdown, Word, EPUB and PDF; portable backup and restore; a legacy StoryForgeHub importer with a dry run, a rehearsal into a new folder, reconciliation and a byte-for-byte compare; deterministic output.
- **F17 Shared mode:** an optional server layer with accounts, roles, invites, read-only share links, comments, suggestions, an audit log with a hash chain, conflict handling (`409 STALE` keeps the losing text as a suggestion) and rate limits; the Markdown files stay the authority.
- **F18 Extensions:** themes, layout and prompt customization, feature modules, plugin manifests, API v1 with scoped read, propose and events tokens, and signed webhooks (separate programs; StoryForge never runs plugin code), with two sample plugins.
- **F19 Open source and operation:** the AGPL-3.0-only licence, launchers for Windows, macOS and Linux, Docker, Compose, systemd and Caddy files, an owner password reset command, no telemetry and no paywalls, accessibility and performance work with `npm run bench`, one-command CI (`npm run ci`) with a GitHub Actions workflow, a deterministic versioned release zip, and contributor, security and release documentation.
- **F20 Receipts:** a hash-linked provenance ledger of author, AI and outside changes with lineage, per-line origin, an integrity check and an exportable evidence pack; receipts are private and make no legal claim.
