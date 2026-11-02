# M05-J06 contract — author writes, StoryForge checks; suggestions stay unapplied until accepted

Binding: CLAUDE-BOOK-INTEGRATION.md (modes table, canon and state rule); DECISIONS 1, 6, 9, 11; contracts M05-J01 (findings), M05-J02 (review UI patterns), M05-J04 (AI rewrite, `recordProvenance` hook), M05-J05 (adapter, write boundary, context pack), M03-J03 (exact Undo).

The author is the only one who changes prose. Every machine output is a **report** or an **unapplied suggestion**. A suggestion changes a canonical file only when the author accepts it, and then only the accepted part.

## 1. Suggestion documents — `suggestions/<YYYY>/<YYYYMMDD-HHMMSS>-<slug>.md`

A new non-canonical kind (like `ai/` records): readable, portable, never treated as story text or canon.

~~~markdown
---
schema: storyforge.suggestion/v1
id: note_01…
target: scene_01…              # ID of the canonical file it would change (scene, entry, thread or event); or "" for a new file
target_path: manuscript/…/0010-arrival.md   # path when created (informational; the ID is the truth)
base_sha256: 3b9e…             # bytes of the target when the suggestion was made ("" for a new file)
source: ai                     # ai | claude-book | author
mode: suggest                  # suggest | state | canon
created: "2026-11-02T14:03:22Z"
status: pending                # pending | accepted | declined | partial  (derived from hunks; written for readers)
ai: { provider: …, model: …, locality: local, context_sha256: … }   # only when source is ai
hunks:
  - { id: h1, line: 17, lines: 1, original_sha256: …, status: pending }    # line = 1-based first line in the base file; lines = count replaced
  - { id: h2, line: 23, lines: 2, original_sha256: …, status: accepted, decided: "2026-11-02T14:05:00Z" }
---
Optional rationale (Markdown).

```diff
@@ -17,1 +17,1 @@ h1
-In the glass of the ticket hut she caught her own face, green eyes ringed with salt, and looked away.
+In the glass of the ticket hut she caught her own face, grey eyes ringed with salt, and looked away.
@@ -23,2 +23,1 @@ h2
…
```
~~~

