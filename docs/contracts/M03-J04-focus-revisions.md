# M03-J04 contract — writing context, focus, goals and revisions

Binding: FORMAT-v1 §3.3 (`daily_word_goal`), §9 (`.storyforge/revisions/`), §9.1 (`activity/writing-log.md`) — all added 2026-11-01; DECISIONS 6 (recoverable prior versions), 7 (Git supported, never replaced or touched); contracts M03-J01 (structure commands), M03-J02 (editor, save controller, line diff), M01-J02 (single writer). Reference: `design/screens/Editor.dc.html` (right "In this scene" / "Scene notes" rail, goal card, focus mode).

## 1. Format support

- Validator: `book.md` `daily_word_goal` = integer ≥ 1 (else `E102`).
- `activity/writing-log.md`: a normal `storyforge.doc/v1` planning-style doc at the book root (validator must accept it with no diagnostics; it's not under `planning/`, so check the folder rules don't flag it — if they do, allow `activity/` explicitly).

## 2. Writing log (server side — authoritative counts)

- Every successful **body save** (J02 PUT, raw save, split/merge do NOT count) computes `added`/`removed` words for that save: word-level diff of old vs new body using `countWords` tokens (LCS on tokens is fine; cap cost by falling back to `max(0, new−old)` / `max(0, old−new)` above 20 000 tokens).
- Totals are kept per book per local date in memory and flushed to `activity/writing-log.md` (through the store, journaled) at most every 60 s and on shutdown; the row for today is updated in place; other rows untouched byte-for-byte. Missing file → created on first flush with `schema/id/title: Writing log`. Unparseable rows → kept, skipped.
- `Minutes` and `Sessions` come from client session reports (§3).
- Route `GET /api/books/:b/activity?days=30` → `{ goal, today: { added, removed, net, minutes, sessions }, days: [...] , streak }` (streak = consecutive days ending today/yesterday with net ≥ goal; 0 without a goal).
- Route `POST /api/books/:b/activity/session` (write-guarded) `{ minutes }` — client reports a finished session (≥ 1 min).
- Setting the goal: `POST /api/books/:b/goal` `{ daily_word_goal | null }` → single-line `book.md` edit via `editFrontMatterLine`. Removing the goal isn't supported by the line editor: `null` → `400 NOT_SUPPORTED`; the UI only offers setting or changing the number.

## 3. Sessions and goals (client)

- A **session** starts at the first edit in the editor and ends after 10 min without edits, on leaving the book, or on page hide; minutes = active span; reported via `POST …/session`.
- **Goal card** (reference: top of the right rail, or under the toolbar when the rail is hidden): "Today 412 / 500 words" + progress bar (`role=progressbar`), "This session +128", streak "3 days" when > 0; "Set a daily goal" link opens a small dialog (number input). Updates live from the save responses (PUT body response gains `{ words: { added, removed } }`) plus a refetch every 60 s.
- **Progress:** chapter row in the rail shows `scenes final/total` as a thin bar under the count; book word count vs `word_target` already exists (J02 of M02) — show it in the rail header.

## 4. Focus mode

