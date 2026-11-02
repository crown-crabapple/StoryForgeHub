# M01-J04 contract — watcher, external-edit reconciliation, status, repair, single-instance lock

Binding: DECISIONS 1, 5, 6; FORMAT-v1 §9, §10; contracts J01–J03.

## Goal

Changes made outside the app (another editor, Git, a sync tool) show up in the app quickly and safely. Valid changes are indexed. Invalid content is **never hidden and never changed**: the app keeps showing the last valid structure and points at the broken file. A repair/rebuild command brings the book back to a valid indexed state. Only one app instance writes to a library at a time.

## 1. Watcher (`packages/core/src/watcher.mjs`)

- One `fs.watch(bookRoot, { recursive: true })` per book. `fs.watch` lives in a new store helper `store.watch(onEvent)` (keeps `node:fs` in allowed modules); it returns `{ close() }`.
- Ignore events under `.storyforge/` and for `*.sf-tmp` files and non-`.md` files (except `book.md`, `series.md`, `library.md` — those are `.md` anyway).
- **Debounce:** collect events per book; act 300 ms after the last event (max wait 2 s).
- **Own writes:** events caused by the app's own writes (paths in the store's last-op set, within 2 s) are ignored — the write path already refreshes.
- **Fallback poll:** every `pollMs` (default 30 000; configurable for tests) run `index.status()` (stat-based, cheap) for each book; if stale → reconcile. If `fs.watch` throws or emits `error`, close it, set `mode: 'poll'`, and poll every 5 000 ms. Mode and reason are reported in status.
- Also covers files the J03 freshness check missed: `series.md`, `library.md` changes trigger reconcile of every affected book (closes the J03 blind spot).

## 2. Reconcile (`index.reconcile()`, in `packages/index`)

1. Run `validate` for the book.
2. If the book has **no manuscript-structure errors** (E1xx/E2xx on files under `manuscript/`, as in the manuscript contract rule 5) → normal `refresh()`. State `fresh`.
3. If it **has** such errors → **keep the last valid projection** (do not touch `scenes`, `excluded`, `objects`, `links`, `mentions`, `fts`), but replace the `diagnostics` table with the current diagnostics and set meta `state = 'invalid'`, `invalid_since`, `invalid_paths` (JSON). `status().state === 'invalid'`.
4. If there was no previous valid projection → build what can be built (J03 build of the current files) and mark `invalid` anyway.
5. Never write a project file. Never move, rename or "fix" anything.

`status()` gains state `invalid` with `invalid_paths`.

### Reads while invalid

- `getBook` → last valid structure from the index, plus `index_state: 'invalid'`, `invalid_paths`, and current diagnostics. A scene whose file is now unreadable keeps its place and gets `problem: { code, message }`.
- `getScene` → **always the current file bytes** (raw body, even if front matter is broken), plus `sha256` and `problem` if it can't be parsed. Never null for a file that exists.
- A file **added** externally with broken front matter appears in `getBook().unplaced: [{ path, problem }]`.
- Writes through the app (J02) on an invalid book are refused (existing rule) except `updateSceneBody` on a **valid** scene file, which stays allowed so the author can keep working.

## 3. Rename handling

Scenes and entries are keyed by `id`. An external rename/move of a file with an unchanged `id` is the same object at a new path; the index updates the path; nothing else changes. An external rename that creates a W201/W202 mismatch is shown as a warning, not auto-fixed.

## 4. Status API and UI

`GET /api/status` →

```json
{ "instance": { "pid": 1234, "started_at": "…", "lock": "held" },
  "watch": { "mode": "watch|poll", "reason": null, "last_event_at": "…", "pending": 0 },
  "books": [ { "book_id": "…", "title": "…", "index": "fresh|stale|building|invalid|missing|error",
               "invalid_paths": [], "errors": 0, "warnings": 3, "last_reconciled_at": "…" } ],
  "recover": { "needsAttention": [], "rolledBack": [] } }
```

UI: the status dot (J03) shows the worst book state; clicking it opens a **Status panel**: watcher mode, each book's state, invalid files (each a link that opens the file's raw text in the book view), recovery items, and two buttons — **Rebuild index** and **Repair…**. The book view shows a banner "This book has a file that can't be read: <path>. Showing the last good version of the book. Fix the file and it will update." when `invalid`. The UI polls `/api/status` every 3 s (no websockets in this job).

