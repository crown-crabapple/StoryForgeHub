# M05-J07 contract — keep the receipts: provenance ledger

Binding: DECISIONS 1, 5, 6, 11, 12 and "Provenance receipt v1 minimum"; CLAUDE-BOOK-INTEGRATION "Receipts in the author workflow"; contracts M01-J02 (store), M03-J02 (editor saves), M03-J04 (revisions), M01-J04 (watcher), M05-J03 (export, backup `includeProvenance`), M05-J04 (`recordProvenance` hook, AI), M05-J06 (suggestions, check, publish).

Receipts are **records**, kept in the book folder, readable without StoryForge, and never sent anywhere except by an explicit author export. They never decide authorship or copyright.

## 1. Files

### 1.1 Receipt — `provenance/<YYYY>/<MM>/<rcpt_ULID>.md`

~~~markdown
---
schema: storyforge.receipt/v1
id: rcpt_01…
at: "2026-11-02T14:05:00.123Z"
actor: ai                       # author | ai | external | system
operation: suggestion.accept    # see 1.3
workflow: ai-rewrite            # editor | ai-rewrite | ai-chat | suggestion | claude-book | watcher | revision | undo | export | check
target: { id: scene_01…, path: manuscript/…/0010-arrival.md }
before_sha256: 3b9e…            # target bytes before ("" when the file did not exist)
after_sha256: 77c1…             # target bytes after (equal to before when nothing was written)
ranges:                         # changed line ranges, 1-based, in before / after
  - { before: [17, 17], after: [17, 17] }
parents:                        # hash links: id + sha256 of the parent receipt FILE bytes
  - { id: rcpt_01…, sha256: a41f… }
ai:                             # only for AI-related receipts
  provider: Local mock
  model: mock-1
  locality: local
  settings_sha256: …
  prompt_sha256: …              # sha256 of the instruction text
  context_sha256: …             # M05-J04 contextSha256
  suggestion: note_01…          # M05-J06 suggestion id
  hunks: [h2]
  acceptance: accepted          # proposed | accepted | declined | partial
---
Plain-language summary line (generated), e.g. "Author accepted 1 of 3 AI-suggested changes (lines 17–17)."

```diff
@@ -17,1 +17,1 @@
-…
+…
```
~~~

- Receipts are **immutable**: written once with `store.create`; never edited or deleted by the app (archive is not offered).
- The diff is the exact line diff from the `before` object to the `after` object (§1.2); for no-write receipts (`check.report`, `suggestion.decline`, `ai.proposal`) the body holds the *proposed* diff or nothing, and `after_sha256 == before_sha256`.
- Full prompt/context text is stored **only** when the author ticks "Keep the full prompt in the receipt" (per action; default off) — then in a `## Prompt` section of the body.

### 1.2 Content objects — `provenance/objects/<first 2 hex>/<sha256>`

Raw bytes of every `before`/`after` state a receipt names, content-addressed (written once, skipped when present). No extension, so readers never mistake them for Markdown documents. This is what keeps "the original author save and every intermediate revision recoverable" without `.storyforge/`.

### 1.3 Operations

| operation | actor | when | writes target? |
|---|---|---|---|
| `baseline` | system | first time StoryForge sees a scene with no receipt (§2) | no |
| `author.edit` | author | flush of the author's own saves (§2) | already written by the editor |
| `external.change` | external | the watcher sees a scene change not made by StoryForge | already on disk |
| `ai.proposal` | ai | M05-J06 suggestion created from an AI reply | no |
| `ai.generation` | ai | co-write draft recorded (adapter `co-write`) | no (target = the draft path in `.work`, outside the book: `target.id` = `""`) |
| `suggestion.accept` | ai (if the suggestion source is ai) / author / system (claude-book) | hunk(s) accepted | yes |
| `suggestion.decline` | same | hunk(s) declined | no |
| `undo` | author | an Undo (restoreOp) on a scene | yes |
| `revision.restore` | author | M03-J04 revision restored | yes |
| `publish` | author | adapter `publish --confirm` | yes |
| `check.report` | system | app check / adapter check | no |
| `ai.chat` | ai | chat sent (no target; `target.id` = `""`; hashes of the files given) | no |

Partial acceptance = several `suggestion.accept`/`suggestion.decline` receipts on one suggestion; the summary and `acceptance` say `partial` once at least one is accepted and one declined.

