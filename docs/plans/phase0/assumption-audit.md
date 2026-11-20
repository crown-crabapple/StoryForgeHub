# Phase 0 assumption audit

Every place in the repo that states or enforces one of three assumptions the hosted redesign ([hosted-authoring-plan.md](../hosted-authoring-plan.md)) replaces: the Markdown library on disk is canonical, the app runs on loopback only, no account is needed. Line numbers are from the worktree at `feat/phase0-hosted-foundation`.

Dispositions: **Supersede** (whole doc or rule replaced), **Amend** (a passage changes), **Keep** (still true, for example Markdown import/export behaviour or loopback rules for outbound AI/webhook/OAuth targets).

Where one file repeats a finding, the rows are merged and list several line numbers. Contract files not named below mention disk or Markdown only in passing and are not listed.

## 1. Storage canon (files are the truth)

| Location | Quote | Disposition | Reason |
| --- | --- | --- | --- |
| docs/decisions/0001-local-web-app-stack.md:1 | "Local web app on Node, React and built-in SQLite" | **Supersede** | Whole ADR is the local file-canonical stack; plan section 4 replaces it. |
| docs/decisions/0001-local-web-app-stack.md:7 | "The project folder of Markdown files is the only source of truth" | **Supersede** | Database becomes the source of truth. |
| docs/decisions/0001-local-web-app-stack.md:41 | "database is authoritative there; contradicts DECISIONS 1 and 5" | **Supersede** | A rejected alternative that is now the chosen direction. |
| docs/decisions/0001-local-web-app-stack.md:46 | "every read and write goes through the server and `FileRepository`" | **Supersede** | Repository interface is file-backed. |
| docs/decisions/0002-scene-editor-codemirror.md:20 | "what's on disk is exactly what's typed" | **Supersede** | Text-preserving editing of the file is the ADR's premise. |
| docs/decisions/0003-story-planner.md:15, 19, 27, 88, 100, 157 | "Kept on disk"; "files are found by `walkMarkdown`"; "A link file on disk always means" | **Amend** | Plan section 4: ADR stays, its storage section is amended. |
| README.md:15 | "Markdown is canonical and the folder is the whole project." | **Amend** | Guarantee list; Markdown becomes import/export. |
| docs/format.md:3-4 | "The folder is the whole book... StoryForge keeps no database that you need" | **Amend** | Opening claim of the format spec no longer holds. |
| docs/format.md:29, 433 | ".storyforge/ ... (disposable)" | **Amend** | Index-as-cache model is file-specific. |
| docs/format.md:36-37 and the rest of the spec | "Every file is UTF-8 text, Markdown with a block of settings" | **Keep** | Defines the import source and Markdown export shape. |
| docs/install.md:39-40 | "The folder is everything the author wrote"; "It is **disposable**" | **Amend** | Data-location table. |
| docs/install.md:47-48 | "any ordinary copy of it is a backup" | **Amend** | Copying a folder is not a backup of a hosted book. |
| docs/self-hosting.md:6 | "nothing moves into a database" | **Supersede** | Direct opposite of the new design. |
| docs/self-hosting.md:19 | "This is the canonical copy of the writing." | **Supersede** | `/library` mount is no longer canonical. |
| docs/self-hosting.md:25 | "There is no database service." | **Supersede** | PostgreSQL is added (plan Phase 1). |
| docs/compatibility.md:21 | "Files are rewritten only when the author runs an explicit upgrade" | **Amend** | Upgrade path is a database migration after import. |
| docs/compatibility.md:46-48 | ".storyforge/index.sqlite is a disposable projection of the Markdown files" | **Amend** | Projection of files is replaced by the database. |
| docs/compatibility.md:65 | "Exports (Markdown, Word, EPUB, PDF) are deterministic" | **Keep** | Export determinism carries over (plan Phase 5). |
| docs/customization.md:135, 141, 234 | "keeps its files on disk, untouched"; prompts are Markdown files in `_prompts` | **Amend** | Module data and prompts live in files today. |
| docs/privacy-ai.md:69 | "These files are part of the book and go into backups." | **Amend** | AI records are book files. |
| docs/plugins.md:86 | "a Codex entry, a receipt, or any other canonical file" | **Amend** | Plugin write limits are phrased in files; propose-only rule stays. |
| docs/development.md:74 | "Files are written only in `packages/store`." | **Amend** | Layer rule is file-specific. |
| docs/migration.md:61, 72 | "compares the dump with the files on disk" | **Keep** | Legacy importer behaviour is import-source material. |
| docs/migration.md:3 | "legacy StoryForgeHub (the web version with a database)" | **Keep** | Historical description. |
| CONTRIBUTING.md:44 | "Markdown is canonical." | **Supersede** | Contribution rule, replaced by database authority. |
| packages/manuscript/CONTRACT.md:25-26, 41-42 | "Creates a new scene file"; "moves the file to its canonical path" | **Amend** | Scene operations are file operations. |
| docs/contracts/M01-J01-app-boundary.md:38, 46 | "body exactly as on disk"; "implements the interface on disk" | **Supersede** | `FileRepository` is the file-backed boundary. |
| docs/contracts/M01-J02-writer-recovery.md:46, 106 | "Found on disk"; "modify the file on disk with plain `fs.writeFile`" | **Supersede** | Journaled file writes and external-edit conflicts are file semantics. |
| docs/contracts/M01-J03-projection.md:8, 78 | "stores **no canonical field the files don't hold**" | **Supersede** | The index is a projection of files. |
| docs/contracts/M01-J04-reconcile.md:57 | "clears `invalid` if the files are now valid" | **Supersede** | Watcher/reconcile model is for files. |
| docs/contracts/M02-J03-new-book.md:3, 20 | "with no database setup"; "Template files are otherwise valid Markdown" | **Amend** | Gate wording; templates become seed data. |
| docs/contracts/M03-J03-reorder.md:12, 18, 36, 39 | "changed on disk since it was read"; "canonical filename/folder" | **Supersede** | Reorder renames files; becomes a record ordering. |
| docs/contracts/M04-J02-codex-browser.md:12 | "Create / edit / archive (canonical files only)" | **Amend** | Codex writes go to records. |
| docs/contracts/M05-J01-continuity-rules.md:69, 161 | "`.storyforge/` is never read"; "computed from files on each call" | **Amend** | Rule inputs are file reads. |
| docs/contracts/M05-J02-continuity-review.md:34 | "`file` must be a canonical book file" | **Amend** | Context route addresses files. |
| docs/contracts/M05-J03-export-backup.md:5, 34 | "Export **reads** the canonical files and produces bytes." | **Amend** | Exporter reads the database; fidelity checks stay. |
| docs/contracts/M05-J05-claude-book-adapter.md:20 | "sources = every canonical file read" | **Amend** | Adapter reads the Markdown tree. |
| docs/contracts/M05-J06-author-check-suggest.md:5, 9, 15 | "changes a canonical file only when the author accepts it" | **Amend** | Suggestion target is a file ID; the author-only rule stays. |
| docs/contracts/M05-J07-receipts.md:60 | "`external.change` ... already on disk" | **Amend** | Receipt event for file changes. |
| docs/contracts/M06-J02-import-rehearsal.md:39, 44, 48, 58 | "compares ... with one taken from the **files on disk**" | **Keep** | Legacy-import rehearsal; informs the Phase 1 importer. |
| docs/contracts/M07-J01-shared-worlds-customization.md:74 | "`_templates/` is not a book or series" | **Amend** | Folder-scanner rule. |
| docs/contracts/M07-J02-goals-analytics-tasks.md:116 | "parsed and written back byte-identical when untouched" | **Amend** | Byte-identical file round trip. |
| docs/contracts/M07-J03-shared-mode.md:3, 5 | "optional server layer retains file authority"; "Nothing canonical moves into a server database" | **Supersede** | The central shared-mode premise. |
| docs/contracts/M07-J03-shared-mode.md:93, 161 | "author data, non-canonical"; "A's text is on disk" | **Amend** | Comments and suggestion proof are file-based. |
| docs/contracts/M07-J04-customization-modules.md:67 | "its files stay on disk untouched" | **Amend** | Module off-switch semantics. |
| docs/contracts/M08-J01-deployment.md:43, 55 | "No database service."; "the `library/` folder, which is canonical" | **Supersede** | Deployment and backup scope. |
| docs/contracts/M08-J02-extensions-api-webhooks.md:5 | "It can never write a canonical file." | **Amend** | Propose-only stays; "canonical file" wording changes. |
| docs/contracts/M08-J05-ci-release.md:78 | "Markdown is canonical, and the folder is the whole project" | **Supersede** | Release guarantee text. |
| docs/contracts/M09-J01-canvas.md:3, 35, 72 | "files are canonical"; "This canvas changed on disk" | **Amend** | Canvas files and conflict banner. |
| docs/contracts/M10-plan-canvas.md:3, 5 | "stay the only copy of the plan" | **Supersede** | Planning data moves to database records (Phase 1). |
| packages/manuscript/src/indexfile.mjs:1 | "The disposable index: .storyforge/index.json." | **Amend** | Comment describes the file-side index. |
| packages/export/src/manuscript.mjs:1 | "built from the canonical files (read-only)" | **Amend** | Comment; assembler reads files. |
| packages/mcp/src/tools.mjs:3 | "prose or a canonical file: the propose tools create a suggestion" | **Amend** | MCP handlers move to the database; propose semantics stay. |
| packages/core/src/fs-writes.mjs:1084, 1099, 1144 | "canonical files only; dryRun previews with diffs" | **Amend** | Comments on file-write sections. |
| packages/format/test/build-fixtures.mjs:3 | "The committed fixtures are the source of truth" | **Keep** | Fixtures seed the Phase 0 import fixture. |

