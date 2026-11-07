# AI Workspace (M12 draft plan)

Goal: the last phase. An AI can work a whole book with the author: workspace docs (book, style, plan, state), ledgers, continuity check, writing log, tasks, and it can create chapters and scenes.
The author turns it on or off per book and picks **how much AI** they want.

Sources: the Claude-Book workflow (`E:\Claude-Book-main`, its chapter loop and old `codex_*` tools) and story-skills (stages, approval gates, `story context`, continuity checks).

## What exists today

- Modules on/off per book (`ai`, `planner`, `continuity`, `tasks`, …). Tokens carry permissions: `read`, `propose`, `canvas`, `plan`, `events`.
- Story plan, scene plans, structures/beats, arcs, relationships, clues, synopses (M1–M11). AI can change all of it with `plan`.
- Continuity engine: CF1 facts, TL1 timeline, KN1 knowledge, ST1 possession/location, TH1 threads, PL1–PL6. Exceptions = dismissals.
- Threads (promise / question / mystery / subplot / arc, setup and payoff scenes). Timeline events carry `knows`, `learns` and `state` items.
- Writing log `activity/writing-log.md`, Tasks `planning/tasks/`, suggestions (author accepts hunks), Undo for every write.
- Legacy import already lands old workspace docs, state docs, ledgers, knowledge and writing log in these places.
- Missing: workspace docs as a concept, chapter cast, continuity settings, AI task flag, AI word share, any AI path to create chapters or scenes. The old tool names are in `NOT_OFFERED`.

## Core decisions

1. **One switch, three levels.** A new `workspace` module (on/off per book). When on, the author picks an **AI level** per book. The server caps every token by the level, so the level always wins over what a token was granted.

| Level | AI may |
|---|---|
| Off (module off) | read only (as today) |
| **Advisor** | read, suggest edits, add tasks and notes, run checks |
| **Planner** | + change the plan, canvas, workspace docs, ledgers, state |
| **Co-writer** | + create chapters and scenes with draft prose |

2. **Reuse, don't copy.** Each Claude-Book piece maps onto what StoryForge already has:

| Claude-Book / story-skills | StoryForge home |
|---|---|
| plan doc, synopsis, structure | story plan, scene plans, structures, synopses (exists) |
| promises / questions ledger | threads (exists; kinds promise, question) |
| clues | clues (exists) |
| knowledge facts, state events (died, lost, holder…) | timeline event `knows` / `learns` / `state` items (exists) |
| timeline current / history | timeline events (exists) |
| writing log | `activity/writing-log.md` (exists) + AI share (new) |
| tasks, "for Claude" | tasks (exists) + `for: ai` field (new) |
| book doc, style doc, voice | **new** `planning/workspace/book.md`, `style.md` |
| state per chapter (situation, characters, knowledge, inventory) | **new** `planning/state/chapter-NN/*.md` (same layout the legacy import uses) |
| chapter cast (pov / appears / mentioned) | **new** scene field `cast` |
| continuity thresholds, severities | **new** `planning/continuity/settings.md` |

3. **Never overwrite the author's prose.** Even at Co-writer, AI edits to existing scenes stay suggestions. AI may only create *new* chapters and scenes. They are marked `origin: ai` and `status: draft`, and one click undoes them.
4. **Locks.** Any workspace doc or state folder can be locked. AI writes to a locked doc are refused. Only the author unlocks.
5. **Know how much is AI.** Words AI writes are logged with source `ai`. Insights shows the human vs AI share, and can draft an AI-use disclosure.
6. **Everything AI does shows in an AI Activity feed**, with Undo per item.

## New AI tools (MCP), by level

- **Advisor:**
  - `codex_get_context` (story-skills `context`: plan, cast, POV knowledge, open promises, last scene, style, all packed for one chapter)
  - `codex_list_docs`, `codex_get_doc`
  - `codex_get_ledger`, `codex_get_cast`, `codex_knowledge_at`, `codex_get_state_events`
  - `codex_continuity_check`
  - `codex_get_tasks`, `codex_create_task`
- **Planner:**
  - `codex_save_doc`, `codex_append_doc`
  - `codex_save_ledger_item` (thread), `codex_set_chapter_cast`
  - `codex_record_knowledge`, `codex_record_state_events`
  - `codex_dismiss_finding`, `codex_restore_finding`
  - `codex_update_task`, `codex_complete_task`, `codex_log_writing`
  - Retire, never hard-delete.
- **Co-writer:** `codex_create_chapter`, `codex_create_scene` (new drafts only).
- Author only: lock/unlock, thresholds, AI level.

## Jobs

| Job | What |
|---|---|
| W1 | `workspace` module, AI level per book, server cap of token permissions by level, new permissions `workspace` and `draft`, AI Activity feed (I write the gating myself) |
| W2 | Workspace docs: book, style (style sheet + voice samples), state per chapter; locks; routes; MCP doc tools |
| W3 | Ledgers: scene `cast` field; promise/question views over threads; knowledge and state-event tools over timeline events |
| W4 | Continuity: new rules (dead character on the page, destroyed or lost object used, promise overdue after N chapters); settings file (thresholds, severity on/off per rule); `codex_continuity_check`, dismiss and restore |
| W5 | Writing log AI share + disclosure draft; tasks `for: ai`; task and log tools |
| W6 | Co-writer: create chapter and scene (draft, `origin: ai`), `codex_get_context` pack |
| W7 | The workflow: a StoryForge "chapter loop" skill adapted from Claude-Book (plan → approve → draft → checks → state update → log), with story-skills gates (outline approval before prose) |
| W8 | Web: AI Workspace tab (Docs, State, Ledgers, AI Activity), AI level in book settings, Insights AI share; docs, contract, tests, CI |

Order: W1 → (W2, W3, W5 in parallel) → W4 → W6 → W7 → W8. One PR per two or three jobs. Deploy only on your OK.

## Out of scope

- An AI that runs on its own on a schedule (story-skills has a GitHub Action for that). Possible later.
- Automatic humanizer / voice-fingerprint scripts (Claude-Book local scripts). The style doc keeps the voice rules; the skill can use the humanizer skill.
- Promoting AI drafts to canon without the author.

## Done when

- With the module off, AI tools act exactly as today.
- At each level, the AI can do exactly that level's list, and nothing more, even with a token that has more permissions.
- An AI can run one full chapter loop on a test book: context → plan → new draft scene → continuity check → state docs and ledgers updated → writing log. Every step shows in AI Activity with Undo.
- Existing scenes never change without the author accepting a suggestion.
- `npm run ci` passes.
