# What is in a book folder

A StoryForge book is a folder of plain files. The folder is the whole book: if you have it, you have everything the author wrote. StoryForge keeps no database that
you need and no copy of your work anywhere else (see [install.md](install.md), "Where your data lives").

## Layout

```text
my-library/                  any folder; holds one or more books
  my-novel/                  one book = one folder with a book.md
    book.md                  title, status, genre, targets
    manuscript/
      act-01-low-water/
        act.md               optional act title
        ch-001-the-drowned-rows/
          chapter.md         optional chapter title and notes
          0010-arrival.md    one scene per file
          0020-the-key.md
    codex/                   characters, locations, factions, objects, lore (one file each)
    planning/                plot threads, timeline events, plans; canvases/ holds visual boards (.canvas, JSON Canvas); links/, scene-plans/, arcs/, structures/, relationships/ and synopses/ hold Story Planner files, and story.md is the story plan
    research/                research notes and sources
    assets/                  images and attachments (assets/drafts/ holds AI cover drafts, only if you generated any)
    activity/                writing log, goals and sessions; ai-usage.md (AI token counts) only if you turned it on
    suggestions/             suggested changes, never applied until you accept them
    provenance/              receipts (the record of who changed what)
    ai/                      AI records, only if you turned them on
    archive/                 things you archived, same layout as above
    legacy/                  only in books imported from the old StoryForgeHub
    .storyforge/             the index and other working files (disposable)
```

A book can also sit one level down, inside a series folder that holds a `series.md`. A library is found by looking, not by a list: every folder with a `book.md` is a book.

## Files

- Every file is UTF-8 text, Markdown with a block of settings (front matter) at the top between two `---` lines.
- The front matter says what the file is (`schema`) and gives it a permanent `id`. A Markdown file without it is a plain note: StoryForge keeps and searches it and never calls it an error.
- A file StoryForge did not change is not rewritten. Settings it does not know are kept.
- Filenames use lower-case letters, digits and `-`. Other names are read, with a warning.

## Order comes from the file, not the folder

Scene order is decided by two numbers in each scene file, `chapter` and `sequence`, not by folder or file name. The `0010-` in a file name and the `ch-001-` in a folder name are
there so a file listing shows the right order; if they disagree with the numbers, the numbers win and StoryForge warns. Gaps are normal (10, 20, 30), so an insert rarely renumbers anything.

Scenes marked as an alternate version of another scene (`variant_of`) are kept beside it but are not part of the book order, the word counts or an export.

## What is canon

| Counts as the book | Kept, but not canon |
| --- | --- |
| Scenes in `manuscript/` | `research/` notes (canon only if a note says `canon: true`) |
| `codex/` entries | `suggestions/` until you accept them |
| `planning/` threads and events | `ai/` records and `provenance/` receipts (records, never text); `planning/canvases/` boards, `planning/links/`, `planning/scene-plans/`, `planning/arcs/`, `planning/structures/`, `planning/relationships/`, `planning/synopses/` and `planning/story.md` |
| `book.md`, `act.md`, `chapter.md` | `archive/` (left out of order, counts and export) |
| `assets/` the book uses | `legacy/` (see below) |

Notes in a scene written as `<!-- note: ... -->` stay in the file, show in the notes rail, and are never exported.

## Story Planner files

Six kinds of file hold planning data. None is story text or canon, and none changes a scene file.

### A causal link: `planning/links/key-therefore-ferry.md`

```yaml
---
schema: storyforge.link/v1
id: note_01S50000000000000000000013
slug: key-therefore-ferry
from: scene_01S50000000000000000000003
to: scene_01S50000000000000000000005
relation: therefore
created: 2026-11-05
---
The key failing forces Maren onto the ferry.
```

- One link per file. The body is the rationale.
- Required: `slug`, `from`, `to`, `relation`. `created` is optional.
- `relation` is one of `therefore`, `but`, `enables`, `reveals`, `motivates`, `prevents`, `foreshadows`, `pays_off`, `parallel`, `other`.
- `from` and `to` are scene ids, or (Story Planner M5) the id of a beat inside a structure. A missing target is `E301`. A target that is archived, or a beat of an archived structure, is `W303`. Beat ids resolve here and nowhere else.
- A link from a scene (or beat) to itself is `E211` (at `to`).
- Two live links with the same `from`, `to` and `relation` give `W316` on the second (at `relation`). Archived links are not counted.
- StoryForge names the file after the two scene slugs and the relation (up to 60 characters; `-2`, `-3` … when the name is taken).
- Archive moves the file to `archive/planning/links/`. Restore moves it back.