## 2. Local-only / loopback binding

| Location | Quote | Disposition | Reason |
| --- | --- | --- | --- |
| docs/decisions/0001-local-web-app-stack.md:17 | "A local server bound to `127.0.0.1`, opened in the browser" | **Supersede** | Hosted app with authentication. |
| docs/decisions/0001-local-web-app-stack.md:48 | "The server must refuse non-loopback connections until M07 adds auth." | **Supersede** | Same. |
| SECURITY.md:21 | "Personal mode listens on `127.0.0.1` only, has no accounts" | **Amend** | Threat model statement for the local mode. |
| SECURITY.md:47 | "bypasses of roles, share links, plugin tokens, the loopback, `Host`" | **Amend** | In-scope list names loopback guard. |
| README.md:33 | "Then open `http://127.0.0.1:4317/`." | **Amend** | Quick start. |
| docs/install.md:4, 62 | "The app listens on `127.0.0.1` only" | **Amend** | Install guide for local use. |
| docs/troubleshooting.md:17 | "The address is always `127.0.0.1`." | **Amend** | Port troubleshooting. |
| docs/development.md:20, 23, 26, 28, 50, 96 | "serves the library on `127.0.0.1:4317`"; "(loopback only)" | **Keep** | Dev loop and test servers stay local, whatever production does. |
| docs/self-hosting.md:7 | "listens on `127.0.0.1` only" | **Amend** | Mode summary. |
| docs/self-hosting.md:49, 53, 56 | "Compose publishes the app on `127.0.0.1:4317` of the host only." | **Amend** | Default publish address and personal-mode note. |
| docs/self-hosting.md:68, 86, 94, 100, 117, 130 | "STORYFORGE_HOST=127.0.0.1 so that only the proxy can reach the app" | **Keep** | Proxy-fronted binding is still a valid hosted topology. |
| docs/self-hosting.md:224 | "TLS is required for anything that is not loopback." | **Keep** | Still true for hosting. |
| docs/privacy-ai.md:5 | "The app listens on `127.0.0.1` only, has no account" | **Amend** | Privacy summary. |
| docs/privacy-ai.md:17 | "the host is `localhost`, `127.0.0.1` or `[::1]`" | **Keep** | AI provider locality rule. |
| docs/api.md:39 | "Personal mode answers loopback clients only." | **Amend** | Auth description of `/api/v1`. |
| docs/api.md:447, 468 | "cannot subscribe an address on this computer" | **Keep** | Webhook target rules. |
| docs/mcp.md:46, 53, 64 | "`http://127.0.0.1:4317/mcp` or `https://<your domain>/mcp`"; "only talks to `127.0.0.1`" | **Amend** | Connection docs; the bridge is loopback by design. |
| docs/mcp.md:232 | "Redirect URIs must be `https`, or `http` to `127.0.0.1`" | **Keep** | OAuth native-app rule (RFC 8252). |
| docs/plugins.md:78 | "use `http://127.0.0.1:8787/` as the address" | **Keep** | Example webhook receiver. |
| deploy/compose.yaml:6, 21 | "The app listens on 127.0.0.1:4317 of this machine only." | **Amend** | Default port publish. |
| deploy/storyforge.env.example:4, 14, 17, 21 | "personal has no accounts and listens on 127.0.0.1" | **Amend** | Env documentation. |
| deploy/entrypoint.mjs:7, 16, 30-32 | "personal refuses anything else, like the CLI" | **Amend** | Comment and refusal of non-loopback host in personal mode. |
| deploy/install-server.sh:10, 21, 167, 193, 195 | "shared mode, 127.0.0.1, the public https address" | **Keep** | Proxy-behind topology. |
| deploy/Caddyfile.example:3; deploy/storyforge.service:5 | "use 127.0.0.1:4317 instead" | **Keep** | Reverse-proxy examples. |
| StoryForge.cmd:3; storyforge.sh:3 | "later runs go straight to the browser." | **Amend** | Launchers open the local app; no loopback literal in the scripts. |
| docs/contracts/M01-J01-app-boundary.md:52, 70, 82 | "Host is always `127.0.0.1` in this job (no flag to change it)." | **Supersede** | Loopback and Host guard. |
| docs/contracts/M01-J02-writer-recovery.md:81 | "loopback + Host guard (J01), `content-type: application/json`" | **Amend** | Write guard definition. |
| docs/contracts/M05-J02-continuity-review.md:12 | "Same write guards as every write route (loopback, Host" | **Amend** | Guard wording. |
| docs/contracts/M05-J03-export-backup.md:50 | "write-guarded: loopback, Host, `x-storyforge: 1`" | **Amend** | Restore route guard. |
| docs/contracts/M05-J04-ai-workshop.md:11, 17, 48 | "`http:` to non-loopback hosts (cloud must be https)" | **Keep** | Outbound AI transport rule. |
| docs/contracts/M07-J03-shared-mode.md:5, 15, 16 | "No accounts, no login, `127.0.0.1` only"; "`--host` other than `127.0.0.1`/`::1` is refused" | **Amend** | Defines personal mode as loopback-only. |
| docs/contracts/M07-J03-shared-mode.md:169 | "personal `serve` binds only to loopback, has no auth routes" | **Amend** | Acceptance item. |
| docs/contracts/M07-J05-privacy-conflict-proof.md:59 | "the server listens only on loopback (check the socket address)" | **Amend** | Privacy proof item. |
| docs/contracts/M08-J01-deployment.md:29, 41, 61, 89 | "binds 127.0.0.1 inside the container"; "TLS is required for non-loopback access" | **Amend** | Deployment contract; TLS line is Keep. |
| docs/contracts/M08-J02-extensions-api-webhooks.md:41, 95 | "Personal mode stays loopback-only for every request." | **Amend** | Plugin API auth. |
| packages/core/src/config.mjs:1, 8, 46, 72 | "Host is always loopback in this version." | **Supersede** | `HOST = '127.0.0.1'` with no override. |
| apps/server/src/security.mjs:1, 3, 17, 26 | "Request guards: loopback-only clients and a Host check" | **Amend** | Personal-mode guard; Host check applies to hosting too. |
| apps/server/src/server.mjs:1, 156, 160, 284 | "loopback clients only, no accounts, no policy." | **Amend** | Personal path of the request handler. |
| apps/server/src/shared-cli.mjs:16-19 | "PERSONAL_HOST = '127.0.0.1'"; `isLoopbackHost` | **Amend** | Constants behind the CLI refusal. |
| apps/server/src/main.mjs:283, 298, 300 | "--host ... is refused: without --shared StoryForge listens on" | **Amend** | CLI refuses non-loopback host in personal mode. |
| apps/server/src/shared-gate.mjs:2, 40-47 | "personal mode keeps its loopback-only guard and has no accounts" | **Amend** | Host allow-list. |
| apps/server/src/help.mjs:31, 33, 36 | "Without it nothing changes: no accounts, 127.0.0.1 only." | **Amend** | CLI help text. |
| apps/server/src/open-browser.mjs:1 | "the URL is the loopback address of this process" | **Amend** | `--open` assumes a local browser. |
| packages/mcp/src/bridge-transport.mjs:3, 7, 17 | "The address is always 127.0.0.1 and the path always /mcp" | **Keep** | The stdio bridge talks to a local server; hosted use goes over HTTPS. |
| apps/server/src/mcp-cli.mjs:7, 60 | "`postLoopback`" | **Keep** | Same bridge. |
| apps/web/vite.config.mjs:8 | "'/api': 'http://127.0.0.1:4317'" | **Keep** | Dev proxy only. |
| packages/ai/src/transport.mjs:17, 42; packages/ai/src/profiles.mjs:25, 58 | "LOOPBACK_HOSTS"; "http: is only allowed for localhost" | **Keep** | Outbound provider rule. |
| packages/integrations/src/url-rules.mjs:33, 77-79; apps/server/src/api-v1.mjs:639-641 | "http: is only allowed to this computer" | **Keep** | Outbound webhook rule. |
| packages/shared/src/oauth.mjs:69-72 | "a redirect URI must be https (or http to 127.0.0.1" | **Keep** | OAuth redirect rule; OAuth 2.1 stays (plan section 0). |

