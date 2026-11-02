# M06-J01 contract — legacy StoryForgeHub dry-run importer

Binding: DECISIONS 1, 3, 4, 10; FORMAT-v1 (all sections, esp. §1.3 IDs, §1.7 comments, §4 manuscript/ordering, §5 entries, §6 planning incl. event `state`, §9.1 writing log, §12 legacy mapping); M00-J01 audit (`evidence/M00-J01/RESULT.md`: content types, risks 1–10, defects 1–2).

Nothing in this job writes a book, touches the legacy repository, or connects to the live legacy server. The importer turns a **legacy dump** into a complete **import plan** (every destination file with its exact bytes) and a **report**. M06-J02 will execute the plan into a new folder.

## 1. Input — the legacy dump

- `tools/legacy-dump/dump.php` (in the **v2** repo; the legacy repo is never changed): `php dump.php --dsn <PDO DSN> [--user U --password-env VAR] --out <new empty dir>`. Read-only: `SELECT` only, inside a read-only transaction where the driver supports it. Works on MySQL/MariaDB and SQLite.
- Discovers the **live** tables (not `schema.sql`; risk 10): for each table writes `<out>/tables/<table>.jsonl` (one JSON object per row, columns as named, BLOB/TEXT as UTF-8 strings, invalid UTF-8 → base64 with `{"$b64": …}`), and `<out>/manifest.json` `{ dumper_version: 1, driver, dumped_at, tables: { name: { rows, columns: [..], sha256 } } }`.
- **Never dumped** (secrets / server-only): `password_hash`, `token`, `secret`, `code` columns of `users`, `api_tokens`, `password_resets`, `invites`, `oauth_*`; the tables are listed in the manifest with `rows` and `"skipped": "server-only"`. `users` keeps `id`, display name only (for attribution).
- PHP is needed only to run the dumper. A dump is plain files and is the importer's only input.

## 2. Package `@storyforge/legacy-import`

Pure planning (reads the dump directory, no writes): `planImport(dumpDir, { books?: string[] }) → Plan`.

```ts
Plan = {
  importer_version: 1, dump: { sha256 /* of manifest */, dumper_version },
  books: [{ legacy_id, slug, title, root: '<book-slug>/', files: [{ path, bytes /* Buffer */, sha256, kind, sources: [{ table, id }] }] }],
  dispositions: [{ table, id, disposition, target? /* path */, reason? }],   // exactly one per legacy row
  issues: [{ severity: 'error'|'warning'|'info', code, table?, id?, path?, message }],
  summary: { tables: { [name]: { rows, by_disposition: { [d]: n } } }, files: n, coverage: 1 }
}
```

