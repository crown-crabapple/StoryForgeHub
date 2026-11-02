# M05-J02 contract — continuity review experience

Binding: contract M05-J01 (findings, fingerprints, exceptions, `GET /api/books/:b/continuity`); M03-J02 (editor, `?line=` jump), M03-J04 (editor rail), M04-J02/J04 (dialog and write patterns, Undo); DECISIONS 1, 6. Design tokens: `design/README.md` (dark graphite, warm gold for action/selection).

Diagnostics are **advice**. Nothing in this job changes prose, Codex entries or events; the only files it writes are continuity exceptions (`planning/continuity/<slug>.md`).

## 1. Write routes (exceptions)

- `POST /api/books/:b/continuity/exceptions` body `{ fingerprint, rationale, title?, dryRun? }` → creates `planning/continuity/<slug>.md` per M05-J01 §1.3 through the store (atomic, journaled). `slug` from the title (default: the finding's title) made unique (`-2`, `-3`). `created` = today (local date). Refusals (nothing written): unknown fingerprint (not a current finding) → 404 `FINDING_NOT_FOUND`; already excepted → 409 `ALREADY_EXCEPTED`; empty/whitespace rationale → 400 `RATIONALE_REQUIRED`. Returns `{ file, slug, undo: { op } }`. `dryRun` returns the file text without writing.
- `DELETE /api/books/:b/continuity/exceptions/:slug` → **archives** the exception file (store `archive`, recoverable — never a hard delete). 404 if missing. Returns `{ archived, undo }`.
- Undo: exact restore via the existing `restoreOp` mechanism (M03-J03), byte-identical.
- Same write guards as every write route (loopback, Host, JSON content type, `x-storyforge: 1`); 403 otherwise.

## 2. Editor rail — Continuity section (replaces the M05 placeholder in `Inspector.jsx`)

- Lists current findings whose sources include the open scene (by scene ID), errors first; count badge in the section title.
- Each card: severity dot, title, one-line message, the two (or more) sources as "file › heading, line N" links, actions **Show both**, **Acknowledge…**.
- When the scene has none: "No continuity findings for this scene." plus a link "Review all (N)" to the queue.
- **Non-blocking:** never a modal, never prevents typing/saving; refreshes after each save and on the status poll (≤ 3 s after an outside edit, as other rail data).
- In the editor text, the evidence range of a finding in the open scene gets a subtle dotted underline decoration (CodeMirror decoration only — never a text change) with the finding title as `title`/aria-description. Clicking a rail source of the open scene scrolls to and selects the range.

## 3. Review queue — new project tab **Continuity** (`/books/:id/continuity`)

- Added to `PROJECT_TABS` after Timeline.
- Sidebar filters: All · Errors · Warnings · Info · Acknowledged; by rule (CF1, TL1, KN1, ST1, TH1, with plain names); by character/entry (subject).
- List: one row per finding — severity, rule name, title, subject, first source; keyboard navigable (↑/↓, Enter opens).
- Detail pane:
  - Message, rule description (from `RULES`), fingerprint (small, copyable).
  - **Show both:** side-by-side panels, one per source (stacked under 900 px wide): heading, file path, line number, and ±3 lines of context around the evidence line read from the file, with the evidence range highlighted. Read-only.
  - **Open** on each source → navigates to the file: scenes → editor at `?line=N` (M03-J02); entries → Codex entry; events → Timeline `?event=`; threads → Threads tab; notes → Notes view.
  - **Acknowledge…** → dialog: rationale (required, multi-line), title (prefilled), "This creates `planning/continuity/<slug>.md` — a Markdown file you can edit or delete. It hides only this finding; if the facts change, a new finding appears." → Save → finding moves to Acknowledged, Undo toast.
  - In Acknowledged: the exception's rationale, file link, and **Restore finding** (archives the exception; Undo toast).
  - Stale exceptions (M05-J01 `stale_exceptions`) listed in Acknowledged with a note "No longer matches a finding" and **Remove** (archive).
- Context lines come from `GET /api/books/:b/continuity/context?file=<book-relative>&line=N&radius=3` → `{ lines: [{ n, text }] }`; `file` must be a canonical book file (no `.storyforge/`, no escape → 400); radius ≤ 10.

## 4. Guarantees

- No route or UI action in this job writes anything other than exception files.
- Findings shown in the UI equal the engine output (no client-side filtering beyond the visible filters).

## 5. Acceptance

1. **Salt Orchard flow (route + render tests, and manual):** open Arrival scene → Continuity rail shows the CF1 card → Show both shows `Eyes: Grey` (codex) and the "green eyes" line (scene) highlighted → Acknowledge with a rationale creates `planning/continuity/<slug>.md` whose `fingerprint` equals the finding's and whose body is the rationale → the finding leaves the rail and shows under Acknowledged → Restore finding archives the file → finding is back; Undo of each step is byte-identical.
2. **No prose/canon writes:** across the full flow, every file except `planning/continuity/**` and `archive/planning/continuity/**` (and `.storyforge/`) is byte-identical (hash the tree before/after).
3. **Refusals** write nothing: unknown fingerprint 404, duplicate 409, empty rationale 400, 403 guards, dry run writes nothing; context route escapes → 400.
4. **Outside edits:** writing an exception file by hand with `fs.writeFile` → finding suppressed within 5 s via the status poll (watcher on); deleting it by hand → finding returns.
5. **Render tests:** rail section (findings / empty state), queue filters, detail with both sources, acknowledge dialog validation, acknowledged list, stale exceptions; keyboard navigation of the list.
6. **Manual (coordinator, real browser):** the flow in 1 with screenshots of the rail card, Show both, and the Acknowledged view.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
