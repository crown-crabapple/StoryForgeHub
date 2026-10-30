---
name: storyforge
description: >-
  Works an author's StoryForgeHub Codex through the codex_* MCP tools: runs the
  tasks flagged "for Claude", reads and edits entries and chapters, checks
  continuity, reports prose diagnostics, and fills the writing log. Use whenever
  the author says "check my Codex for tasks and run them", "run my tasks",
  "fill in the writing log", "log my writing", "search my book for …", "read
  chapter N", or "check this against my Codex". Requires the StoryForgeHub MCP
  connector (codex_* tools), which acts AS the signed-in author — their books,
  their role. Never invents canon; never hard-deletes; flags conflicts instead
  of overwriting.
---

# storyforge

The Claude-side co-worker for a StoryForgeHub Codex. Everything happens **through
the `codex_*` MCP tools** — the connector acts *as the author who connected it*
(their books, their role, their name in the app's activity log). There are no
files to manage and no sync to think about: the app is the source of truth and
every tool write lands in it directly.

## Requires: the StoryForgeHub MCP connector
The `codex_*` tools must be available (added under Settings → Connectors, either
by OAuth sign-in or a `?k=<personal token>` URL). If they aren't, point the
author at their app's **Working with Claude** page (`?p=claude`) and stop — do
not improvise another route.

## Before doing anything
1. `codex_status()` — confirms the connector is live and shows how many books,
   entries, and chapters *this author* can see.
2. Hold the writing rules for every edit: US English, sentence-case headings,
   `- **Trait:** value` colon-bullets, entry status only `seed`/`sketch`/`canon`.
   `reference.md` has the exact entry-markdown shape the app round-trips.
3. **Never invent canon.** If a task is ambiguous or would contradict the
   manuscript or the Codex, don't guess — ask.

## Task: "check my Codex for tasks and run them"
1. `codex_get_tasks(for_claude=1, status="todo")` — optionally scoped with `book=<id>`.
2. Mark a task you're starting with `codex_update_task(task_id, status="doing")`
   so co-authors see it's claimed.
3. Do the work through the tools:
   - Context: `codex_search(query)` (server-side, returns snippets across
     entries, chapters, and notes), `codex_get_entry(book, db, slug)`,
     `codex_get_chapter(book, chapter_id | file)` for full prose.
   - Create/edit an entry: compose the markdown (reference.md shape; new
     entries start `seed`/`sketch`), then `codex_save_entry(book, db, slug, md)`.
     Honor the task's `target_db`/`target_slug` if set.
   - Chapters: to EDIT existing prose, first `codex_get_chapter` (read it!),
     then `codex_save_chapter(book, filename, markdown, base_hash=<body_hash
     you just read>)`. A refused save means the chapter moved meanwhile — the
     refusal carries the current hash + body; merge your change into THAT and
     retry with the new hash. Creating a brand-new chapter needs no base_hash
     (`codex_save_chapter` with a fresh filename, or `codex_create_chapter`
     for a titled empty one). Never save over prose you haven't read.
4. Finish with `codex_complete_task(task_id, result="one line on what changed")`.
   **Blocked / ambiguous:** do NOT mark it done — set it back with
   `codex_update_task(task_id, status="todo", result="what you need decided")`
   and tell the author.
5. Report what ran and what changed. Writes are already persisted — nothing to push.

## The Workspace (plan, style, story state, chapter log)
Each book has a **Workspace** of Markdown docs for the planning layer:
`book` (settings), `synopsis`, `plan` (the outline), `structure`, `style`,
`development/*` (proposals — never treat as canon), `state/chapter-NN/*`
(story state after each chapter), and `timeline/history` + `timeline/current-chapter`.
- Read with `codex_list_docs(book, prefix?)` / `codex_get_doc(book, path)`.
- Write with `codex_save_doc` — same rule as chapters: read first, pass the
  `body_hash`; a refusal carries the current body to merge into.
- `timeline/history` only grows: `codex_append_doc`. `state/current/*` is the
  newest snapshot, read-only — write `state/chapter-NN/*` instead.
- Once a chapter's state is final, `codex_lock_docs(book, "state/chapter-NN")`.
  Locked docs refuse writes; only the author can unlock.

## Continuity ledgers (promises, chapter cast, knowledge)
Structured story state the Workspace prose can't check:
- **Promises & questions** — `codex_get_ledger(book)` before planning a
  chapter; `codex_save_ledger_item` when a chapter plants a setup or poses a
  question (`planted_in`) and again when it pays off / resolves (`payoff_in`).
  One item per setup. Retire with status `dropped`/`abandoned`, don't delete.
- **Cast** — after a chapter is final, `codex_set_chapter_cast(book, chapter,
  [{slug, role}])`: `pov`, `appears` (physically on the page) or `mentioned`
  (memory, letter, flashback, talk). A dead character in a flashback is
  `mentioned`, never `appears`.
- **Knowledge** — `codex_record_knowledge` for what each character learned in
  the chapter (`learned_in`); `codex_knowledge_at(book, character, at=N)`
  before writing a scene, so a POV character never acts on what they don't
  know yet.
Slugs are bible entry slugs; an unknown slug saves with a warning — create the
entry or a task rather than inventing canon.
- **State events** — after a chapter, `codex_record_state_events` for deaths
  and revivals, and objects destroyed / lost / found / changing `holder` or
  `location`, each in the chapter it happens.

## Task: "check continuity" (and before every chapter review)
1. `codex_continuity_check(book)` — or, for a draft not yet saved,
   `codex_continuity_check(book, chapter=N, cast=[...])` (nothing is saved).
2. **Errors** are contradictions in the record: fix the draft, or fix the
   record if the record is wrong. Report what you changed.
3. **Warnings** are prompts: an unpaid promise, an object away from its holder.
   Mention them; act only if the author's plan agrees.
4. A deliberate break (a seance, an unreliable narrator, a payoff in the
   sequel) → `codex_dismiss_finding(book, code, reason, slug?, chapter?)` with
   the author's reason. Never hide a finding by editing the record.
The check reads only the ledgers, never prose — judgement calls (does the
scene act on knowledge it shouldn't?) stay with the reviewer.

## Task: "fill in the writing log" / "log my writing"
1. `codex_list_chapters(book)` and sum the words for the manuscript total.
2. Compare to the last logged baseline (`codex_get_tasks` is not the log —
   the app's writing-log rows come back from `codex_log_writing`'s page).
   If there's no prior baseline, set it silently — don't log a giant first row.
   Only log when the delta is non-zero.
3. `codex_log_writing(book, words_added, total_words, chapters, note="…")`.
   Leave minutes/mood blank unless given; rows are stored as `source: claude`.

## Task: "what do the diagnostics say about chapter N?"
`codex_get_diagnostics(book, chapter_id)` returns the app's Smart-editing
analysis — overused words, repeated phrases, patterns to review (severity-
tagged), and dialogue-tag stats. Present them as **review prompts, not
verdicts**, and never as "AI-written" claims.

## Leaving work for the author
`codex_create_task(book, title, body, for_claude=False)` puts a card on the
book's Tasks page — use it for things you found but shouldn't decide alone
(continuity questions, missing entries, contradictions).

## Rules
- **Never hard-delete.** To remove something, blank the section or note it in
  the result — entries and chapters are never deleted by Claude.
- **Never invent canon** that contradicts the manuscript or the Codex.
- **Flag conflicts, don't overwrite.** If a save is refused because someone
  edited meanwhile, or your intent disagrees with what the app holds, report
  it and let the author decide.
- Everything goes through the `codex_*` tools — no files, no bridges.
