# What the loop does at each AI level

The author sets the level per book. The server caps every token by it, so a token with more permissions still gets only the level's powers. A level also needs the token's permission: both must allow a call. Read the level from `ai_level` of the book in `codex_status` at the start of every run.

| Level (`ai_level`) | The loop does | Permission the writes need |
|---|---|---|
| Off (`off`) | Read only. Answer questions about the book. Do not run the loop. | `read` |
| Advisor (`advisor`) | Context, plan and outline, checks, suggestions and tasks. No saved plan, no docs. | `propose` (suggestions), `workspace` (tasks) |
| Planner (`planner`) | Advisor, plus saved scene plans and beats, workspace and state docs, ledgers, cast, knowledge, state events, the writing log. | `plan`, `workspace` |
| Co-writer (`cowriter`) | Planner, plus new chapters and scenes with draft prose. | `draft` |

A book whose author set no level is at `planner`.

## Advisor

- Read: `codex_get_context`, `codex_get_doc`, `codex_list_docs`, `codex_get_ledger`, `codex_get_cast`, `codex_knowledge_at`, `codex_get_state_events`, `codex_get_tasks`, and the other read tools.
- Check: `codex_continuity_check`, `codex_get_diagnostics`.
- Write: `codex_propose_edit`, `codex_save_chapter`, `codex_save_entry` (all suggestions the author accepts), `codex_create_task`.
- Show the chapter plan and outline in chat. Deliver the draft in chat.
- Skip, and say so: saving plans or beats, state docs, ledger and cast writes, the writing log, locking, updating or completing tasks, dismissing findings.
- Put everything you would have recorded into one task so the author can apply it.

## Planner

Everything in Advisor, plus:

- Plan (`plan`): `codex_save_scene_plan`, `codex_set_beats`, `codex_create_link`, and the other plan tools. Canvas tools need the `canvas` permission.
- Workspace (`workspace`): `codex_setup_workspace`, `codex_save_doc`, `codex_append_doc`, `codex_lock_docs`.
- Ledgers (`workspace`): `codex_save_ledger_item`, `codex_set_chapter_cast`, `codex_record_knowledge`, `codex_record_state_events`.
- Findings and tasks (`workspace`): `codex_dismiss_finding`, `codex_restore_finding`, `codex_update_task`, `codex_complete_task`.
- Log (`workspace`): `codex_log_writing`.
- Deliver the draft in chat or as a doc under `development/` (a proposal, never canon).
- Skip, and say so: creating chapters or scenes.

## Co-writer

Everything in Planner, plus (`draft`):

- `codex_create_chapter`, `codex_create_scene` for new chapters and scenes. They arrive as AI drafts (origin `ai`, status `drafting`).
- `codex_save_draft` to revise an AI draft the author has not yet accepted (status still `drafting`).
- You still cannot change an accepted or author-written scene except by proposal (`codex_propose_edit`).

## When a call is refused

`AI_LEVEL` means the book's level does not allow it. `PLUGIN_SCOPE` means this token lacks the permission. In both cases:

1. Do not retry. Do not try another tool to do the same write.
2. Call `codex_status` to see the book's `ai_level`; the tools your token lacks the permission for are not in your tool list.
3. Carry on with the steps that are still allowed, in the lower-level form above.
4. List the skipped steps in the report, and say what the author can change (the level in Settings, AI level, or the token's permissions in Settings, AI connections).

Other refusals mean something else, not a level problem:

- `LOCKED`: the doc is locked. Do not write it; later state goes in the next chapter's docs.
- `NOT_AI_DRAFT`: the scene is not an unaccepted AI draft. Send a proposal with `codex_propose_edit`.
- `CONFLICT` (a stale `base_sha256`): read the doc or scene again, merge your change, retry once.
- `MODULE_OFF`: the author turned that feature off for the book. Skip the step and say so.

Only the author can change the level, unlock a doc, or set the continuity thresholds and severities. You can lock a doc with `codex_lock_docs`, but never unlock one.
