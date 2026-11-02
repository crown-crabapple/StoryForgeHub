# M06-J02 contract — legacy import, rehearsal and reconciliation

Binding: M06-J01 contract (plan shape, deterministic IDs, dispositions); FORMAT-v1 (§2 layout, §9, §12); DECISIONS 1, 3, 4, 10; M06 milestone gate.

M06-J01 produces a complete, deterministic **plan**. This job **executes** a plan into a **new** library folder, checks the result against the dump **independently of the plan**, and shows that two imports of the same dump are equivalent. The legacy app, its repository and its server are never touched.

## 1. CLI

```
node apps/server/src/main.mjs import-legacy --dump <dir> [--book <legacy slug>]... --into <new library folder> [--report <file.md>] [--json <file.json>]
node apps/server/src/main.mjs import-legacy --dump <dir> --reconcile <library folder> [--report <file.md>] [--json <file.json>]
node apps/server/src/main.mjs import-legacy --compare <library A> <library B>
```

- `--dry-run` keeps its J01 behaviour. Without `--dry-run`, `--into`, `--reconcile` or `--compare` → exit 2 with a usage message (replaces the J01 "the import itself is M06-J02" message).
- `--into`: refused (exit 2, nothing written) when the folder exists and is not empty, is a file, is inside the dump folder, or is inside a folder containing a `.git` entry named `legacy-StoryForgeHub` (guard: the resolved path must not be inside any directory whose basename is `legacy-StoryForgeHub`). A plan with any `error` issue or coverage < 1 is refused (exit 1, nothing written).
- The import writes **only** through `@storyforge/store` (`writeNewTree(into, produce)`), all books in one call, so the folder appears whole or not at all. It writes nothing else inside `<into>` (no report, no index, no receipts, no `.storyforge/`).
- After writing: `validate()` every imported book; then reconcile (§3) the new library against the dump. Print the reconciliation report (or write it with `--report`). Exit 0 only when every book validates with no `error` diagnostics **and** reconciliation has no unexplained difference; else exit 1 (the folder stays for inspection; never deleted by the tool).
- `--report` / `--json` use J01 `outputPathProblem` rules, and additionally must not be inside `<into>` or the reconciled library.
- `--compare A B`: compares two libraries (§4). Prints a short result; exit 0 when equivalent, 1 otherwise. Read-only.
- `--help` and `help.mjs` updated for the new flags.

## 2. Package additions (`@storyforge/legacy-import`)

- `executePlan(plan, intoDir) → Promise<{ ok, files, code? }>`: thin wrapper over `writeNewTree` (the package may depend on `@storyforge/store`; no `node:fs` writes in this package — lint boundary unchanged).
- `reconcile(dumpDir, libraryDir, { books? }) → Reconciliation` — **reads the written v2 files** (via `@storyforge/format` parsing / reading from disk) and the dump rows. It must **not** reuse the plan's file list or bytes as the expected side; it may reuse the J01 pure helpers for **ID derivation**, slug normalisation and the scene split rules (they are the spec), and the plan's `dispositions` only to *explain* rows that were not converted.
- `compareLibraries(a, b) → { equivalent, differences: [{ path, why }] }`: same set of relative paths and byte-identical files, ignoring `.storyforge/` only.

```ts
Reconciliation = {
  dump: { sha256 }, library, books: [{ legacy_id, slug, checks: [Check] }],
  unexplained: number,     // total of failing checks; 0 = pass
}
Check = { name, legacy: number|string, v2: number|string, ok: boolean, explained?: string, details?: string[] /* ≤ 20 */ }
```

## 3. Reconciliation checks (per book)

Every check compares a count or hash taken from the **dump** with one taken from the **files on disk**. A difference is *explained* only when it maps to a disposition or issue code from the plan (e.g. `derived`, `server-only`, `skipped` with reason, `chapter-ref-unresolved`); anything else is *unexplained*.

