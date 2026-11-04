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
    planning/                plot threads, timeline events, plans; canvases/ holds visual boards (.canvas, JSON Canvas)
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
| `planning/` threads and events | `ai/` records and `provenance/` receipts (records, never text); `planning/canvases/` boards |
| `book.md`, `act.md`, `chapter.md` | `archive/` (left out of order, counts and export) |
| `assets/` the book uses | `legacy/` (see below) |

Notes in a scene written as `<!-- note: ... -->` stay in the file, show in the notes rail, and are never exported.

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