### A scene plan: `planning/scene-plans/the-key.md`

```yaml
---
schema: storyforge.scene-plan/v1
id: note_01S50000000000000000000014
scene: scene_01S50000000000000000000003
goal: Prove the harbour key opens the sea gate.
opposition: The harbourmaster wants the key returned before dusk.
conflict: Maren must choose between the gate and her apprenticeship.
turn: The key opens a different door.
outcome: Maren is locked out of the guild.
consequence: She has to ask the ferryman for passage.
stakes: Her place in the town.
emotional_start: hopeful
emotional_end: cornered
purpose: Close off the safe path.
characters: [maren-hollis, pell]
---
Free planning notes for this scene.
```

- One file per planned scene. `scene` (the scene's id) is the key; the file name is only a label and is not changed if the scene is renamed. A scene with no plan has no file.
- Required: `scene`. Optional: `goal`, `opposition`, `conflict`, `turn`, `outcome`, `consequence`, `stakes`, `emotional_start`, `emotional_end`, `purpose` (each a one-line string; StoryForge writes at most 2,000 characters) and `characters` (a list of entry slugs).
- `scene` and each `characters` slug must resolve: a miss is `E301`.
- Two live plans for the same scene give `W317` on the second (at `scene`). Archived plans are not counted.

### The story plan: `planning/story.md`

```yaml
---
schema: storyforge.story-plan/v1
id: note_01S50000000000000000000015
premise: An apprentice finds that the harbour key opens the wrong door.
logline: Maren must choose between the sea gate and her place in the guild.
theme_question: What does belonging cost?
central_conflict: The guild wants the key back; Maren wants to know what it opens.
protagonist_goal: Learn what the key opens.
stakes: Her place in the town.
protagonist: maren-hollis
primary_structure: note_01S50000000000000000000017
---
Free story notes.
```

- One story plan per book, and it must be at `planning/story.md`. The body is free notes.
- Nothing is required. Optional: `premise`, `logline`, `theme_question`, `central_conflict`, `protagonist_goal`, `stakes` (each a one-line string; StoryForge writes at most 2,000 characters), `protagonist` (an entry slug) and `primary_structure` (the id of a structure, see below).
- `protagonist` must resolve: a miss is `E301`.
- `primary_structure` must resolve to a structure: a miss is `E301`. A structure that is archived is `W303`.
- A live story plan at any other path gives `W318` (at `schema`), on every such file. Archived story plans are not counted.

### A character arc: `planning/arcs/maren-hollis.md`

```yaml
---
schema: storyforge.arc/v1
id: note_01S50000000000000000000016
slug: maren-hollis
character: entry_01S5000000000000000000000G
arc_type: positive
want: To learn what the harbour key opens.
need: To trust the town that raised her.
false_belief: Belonging means obeying the guild.
fear: Being locked out for good.
wound: Her mother left without a word.
start_state: Obedient and certain.
end_state: Free and uncertain.
milestones:
  - scene: scene_01S50000000000000000000003
    pressure: The harbourmaster wants the key back.
    choice: She keeps the key.
    belief_before: The guild will protect her.
    belief_after: The guild will not.
    cost: Her apprenticeship.
  - scene: scene_01S50000000000000000000005
    pressure: The ferryman asks for a price.
---
Free arc notes.
```

- One arc per character per book. The arc belongs to the book; the Codex entry is never changed by it.
- Required: `slug`, `character`. `character` is an entry id. It resolves like other entry references, and a series-shared entry resolves too. A miss is `E301`.
- Optional: `arc_type` (one of `positive`, `negative`, `flat`, `custom`), `want`, `need`, `false_belief`, `fear`, `wound`, `start_state`, `end_state` (each a one-line string; StoryForge writes at most 2,000 characters) and `milestones`. The body is free notes.
- `milestones` is an ordered list of mappings. Each has a `scene` (a scene id) and optional one-line `pressure`, `choice`, `belief_before`, `belief_after` and `cost`. Moving a scene never changes a milestone, because it names the scene by id.
- A milestone that is not a mapping, has no `scene`, or has a non-string `pressure`, `choice`, `belief_before`, `belief_after` or `cost` is `E102` (at `milestones[i]` or `milestones[i].<key>`). A key other than those six is `I401`. A `scene` that does not resolve is `E301`; one that is archived is `W303`.
- StoryForge writes `milestones` as one block of plain mappings. If you edit the block by hand and add a comment, anchor or alias, StoryForge refuses to change it from the app (`REFUSED_UNSIMPLE_FIELD`) until you fix the file.
- Two live arcs naming the same `character` give `W319` on the later file (by file name, at `character`). Archived arcs are not counted.
- StoryForge names the file after the character's slug (`-2`, `-3` … when the name is taken by a live or archived file).
- Archive moves the file to `archive/planning/arcs/`. Restore moves it back.

### A structure: `planning/structures/main-three-act.md`

```yaml
---
schema: storyforge.structure/v1
id: note_01S50000000000000000000017
slug: main-three-act
name: Main structure
template: three-act
template_version: 1
beats:
  - id: note_01S50000000000000000000018
    name: Opening image
    purpose: Show the world before it changes.
    question: What does normal look like?
    position: about 1%
    state: done
    scenes: [scene_01S50000000000000000000003, scene_01S50000000000000000000005]
  - id: note_01S50000000000000000000019
    name: Inciting event
    purpose: Something knocks the hero off the usual path.
    scenes: [scene_01S50000000000000000000003]
  - id: note_01S5000000000000000000001A
    name: Final choice
    state: omitted
---
Free structure notes.
```

- A structure is a beat sheet. A book can have any number of them, or none. The body is free notes.
- Required: `slug`, `name`. Optional: `template` (a template id), `template_version` (an integer) and `beats`.
- `beats` is an ordered list of mappings. Each has an `id` (`note_` and a 26-character ULID) and a `name` (one line). Optional: one-line `purpose`, `question` and `position` (such as "about 25%"), `state` and `scenes`.
- `state` is `open`, `done` or `omitted`. A beat with no `state` is open.
- `scenes` is a list of scene ids, at most 50 per beat. One scene can be in any number of beats and structures. Moving a scene never changes a beat, because it names the scene by id.
- A beat that is not a mapping, has no valid `id`, has no one-line `name`, has a `purpose`, `question` or `position` that is not one line, has an unknown `state`, or has `scenes` that is not a list of scene ids (or has more than 50) is `E102` (at `beats[i]` or `beats[i].<key>`). A beat id used by two beats among the live structures is `E102` on the later one, by file name. Archived structures are not counted. A key other than the seven above is `I401`. A scene that does not resolve is `E301`; one that is archived is `W303`.
- Templates are built in to StoryForge. They are not files in the book. Applying one copies its beats into the new structure, each with a new id, and writes `template` and `template_version` once. The file never follows the template again, so changing a template never changes a book. The ids are `three-act` (Three acts), `five-act` (Five acts), `heros-journey` (Hero's journey), `seven-point` (Seven points), `story-circle` (Story circle), `mystery` (Mystery), `romance` (Romance) and `custom` (Custom, with no beats).
- StoryForge writes `beats` as one block of plain mappings. If you edit the block by hand and add a comment, anchor or alias, StoryForge refuses to change it from the app (`REFUSED_UNSIMPLE_FIELD`) until you fix the file.
- StoryForge names the file after the structure's name (`-2`, `-3` … when the name is taken by a live or archived file).
- Archive moves the file to `archive/planning/structures/`. Restore moves it back. No scene is changed.

### A relationship: `planning/relationships/maren-hollis-and-pell.md`

```yaml
---
schema: storyforge.relationship/v1
id: note_01S5000000000000000000001B
slug: maren-hollis-and-pell
a: entry_01S5000000000000000000000G
b: entry_01S5000000000000000000000K
baseline: Apprentice and ferryman, wary of each other.
end_state: Allies who owe each other.
developments:
  - scene: scene_01S50000000000000000000003
    change: Pell lends Maren the key.
    a_view: Maren trusts Pell a little.
    b_view: Pell fears what Maren will find.
  - scene: scene_01S50000000000000000000005
    change: Maren pays Pell for passage.
---
Free relationship notes.
```

- One file per pair of Codex entries (any entry type), in this book. The Codex `related:` field is never changed.
- Required: `slug`, `a`, `b` (entry ids). Optional: one-line `baseline` and `end_state`, and `developments`.
- `developments` is an ordered list of mappings: a `scene` (a scene id) and a one-line `change`, plus optional one-line `a_view` (how A sees B) and `b_view` (how B sees A) at that point.
- `a` equal to `b` is `E212` (at `b`). Two live relationships for the same pair, in either order, give `W320` on the later file (by file name, at `b`). Archived files are not counted.
- StoryForge names the file `<a-slug>-and-<b-slug>` (`-2`, `-3` … when the name is taken) and writes `developments` as one block of plain mappings, like arc milestones.
- Archive moves the file to `archive/planning/relationships/`. Restore moves it back.

### A synopsis: `planning/synopses/one-page.md`

```yaml
---
schema: storyforge.synopsis/v1
id: note_01S5000000000000000000001D
slug: one-page
type: one-page
name: One page
target_words: 300
created: 2026-11-06
---
Free synopsis text.
```

- One file per synopsis, covering the whole book. A book can have any number, including several of one type. The body is the author's Markdown text.
- Required: `slug`, `type`. Optional: `name` (one line), `target_words`, `basis` and `created`.
- `type` is `premise`, `logline`, `elevator-pitch`, `short`, `one-page`, `long`, `chapter-treatment` or `custom`.
- `target_words` is a whole number of 1 or more. `basis` is 64 lowercase hex characters: the sha256 of the extracted text the author last reviewed. A synopsis with a `basis` is stale when the text extracted from the plan today hashes differently; one without a `basis` is never stale.
- A `type` that is not one of the eight, a `name` that is not one line, a `target_words` that is not a whole number of 1 or more, or a `basis` that is not 64 lowercase hex characters is `E102`.
- StoryForge names the file after the synopsis's name, else after the type's label (`-2`, `-3` … when the name is taken). It never writes the synopsis text from the plan on its own: the extracted text is only a proposal the author accepts.
- Archive moves the file to `archive/planning/synopses/`. Restore moves it back.

### Diagnostics

| Code | Severity | Meaning |
| --- | --- | --- |
| `E211` | error | A link's `from` and `to` are the same scene |
| `E212` | error | A relationship's `a` and `b` are the same entry |
| `W316` | warning | Two live links have the same `from`, `to` and `relation` |
| `W317` | warning | Two live scene plans name the same scene |
| `W318` | warning | A live story plan is not at `planning/story.md` |
| `W319` | warning | Two live arcs name the same character |
| `W320` | warning | Two live relationships name the same pair of entries, in either order |

Arc milestones also use the general codes `E102` (malformed milestone), `I401` (unknown milestone key), `E301` (unknown scene) and `W303` (archived scene).

Relationship developments use the same codes: `E102` (malformed development, or a missing or multi-line `change`), `I401` (unknown development key), `E301` (unknown scene) and `W303` (archived scene). A relationship's `a` and `b` use `E301`, `E302` and `W303` like other entry references.

Structure beats use the same codes: `E102` (malformed beat, or a beat id used twice), `I401` (unknown beat key), `E301` (unknown scene) and `W303` (archived scene). A story plan's `primary_structure` uses `E301` and `W303`.

## Continuity exceptions: `planning/continuity/<slug>.md`

```yaml
---
schema: storyforge.continuity-exception/v1
id: note_01…
slug: maren-eyes-are-green-on-purpose
fingerprint: cf1-3b9e0c1d2a4f5e6b
rule: CF1
title: Maren's eyes look green in the hut glass
created: "2026-11-02"
intentional: true
---
Why the author accepts this finding.
```

- One file suppresses the one finding with that `fingerprint`, and nothing else. Removing or archiving the file brings the finding back.
- `intentional` is optional and must be `true` or `false`; any other value is `E102`. `true` means "this is on purpose"; no key means "acknowledged". Both suppress the same way. StoryForge writes the key only as `true`.
- Planner findings (`PL1` to `PL4`) use the same files.

## `.storyforge/` is disposable

`.storyforge/` holds the search index, edit locks, prior versions from saves, local revision copies and per-machine screen settings. None of it is your book.

- Delete it any time (close StoryForge first if you want to remove the locks). StoryForge builds the index again from the files: `node apps/server/src/main.mjs rebuild --library <folder>`.
- It is left out of backups and exports.
- The revision copies in it are safety copies on this computer only. They are not a backup.
- If you keep a book in Git, ignore it: add `.storyforge/` to `.gitignore`.

## `legacy/`

A book imported from the old StoryForgeHub has a `legacy/` folder with data the new format has no place for:

- `legacy/history/` holds the old revision text of chapters, entries and workspace documents, one file per saved revision.
- `legacy/tables/` holds rows with no equivalent in the new format, one JSON line per row, as they were.

Nothing in `legacy/` is story text or canon, and it never appears in an export. Keep it: it is part of your folder and part of your backup. See [migration.md](migration.md).

## Editing the files yourself

You can edit any file in a text editor while StoryForge is open; StoryForge watches the files and picks up the change. If a file ends up unreadable, StoryForge keeps working, shows which file and why,
and the message clears when you fix it. See [troubleshooting.md](troubleshooting.md).
