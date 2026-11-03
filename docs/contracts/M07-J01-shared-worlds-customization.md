# M07-J01 contract — series worlds, cross-book links and customization data

Binding: DECISIONS 1–5; FORMAT-v1 §1.3 IDs, §1.4 slugs, §1.8 links, §2 layout, §3 library/series/book, §5 entries, §5.1 type files; M04-J01 graph; packages/templates.

Everything here is **additive within v1**: a v1 reader that ignores the new files and fields still reads every book correctly; nothing existing changes meaning, except that `[[x:slug]]` links (reserved since v1 and reported as `I402`) now resolve.

Split (protocol "split before implementation"):
- **M07-J01a** — format, validator, index/graph, independent resolver, fixtures (§1–§6, §8).
- **M07-J01b** — server routes and UI (§7). Depends on J01a.

## 1. Shared world (series canon)

- A series folder may hold `codex/` with the same layout as a book's codex (`codex/<type>s/<slug>.md`, `codex/_types/<type>.md`). These are **shared entries** and **shared type files**, owned by the series.
- Every book directly inside that series can **see** them. A book outside the series cannot (except through an explicit cross-book link, §2).
- **Resolution** in a book (FORMAT §1.8, extended). After step 3, before step 4, add:
  - 3a. Look for the current `slug`, then `previous_slugs`, among the shared entries of the book's series.
  - The book's own entries, threads and events always win.
  - When a book-local entry has the same slug as a shared entry, add **`W309`** at the local entry's `slug`: "this entry shadows the series entry …".
- Front-matter reference fields (`pov`, `characters`, `locations`, `related[].to`, entry `fields` links, …) resolve the same way. `E302` (wrong kind) still applies.
- Explicit form: `[[<series-slug>:<slug>]]` always means the shared entry, even if a local one shadows it.
- **Uniqueness:**
  - Slugs among a series' shared entries are unique within the series (`E208`, same message).
  - IDs stay unique library-wide (`E201`, unchanged).
- **Types:**
  - Series `_types` apply to every book in the series.
  - A book `_types` file for the same `type` overrides it for that book. Report **`I403`** at the book file's `type`.
  - Two series type files for one type → `E209` (unchanged).
- A shared entry may link (body, `fields`, `related`) only to:
  - other shared entries of its series;
  - objects by ID anywhere in the library;
  - `[[book-slug:slug]]` cross-book links.

  A bare slug that only a book could resolve → `E301`. Shared canon cannot depend on one book's private canon.
- **Shared folder rules:**
  - A shared entry is never under a book's `archive/`. It may be under the series' own `archive/` (§8 semantics, series scope).
  - Any series-level folder other than `codex/` and `archive/` is ignored, except book folders and `series.md`.

## 2. Cross-book links

- `[[<book-slug>:<target>]]` and `[[<book-slug>:<target>|Label]]`:
  - `<target>` is a slug (entry, thread or event of that book, using that book's resolution, including its series' shared entries) or any ID.
  - `[[<series-slug>:<slug>]]` names a series' shared entry (§1).
  - The prefix is matched against book slugs first, then series slugs.
- `E203` is extended. A **book slug equal to a series slug** anywhere in the library → **`E210`** on both `series.md` and `book.md`, at `slug`.
- Unknown prefix, or target not found in that book or series → **`E303`** "cross-book link target not found" (error, at the link location).
  - Inside a single-book validation (root = a book folder, so other books cannot be seen) → `I402` as before.
  - A target found only in that book's `archive/` → `W303`.
- `I402` keeps its meaning: "cross-book link not checked". Now it is emitted only when the validation root cannot see the other book.
- Cross-book links are allowed in bodies and entry `fields` values only. In front-matter reference fields, a value with `:` → `E302`.

## 3. Labels and colours

- `book.md` and `series.md` may have `labels:`, a list of `{ name: <text>, color: "#RRGGBB" }`.
  - `name` is unique within the list (case-insensitive). A duplicate → `E102` at `labels[i].name`.
  - A `color` that is not a quoted `#RRGGBB` → `E102`.
- Any scene, chapter, act, entry, thread, event or planning doc may have `labels: [name, …]`.
- A label must be defined by the document's book or its series. Otherwise **`W311`** at `labels[i]`.
- Labels are display/filter data only; they never change order or canon.

## 4. Custom field kinds

- In a type file, each `fields` item is either a string label (as today), or `{ label, kind, choices? }`:
  - `kind` is one of `text`, `number`, `date` (ISO `YYYY-MM-DD`), `link` (a value that is one `[[link]]`), `choice` (one of `choices`), `list` (a YAML list of strings).
  - `choices` is required for `choice`, and is a list of strings.
  - Bad shape → `E102` at `fields[i]`.
- An entry whose `fields[label]` value does not fit its type's declared kind → **`W312`** at `fields.<label>`. This is a warning only; it is never refused on save.
- Existing `values:` (CF1) is unchanged.

## 5. User templates (reusable project templates and planning structures)

- A library may hold `_templates/<name>/`, laid out exactly like the built-in `packages/templates/templates/<name>/`:
  - `template.md` with `schema: storyforge.template/v1`, `name`, `title`, `description`;
  - plus the book files with the documented placeholders.