## 3. No accounts / no database

| Location | Quote | Disposition | Reason |
| --- | --- | --- | --- |
| docs/decisions/0001-local-web-app-stack.md:8 | "no database service and no cloud account" | **Supersede** | Constraint reversed by plan section 2. |
| README.md:14 | "No account required in personal mode." | **Amend** | Hosted app requires an account. |
| SECURITY.md:21 | "has no accounts and no authentication routes" | **Amend** | Same sentence as in section 2. |
| docs/install.md:4 | "There is no account, no sign-in and no cloud service." | **Supersede** | Install guide is for the local app. |
| docs/self-hosting.md:6-7, 53 | "Without `--shared` StoryForge has no accounts"; "`STORYFORGE_MODE=personal` runs without accounts" | **Amend** | Mode description. |
| docs/self-hosting.md:177 | "accounts, invites, share links, the audit log" in `shared-data/` | **Amend** | JSON store moves into the database (plan Phase 0 item 6). |
| docs/self-hosting.md:274 | "No telemetry, no update checks, no account with anyone." | **Keep** | Still true; unrelated to user accounts. |
| docs/development.md:14 | "no database server, no service." | **Amend** | Dev prerequisites gain PostgreSQL. |
| docs/migration.md:119 | "StoryForge is one person on one computer. It has no accounts." | **Amend** | Reason legacy accounts were not imported. |
| deploy/compose.yaml:7 | "There is no database service" | **Supersede** | Compose file gains the database. |
| deploy/entrypoint.mjs:50 | "ignored in personal mode (no accounts)" | **Amend** | Entrypoint warning. |
| deploy/storyforge.env.example:4 | "The image defaults to shared (accounts, roles, invites, audit)." | **Keep** | Behaviour spec for the migrated model. |
| docs/contracts/M02-J03-new-book.md:3 | "with no database setup" | **Amend** | M02 gate wording. |
| docs/contracts/M07-J03-shared-mode.md (whole) | "Shared mode is opt-in per run (`serve --shared`)." | **Amend** | Kept as behaviour spec for roles, invites, audit; storage section replaced. |
| docs/contracts/M08-J01-deployment.md:43, 69 | "No database service."; "no account with anyone" | **Supersede** | Database line replaced; telemetry line is Keep. |
| docs/contracts/M08-J05-ci-release.md:78 | "no account required in personal mode" | **Amend** | Release guarantee text. |
| packages/shared/src/index.mjs:2, 7 | "Personal mode never loads this package's data." | **Amend** | Package is the JSON store (`openSharedData`). |
| packages/shared/src/passwords.mjs:2 | "Records read back from users.json are bounds-checked" | **Amend** | Users in a JSON file. |
| packages/shared/src/audit.mjs:1, 17 | "audit.jsonl in the shared-data folder, append-only" | **Amend** | Audit log file. |
| packages/shared/src/oauth.mjs:2 | "Kept in oauth.json beside plugin-tokens.json" | **Amend** | OAuth tokens in a JSON file; the flow is Keep. |
| packages/shared/src/plugin-tokens.mjs:3 | "the user config folder in personal mode" | **Amend** | Token store location. |

