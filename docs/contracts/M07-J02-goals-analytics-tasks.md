# M07-J02 contract — goals, sessions, dashboards and revision tasks

Binding: DECISIONS 1, 4, 5; FORMAT-v1 §3.3 `daily_word_goal`, §9.1 writing log; M03-J04 (activity routes, sessions, goal card); M04-J02/J03 (codex, board, threads matrix); M05-J01/J02 (continuity findings, fingerprints); M05-J06 (author check findings); M07-J01 (labels, shared entries).

All new data is **portable project files**. Every chart is computed from the rebuildable index, or from the files when the index is not fresh. Nothing is stored only in SQLite.

## 1. Goals — `activity/goals.md` (author data, optional)

```yaml
---
schema: storyforge.goals/v1
id: note_…
goals:
  - { id: g1, kind: words,   target: 500,   period: day }
  - { id: g2, kind: words,   target: 90000, period: total, due: 2027-03-01 }
  - { id: g3, kind: scenes,  target: 5,     period: week }
  - { id: g4, kind: minutes, target: 300,   period: week, scope: chap_… }
---
```

- `kind`: `words`, `scenes`, `chapters` or `minutes`.
- `period`: `day`, `week` (ISO, Monday start), `month`, `total`.
- `due`: ISO date, optional; `total` only.
- `scope`: a chapter/act ID, or absent for the whole book.
- `daily_word_goal` in `book.md` stays valid. When there is no `words`/`day` goal, the app shows it as one; the two are never written twice.
- Bad shape → `E102` at `goals[i].<key>`. A `scope` that does not resolve → `E301`.

## 2. Sessions and timers — `activity/sessions/<YYYY>/<YYYY-MM>.md`

- A `storyforge.doc/v1` file with one Markdown table, newest last:
  `| Start | End | Minutes | Added | Removed | Kind | Scenes |`
  - `Kind`: `session`, `sprint` or `timer`.
  - `Scenes`: scene IDs, space-separated.
- **Write rules:**
  - Appended by the server on `POST …/activity/session`. That route gains `{ start, end, kind, scenes }`; the old `{ minutes }` body keeps working.
  - Rows the app cannot parse are kept and skipped, as in §9.1.
  - The writing log (§9.1) remains the per-day summary. Sessions add detail and never replace it.
- **Timers (client):**
  - Sprint: N minutes, with an optional word target.
  - Timer: plain countdown, with pause and resume.
  - Finishing one reports a row with that `kind`. An abandoned timer writes nothing.
  - Keyboard operable. The time left is announced politely, once a minute, in the shared live region.
- **Streaks:** computed from the writing log and sessions, as in M03-J04, extended to every `day` goal.

## 3. Dashboards — route `/books/:id/insights`

One page with sections. Every chart has a text/table alternative ("Show as table") and is drawn as hand-made SVG with the design tokens. No new dependencies.

- **Progress:**
  - each goal's progress (with progressbar aria);
  - words per day over the last 30/90 days (writing log);
  - the projected finish date for a `total` goal with `due`.
- **Manuscript:**
  - words per chapter and per scene;
  - scenes by status;
  - scenes by label (J01);
  - POV share by words.
- **Story:**
  - character appearances by chapter (heat map: entry × chapter, scene count);
  - plot threads by chapter (matrix: planted / developed / paid);
  - relationship counts per character (from `related`);
  - timeline event density by chapter.
  - Shared series entries count like book entries and are badged.
- **Data:**
  - A route `GET /api/books/:id/insights` returns one JSON with every series of numbers.
  - The output is deterministic: sorted keys, stable order (by chapter/sequence, then id).
  - Computed from the index when it is fresh, else from `validate()`. Both paths give the same JSON (tested).
- Each chart element links to its source. For example, a heat-map cell → that entry filtered to that chapter's scenes, and a status bar → Outline filtered by status.

## 4. Revision tasks — `planning/tasks/<slug>.md`

```yaml
---
schema: storyforge.task/v1
id: note_…
slug: fix-ilse-eye-colour
title: "Ilse's eyes: grey in ch 2, green in ch 9"
status: open            # open | doing | done | dropped
source: { kind: continuity, code: CF1, fingerprint: cf1-… }   # kind: continuity | check | manual
targets:
  - { id: scene_…, line: 14, quote: "her green eyes", sha256: … }   # sha256 of the scene file when the task was made
created: "2026-11-02T14:03:22Z"
labels: []
---
Evidence and notes (Markdown). The finding's message and quotes are copied here at creation.
```

- **Creating a task:**
  - Continuity findings (M05-J02) and author-check findings (M05-J06) gain **Make a task**. It writes one task file through the store and **never touches prose**.
  - The same finding (`source.fingerprint`) cannot make two open tasks. The existing one is offered instead.
  - Manual tasks come from the Tasks page.
- **Opening a task target:**
  - It goes to that scene and selects the quote. It looks at `line` first, then for a unique occurrence of `quote`. This is the same locating rule as suggestion hunks.
  - When the quote can't be found, it opens the scene and says so. It never guesses.
- **Changing a task:** status changes are single-line front-matter edits.
- **Format checks:**
  - A target ID that doesn't resolve → `W313`, a new warning, at `targets[i].id`.
  - Bad shape → `E102`.
  - Validator: new kind `task`, folder rule `planning/tasks/` (`W201` elsewhere).
- **Tasks page** `/books/:id/tasks`: list with filter by status, label and source; keyboard flow; counts on the Insights page.
- Legacy-imported `planning/tasks/*.md` docs (M06) stay plain docs. They are not converted.

## 5. Acceptance

1. **Rebuild reproduces dashboards:**
   - On the M06-J03 large synthetic book plus the `tidewater` fixture, take `GET …/insights` JSON.
   - Delete every `.storyforge/`, rebuild, and take it again: byte-identical.
   - It is also identical when computed without an index.
   - A golden for the fixture's counts.
2. **Task opens its source without changing prose:**
   - Make a task from a continuity finding.
   - Snapshot the book (sha of every file except the new task and receipts).
   - Open the task (route returns scene + selection), mark it done.
   - Snapshot again: unchanged except the task file.
3. **Goals and sessions round trip:**
   - The files are parsed and written back byte-identical when untouched.
   - Malformed rows are kept.
   - `daily_word_goal` stays compatible.
4. **Timers:** fake-clock tests for sprint, pause and resume, and abandon (no row).
5. **UI:** a11y audit extended to Insights and Tasks; a keyboard walk through Insights → heat-map cell → scene, and Tasks → open → done.
6. `npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