### 1.4 Chain

- **Per target:** every receipt for a scene has as first parent the previous receipt for that scene (by time). The first receipt of a scene has none (its `before_sha256` is the first state StoryForge saw).
- **Cross links:** `suggestion.accept`/`decline` also lists the `ai.proposal` receipt of that suggestion; `publish` lists the `ai.generation` receipt when the draft was recorded.
- **Flush before others:** before writing any non-author receipt for a scene whose current bytes differ from its last receipt's `after_sha256`, the app first writes an `author.edit` (or `external.change`, if the watcher reported it) receipt for that difference, so every change is attributed.

## 2. Author saves — coalesced, never lost

Editor autosaves are not one receipt each. Pending author changes for a scene are flushed into one `author.edit` receipt (diff from the last receipt's `after` object to the current bytes) when: (a) another actor is about to act on the scene (§1.4), (b) a revision is saved (manual or automatic, M03-J04), (c) the scene is closed or another scene opened, (d) 10 minutes have passed since the last flush and the bytes changed, (e) the author clicks **Record now** in the Receipts inspector. The first time StoryForge sees a scene with no receipt, it writes a `system` `baseline` receipt (`operation: baseline`, before = "" , after = current) — the "Author-written as first seen" starting point.

## 3. Wiring

- `recordProvenance(event)` (core, M05-J04 hook) becomes the receipt writer for every event kind M05-J04/J06 emit; the adapter (`publish`, `co-write`, `check`, `suggest`, `propose-state`) records through the same core function (or the callback option it exposes).
- The watcher's external-change path calls `recordProvenance({ kind: 'external.change', … })` for scenes.
- Undo (`restoreOp`) and revision restore record `undo` / `revision.restore`.
- Receipt writes go through the store in the **same batch** as the target write where there is one (target change and receipt land together or not at all).

## 4. Inspector — "Receipts"

- Editor rail section **Receipts** (and a full view): the scene's lineage in plain words, newest last, e.g. *Author wrote (baseline) → Author edited (3 sessions) → AI suggested 3 changes (Local mock, mock-1, local) → Author accepted lines 17–17 → Author declined 1 change → Author revised lines 19–19*. Each step expands to its details: time, actor, hashes, ranges, diff, AI settings/prompt hashes, parent links, receipt file path.
- **Selected passage:** select text in the editor → "Where did this come from?" → line-level lineage computed by replaying the chain's diffs (blame over the receipt objects): for each selected line, the receipt that last introduced it and its actor, shown as *Author-written*, *AI-generated proposal* (never in the scene unless accepted), *Author text edited with AI* (accepted AI hunk), *Changed outside StoryForge*.
- A fixed note: "Receipts are a record of what happened in this project. They are not legal advice and do not decide who owns or can copyright any text."
- Integrity status badge (§6) with the problem list.

## 5. Export controls (extends M05-J03)

- Export dialog gets **What to include**: (1) *Manuscript only* (default, as today — no provenance, provider or prompt data anywhere in the bytes); (2) *Manuscript + provenance summary* — appends a "Provenance summary" section/chapter: per scene, the plain-language lineage and counts, plus the legal-not-a-determination note; no prompts, no hashes of private settings beyond receipt ids; (3) *Complete private evidence package* — a zip: the manuscript export (chosen format), `provenance/` receipts for the selected scenes (all by default) and the objects they reference, `verify.json` (§6 result), and `README.txt` explaining what it is, that it is private, and the not-legal-advice note. A warning before download: "This contains your full text history and any prompts you chose to keep."
- Backup's `includeProvenance` (M05-J03) now has real content; still off by default.
- CLI: `export … --include manuscript|summary|evidence`.

## 6. Integrity — report, never repair

`verifyReceipts(bookRoot) → { ok, receipts, problems: [{ code, file, receipt?, detail }] }`, run on demand (Inspector, CLI `node apps/server/src/main.mjs receipts verify --library … --book …`, and the evidence export):

| code | meaning |
|---|---|
| `RCPT_PARENT_MISSING` | a parent id has no receipt file |
| `RCPT_PARENT_ALTERED` | a parent receipt file's bytes no longer hash to the recorded `sha256` |
| `RCPT_OBJECT_MISSING` | a named before/after object is absent |
| `RCPT_OBJECT_ALTERED` | an object's bytes don't hash to its name |
| `RCPT_DIFF_MISMATCH` | applying the receipt's diff to `before` does not give `after` |
| `RCPT_CHAIN_GAP` | a receipt's `before_sha256` ≠ the previous receipt's `after_sha256` for that target |
| `RCPT_UNRECORDED` (info) | the scene's current bytes ≠ its last receipt's `after` (pending author edits or an edit made while StoryForge was closed) |
| `RCPT_MALFORMED` | front matter fails the schema |

Nothing is rewritten, renumbered or "fixed"; the author sees the list. The validator (`@storyforge/format`) accepts the `receipt` kind and ignores `provenance/objects/**`; it does not run the chain check.

FORMAT-v1: `provenance/` layout and the `receipt` kind (new §9.4, §11.1), marked M05-J07.

## 7. Privacy

- Receipts, objects and prompts never leave the machine except through the author's export/backup choice. The AI provider receives only what M05-J04 already sends (the previewed package) — receipts add nothing to provider requests.
- No receipt contains an API key (test scans every receipt and object).

## 8. Acceptance

1. **The scenario:** on a copy of Salt Orchard, open Arrival (baseline receipt), the author edits a line (flush → `author.edit`), an AI rewrite (mock) proposes a suggestion changing three separate line ranges (`ai.proposal`), the author accepts one hunk, declines one, and edits the third range by hand (flush → `author.edit`). The Inspector lineage reads in that order; "Where did this come from?" on each of the three ranges reports: accepted → *Author text edited with AI*, declined → *Author-written* (unchanged), hand-revised → *Author-written* (author edit after an AI proposal, with the proposal visible as history).
2. **Hash chain:** every receipt's parents resolve and hash-match; diffs replay before→after exactly; `verifyReceipts` → ok.
3. **Rebuild:** delete `.storyforge/` entirely (index, trash, revisions), restart → receipts still verify, Inspector shows the same lineage (all from `provenance/`).
4. **Tamper:** edit one receipt byte → `RCPT_PARENT_ALTERED` on its child; delete an object → `RCPT_OBJECT_MISSING`; edit the scene outside StoryForge while it's stopped → `RCPT_UNRECORDED` (and after restart with the watcher, an `external.change` receipt on next flush); nothing is repaired.
5. **Exports:** manuscript-only bytes contain no provider name, model, prompt text, receipt id or hash; summary contains the lineage text and the note; evidence zip contains exactly the receipts of the selected scenes + referenced objects + `verify.json` + `README.txt`.
6. **Atomic with the target:** a fault injected between target write and receipt write (store `__faults`) rolls both back.
7. **No key** in any receipt, object, summary or evidence package; full prompt stored only when ticked.
8. **Render tests:** Receipts rail section, lineage steps, selected-passage panel, integrity list, export include options with warning.
9. **Manual (coordinator):** scenario 1 in the browser with screenshots.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.

## Boundary

Not legal advice; no copyrightability labels. Never transmit receipts. Never rewrite history.

## 9. Package split (for parallel work)

- New package `@storyforge/receipts` (pure, no fs): `buildReceipt(fields) → { text, sha256 }`; `parseReceipt(text)`; `lineDiff(beforeBytes, afterBytes) → { diff, ranges }` (reuse `@storyforge/suggestions` diff); `applyDiff(beforeBytes, diffText) → bytes`; `verifyChain({ receipts: [{ path, bytes }], objectBytes(sha) }) → { ok, problems }` (§6 codes except `RCPT_UNRECORDED`, which core adds); `lineage(receiptsForScene) → steps` (plain-language, §4); `blame({ receipts, objectBytes, currentBytes, fromLine, toLine }) → [{ line, receiptId, actor, label }]`.
- Core: receipt writer behind `recordProvenance`, object store, flush rules (§2), `repository.getReceipts(bookId, sceneId)`, `repository.blame(bookId, sceneId, from, to)`, `repository.flushReceipts(bookId, sceneId)`, `repository.verifyReceipts(bookId)`.
- Routes: `GET /api/books/:b/receipts?scene=<id>` → `{ receipts, lineage, status }`; `GET /api/books/:b/receipts/blame?scene=&from=&to=`; `POST /api/books/:b/receipts/flush { sceneId }` (write-guarded); `GET /api/books/:b/receipts/verify`.
- Export (`@storyforge/export`) + web Receipts UI + export include options consume the above.