## 4. Markdown editor (CodeMirror, Markdown syntax in the editor)

| Location | Quote | Disposition | Reason |
| --- | --- | --- | --- |
| docs/decisions/0002-scene-editor-codemirror.md:1 | "CodeMirror 6 editing the Markdown text directly" | **Supersede** | Plan: ADR 0002 replaced in Phase 0. |
| docs/decisions/0002-scene-editor-codemirror.md:5-12 | "TipTap 2 + legacy `codex-md.js` (rich-text model)" rejected | **Supersede** | The evidence table rejects the rich-text model now chosen. |
| docs/contracts/M03-J02-editor.md:3, 5 | "CodeMirror 6, text-preserving"; pinned `@codemirror/*` versions | **Supersede** | Editor contract. |
| docs/contracts/M03-J02-editor.md:30, 47 | "CodeMirror history (session)"; Compare against "the file on disk" | **Supersede** | Undo and conflict banner. |
| docs/contracts/M03-J02-editor.md:54 | "**Edit raw file...** opens the whole file (front matter + body)" | **Supersede** | Raw-file editing; plan: authors never need Markdown. |
| docs/contracts/M03-J02-editor.md:69 | "CRLF scene editing keeps CRLF on disk" | **Supersede** | Line-ending preservation. |
| docs/contracts/M05-J02-continuity-review.md:20 | "dotted underline decoration (CodeMirror decoration only" | **Amend** | Re-anchor to rich-text ranges (Phase 4). |
| docs/contracts/M13-J01-findings-foundation.md:3, 31, 115, 130 | "CodeMirror document positions"; "enters CodeMirror history" | **Amend** | Plan Phase 4 re-anchors the findings layer. |
| docs/contracts/M13-J01-findings-foundation.md:5 | "four optional, local-only integrations" | **Keep** | Checkers are reused. |
| apps/web/package.json:17-22 | "@codemirror/lang-markdown": "6.5.2" | **Supersede** | Dependency set replaced. |
| apps/web/src/editor/extensions.js:1, 3 | "CodeMirror extensions for the scene editor: Markdown highlighting" | **Supersede** | Editor implementation. |
| apps/web/src/editor/commands.js:64-66 | "Bold: `**...**`. Italic: `*...*`." | **Supersede** | Toolbar inserts Markdown syntax. |
| apps/web/src/editor/buffer.js:3, 59-70 | "with a CRLF separator CodeMirror splits inserted text" | **Supersede** | Line-ending handling for files. |
| apps/web/src/editor/SceneEditorPage.jsx:1-5 | "formatting toolbar and the CodeMirror editor" | **Supersede** | Per-scene editor page (plan Phase 2). |
| apps/web/src/editor/RawEditor.jsx:3 | "defaultKeymap, history, historyKeymap" | **Supersede** | Raw file editor. |
| apps/web/src/editor/continuity-marks.js:3-5; finding-marks.js:4-5; suggestion-marks.js:4-5; focus-extensions.js:1-4 | "import { Decoration, EditorView } from '@codemirror/view'" | **Amend** | Decorations are CodeMirror; behaviours are reused on the new editor. |
| apps/web/src/editor/suggestion-marks.js:21 | "a pure insertion (`lines` 0) when its line is in the text" | **Amend** | Suggestions anchored by Markdown lines. |

