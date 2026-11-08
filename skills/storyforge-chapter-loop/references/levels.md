# What the loop does at each AI level

The author sets the level per book. The server caps every token by it, so a token with more permissions still gets only the level's powers. Read the level from `codex_status` at the start of every run.

| Level | The loop does |
|---|---|
| Off | Read only. Answer questions about the book. Do not run the loop. |
| Advisor | Context, plan and outline, checks, suggestions and tasks. No saved plan, no docs. |
| Planner | Advisor, plus saved scene plans and beats, workspace and state docs, ledgers, cast, knowledge, state events, the writing log. |
| Co-writer | Planner, plus new chapters and scenes with draft prose. |

## Advisor

- Read: `codex_get_context`, `codex_get_doc`, `codex_list_docs`, `codex_get_ledger`, `codex_get_cast`, `codex_knowledge_at`, `codex_get_state_events`, `codex_get_tasks`, and the other read tools.
- Check: `codex_continuity_check`, `codex_get_diagnostics`.
- Write: `codex_propose_edit`, `codex_save_chapter`, `codex_save_entry` (all suggestions the author accepts), `codex_create_task`.
- Show the chapter plan and outline in chat. Deliver the draft in chat.
- Skip, and say so: saving plans or beats, state docs, ledger and cast writes, the writing log, locking.
- Put everything you would have recorded into one task so the author can apply it.

## Planner

Everything in Advisor, plus:

- Plan: `codex_save_scene_plan`, `codex_set_beats`, `codex_create_link`, and the other plan tools.
- Workspace: `codex_save_doc`, `codex_append_doc`, `codex_lock_docs`.
- Ledgers: `codex_save_ledger_item`, `codex_set_chapter_cast`, `codex_record_knowledge`, `codex_record_state_events`.
- Findings and tasks: `codex_dismiss_finding`, `codex_restore_finding`, `codex_update_task`, `codex_complete_task`.
- Log: `codex_log_writing`.
- Deliver the draft in chat or as a doc under `development/` (a proposal, never canon).
- Skip, and say so: creating chapters or scenes.

## Co-writer

Everything in Planner, plus:

- `codex_create_chapter`, `codex_create_scene` for new chapters and scenes. They arrive as AI drafts.
- `codex_save_draft` to revise a draft you made that the author has not yet accepted.
- You still cannot change an accepted scene except by proposal.

## When a call is refused

`AI_LEVEL` means the book's level does not allow it. `PLUGIN_SCOPE` means this token lacks the permission. In both cases:

1. Do not retry. Do not try another tool to do the same write.
2. Call `codex_status` to see what the level and token allow.
3. Carry on with the steps that are still allowed, in the lower-level form above.
4. List the skipped steps in the report, and say what the author can change (the level in book settings, or the token's permissions in Settings).

Only the author can change the level, lock or unlock docs, or set continuity thresholds.
