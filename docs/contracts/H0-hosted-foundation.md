# H0 — Hosted foundation: data, access, backup and compatibility contract

**Status:** accepted 2026-11-19 · **Phase:** 0 of the [hosted authoring plan](../plans/hosted-authoring-plan.md) · **Decisions:** [ADR 0004](../decisions/0004-hosted-database-canonical.md), [ADR 0005](../decisions/0005-rich-text-chapter-editor.md) · **Audit:** [phase0/assumption-audit.md](../plans/phase0/assumption-audit.md)

This contract fixes what Phase 1 builds. Every rule here is testable; the tests named in §8 are the proof.

## 1. Scope

In: the database model, the access model, backup and recovery, the Markdown import/export compatibility policy, the import fixture, and the `/api/v1` + MCP compatibility suite.
Out: the editor UI (Phase 2), mention detection (Phase 3), diagnostics UI (Phase 4), new export formats and invitations UI (Phase 5).

## 2. Database model

### 2.1 Rules for every table

- Primary key `id text` holding today's id form (`<prefix>_<ULID>`; ADR 0004). Imported records keep their id.
- `created_at`, `updated_at timestamptz`, `version integer` (starts at 1, +1 on every write; used for optimistic concurrency).
- Book-owned rows carry `book_id`; series-owned rows carry `series_id`. Every query filters by one of them **and** by the caller's membership (§3).
- Archive is `archived_at timestamptz null`, not a move. "Archived" in the API means `archived_at is not null`.
- `import_metadata jsonb` holds front-matter fields the importer could not map (including `x-*` fields and unknown fields that give I401 today). It is never dropped and is shown to the author for review.
- No hard deletes from authoring routes. Deletion is archive; purge is an owner-only admin action with a change-log row.

### 2.2 Typed tables (queried, joined or permissioned on their own)

