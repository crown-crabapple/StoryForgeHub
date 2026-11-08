# Formats

Copy these shapes. Use entry slugs only. A named element with no entry goes in "New elements" or a task, never a made-up slug.

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

Cast roles: at most one `pov`. `appears` means on the page. Memories, letters, flashbacks and talk are `mentioned`; a dead character in a flashback is `mentioned`.

Beats go to the scene plans with `codex_set_beats`; the rest goes in the scene plan with `codex_save_scene_plan`.

## State docs

Saved with `codex_save_doc` under `state/chapter-NN/`.

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

```markdown
## Chapter N - day or time
- Event, in order.
```

## Ledger, cast, knowledge and state events

What each call carries (use the field names the tool lists):

- `codex_set_chapter_cast`: the chapter and one row per character: slug and role (`pov`, `appears`, `mentioned`).
- `codex_record_knowledge`: the character, what they now know, and the chapter they learned it in. Only knowledge. Beliefs, guesses and rumors stay in the `knowledge` doc.
- `codex_record_state_events`: the slug, the event and the chapter. Characters: `died`, `revived`. Objects: `destroyed`, `lost`, `found`, `holder`, `location`. `holder` and `location` also need a value, which is a slug. A handover is a `holder` event.
- `codex_save_ledger_item`: a new item has a kind (promise, question) and a title, planted in this chapter. A payoff names the existing item and the chapter that pays it off. One item per setup. To retire an item, set its status; never delete.

## Writing log

`codex_log_writing`: the words added this chapter, marked as AI, the chapter number, and a short note. Log only the words you wrote.

## Task for a canon gap

`codex_create_task`: title "Ch NN: new or changed canon to review", a body listing each name and where it appears in the chapter. Do not set it up as work for yourself.