## 5. Backup and recovery tied to files

| Location | Quote | Disposition | Reason |
| --- | --- | --- | --- |
| docs/backup-restore.md:3 | "A book folder is the book, so a copy of the folder is a backup" | **Supersede** | Plan: automated database backups. |
| docs/backup-restore.md:7, 15, 42 | "A backup is one `.zip` of the book folder, byte for byte" | **Supersede** | Zip of folder; restore returns the same files. |
| docs/backup-restore.md:24-25, 32, 37, 40, 45 | "`backup --library D:/Books --book my-novel --out my-novel.zip`" | **Amend** | Becomes the Markdown export path (Keep as export behaviour). |
| docs/install.md:47, 50, 53 | "any ordinary copy of it is a backup" | **Amend** | Folder-copy backup advice. |
| docs/self-hosting.md:172-180 | "a plain copy of the folders is enough"; "Do not back up `.storyforge/`" | **Supersede** | Backup section for library and shared-data folders. |
| docs/troubleshooting.md:68-74, 98-99 | "restore only writes into a folder that does not exist or is empty" | **Amend** | Restore-into-folder errors. |
| docs/compatibility.md:21 | "copies the originals to the book's trash first" | **Amend** | Upgrade recovery is a file copy to trash. |
| docs/decisions/0003-story-planner.md:27, 157 | "Walks the whole book folder"; "Rollback means removing the code" | **Amend** | Planner backup and rollback by files. |
| docs/contracts/M01-J02-writer-recovery.md (whole) | "Found on disk" recovery action table | **Supersede** | Journaled write and crash recovery for files. |
| docs/contracts/M05-J03-export-backup.md:50 | "restores into `<libraryRoot>/<folder>`" | **Supersede** | Folder restore route; export parts are Keep. |
| docs/contracts/M07-J03-shared-mode.md:164 | "a personal-mode export and backup of the same library contain every canonical file" | **Amend** | Acceptance item. |
| docs/contracts/M08-J01-deployment.md:55 | "what to back up: the `library/` folder, which is canonical" | **Supersede** | Deployment backup scope. |
| docs/privacy-ai.md:69 | "go into backups" | **Amend** | Backup scope. |
| packages/export/src/backup.mjs:1-3 | "Portable backup (a zip of the book folder) and restore" | **Amend** | Reusable as an export/import path. |
| apps/server/test/export-routes.test.mjs:5 | "main.mjs export, backup, restore" CLI commands | **Amend** | CLI backup and restore address book folders. |

