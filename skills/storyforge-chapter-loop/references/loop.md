# The chapter loop

One chapter per run. `NN` is the zero-padded chapter number (`04`). Every call takes `book`, the book's slug or id. Each step says what to skip at a lower level (see `levels.md`); argument names are in `formats.md`.

## 0. Status and level

Call `codex_status`. Note the book and its `ai_level` (`off`, `advisor`, `planner` or `cowriter`). Say the level to the author in one line. If the connector fails, stop.

## 1. Find the next chapter

1. `codex_list_chapters` gives the acts, chapters and scenes. The next number is the highest chapter plus one. If the author named a chapter, use that.
2. `codex_list_docs` lists the workspace docs by `path`. State docs are `state/chapter-NN/situation`, `characters`, `knowledge` and `inventory`. If earlier chapters have no state, tell the author and offer a backfill: for each, in order, read the chapter (`codex_get_chapter`, `chapter` is its number) and run step 9 on it. For a long book, offer to backfill only the last three chapters, and say that is what you did.
3. If there is no `workspace/book` or `workspace/style` doc, and the level is planner or above, offer `codex_setup_workspace`. It creates the starter docs that do not exist (`workspace/book`, `workspace/style` and `state/chapter-00/*`) and never touches an existing one. The starters hold template text in square brackets: fill them with the author's answers using `codex_save_doc` (pass `base_sha256`). Do not make up a style guide: ask the author, or look in notes with `codex_search`.

## 2. Gather context

Call `codex_get_context` with `chapter` and, if you need more or less than the default, `budget` (500 to 200000 characters; default 24000). The pack has these sections, in priority order: `workspace` (the book and style docs), `story`, `scene_plans`, `cast`, `knowledge` (what each point-of-view or appearing character knows at the end of the previous chapter), `open_ledger`, `state_events`, `state_docs`, `previous_tail` (the end of the previous chapter) and `continuity`.

`truncated` names every section that was cut. Read those sections in full with `codex_get_doc`, `codex_get_ledger`, `codex_get_state_events`, `codex_get_cast`, `codex_knowledge_at` and `codex_get_scene_plan`, or ask again with a larger `budget`.

Then read what the plan names: `codex_get_entry` for each character, place, faction, object and lore item (`entry` is its slug or id). Treat `canon` entries as binding, `sketch` as strong guidance, `seed` as loose guidance. Use `codex_search` when a name does not map to an entry.

## 3. Plan the chapter

Write the chapter plan (shape in `formats.md`): objective, starting point, beats, ending hook, cast with roles, ledger moves.