## 5. Repair

- `GET /api/books/:b/repair/plan` → `planRepair` (manuscript) result, plus `unrepairable` items explained in plain words.
- `POST /api/books/:b/repair` (write-guarded) `{ actions }` → `applyRepair` with exactly the actions the user confirmed; then `rebuild()`.
- `POST /api/index/rebuild` (J03) also clears `invalid` if the files are now valid.
- UI **Repair…** shows the planned actions as a list ("Rename … → …", "Renumber chapter 2"), unrepairable files with "fix this file by hand", and Apply/Cancel. Nothing runs without Apply.
- CLI parity: `node apps/server/src/main.mjs repair --library <path> [--apply]` and `rebuild --library <path>` (reuse `sf-manuscript` logic; print the plan; write only with `--apply`).

## 6. Single-instance lock

- On startup the server acquires `<libraryRoot>/.storyforge-lock` via a new store method `store.acquireLock(path, info)` (exclusive create, content = JSON `{ pid, hostname, started_at, port }`).
- If the lock exists and its `pid` is alive on this host → refuse to start: exit code 3, message naming the pid/port.
- If the pid is not alive (or the hostname differs and the lock is older than 24 h) → take it over, record `lock: 'taken-over'` in status.
- Released on clean shutdown (SIGINT/SIGTERM/`server.close`). Tests/CLI `repair` and `rebuild` also take the lock (or refuse if a server holds it, with exit 3 — except `repair` without `--apply`, which is read-only and needs no lock).
- The lock file is not author data; it's ignored by validation and the watcher.

## 7. Symlinks (carried from J02)

`store` refuses any operation whose real path (after `fs.realpath`) leaves the book root → `OUTSIDE_ROOT`. Validation/indexing skip symlinked directories.

## Acceptance (test-author)

Use temp copies of `packages/format/fixtures/valid/salt-orchard` unless stated. Wait for conditions with a bounded poll (≤ 5 s), never fixed sleeps.

1. **External valid edit:** with the server/repository watching, change a scene body with plain `fs.writeFile` → within 5 s `getScene` returns the new text and `search` finds a new word; `status` `fresh`.
2. **External rename:** rename a scene file within its folder (id unchanged) → same `id`, new `path`, same position; W202 shown if prefix now mismatches.
3. **External invalidation:** break a scene's YAML → within 5 s state `invalid`, `invalid_paths` lists it, diagnostics show `E100` for it; `getBook` still lists all 7 scenes in the old order with `problem` on that one; `getScene` returns the raw broken text byte-for-byte; the file is byte-identical to what was written (never touched); `search` still answers.
4. **External broken new file:** add a new `.md` with broken front matter under `manuscript/` → listed in `unplaced`, state `invalid`.
5. **Recovery by fixing:** fix the broken YAML externally → back to `fresh`, order correct.
6. **Repair:** misfile a scene externally (W201) and duplicate a sequence (E204) → state `invalid`; `repair/plan` lists one rename + one renumber; apply via the route → state `fresh`, validate clean for those codes, every original body still present (book or trash).
7. **Poll fallback:** start with watching disabled/forced to fail (test option) and `pollMs` 200 → an external edit is still picked up within 5 s; status `mode: 'poll'` with a reason.
8. **Own writes not double-processed:** `updateSceneBody` through the app triggers exactly one index update (count reconcile calls via a test hook).
9. **series/library edits:** change `series.md` title in the library fixture → affected books' `listBooks` reflect it within 5 s.
10. **Lock:** second `main.mjs` on the same library exits 3 with a message; a lock file with a dead pid is taken over; lock removed on clean shutdown; `rebuild` CLI refuses while a server holds it.
11. **Symlink:** a symlinked file or directory pointing outside the book → store write refused `OUTSIDE_ROOT`; not indexed. (Skip with a clear `t.skip` reason if the OS refuses to create symlinks without privileges.)
12. **M01 gate (end-to-end):** start server on a temp library; build index; stop server; delete `.storyforge/` entirely; edit a scene in "an external editor" (`fs.writeFile`) and rename another; start server again → same scene IDs, correct order, edited text served, search finds the new word, no file lost (every `.md` from before exists with expected bytes, except the two intentionally changed), status `fresh`.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone. Tests must clean up watchers and servers (no hanging handles: the suite must exit on its own).
