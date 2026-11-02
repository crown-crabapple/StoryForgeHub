# M02-J03 contract — new book from templates, open an existing folder

Binding: DECISIONS 1–6, FORMAT-v1 (all of §1–§4, §6.3, §11), contracts M01-J02 (single writer), M01-J04 (lock), M02-J01/J02 (UI). The M02 gate: "A user can create, open, search, and archive a fixture book through the reference-style library with no database setup."

## 1. Templates — `packages/templates` (`@storyforge/templates`)

Templates are **documented files in the repo**, not code: `packages/templates/templates/<name>/`.

```text
<name>/
  template.md                 schema: storyforge.template/v1 — name, title, description, beats (list), source note
  book/                       the files a new book gets, with placeholders
    book.md
    manuscript/act-NN-<slug>/act.md
    manuscript/act-NN-<slug>/ch-NNN-<slug>/chapter.md
    manuscript/act-NN-<slug>/ch-NNN-<slug>/0010-<slug>.md
    planning/plan.md          what the structure is and how to use it, in plain words
```

Placeholders (exact): `{{book_title}}`, `{{book_slug}}`, `{{pen_name}}`, `{{today}}`, and `{{id:<key>}}` — each distinct `<key>` becomes one fresh ULID with the right prefix (prefix is the part of the key before `:`/`-`, e.g. `{{id:scene-01}}` → `scene_…`, `{{id:book}}` → `book_…`). Template files are otherwise valid Markdown; `npm test` checks each template renders to a validator-clean book.