- Toggle: toolbar button "Focus" + **Ctrl/Cmd+Shift+F**; **Escape** exits (unless a dialog is open).
- Hides the rail, inspector, project nav and top-bar controls; keeps a minimal top strip with the scene title, SaveStatus and "Exit focus". Centred prose column, larger margins.
- Options (persisted per user, safe storage): **Typewriter scrolling** (caret line kept ~40% from the top) and **Dim other paragraphs** (paragraphs other than the caret's at 45% opacity; decoration only).
- Autosave, conflict banner and draft store work unchanged in focus mode; a conflict exits focus mode automatically so the banner is visible.
- `prefers-reduced-motion`: no animated transitions.

## 5. Right rail (scene context)

Sections, top to bottom:
1. **Goal card** (§3).
2. **Scene** — status (select → J01 `setSceneFields`), POV (select of character entries → `setSceneFields`), summary (read-only text), words, last saved time, file path (copy button).
3. **In this scene** — characters/locations/threads from front matter **and** every `[[link]]` in the body (deduplicated; "mentioned" tag for body-only links), each as a button that expands an **entry preview**: name, type, status, first paragraph of its first `##` section, and its `fields` as a small list; new read route `GET /api/books/:b/entries/:id` → `{ id, slug, name, type, status, fields, sections: [{ heading, text }] }` (sections' text plain, first 600 chars each).
4. **Scene notes** — every `<!-- note: … -->` with its line; clicking moves the editor caret there.
5. **Continuity** — placeholder card "Continuity checks arrive in M05." + the validator problems for this scene (existing).
6. **Revisions** (§6).

## 6. Revisions

- **Snapshot** = the whole scene file's bytes, saved by the store to `.storyforge/revisions/<scene-id>/<YYYYMMDDTHHMMSSZ>-<reason>.md` with a sidecar line in `index.json` there (`{ file, at, reason, sha256, words, label? }`). Reasons: `session` (first save of each editing session, **before** writing), `interval` (every 15 min of active editing, before writing), `manual` ("Save a revision" button with optional label), `restore` (the current version, before a restore), `external` (before the editor reloads after an external change, when the buffer was clean but the disk changed — snapshot the **new** disk content so it's findable).
- Never stored twice when the sha equals the latest snapshot. Retention: keep all `manual` and `restore`; for others keep the latest 30 per scene plus one per day for 90 days; pruning moves pruned files to the trash, never deletes.
- Revisions follow the scene id, so moves/renames don't lose them.
- **List** in the rail: newest first, "Today 14:02 · session · 812 words", label if any.
- **Compare**: revision vs current body, line diff (J02 `line-diff.js`).
- **Restore** (two choices, both preview first):
  - **Restore into this scene** → snapshot the current file (`restore`), then save the revision's **body** through the normal body PUT with the current `base_sha256` (front matter of the current file kept; the old front matter is shown in the preview if it differed). The current version is never erased — it's now the newest revision.
  - **Restore as a new scene** → `createScene` right after the current one, title "<title> (revision <date>)", body = the revision's body.
- Git: the app never runs git; revisions live under `.storyforge/` (ignored by the recommended `.gitignore`). The rail shows one line: "Local safety copies on this computer. Use Git or backups for history you can't lose."
- Routes: `GET /api/books/:b/scenes/:s/revisions`, `GET …/revisions/:file` (body + front matter + sha), `POST …/revisions` `{ label? }` (manual), `POST …/revisions/:file/restore` `{ mode: 'into' | 'new', base_sha256, dryRun? }` (write-guarded).

## 7. Acceptance

1. **Writing log:** a series of saves → today's `added`/`removed` match a word-level recount; `activity/writing-log.md` rows correct; earlier rows byte-identical; unparseable rows kept; validator clean; deleting the file loses no manuscript text.
2. **Goal + streak:** set `daily_word_goal` (single-line edit, body untouched) → activity route reflects it; streak computed over fixture days.
3. **Revisions:** session/interval/manual/external snapshots created at the right moments (fake clock); no duplicate when sha unchanged; retention rules (fake clock over 120 days) move pruned files to trash; revisions survive a scene move/rename.
4. **Restore without erasing:** restore into → current version present as the newest revision byte-for-byte, scene body = revision body, front matter = current; restore as new → new scene after, original untouched; stale `base_sha256` → 409, nothing written.
5. **Entry preview route** returns name/type/fields/sections for an entry; 404 unknown.
6. **Focus mode** (render + pure logic): toggled state hides rail/inspector/nav; Escape and shortcut handling (pure keymap function); conflict exits focus mode; typewriter/dim options are decoration-only (serialise unchanged).
7. **Right rail render:** goal card numbers and progressbar aria; body-only links tagged "mentioned"; notes list with line numbers; continuity placeholder; revisions list order and labels.
8. **Editor reference scenario end-to-end (coordinator, real browser):** open a scene, write (autosave), see today's count rise toward the goal, add a note and jump to it from the rail, enter focus mode and write, exit, save a manual revision, change text, restore the revision into the scene and see the previous text as a new revision (nothing lost).

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