- **Deterministic:** same dump → identical plan (bytes, order, IDs). IDs are derived, not random: `<prefix>_` + 26 Crockford chars from `sha256('storyforge-legacy-v1' | table | legacy id)` (first 130 bits). Two imports of the same dump therefore produce the same IDs (needed for J02 "equivalent").
- **Dispositions** (every row of every dumped table gets exactly one; coverage must be 1.0):
  `converted` (becomes/feeds a v2 file), `merged` (folded into another row's file, e.g. entry_fields → its entry), `history` (written under `legacy/history/`), `kept-as-data` (written verbatim under `legacy/tables/` because v2 has no model for it), `derived` (cache rebuilt by v2; not imported — mentions, prose_analysis, claim_sources, exercises, threads cache, sync_state, scenes cache), `server-only` (accounts, members, activity, locks, tokens — not imported, M07), `skipped` (with a reason: archived-and-empty, duplicate, …). Unknown tables (schema drift) → `kept-as-data` + an `info` issue.
- **Mapping** (FORMAT §12 plus M00 table): books → `book.md`; acts/chapters → `manuscript/act-NN-<slug>/ch-NNN-<slug>/chapter.md` + scenes; entries + fields + sections + relations → `codex/<type>s/<slug>.md` (bullets `- **Label:** value` → `fields`, sections → `##` body, relations → `related`); sources → `research/sources/<cite-key>.md`; note_pages / meta_pages / workspace_docs → planning docs (`planning/notes/`, `planning/meta/`, `planning/<path>`), `locked` kept; progressions → events (`order` from `when_order` else legacy order; `when` from `when_label`); state_events → event `state` items (`died|revived|destroyed|lost|found|holder|location`) on the event of that chapter (create `planning/timeline/legacy-chapter-<n>.md` when none); knowledge_facts → `learns` items; story_ledger → threads (promise/question → kind, status mapped to §6.1, `planted_in`/`payoff_in` chapter strings resolved to scene IDs — unresolvable → issue + kept in body); chapter_cast → scene `pov`/`characters` on every scene of the chapter + `x-legacy-cast-review: true`; continuity_exemptions → `planning/legacy/continuity-exemptions.md` doc (the v2 engine uses different fingerprints); tasks + task_steps → `planning/tasks/<slug>.md` docs; writing_log → `activity/writing-log.md` (§9.1 table); chapter_notes (comments) → `planning/legacy/comments/<chapter-slug>.md` (quote + note + author name); canvas_cards/links → `planning/board.md`; vision_items → `research/vision.md`; captures → `planning/inbox.md`; dictionary_terms → `planning/dictionary.md`; chapter_revisions / entry_revisions / workspace_revisions → `legacy/history/<kind>/<slug>/<saved_at>.md` (raw body + front matter `{ legacy_table, legacy_id, saved_at, saved_by_name }`). Archived rows go under `archive/` with the same sub-layout.
- **Chapters and order:** `chapter` = integer by legacy order (`sort_order`, then `num` natural order, then id); original `num` kept as `x-legacy-num`; ties → `warning` issue with both ids (risk 3). Acts from `acts`/`chapters.act_id`; none → act 1.
- **Scene split — byte-preserving (risks 1, 2):** a chapter body is split on lines that are exactly `---`, `***` or `___` (outside fenced code blocks and tables). Each scene body is the segment text **byte for byte** (no trimming beyond the separator line and the single blank line around it, which are recorded); comment-only and heading-only segments are **kept** as their own scene (not dropped) with an `info` issue. Invariant (tested): joining the scene bodies with their recorded separators reproduces `chapters.body` exactly. `sequence` = 10 × ordinal. Scene `title` = first heading in the segment, else `<chapter title> — part N`. Legacy `scenes.label/summary/note` are **not** trusted for matching (risk 1): applied only when the legacy scenes cache has the same segment count and each cached segment hash matches; otherwise dropped with an `info` issue per chapter.
- **Links:** legacy `[[slug]]` / `[[slug|Label]]` kept; slugs normalised to §1.4 (collisions → `-2` + `previous_slugs` + warning); a link to an unknown slug → `warning`. Chapter-string references (`4`, `3.5`, `prologue`) resolved to scene IDs (risk 4) or reported.
- **Validation:** the planned files, written to an in-memory/temporary tree **only inside the test**, must `validate()` with no `error` diagnostics; the planner itself runs the format validator on an in-memory representation if available, otherwise J02 does the on-disk validation. (The planner may expose `planToTree(plan)` → `Map<path, Buffer>` for tests.)

## 3. CLI and report

- `node apps/server/src/main.mjs import-legacy --dump <dir> [--book <legacy slug>]... --dry-run [--report <file.md>] [--json <file.json>]`. Without `--dry-run` → exit 2 "the import itself is M06-J02". Report/JSON files: written only to a path that doesn't exist and isn't inside the dump dir (refuse otherwise); default prints the report to stdout. Exit 0 when coverage is 1 and no `error` issues; 1 otherwise.
- **Report (Markdown, owner-readable):** per book: counts table (legacy rows per type → destination files), destination tree (paths, kinds, proposed IDs), chapter/scene order table (legacy num → chapter, scene count, bytes), issues grouped by code with plain explanations, the disposition table for every legacy table (rows, each disposition), and "Nothing was written."

## 4. Fixtures (no user data)

- `packages/legacy-import/fixtures/seed-dump/`: produced by running the legacy repo's own `bin/seed.php` into a throwaway SQLite DB (create the `users` table first — M00 defect 2; use a scratch `php.ini` via `PHPRC` with pdo_sqlite, as in M00), then `dump.php`. Committed with a README saying how it was made. Check `bin/seed.php` content is synthetic before committing (report what it contains).
- `packages/legacy-import/fixtures/edge-dump/`: a hand-written dump (JSONL) covering: `---` inside a fenced code block and in a table, comment-only and heading-only segments, `3.5` and `prologue` chapters, duplicate `sort_order`, an archived chapter, a renamed-entry slug collision, a ledger item pointing at a missing chapter, an unknown table, a non-UTF-8 value, every M00 content type at least once, and a server-only table with fake rows.
- Each fixture has `expected-plan-summary.json` (summary + issue codes) and the test compares whole plans against a golden tree hash.

## 5. Acceptance

1. **100% disposition:** for both fixtures, every row of every dumped table has exactly one disposition; `summary.coverage === 1`; every M00-J01 content type appears in the edge dump and has a non-`skipped` disposition (or a documented one).
2. **Dry run changes nothing:** the CLI dry run leaves the dump directory, the legacy repo (`git status --porcelain` empty in `E:\StoryForgeHub\legacy-StoryForgeHub`), and any library untouched (tree snapshots); writes only the requested report files.
3. **Byte-preserving split:** for every chapter in both fixtures, re-joining scenes reproduces the body exactly; fenced-code/table `---` not split; comment-only/heading-only segments kept.
4. **Deterministic:** two plans of the same dump are byte-identical (files, IDs, report); a copy of the dump in another folder gives the same plan.
5. **Valid output:** writing the plan's files to a temp dir (test only) → `validate()` has no errors; warnings listed in the expected summary.
6. **Dumper:** on the seeded SQLite, `dump.php` output matches the manifest (row counts, sha256), skips secret columns/tables, and is read-only (the DB file's bytes/mtime unchanged). (Skipped with a message if PHP is unavailable; PHP 8.5 is at `C:\php`.)
7. **Report readable:** golden report for the edge dump reviewed by the coordinator.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