1. **Counts:** chapters (live + archived), scenes per chapter (dump segments by the J01 split rule vs scene files), entries per type, docs (note_pages, meta_pages, workspace_docs, tasks, dictionary, comments), events (progressions + created legacy-chapter events), threads (story_ledger), sources, writing-log rows, history files (chapter/entry/workspace revisions).
2. **IDs:** every expected deterministic ID (from `table | legacy id`) is present exactly once in the library; no ID appears twice; no file has an ID that maps to no legacy row (except documented created files such as `legacy-chapter-<n>` events).
3. **Order:** chapter order in the library (by `chapter` field) equals legacy order (`sort_order`, `num` natural, id); scene order within each chapter (by `sequence`) equals segment order; `x-legacy-num` equals legacy `num`.
4. **Text hashes:** for every chapter, joining the scene **bodies read from disk** with the recorded separators reproduces `chapters.body` byte-for-byte (sha256 equal). Entry sections, doc bodies, note pages, comments and revision bodies: sha256 of the legacy text equals sha256 of the corresponding text on disk (after removing only the front matter the importer adds).
5. **Codex links:** every `related` target and every `[[link]]` in imported files resolves to an imported entry, or is listed with a `link-*` issue code; count of legacy `entry_relations` rows equals count of `related` items written.
6. **Notes and comments:** every `note_pages` row and every `chapter_notes` row is present (count + body hash).
7. **Archive and revisions:** archived legacy rows are under `archive/` and live rows are not; every revision row has exactly one file under `legacy/history/` with the same `saved_at`.
8. **Coverage:** every dump row is accounted for: found on disk, or disposition `derived` / `server-only` / `skipped` (with reason) / `kept-as-data` (file under `legacy/tables/` present with same row count).

The report (Markdown, owner-readable) shows per book a table `Check | Legacy | v2 | Result`, then explained differences, then unexplained ones in full (paths and legacy ids, never body text). It must **not** print manuscript or entry text — only titles, slugs, ids, counts and hashes.

## 4. Equivalence

Two imports of the same dump into two new folders must be byte-identical (`compareLibraries` equivalent). The imported library must also survive the M06 gate path: delete `.storyforge/`, rebuild the index (`rebuild` CLI), validate again — no errors.

## 5. FORMAT addition

FORMAT-v1 §2 and §9: add `legacy/` (author data, non-canonical): `legacy/history/<kind>/<slug>/<saved_at>.md` (raw revision bodies) and `legacy/tables/<table>.jsonl` (rows v2 has no model for). Readers MUST NOT treat it as story text or canon; the validator ignores it except for front-matter syntax. *(Added 2026-11-02, M06-J02; additive within v1.)* If the validator currently warns on these paths, fix the validator, not the importer.

## 6. Tests (fixtures only — no user data in the repo)

Using `seed-dump` and `edge-dump`:
1. Import into a temp folder → exit 0, every book validates, reconciliation `unexplained === 0`.
2. Two imports → `compareLibraries` equivalent; a one-byte change in B → not equivalent, path named.
3. Refusals: non-empty `--into`, `--into` inside the dump, `--report` inside `<into>`, plan with an error issue → nothing written (tree snapshot unchanged).
4. Reconciliation catches tampering: after import, (a) delete a scene file, (b) edit one byte of a scene body, (c) swap two scenes' `sequence`, (d) remove a `related` item, (e) delete a revision file — each yields `unexplained > 0` naming the right check.
5. Index delete + rebuild + validate on the imported library → no errors.
6. Dump folder and the legacy repo unchanged (tree snapshot / `git status --porcelain` when the repo exists; skip with a message otherwise).
7. Report contains no scene body text (test: no 20-char run from any fixture scene body appears in the report).

## 7. Real-data rehearsal (coordinator, not committed)

Run on the owner's dump outside every repo: two imports into new folders under `E:\StoryForgeHub\migration-rehearsal\`, `--compare`, index delete + rebuild, reconciliation reports. Evidence in the plan repo records counts, hashes, check results and explained/unexplained totals only — no titles or text from the owner's books.

## 8. Acceptance

Two clean rehearsal imports produce equivalent, validated v2 folders and reconciliation reports with no unexplained loss; legacy untouched; `npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