## 6. Tests that enforce any of the above

| Location | Quote | Disposition | Reason |
| --- | --- | --- | --- |
| apps/server/test/deploy-static.test.mjs:59, 67, 69 | "published on 127.0.0.1 by default ... no database" | **Supersede** | Asserts the loopback port and bans postgres/mysql/redis in compose. |
| apps/server/test/deploy-static.test.mjs:138 | "install-server.sh: shared mode on 127.0.0.1" | **Keep** | Proxy topology stays. |
| apps/server/test/deploy-entrypoint.test.mjs:22-24, 82 | "personal mode: no accounts, loopback, and the owner variables are ignored" | **Amend** | Asserts personal-mode planning. |
| apps/server/test/shared-mode.test.mjs:656, 667, 742 | "personal mode: serve refuses --host other than 127.0.0.1" | **Supersede** | Asserts no accounts and no audit files in the library. |
| apps/server/test/shared-mode.test.mjs:653 | "the loopback Host guard is unchanged" | **Amend** | Host guard in shared mode. |
| apps/server/test/shared-mode.test.mjs:3, 37-48 | "Servers listen on 127.0.0.1 only." | **Keep** | Test harness binding. |
| apps/server/test/m07-proof.test.mjs:1113-1136, 1171 | "listens on loopback only, has no auth or shared routes, asks nobody for an account" | **Supersede** | Enforces personal-mode privacy proof. |
| apps/server/test/m07-proof.test.mjs:3, 636-639 | "Everything binds 127.0.0.1 on port 0" | **Keep** | Harness. |
| apps/server/test/server.test.mjs:123, 131-133 | "Host header guard: localhost:<port> and 127.0.0.1:<port> are accepted" | **Amend** | Guard tests; expected hosts change with deployment. |
| apps/server/test/launch.test.mjs:162, 181-182 | "nothing but loopback is ever opened" | **Amend** | Launcher opens the loopback URL. |
| apps/server/test/m01-gate.test.mjs:28 | "Host: `127.0.0.1:${port}`" | **Keep** | Harness request. |
| apps/server/test/editor-e2e.test.mjs:1-6 | "PUT .../raw ... 422 with diagnostics and nothing kept" | **Supersede** | Body and raw file save, conflict, crash mid-save. |
| apps/server/test/export-routes.test.mjs:190 | "never change the book (bytes of every canonical file)" | **Amend** | Export must not mutate source; the principle carries to the database. |
| apps/server/test/export-routes.test.mjs:1-5 | "POST /api/library/restore?folder= raw zip body" | **Supersede** | Folder restore. |
| apps/server/test/export-routes.test.mjs:248, 375 | "scenes in canonical order" | **Keep** | Ordering assertions carry to database exports. |
| packages/export/test/no-writes.test.mjs:55 | "export reads canonical files only" | **Amend** | Asserts exporter ignores `.storyforge`. |
| packages/export/test/order.test.mjs:1, 15, 66, 75 | "every format renders the included scenes in canonical order" | **Keep** | Export-fidelity checks (plan Phase 5). |
| packages/core/test/config.test.mjs:17-30 | "default port 4317 and host 127.0.0.1" | **Supersede** | Asserts the fixed loopback host. |
| apps/web/test/editor-buffer.test.mjs:1-3 | "load -> serialise is the identical string" | **Supersede** | Markdown round trip of the CodeMirror buffer. |
| apps/web/test/editor-commands.test.mjs:1-2 | "only the targeted lines change" | **Supersede** | Markdown command edits. |
| apps/web/test/editor-linebreaks.test.mjs:1-2 | "no bare LF in a CRLF buffer" | **Supersede** | Line-ending behaviour. |
| apps/web/test/finding-marks.test.mjs:1-4 | "EditorState with no DOM" | **Amend** | Findings layer re-anchored in Phase 4. |
| apps/server/test/mcp-oauth.test.mjs:97-103, 134 | "https and loopback redirect URIs register" | **Keep** | OAuth rule stays. |
| packages/legacy-import/test/plan-oracle.test.mjs | legacy import plan oracle | **Keep** | Basis of the Phase 1 importer fixture. |

