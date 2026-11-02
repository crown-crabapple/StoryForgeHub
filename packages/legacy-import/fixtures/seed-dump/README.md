# seed-dump: a synthetic legacy dump

Everything in this folder is invented. There is no real book, person or credential in it.

## How it was made

1. `tools/legacy-dump/make-fixture.php` built a throwaway SQLite database outside both repositories. The script `require`s the legacy
   `src/repo.php` (read-only use of the legacy checkout), creates the legacy tables with the legacy `migrate()` and `ensure_*()` functions
   (the `users` table first, M00 defect 2), and inserts the invented content through the legacy save functions (`save_book`, `save_entry`,
   `upsert_chapter_from_md`, `save_ledger_item`, `save_state_events`, `save_workspace_doc`, ...). It never uses `bin/seed.php` or `sync/seed.json`.
   Timestamps are then normalised so the result is reproducible.
2. `tools/legacy-dump/dump.php` dumped that database: `manifest.json` plus `tables/<table>.jsonl`.

```
php tools/legacy-dump/make-fixture.php --legacy <legacy checkout> --db <new sqlite file>
php tools/legacy-dump/dump.php --dsn sqlite:<that file> --out packages/legacy-import/fixtures/seed-dump --now 2026-01-05T12:00:00Z
node packages/legacy-import/scripts/expected-summary.mjs packages/legacy-import/fixtures/seed-dump > packages/legacy-import/fixtures/seed-dump/expected-plan-summary.json
```

PHP needs `pdo_sqlite`, which is off in the stock `C:\php\php.ini`: copy that file, enable `pdo_sqlite`, `sqlite3` and `mbstring`, and point `PHPRC` at the folder.

## What it contains

Two books.

- **The Salt Orchard** (fiction, series "The Tidewater Books"): two acts; a prologue and five chapters (one archived, one revised after its scenes cache
  was saved so the cache is stale); scene breaks written `---`, `***` and `___`, an HTML comment, a heading inside a scene, a `[^cite:key]` token;
  10 codex entries across characters, locations, factions, objects and lore (fields, sections, relations, an "Open threads" section, a slug shared
  between a character and a lore entry, a link to a page that does not exist); 3 ledger items (promise, question, a promise whose slug collides with
  an entry); chapter cast; state events; knowledge facts; progressions with a timeline label; a continuity exemption; 2 tasks with steps; a writing log
  (three rows, a negative one); two chapter comments; plot board cards and a link; mood board items; captures (one global); dictionary terms;
  a source; a note page, a meta page and four workspace docs (one locked); revisions of chapters, entries and workspace docs with saved-by names.
- **Notes on Tidewater Orchards** (nonfiction): one chapter, one concept entry, one source.

Accounts: two users (`users` keeps only `id` and `display_name` in the dump; the fake password hashes in the database never reach the files),
book members and activity. The secret tables (`api_tokens`, `invites`, `password_resets`, `oauth_*`) exist in the database and are empty, so they appear
in the manifest as `skipped: server-only`.

`expected-plan-summary.json` holds the plan summary, the issue codes, the validator warnings and a sha256 over every planned path and file hash.