- `_templates/` is not a book or series (the scanner skips it). Its files are validated only as templates.
- `listTemplates({ libraryRoot })` returns the built-in templates, then the library ones, each with `source: 'builtin' | 'library'`.
  - A library template with a built-in name → listed as `<name>` with `source: 'library'` and a warning flag `shadows_builtin: true`. Both stay selectable by `source` + `name`.
- **Save book as template** produces a template from a book:
  - It keeps: acts, chapters, scene titles/sequence/status, `_types`, labels, planning docs and threads.
  - It drops: scene bodies, entry bodies and fields, receipts, suggestions, AI records, activity, `legacy/`, `provenance/`, `archive/`.
  - IDs become placeholders, so each new book gets fresh IDs.

## 6. Index and graph

- Each book's index contains the shared entries of its series as graph nodes:
  - `owner: 'series'`;
  - `path` relative to the **library** root (for example `tidewater/codex/characters/ilse.md`);
  - `series_id`.
- Edges from book documents to them are ordinary edges.
- Cross-book targets are stored as **external** nodes `{ id, book_id, owner: 'book', external: true }`, with only id, kind, title and path. A book's index never copies another book's documents.
- Index `schema_version` → 3. An old index is rebuilt (existing behaviour for version change).
- Deleting `.storyforge/` in every book and rebuilding reproduces identical graph nodes and edges, the shared and external nodes included.

## 7. App and UI (J01b)

**Codex**
- Shared entries appear in each series book's Codex with a "Shared · <series title>" badge, and are filterable (All / This book / Shared).
- Opening one shows its series path.
- Saving it writes the **series** file, through `@storyforge/store` with an atomic write, after this notice: "Changes apply to every book in this series."
- New entry: a "Where" choice, either This book or Series (shared). The second choice is shown only for books in a series.
- Entry menu: **Move to series**, which moves the file into the series' codex. The `id` is kept, so all links keep resolving. It is refused when the series already has that slug.
  - The reverse, **Copy into this book**, makes a book-local copy with a new id and the same slug. It shadows the shared entry, and the `W309` warning is shown.

**Cross-book link picker**
- The link autocomplete in the editor and in entry `fields` lists:
  - this book's targets, then its series' shared entries,
  - then other books' entries, written as `[[book-slug:slug]]`.
- Following a cross-book link opens that book on that entry.

**Labels**
- A book (and series) label manager covers name and colour, with the contrast check against the dark surface from the M06 tokens.
- Label chips appear on scenes (Board, Outline) and entries, with filters by label.

**Typed fields**
- The entry editor renders a type's declared field kinds: number input, date input, choice select, link picker, list editor.
- Values that don't fit show the `W312` text inline. Saving is still allowed.

**Templates**
- The New book dialog lists library templates after the built-in ones.
- The book menu has **Save as template…**, which writes `_templates/<name>/` through the store. It is refused when that folder exists.

**General**
- Every new write goes through `@storyforge/store`. Series-level files use a store opened at the series root.
- Receipts stay per book: series-file edits get no receipts in this job.
- Keyboard: every new control is reachable and named (M06-J03 audit rules apply; extend `a11y-audit.test.mjs`).

## 8. Fixtures and acceptance

- **Fixture `packages/format/fixtures/valid/tidewater/`**, a library with:
  - series `tidewater/` (`series.md` with labels, plus `codex/characters/ilse-hollis.md` and `codex/locations/port-aldine.md` shared, and `codex/_types/vessel.md` with typed fields);
  - two books `tidewater/salt-orchard-2/` and `tidewater/low-tide/`, both referencing `ilse-hollis` by bare slug in `characters` and in body links, with **no copy** of the entry in either book;
  - one `[[low-tide:some-thread]]` cross-book link;
  - one book-local entry shadowing a shared one (`W309`);
  - labels on scenes and entries;
  - a library `_templates/mystery-arc/`;
  - plus a standalone book outside the series, which must NOT see the shared entries.
- Invalid fixtures for: `E210`, `E303`, a `W311` case, `W312`, `E102` for each new shape, and a shared entry linking to a book-private slug (`E301`).
- **Independent resolver** `tools/canon-check/resolve.mjs`:
  - It is a second, deliberately separate implementation. It uses only `yaml` and `node:fs`, NOT `@storyforge/format` and NOT the index.
  - It walks a library and prints JSON `{ owners: { <entry id>: 'series:<slug>' | 'book:<slug>' }, links: [ { from_id, raw, to_id } ] }` for every entry and every `[[link]]` and front-matter reference.
- **Acceptance test:**
  1. Copy the fixture.
  2. Delete every `.storyforge/`.
  3. Rebuild all indexes.
  4. For every book, read the graph from the index.
  5. Assert each edge's target and each node's owner equal the independent resolver's output.
  6. Assert `ilse-hollis` exists as exactly one file in the library.
  7. Assert both books' graphs contain an edge to its single id.
  8. Run the same check again after a second rebuild.
- The validator round trip: every new field survives a load/save round trip byte-for-byte when untouched.
- Existing fixtures and goldens are unchanged, except for documented `I402` → resolution changes. List each changed golden in RESULT.
- `npm ci && npm run build && npm run lint && npm test` pass on a clean clone. J01b adds a browser walk:
  1. shared entry visible in both books;
  2. edit it in one book and see it in the other;
  3. move a local entry to the series;
  4. cross-book link opens the other book;
  5. label filter;
  6. typed field;
  7. save as template and create a book from it.