## Counts

| Heading | Supersede | Amend | Keep | Total |
| --- | --- | --- | --- | --- |
| Storage canon (files are the truth) | 18 | 31 | 6 | 55 |
| Local-only / loopback binding | 4 | 29 | 16 | 49 |
| No accounts / no database | 4 | 15 | 2 | 21 |
| Markdown editor (CodeMirror, Markdown syntax in the editor) | 12 | 4 | 1 | 17 |
| Backup and recovery tied to files | 6 | 9 | 0 | 15 |
| Tests that enforce any of the above | 9 | 7 | 8 | 24 |
| **Total** | 53 | 95 | 33 | 181 |

Rows that list several line numbers or files count once.

## Contract files needing a Supersede or Amend banner

Banner is the strongest disposition among the file's rows. All paths are under `docs/contracts/`.

| Contract | Banner |
| --- | --- |
| M01-J01-app-boundary.md | Supersede |
| M01-J02-writer-recovery.md | Supersede |
| M01-J03-projection.md | Supersede |
| M01-J04-reconcile.md | Supersede |
| M02-J03-new-book.md | Amend |
| M03-J02-editor.md | Supersede |
| M03-J03-reorder.md | Supersede |
| M04-J02-codex-browser.md | Amend |
| M05-J01-continuity-rules.md | Amend |
| M05-J02-continuity-review.md | Amend |
| M05-J03-export-backup.md | Supersede |
| M05-J05-claude-book-adapter.md | Amend |
| M05-J06-author-check-suggest.md | Amend |
| M05-J07-receipts.md | Amend |
| M07-J01-shared-worlds-customization.md | Amend |
| M07-J02-goals-analytics-tasks.md | Amend |
| M07-J03-shared-mode.md | Supersede |
| M07-J04-customization-modules.md | Amend |
| M07-J05-privacy-conflict-proof.md | Amend |
| M08-J01-deployment.md | Supersede |
| M08-J02-extensions-api-webhooks.md | Amend |
| M08-J05-ci-release.md | Supersede |
| M09-J01-canvas.md | Amend |
| M10-plan-canvas.md | Supersede |
| M13-J01-findings-foundation.md | Amend |

Also outside `docs/contracts/`: `docs/decisions/0001-local-web-app-stack.md` and `docs/decisions/0002-scene-editor-codemirror.md` (Supersede), `docs/decisions/0003-story-planner.md` (Amend), `packages/manuscript/CONTRACT.md` (Amend).
