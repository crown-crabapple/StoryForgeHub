# Formats

Copy these shapes. Use entry slugs only. A named element with no entry goes in "New elements" or a task, never a made-up slug. Every call takes `book` (the book's slug or id), which is left out below.

## Chapter plan

```markdown
# Chapter N - Title

## Objective
What the chapter must do for the story.

## Starting point
Place, moment and mood. Matches the end of the previous chapter.

## Beats
1. What happens.
2. A reaction or inner shift.
(5 to 10 beats. Mix plot beats and emotional beats.)

## Ending hook
How it ends and the effect on the reader.

## Cast
- `slug`: pov | appears | mentioned

## Ledger
- Plants: new promise or question, with a short title
- Pays off: `ledger-slug` - how

## Key elements
- Locations / Factions / Objects / Lore: name (`slug`), why it matters
- New elements (not in the book): kept to a minimum
```

Cast roles: at most one `pov`. `appears` means on the page. Memories, letters, flashbacks and talk are `mentioned`; a dead character in a flashback is `mentioned` (the rules `CS1` and `CS2` look only at `pov` and `appears`).

Where the plan is saved (planner and up):

- The whole plan, before the chapter has scenes: `codex_save_doc` with `path` `development/chapter-NN-plan` and the plan as `body`.
- Per scene, once the scene exists: `codex_save_scene_plan` with `scene` (the scene id), `fields` (any of `goal`, `opposition`, `conflict`, `turn`, `outcome`, `consequence`, `stakes`, `emotional_start`, `emotional_end`, `purpose`; a string sets one, `null` empties it) and `characters` (the whole list of entry slugs). Pass `base_sha256` from `codex_get_scene_plan` when the scene already has a plan; leave it out when it has none.
- Beats: `codex_set_beats` with `slug` (the structure, from `codex_list_structures`), `beats` and `base_sha256`. It writes the WHOLE beat list in order: keep every existing beat's `id`, leave `id` out for a new beat, and a beat you leave out is removed. A beat has `name`, and optionally `purpose`, `question`, `position`, `state` (`open`, `done` or `omitted`) and `scenes` (scene ids in that beat). `codex_create_structure` (`template`, `name`) starts a structure when the book has none; `codex_list_structure_templates` lists the template ids.

## State docs

Saved with `codex_save_doc` (`path`, `body`, optional `title`; add `base_sha256` only when the doc exists) under `state/chapter-NN/`. A path outside `workspace/<name>`, `state/chapter-NN/(situation|characters|knowledge|inventory)` and `development/<name>` is refused.

`situation`:

```markdown
# Situation - after chapter N

## Immediate context
- Time:
- Location:
- Atmosphere:

## What just happened
Two or three sentences.

## Immediate problem

## Open hooks
- 
```

`characters`:

```markdown
# Characters - after chapter N

## Name
- Location:
- Emotional state:
- Current goal:
- Active conflicts:
- Notable changes:
```

One block for every character who appeared or was mentioned in a way that matters.

`knowledge`:

```markdown
# Knowledge - after chapter N

## Known to all
## Known to specific characters
- Name: knows X (learned chapter N)
## Unknown to characters (the reader knows)
## Clues found
- Clue: found by Name, chapter N
```

`inventory`:

```markdown
# Inventory - after chapter N

## Name
- Item: has | lost | used
```

Write "[time unclear]" rather than guess. Carry forward injuries, resources and open hooks until the text resolves them.

## Timeline entry

Appended with `codex_append_doc` (`path` `workspace/timeline`, `text` the entry below). The call adds to the end and creates the doc when it is missing.

```markdown
## Chapter N - day or time
- Event, in order.
```

## Ledger, cast, knowledge and state events

What each call takes. Each is refused if the chapter or scene is not in the book yet.

- `codex_set_chapter_cast`: `scene` (the scene id) and `cast`, the whole cast of that scene as rows of `entry` (slug) and `role` (`pov`, `appears` or `mentioned`); at most one `pov`, no entry twice, `[]` clears it. One call per scene of the chapter. Optional `base_sha256` (from `codex_get_scene`).
- `codex_record_knowledge`: `character` (slug), `fact` (one line, up to 300 characters, in your words for what the character now knows) and `chapter` (the chapter they learn it in). Only knowledge. Beliefs, guesses and rumors stay in the `knowledge` doc. Read it back with `codex_knowledge_at` (`character`, `at`).
- `codex_record_state_events`: `chapter` and `items`, rows of `subject` (entry slug), `kind` and, for two kinds, `value`. `kind` for a character: `died`, `revived`. For an object: `destroyed`, `lost`, `found`, `holder`, `location`. `holder` takes `value`, the slug of the character who holds it (an empty string for nobody); `location` takes `value`, the slug of a location entry. A handover is a `holder` item. Nothing is deleted: end a state with a later item (`revived`, `found`, a new `holder`).
- `codex_save_ledger_item`: to create, give `title` and `kind` (`promise` or `question`), and optionally `status`, `setup`, `develop`, `payoff` (scene ids) and `characters` (slugs). To change one, give its `slug` and any of `status`, `setup`, `develop`, `payoff`, `characters`, with `base_sha256` from `codex_get_ledger`. `status` is `planned`, `planted`, `developed`, `paid`, `dropped` or `unresolved`. Each list replaces the old one, so read the item first and send the whole list. One item per setup. To retire an item, set `status` to `paid` or `dropped`; never delete.

## Writing log

`codex_log_writing`: `words` (the words you wrote, a whole number of 1 or more), optional `chapter` and a one-line `note`. Log only the words you wrote. Do not log words of a scene made by `codex_create_scene` or `codex_save_draft`: the server logs those.

## Task for a canon gap

`codex_create_task`: `title` "Ch NN: new or changed canon to review", `notes` listing each name and where it appears in the chapter, and `for` `author` (the default). Do not set it up as work for yourself. `codex_get_tasks` lists tasks (filter by `status` or `for`); `codex_update_task` and `codex_complete_task` take the task's `task` (id or slug).

## Dismissing a finding

`codex_dismiss_finding`: `fingerprint` (from a finding of `codex_continuity_check`) and `reason`, the author's reason in their words (required). `codex_restore_finding`: `finding`, the fingerprint or the slug of the dismissal.