| Table | Holds (from today's kind) | Notes |
| --- | --- | --- |
| `account` | `users.json` | username, display_name, scrypt `pw` record, disabled. |
| `session` | `sessions.json` | keyed by sha256 of the cookie token, as today. |
| `invite`, `share_link`, `setup_token` | `invites.json`, `shares.json`, `setup.json` | token hashes only, as today. |
| `membership` | `members.json` | `(account_id, scope_kind library/series/book, scope_id, role)`. See §3. |
| `plugin_token`, `oauth_client`, `oauth_token`, `webhook` | the JSON files of the same names | shapes unchanged. |
| `audit_event` | `audit.jsonl` + `audit-head.json` | append-only; keeps the `prev` hash chain. |
| `library_settings` | `library.md`, `settings.json` | pen names, preferences, modules, `ai_for_members`. |
| `series` | `series.md` | slug, title, status, previous_slugs, labels. |
| `book` | `book.md` | all book fields; `series_id` + `series_number`; `preferences jsonb` (includes the grammar dictionary and AI level). |
| `act`, `chapter` | `act.md`, `chapter.md` | `position` integer for order (replaces folder numbers). |
| `scene` | scene files | `chapter_id`, `position`, `doc jsonb` (ADR 0005 schema), `schema_version`, `notes jsonb`, status, pov, summary, `variant_of`, `origin`, `word_count`, plus the list fields below in `scene_ref`. |
| `codex_type` | `codex/_types/*.md` | book- or series-scoped. |
| `codex_entry` | `codex/**.md` | book- or series-scoped; type, slug, name, status, role, image, `fields jsonb`, `details jsonb` (rich body), previous_slugs. |
| `codex_alias` | entry `aliases[]` | one row per alias, lower-cased match key; used by mention detection (Phase 3). |
| `comment`, `comment_reply` | `comments/**` | anchored per ADR 0005 §Ranges; replies are rows, not body text. |
| `suggestion` | `suggestions/**` | hunks kept as today until Phase 2 redefines them on rich-text ranges. |
| `restore_point` | `.storyforge/revisions` | per scene; newest **4** kept, older pruned in the same transaction. |
| `receipt`, `receipt_blob` | `provenance/**` | immutable; parents chain kept. |
| `change_log` | `.storyforge/journal` | one row per write op: actor, route, affected rows with before/after JSON. Powers Undo for the app and MCP. Kept 30 days. |
| `job` | — (new) | import, export, analysis; state, progress, warnings, result reference. |
| `asset` | `assets/**`, covers | metadata row; bytes in object storage or a disk folder (ADR 0004). |
| `activity_session`, `writing_log` | `activity/**` | rows instead of Markdown tables. |

### 2.3 One table for planning and workspace records

The ~20 planning and workspace kinds are read and written whole, through routes that already validate them with `packages/format` `KINDS`. They share one table:

`story_record (id, book_id | series_id, kind, slug, fields jsonb, body jsonb | text, archived_at, version, import_metadata)` with a unique `(book_id, kind, slug)`.

Kinds stored here: thread, event, link, scene-plan, story-plan, arc, structure, relationship, synopsis, clue, doc (workspace), task, goals, continuity-exception, continuity-settings, style-dismissal, research, source, ai-record, asset-note, plugin manifest, prompt, prompt-workflow, template. Canvases are stored here with `body` = the JSON Canvas document.

Writes validate `fields` against the same `KINDS` table used today, so the field rules do not fork.

### 2.4 References

Every id-valued field that `packages/format` `REFERENCES` lists (scene `characters`, thread `setup`, event `scenes`, clue `knowers[].scene`, entry `first_appearance`, …) is mirrored into `record_ref (from_id, field, to_id, to_kind)` in the same transaction as the write. It powers "used by", and the W301/W303/W308-style checks become queries. A reference to an archived record is still a W303-class finding; it never blocks a write.

`[[slug]]` links inside prose become `entityMention` marks with an entry id on import (state `confirmed`, because the author typed them). Unresolvable ones stay as text and get a finding.

### 2.5 Concurrency

- The API keeps `base_sha256`. The server computes it as the sha256 of the record's **canonical JSON** (sorted keys, no `version`/timestamps). Clients only echo what a read returned, so nothing changes for them.
- Inside the server, writes use `version` with `UPDATE … WHERE id = $1 AND version = $2`. A miss is `409 CONFLICT`, as today.

## 3. Access model

| Today (`shared-data.mjs` `ROLES`) | Database role | Rank | May (from `policy.mjs` `NEEDS`) |
| --- | --- | --- | --- |
| `owner` | `owner` | 4 | everything, including `admin` |
| `editor` | `editor` | 3 | read, export, comment, suggest, write, ai (ai also needs `ai_for_members`) |
| `reviewer` | `commenter` | 2 | read, export, comment, suggest |
| `viewer` | `reader` | 1 | read, export |

- `membership.scope_kind`: `library` (all books — today's member with no `books` map), `series`, or `book` (today's `books` map entries). A book-scoped role can be lower than a library role, never higher, as today.
- Series-shared data (series Codex, `_types`) changes only for a member with library scope or series scope, as today's "member with every book" rule (`book-scope.mjs`).
- `WRITE_CLASSES` and `classifyRead` stay the single map from route to class. Phase 1 changes their data source, not their content. `policy-*.test.mjs` must pass unchanged.
- The shared-mode admin API accepts `reviewer`/`viewer` and returns the new names plus the old ones in a `legacy_role` field for one release.
- **Share links:** a public read-only link is a non-goal for the first hosted release (plan §6). Existing `shares.json` rows are imported **revoked**, and the share-link routes return `410 GONE` with a message. The owner is told in the import receipt.
- Plugin tokens and OAuth grants keep their `permissions` and `books` lists; `books` becomes book ids.

## 4. Backup and recovery

| What | Rule |
| --- | --- |
| Nightly backup | `pg_dump --format=custom` of the whole database, encrypted (age or gpg) with a key that is **not** on the server, copied off the server. Keep 7 daily, 4 weekly, 3 monthly. |
| Media | Object-storage or disk-folder media synced off the server on the same schedule. |
| Restore drill | Before every release: restore the latest backup into a clean PostgreSQL, run migrations, run the read-only compatibility suite (§7) against it, and compare row counts per table with the source. Recorded in `docs/release-checklist.md`. |
| Author export | Any owner can download each book as a Markdown library (FORMAT-v1) at any time. This is the author's own escape hatch, independent of server backups. |
| In-app history | `restore_point` (newest 4 per scene) and `change_log` (Undo, 30 days). These are not backups. |
| Before migrations | The migration runner refuses to run on production unless a backup newer than 24 hours is recorded. |

## 5. Markdown import and export compatibility policy

- **FORMAT-v1 stays the exchange format.** The importer reads every kind in `packages/format` `KINDS` plus the non-document data in §6.
- **Import is one-time and idempotent.** A second import of the same folder (same source fingerprint: sha256 over sorted relative paths and file hashes) changes nothing and says so. A changed folder is refused unless the author picks "import as a new book".
- **Dry run first.** The importer always produces a report — counts per kind, warnings per record, unmapped fields, unresolved links, Markdown constructs that became `rawImport` — before any write. Writing needs a second, explicit step.
- **The source folder is never written** (no journal, no index, no `.storyforge/`). The import receipt stores the source fingerprint and path.
- **Kept on import:** ids, order (acts, chapters, scenes by folder number then `sequence`), all front matter (mapped or in `import_metadata`), author notes, anchors, comments with replies, suggestions, receipts, restore points (newest 4 per scene from `.storyforge/revisions`), archived records (`archive/**` → `archived_at`), the writing log and sessions, goals, dismissals, canvases, assets, and the shared-mode store.
- **Not kept:** the search index, locks, journal and trash (`.storyforge/` caches), and per-machine settings.
- **Export:** the database → FORMAT-v1 Markdown, passing `validate()` with no errors. Import → export → import is stable: the second import of an export is identical, row for row, to the first.
- **Markdown constructs in prose** map to ADR 0005 schema v1. Fenced code, tables, images and footnotes that the schema lacks become `rawImport` nodes and are listed in the report.

## 6. Import fixture

One library, `packages/format/fixtures/hosted-import/`, built from `valid/salt-orchard` and extended so that it holds **at least one of every** item below. It is the input for every Phase 1 importer test.

- A series with two books; series-shared Codex entries and a `_types` file.
- Every `KINDS` kind (31 today; the test iterates `KINDS`, so a new kind must be added), plus the template, prompt, prompt-workflow and plugin documents, including a scene variant (`variant_of`), an archived scene, an archived planner record, and a record with `x-*` and unknown front-matter fields.
- Prose with every construct in §5: author notes, a `sf:anchor` pair, `[[slug]]`, `[[slug|label]]`, a cross-book link, `[@cite]`, a Markdown link, an image, a footnote, a fenced code block, a scene break, emphasis.
- A comment with two replies, a pending suggestion, a receipt chain of three, a canvas with story cards.
- `.storyforge/revisions` with **six** restore points for one scene (to prove pruning to four).
- `activity/` writing log, sessions and goals.
- A `shared-data/` folder: owner, editor, reviewer, viewer, a book-scoped member, an open and a used invite, a share link, an OAuth client with tokens, a plugin token, a webhook, and an audit log with a valid hash chain.
- A broken reference (W303 to an archived scene) and an unresolved `[[link]]`. The unresolved link is an `E301` error today; it is the fixture's **only** error, and the test asserts that.

`hosted-import/expected-import.json` is the executable requirement: counts per kind and table, the ordered scene id list per book, chosen field mappings, the expected `import_metadata` keys, the expected warnings, and the expected `rawImport` constructs. A Phase 0 test proves the fixture is complete (every `KINDS` kind and every listed category present) and that the manifest's counts match the files.

## 7. `/api/v1` and MCP compatibility suite

Pinned from Phase 0; every later phase must pass it unchanged unless a change is deliberate and recorded here.

1. **Route table** — the 48 entries of `plugin-policy.mjs` `V1` (method, path pattern, permission, book flag, AI level) as a committed golden file. `V1` is exported for the test; no behaviour change.
2. **Tool table** — every element of `@storyforge/mcp` `TOOLS` (name, title, need, inputSchema, annotations) and `NOT_OFFERED` as a committed golden file.
3. **Read shapes** — for each GET route in the table, the JSON shape (keys and value types, recursively, arrays by their first element) returned for the `salt-orchard` fixture, as a golden file. Values are not pinned.
4. Golden files are updated only by an explicit `UPDATE_GOLDEN=1` run, and a changed golden needs a line in this section's change list.

Change list: *(none yet)*

## 8. Proof

| Rule | Test |
| --- | --- |
| §6 fixture complete and counts match | `packages/format/test/hosted-import-fixture.test.mjs` |
| §7.1–7.2 route and tool tables | `packages/mcp/test/v1-compat.test.mjs` |
| §7.3 read shapes | `apps/server/test/v1-compat-shapes.test.mjs` |
| §2–§5 | Phase 1 tests, written against this contract and the fixture |

## 9. Decisions recorded here

- **Ids** stay as today (ADR 0004).
- **Share links** are switched off and imported revoked (§3).
- **M13 Milestone 5 (PDF export) is deferred to Phase 5.** It would be built on file-canonical export code that Phase 1 replaces. Phase 5 builds PDF export from the database, reusing the Paged.js interior preview.