- Hunks are line-based (whole lines); each `@@` header ends with the hunk id. The diff block is the source of truth for the proposed text; front-matter hunk entries carry the decisions.
- `original_sha256` = sha256 of the exact original lines (joined with the file's own line ending) — lets a hunk be re-found if other lines moved.
- Validator: new kind `suggestion` (required: `target`, `base_sha256`, `source`, `mode`, `hunks`); malformed hunks/diff → `E102`; `target` that doesn't resolve → `W308` (new: "suggestion target missing", warning — the target may have been archived). FORMAT-v1: `suggestions/` in §2, new §9.3, §11, §11.1, marked M05-J06.

### 1.1 Creating suggestions

- `createSuggestion(bookId, { target, proposedText | proposedRange, source, mode, rationale?, ai? })` in core: computes the line diff between the target's current bytes and the proposed bytes (Myers / LCS on lines; deterministic), splits it into hunks (adjacent changed lines = one hunk; unchanged line between = separate hunks), writes the suggestion through the store (create only). **Never writes the target.** A proposal identical to the target → refused `NO_CHANGE`.
- AI rewrite (M05-J04) now creates a suggestion (source `ai`, with the `ai` block) instead of holding the reply only in memory. The J04 routes keep working: `apply` = accept all hunks, `discard` = decline all.

### 1.2 Deciding

- `POST /api/books/:b/suggestions/:id/hunks/:h { decision: 'accept'|'decline' }` and `POST /api/books/:b/suggestions/:id { decision: 'accept'|'decline' }` (all pending hunks).
- **Accept hunk:** locate the hunk's original lines in the target **now**: at `line` if the lines there hash to `original_sha256`; else the unique place where they do; none or several → 409 `SUGGESTION_STALE` (nothing written). Replace exactly those lines with the hunk's new lines, keeping the file's line ending; write the target through the store with `baseSha256` = current target hash (journaled, atomic); then update the suggestion's hunk status in the same store batch. Undo (restoreOp) restores both files byte-identically.
- **Decline hunk:** only the suggestion file changes. The target is never read for writing.
- Each decision calls `recordProvenance({ kind: 'suggestion.accept'|'suggestion.decline', suggestionId, hunkIds, target, before_sha256, after_sha256, diff })`.
- Write-guarded like all write routes.

## 2. "Check my scene" in the app (mode `check`)

- Editor toolbar **Check scene** → `POST /api/books/:b/check { sceneId }` → report `{ scene, at, findings: [{ severity, kind: 'diagnostic'|'continuity', code, file, line, range, evidence, message, fingerprint? }], summary }` from (a) `validate()` diagnostics for the scene file and files it links, (b) continuity findings whose sources include the scene. **No model call, no write** (it emits `recordProvenance({ kind: 'check.report', … })` only).
- Shown in a report panel with Open links. Nothing in the panel changes text.

## 3. Adapter modes (`sf-claude-book`)

| Command | Output | Writes |
|---|---|---|
| `check --chapter n` or `--scene <id>` | `<work>/reports/chapter-NN-check-report.md` and `.json`: validator diagnostics + continuity findings + style-checker signals (unless `--no-style`), each with file, line, range, evidence and rule/code; exit 1 if any error | `<work>/` only. **No model, no humanizer, no network.** |
| `plan --chapter n` | context pack + `<work>/reports/chapter-NN-plan-request.md` (planner agent file, its inputs) | `<work>/` only |
| `suggest --scene <id> --from <file>` | a suggestion document (§1) from the alternative text in `<file>` (whole-scene body or full file); prints its path | creates **one file** under `<book>/suggestions/` through the store — the only book write the adapter may make besides `publish` |
| `co-write --chapter n --from <file>` | copies the draft to `<work>/drafts/chapter-NN-draft.md` with a header marking it a proposal | `<work>/` only |
| `publish --scene <id> --from <file> --expect-sha256 <hash> --confirm` | replaces the scene **body** (front matter kept byte-for-byte) | the scene, through the store, only with `--confirm` and a matching current hash (else exit 1, nothing written) |
| `propose-state --chapter n --from <chapter-NN-ledgers.json>` | suggestion documents of mode `state` / `canon` (§4) | creates files under `<book>/suggestions/` only |

- `--confirm` and `--expect-sha256` are never defaulted. `publish` calls `recordProvenance({ kind: 'publish', … })`.
- Fix from M05-J05: `ledger.md` status is computed **as of the target chapter** (payoff after chapter n → `open`; setup after n → thread omitted).

## 4. Proposed state, timeline and canon (after author approval)

`propose-state` reads the state-updater JSON (`chapter, cast, knowledge, state_events, ledger_items, unknown_slugs`) and creates suggestions, one per target file:

- `state_events` / `knowledge` → hunks adding `state` items (§6.2) to the chapter's event — the event whose narrative chapter is n and whose title matches `Chapter n` — or, if none, a **new-file** suggestion creating `planning/timeline/chapter-NN-state.md` (an event with `order` after the last event, `scenes` = the chapter's scenes).
- `ledger_items` (plant) → new thread file suggestion (`status: planted`, `setup` = chapter's first scene); (payoff) → hunk on the existing thread: `status: paid`, `payoff` += scene.
- `unknown_slugs` → mode `canon`: new seed entry file suggestions (`status: seed`, body "Proposed from chapter n — review before use"). Never `canon` status.
- Accepting a new-file hunk creates the file through the store; declining leaves nothing.

## 5. UI

- **Suggestions** in the editor rail (scene's pending suggestions, count badge) and a **Suggestions** group in the Continuity tab sidebar (all pending, by target).
- Review view: side-by-side (original | proposed) per hunk, word-level highlight, **Accept** / **Decline** per hunk, **Accept all** / **Decline all**, status chips; source badge (AI / Claude-Book / Author) and, for AI, provider and locality; Undo toast after accept.
- Decided suggestions remain listed under "Decided" with their outcome per hunk.

## 6. Acceptance

1. **Check is read-only:** on salt-orchard, app check of Arrival and adapter `check --chapter 1` both report the CF1 with file:line evidence; the whole book tree (bytes, mtimes, file list) is identical afterwards; no model call (network recorder from M05-J04 shows zero calls).
2. **Accepted hunk changes only its range:** a suggestion with three hunks on Arrival; accept h2 → only h2's lines changed (rest byte-identical), journaled write, Undo byte-identical for both files; suggestion status `partial`.
3. **Declined suggestion:** decline all → the scene byte-for-byte unchanged; only the suggestion file changes.
4. **Stale:** edit the hunk's original lines elsewhere → accept → 409 `SUGGESTION_STALE`, nothing written; lines moved but unique → accepted at the new place.
5. **AI rewrite → suggestion:** with the mock provider, rewrite creates a pending suggestion (source ai, ai block, no key); J04 apply/discard still pass.
6. **Adapter modes:** each command's write boundary (tree snapshots of book and framework); `publish` refuses without `--confirm`, with a stale hash, and keeps front matter bytes; `propose-state` from a sample ledgers JSON creates the expected suggestions and accepting them yields valid files (`validate()` clean).
7. **Provenance hook** called with the documented shapes for check, suggestion create/accept/decline and publish.
8. **Render tests:** rail section, review view (per-hunk buttons, side-by-side), Suggestions group, check report panel.
9. **Manual (coordinator, browser):** AI rewrite (mock) → suggestion with three hunks → accept one, decline one → screenshot; Check scene report.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.

## Boundary

No automatic canon promotion, no prose overwrite, no external call and no publication in default mode. Humanizer and models are never invoked by `check`.

## 7. Package split (for parallel work)

- New package `@storyforge/suggestions` (pure, no fs, depends on `@storyforge/format` only if needed): `buildSuggestion({ id, targetId, targetPath, baseBytes, proposedBytes, source, mode, rationale?, ai?, created }) → { text, hunks }` (throws `NO_CHANGE`); `parseSuggestion(text) → { fm, hunks: [{ id, line, lines, originalLines, newLines, original_sha256, status }], rationale }`; `applyHunk(targetBytes, parsed, hunkId) → { ok: true, bytes, at } | { ok: false, code: 'SUGGESTION_STALE' }`; `setHunkStatus(text, hunkIds, status, decided) → text`; `suggestionPath(created, slug)`. Deterministic line diff inside.
- Core/server/web use it for §1, §2, §5; the adapter (`@storyforge/claude-book`) uses it for `suggest` and `propose-state` and writes the one new file with `openStore(bookRoot).create(...)`; `publish` uses `store.write` with `baseSha256`.