- The starting point must match the end of the previous chapter.
- Never plan a payoff before its setup. Weigh overdue promises (`codex_continuity_check` reports them as `TH2`).
- If a fact that decides whether a major event is possible is missing, mark the plan "needs resolution" and ask the author. Do not invent it.
- Advisor: show it in chat.
- Planner and up, chapter already has scenes: save a scene plan per scene with `codex_save_scene_plan`, and the beats with `codex_set_beats` (`codex_list_structures` gives the structure's `slug`, its beats and `sha256`).
- Planner and up, chapter not written yet: a scene plan and a beat's scenes name existing scene ids, so they cannot be saved yet. Save the whole plan as the doc `development/chapter-NN-plan` with `codex_save_doc`, and save the scene plans and beats once the scenes exist (after step 6, co-writer).

## 4. Author approval (gate)

Show the beats, cast and ledger moves. Ask the author to approve or change them. Do not write prose until they approve. If they change the plan, update it and ask again. A silent author is not an approval.

## 5. Pre-flight check

Call `codex_continuity_check` with `chapter` and `cast` (the planned cast, one `{ entry, role }` per character). It saves nothing. Errors are plain contradictions: `CS1` (a dead character is the point-of-view or appears in the cast), `CS2` (a destroyed or lost object is used), or a payoff before its setup. Fix the plan, and show the author if a beat has to change. Warnings go into your self-review.

## 6. Draft

Write to the approved beats, in the voice of the `workspace/style` doc. One scene per scene break. Do not add story events the beats do not cover.

- Co-writer: `codex_create_chapter` if the chapter does not exist (`title`, and `after`: the previous chapter's number), then `codex_create_scene` per scene (`chapter`, `title`, `body`, optional `summary` and `after`). Each scene arrives as an AI draft: origin `ai`, status `drafting`, whatever you pass. A new chapter comes with one empty placeholder scene; its id is `scene` in the answer. The server adds the words to the AI words of the writing log.
- Planner: deliver the draft in chat, or save it with `codex_save_doc` as `development/chapter-NN-draft` (a proposal, not canon).
- Advisor: deliver the draft in chat.

## 7. Self-review

Read the draft three times, each with one question. Keep notes short.

1. Style: does it follow the `workspace/style` doc and the book's word range (in `workspace/book`)? Use `codex_get_diagnostics` once the chapter exists in the book.
2. Character: does each character act and speak from what the entries and their knowledge say? Does anyone know something they have not learned?
3. Continuity: does it match the state docs, the timeline, the last scene, the ledger and the state events? Does anything dead, lost or destroyed show up?

If a pass finds a problem, revise and read again. At most 3 revision loops. Co-writer revises with `codex_save_draft` (`scene`, the whole new `body`, and `base_sha256` from `codex_get_scene` or from the last save). It works only while the scene is an AI draft with status `drafting`: if it is refused with `NOT_AI_DRAFT`, the author has accepted or written the scene, so stop and send the change with `codex_propose_edit` instead. A stale `base_sha256` is a conflict: read the scene again and redo the change. Lower levels send the corrected text in chat. If problems remain after 3 loops, stop and show the author what is left.

If the author asked for a humanizer pass, run the humanizer skill on the draft. Keep every beat, every line's meaning and speaker, all names and invented terms, point of view, tense, scene breaks and the ending hook. Put back any sentence it changed that carried one of those.

## 8. Check again

Call `codex_continuity_check` with `chapter`. New errors: if the record is wrong, fix the record. If the draft is wrong, revise (inside the 3 loops). If the author wants to keep a deliberate break, call `codex_dismiss_finding` with the finding's `fingerprint` and the author's `reason`. Never edit the record to hide a finding.

## 9. Record state

Planner and up. Extract only what the text establishes. Keep facts apart from beliefs and rumors. Formats are in `formats.md`.

Steps 3 to 6 need the chapter's scenes to be in the book: the cast call names a scene, and knowledge, state events and ledger scene lists name the chapter or scene ids. A call for a chapter or scene that does not exist is refused (`REFUSED_UNKNOWN_CHAPTER` or `REFUSED_UNKNOWN_SCENE`). If the draft is only in chat or in a `development/` doc, do steps 1, 2, 7 and 8 and put the rest in one task, as at advisor level.

1. State docs: `codex_save_doc` for `state/chapter-NN/situation`, `characters`, `knowledge` and `inventory` (new docs need no `base_sha256`; an existing one does).
2. Timeline: `codex_append_doc` with `path` `workspace/timeline` and the chapter's entry as `text`. It adds to the end and creates the doc when missing, so it needs no `base_sha256`. The timeline events of the book are read with `codex_get_timeline`; state events (step 5) go on the chapter's own event, titled `Chapter N (state)`.
3. Cast: `codex_set_chapter_cast` once per scene of the chapter.
4. Knowledge: `codex_record_knowledge` once per fact.
5. State events: `codex_record_state_events` once for the chapter.
6. Ledger: `codex_save_ledger_item` for each planted or paid-off item.
7. Log: `codex_log_writing` with the AI words added. Skip it for scenes made with `codex_create_scene` or `codex_save_draft`: the server already logged those.
8. Canon gaps: if the chapter names a person, place, object or faction with no entry, or stretches an entry, call `codex_create_task` once, listing them. Never create the entry yourself.

Advisor: put the same content in one task with `codex_create_task`, and say the record is not saved.

## 10. Lock

Planner and up: `codex_lock_docs` with `prefix` `state/chapter-NN` locks the chapter's state docs. Never edit a locked doc afterward (it is refused with `LOCKED`); later state goes in the next chapter's docs. There is no unlock tool: only the author unlocks.

## 11. Report

Tell the author, in plain words:

- the chapter title and word count;
- what was created (scenes, docs, ledger items, tasks);
- check results and how many revision loops;
- what you skipped because of the level;
- canon gaps you turned into tasks;
- how to undo: open AI Activity (in the AI Workspace tab) and use Undo on any item, or Archive on a chapter or scene you created.

Then ask whether to go on to the next chapter.

## Discovery mode (no outline)

Only when the author asks to write without an outline. Steps 0 to 2 as above, then:

1. Skip steps 3 and 4. Draft the chapter (step 6 rules), staying inside canon.
2. List every difference between the draft and the plan, ledger and entries. Put each in one kind:
   - **New**: a person, place, object or fact the book does not have.
   - **Contradiction**: the draft breaks something established.
   - **Enrichment**: the draft adds detail to something that exists.
   - **Dangling**: a setup with no planned payoff, or a payoff with no setup.
3. Reconcile each one:
   - Update the plan or ledgers to match (planner and up), or revise the draft.
   - New entities: ask the author. Only they approve them. Unapproved ones become tasks.
   - Contradictions: revise the draft unless the author chooses to change canon.
4. Go on with steps 5 and 7 to 11.