| Template | Structure (scenes have `status: outline`, short beat summary in `summary`, body = one-line prompt in the author's voice-neutral plain English — **written in our own words, no quoted text from any book**) |
|---|---|
| `blank` | 1 act, 1 chapter ("Chapter 1"), 1 empty scene ("Untitled scene", `status: drafting`, empty body) |
| `story-circle` | 8 beats (You, Need, Go, Search, Find, Take, Return, Change) → 2 acts (beats 1–4, 5–8), one chapter per beat, one scene each |
| `heros-journey` | 12 stages → 3 acts (1–5, 6–10, 11–12), one chapter per stage, one scene each |
| `seven-point` | Hook, Plot Turn 1, Pinch 1, Midpoint, Pinch 2, Plot Turn 2, Resolution → 3 acts (Hook–Pinch 1, Midpoint, Pinch 2–Resolution), one chapter each, one scene each |

Each `template.md` names where the idea comes from in one sentence (e.g. "Based on the eight-step story circle popularised by Dan Harmon.") — attribution, not copied text.

API: `listTemplates()` → `[{ name, title, description, beats, acts, chapters, scenes }]`; `renderTemplate(name, vars)` → `Map<relPath, Buffer>` (pure; no file access beyond reading the template folder — it may import `node:fs` for reading its own templates; add it to the lint allow-list as read-only, and the single-writer test must still pass).

## 2. Creating a book — `core.createBook()`

```js
createBook({ title, slug?, template, seriesSlug?, seriesNumber?, penName? })
```

Validation (all before any write; failures return `{ ok:false, code, field, message }`):

| Check | Code |
|---|---|
| `title` 1–120 chars after trim, no control characters | `BAD_TITLE` |
| `slug` (default: slugify(title)) valid per FORMAT-v1 §1.4 | `BAD_SLUG` |
| slug not used by any book in the library | `SLUG_TAKEN` |
| target folder doesn't exist | `FOLDER_EXISTS` |
| `seriesSlug` exists (a `series.md`) | `NO_SUCH_SERIES` |
| `seriesNumber` integer ≥ 1, not used in that series (default: max + 1) | `SERIES_NUMBER_TAKEN` |
| `penName` (slug) exists in `library.md` if given | `NO_SUCH_PEN_NAME` |
| `template` known | `NO_SUCH_TEMPLATE` |
| target path resolves inside the library root | `OUTSIDE_ROOT` |

Target folder: `<library>/<slug>/` or `<library>/<series-folder>/<slug>/`.

Write (single writer): new store function `createTree(libraryRoot, relDir, files)`:
1. Write all files into a staging folder `<library>/.storyforge/staging/<opId>/` (fsync each).
2. Run `validate()` on the staging folder as a book root → must have **zero diagnostics**; else move the staging folder to `<library>/.storyforge/trash/<opId>/failed/` and return `{ ok:false, code:'TEMPLATE_INVALID', diagnostics }`.
3. `rename` staging → target (atomic directory rename; refuse if target appeared meanwhile → move staging to trash, `FOLDER_EXISTS`).
4. Journal the op like other store ops (recovery: a leftover staging folder is moved to trash on next start and reported).

Then `reconcile` the library so the new book shows up; return `{ ok:true, bookId, path }`.

`book.md` gets: `schema`, `id`, `slug`, `title`, `profile: fiction`, `status: planning`, `series_number` (if in a series), `pen_name` (if given), `language: en`.

## 3. Opening an existing folder

The server serves one library at a time. New flow to switch:

- `POST /api/library/open` `{ path }` (write-guarded). Checks: absolute path; exists; is a directory; not inside a `.storyforge/` folder; contains at least one `book.md` within two levels (library) or is itself a book. Else `{ ok:false, code: 'NOT_FOUND' | 'NOT_A_FOLDER' | 'NO_BOOKS' }` (400).
- On success: acquire the new folder's lock (J04 rules; held by another instance → 409 `LOCKED` with holder info), close the current repository/watchers, release the old lock, open the new repository, run recovery, start indexing in the background; respond `{ ok:true, library }`. If anything fails after the new lock is taken, release it and keep the old library open (no half-switched state).
- **Recent libraries**: last 8 opened paths in a per-user app config file (not author data): `%APPDATA%\StoryForge\recent.json` on Windows, `~/.config/storyforge/recent.json` elsewhere. Written through a new store function `writeUserConfig(name, json)` (atomic). Missing paths are shown greyed with "not found" and can be removed from the list (`DELETE`-style: `POST /api/library/recent/remove` `{ path }`). `GET /api/library/recent`.
- The CLI `--library` still works and is added to recents.

No native folder picker (browser limitation): a text field with the path, plus the recents list.

## 4. UI

"Start something new" (Home reference) now has two real buttons: **New book…** and **Open folder…**.

**New book dialog** (focus-trapped, Escape closes): Title (required) · Folder name (slug, auto-filled from title, editable, live validation message) · Pen name (select from `library.md`, or none) · Series (Standalone or an existing series; number auto, editable) · Template (radio cards: name, one-line description, "N chapters · N scenes", expandable beat list) · Create / Cancel. Errors from the API appear next to the field named in `field`. On success → navigate to the new book.

**Open folder dialog**: path field, Open / Cancel, recents list (click to open; "Remove" per item). Errors in plain words ("That folder has no books in it", "Another StoryForge window is using that folder").

Top bar BookSwitcher gains a final "Open another folder…" item that opens the same dialog.

## 5. Acceptance (test-author)

1. **Each template** (`blank`, `story-circle`, `heros-journey`, `seven-point`): `createBook` in a temp library → folder exists; `validate()` → zero diagnostics; scene count/order/act/chapter labels match `listTemplates()`; every ID fresh (two books from the same template share no IDs); no `{{` left in any file.
2. **Independent parser:** for each created book, a second, minimal reader written in the test (not using `@storyforge/format`: plain text front-matter split + `yaml` parse + sort by `(chapter, sequence)`) gives the same scene ID order as `validate()`.
3. **Reopen after cache deletion:** delete `.storyforge/` everywhere → `getBook` structure identical.
4. **Validation failures:** every code in §2's table, nothing written (snapshot the library before/after, ignoring `.storyforge/`).
5. **Atomic create:** fault-inject between staging and rename (existing `__faults` mechanism, child-process `exit`) → after restart the target doesn't exist, the staging folder is in trash, recovery reports it; no partial book visible to `listBooks`.
6. **Into a series:** create with `seriesSlug` → in that series folder, `series_number` = max+1 by default; explicit taken number → `SERIES_NUMBER_TAKEN`.
7. **Open folder:** switch from library A to B via the route → `listBooks` shows B; A's lock released, B's held; bad paths give the right codes; a folder locked by another (child) instance → 409 `LOCKED` and A stays open; recents updated (use a temp `APPDATA`/`XDG_CONFIG_HOME` in tests).
8. **Templates are documented:** each `template.md` validates against its own schema (name, title, description, beats non-empty), and `planning/plan.md` exists in each.
9. **M02 gate (end-to-end, server-level):** with no `.storyforge/` anywhere: create a book from `story-circle` via the API → it appears in `/api/books` as a cover card entry (`cover_state: 'none'`) → search finds a word from its plan → archive one of its scenes via the J02 route → book still valid; open another library folder via the route and back; all without any database setup step.
10. Web render tests: Start section now has exactly the two buttons; New book dialog fields, labels, template cards, field-level error rendering; Open folder dialog with recents (incl. "not found" item).

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
