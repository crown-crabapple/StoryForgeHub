# The chapter loop

One chapter per run. `NN` is the zero-padded chapter number. Each step says what to skip at a lower level (see `levels.md`).

## 0. Status and level

Call `codex_status`. Note the book and its AI level. Say the level to the author in one line. If the connector fails, stop.

## 1. Find the next chapter

1. `codex_list_chapters` gives the next number (highest plus one). If the author named a chapter, use that.
2. `codex_list_docs` shows which `state/chapter-NN` folders exist. If earlier chapters have no state, tell the author and offer a backfill: for each, in order, read the chapter (`codex_get_chapter`) and run step 9 on it. For a long book, offer to backfill only the last three chapters, and say that is what you did.
3. If there is no `book` or `style` doc and the level allows it, offer to create them with `codex_save_doc`. Do not make up a style guide: ask the author, or look in notes with `codex_search`.

## 2. Gather context

Call `codex_get_context` with the chapter and a token budget. It packs the plan, cast, what the point-of-view character knows, open promises, the last scene and the style. Then read what the plan names: `codex_get_entry` for each character, place, faction, object and lore item. Treat `canon` entries as binding, `sketch` as strong guidance, `seed` as loose guidance. Use `codex_search` when a name does not map to an entry. Read `codex_get_ledger` and `codex_get_state_events` if the pack is thin.

## 3. Plan the chapter

Write the chapter plan (shape in `formats.md`): objective, starting point, beats, ending hook, cast with roles, ledger moves.

- The starting point must match the end of the previous chapter.
- Never plan a payoff before its setup. Weigh overdue promises.
- If a fact that decides whether a major event is possible is missing, mark the plan "needs resolution" and ask the author. Do not invent it.
- Planner and up: save it with `codex_save_scene_plan` and `codex_set_beats`. Advisor: show it in chat.

## 4. Author approval (gate)

Show the beats, cast and ledger moves. Ask the author to approve or change them. Do not write prose until they approve. If they change the plan, update it and ask again. A silent author is not an approval.

## 5. Pre-flight check

Call `codex_continuity_check` with the chapter and the planned cast. It saves nothing. Errors are plain contradictions (a dead character on the page, a payoff before setup, a used object that was lost or destroyed): fix the plan, and show the author if a beat has to change. Warnings go into your self-review.

## 6. Draft

Write to the approved beats, in the voice of the `style` doc. One scene per scene break. Do not add story events the beats do not cover.

- Co-writer: `codex_create_chapter` if the chapter does not exist, then `codex_create_scene` per scene. They land as AI drafts.
- Planner: deliver the draft in chat, or save it with `codex_save_doc` as `development/chapter-NN-draft` (a proposal, not canon).
- Advisor: deliver the draft in chat.

## 7. Self-review

Read the draft three times, each with one question. Keep notes short.

1. Style: does it follow the `style` doc and the book's word range? Use `codex_get_diagnostics` once the chapter exists in the book.
2. Character: does each character act and speak from what the entries and their knowledge say? Does anyone know something they have not learned?
3. Continuity: does it match the state docs, the timeline, the last scene, the ledger and the state events? Does anything dead, lost or destroyed show up?

If a pass finds a problem, revise and read again. At most 3 revision loops. Co-writer revises with `codex_save_draft` (it works only on AI drafts the author has not accepted). Lower levels send the corrected text in chat. If problems remain after 3 loops, stop and show the author what is left.

If the author asked for a humanizer pass, run the humanizer skill on the draft. Keep every beat, every line's meaning and speaker, all names and invented terms, point of view, tense, scene breaks and the ending hook. Put back any sentence it changed that carried one of those.

## 8. Check again

Call `codex_continuity_check` for the chapter. New errors: if the record is wrong, fix the record. If the draft is wrong, revise (inside the 3 loops). If the author wants to keep a deliberate break, call `codex_dismiss_finding` with their reason. Never edit the record to hide a finding.

## 9. Record state

Planner and up. Extract only what the text establishes. Keep facts apart from beliefs and rumors. Formats are in `formats.md`.

1. State docs: `codex_save_doc` for `state/chapter-NN/situation`, `characters`, `knowledge` and `inventory` (new docs need no `base_sha256`).
2. Timeline: read the `timeline` doc, then append this chapter's events (`codex_append_doc` if the timeline is append-only, else `codex_save_doc` with `base_sha256`).
3. Cast: `codex_set_chapter_cast`.
4. Knowledge: `codex_record_knowledge`.
5. State events: `codex_record_state_events`.
6. Ledger: `codex_save_ledger_item` for each planted or paid-off item.
7. Log: `codex_log_writing` with the AI words added.
8. Canon gaps: if the chapter names a person, place, object or faction with no entry, or stretches an entry, call `codex_create_task` once, listing them. Never create the entry yourself.

Advisor: put the same content in one task with `codex_create_task`, and say the record is not saved.

## 10. Lock

Planner and up: `codex_lock_docs` for the chapter's `state/chapter-NN` docs. Never edit a locked folder afterward; later state goes in the next chapter's docs.

## 11. Report

Tell the author, in plain words:

- the chapter title and word count;
- what was created (scenes, docs, ledger items, tasks);
- check results and how many revision loops;
- what you skipped because of the level;
- canon gaps you turned into tasks;
- how to undo: open AI Activity and use Undo on any item.

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
