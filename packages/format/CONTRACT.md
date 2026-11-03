# @storyforge/format — validator contract (M00-J03)

Implements [FORMAT-v1](../../../storyforge-v2-production-plan/spec/FORMAT-v1.md) (absolute: `E:\StoryForgeHub\storyforge-v2-production-plan\spec\FORMAT-v1.md`). The spec is the authority; this file fixes the API and the points the spec leaves to the implementation.

## Stack

- Node ≥ 20, plain ES modules (`.mjs`), no build step, JSDoc types.
- One runtime dependency: `yaml@2.9.1` (exact pin), used in YAML 1.2 core mode with source positions.
- Tests: `node --test` (built-in runner). No other test framework.

## Layout

```text
packages/format/
  package.json         name @storyforge/format, "type": "module", bin sf-validate
  src/index.mjs        export { validate }
  src/*.mjs            internal modules (parse, ids, scenes, links, library…)
  bin/sf-validate.mjs  CLI
  fixtures/valid/…     valid projects
  fixtures/invalid/…   one defect each, with expected.json
  test/*.test.mjs
```

## API

```js
import { validate } from '@storyforge/format';
const result = await validate(rootDir);
```

`rootDir` may be a book root (has `book.md`), a series root (has `series.md`) or a library root (anything else; scanned per §3.1).

```ts
type Result = {
  diagnostics: Diagnostic[];      // sorted, see below
  books: Book[];                  // sorted by path
};
type Diagnostic = {
  code: string;                   // e.g. "E204"
  severity: 'error' | 'warning' | 'info';
  file: string;                   // path relative to rootDir, forward slashes
  location: string;               // field path ("sequence", "characters[1]", "related[0].to"),
                                  // "line N" for body links (1-based, from file line 1), or "" for whole-file
  message: string;                // human text; NOT compared by tests
};
type Book = {
  path: string;                   // book root relative to rootDir ("" if rootDir is the book)
  id: string | null; slug: string | null; title: string | null;
  series: string | null;          // series slug when inside a series
  order: Scene[];                 // §4.2 order
  excluded: { id: string | null; path: string; reason: 'variant' | 'archived' | 'outside-manuscript' | 'unsupported-schema' }[];
  timeline: { slug: string; order: number; narrative_position: number | null }[]; // chronological
};
type Scene = {
  position: number;               // 1-based, book-wide
  id: string; title: string; act: number; chapter: number; sequence: number;
  act_label: string; chapter_label: string;  // §4.5 defaults apply
  path: string;                   // relative to rootDir
};
```

Diagnostics sort: by `file`, then `location` (natural order: `line 2` before `line 10`), then `code`. Each (code, file, location) appears once.

`validate` never writes, never throws on bad input (a bad file is a diagnostic), and ignores `.storyforge/` everywhere.

## CLI

`sf-validate <path> [--json]` — prints diagnostics one per line as `CODE severity file location message`, or the full Result as JSON. Exit code: `1` if any `error`, else `0`. Exit `2` on a usage error.

## Implementation decisions the spec leaves open

1. **E205** is reported on every scene of the offending chapter, location `act`.
2. **E206** is reported on the first scene (in §4.2 order) of each chapter whose act is lower than the previous chapter's act, location `act`. The "previous act" is the highest act seen so far.
3. **E202 / E203 / E204 / E207 / E208 / E201** are reported on **every** file involved, at the field concerned (`series_number`, `slug`, `sequence`, `chapter` or `act`, `slug`, `id`).
4. **pen_name**: checked only when `library.md` exists; an unknown pen-name slug → `E301` at `pen_name`.
5. A file with a scene schema in the wrong chapter or act **folder** → one `W201` at `chapter` (or `act` if only the act folder is wrong). A codex entry whose first folder under `codex/` is not its expected folder → `W201` at `type`. Expected folder: `characters`, `locations`, `factions`, `objects`, `lore` for the built-in types (spec §2); `<type>s` for custom types. Entries directly in `codex/` are not checked. A thread not under `planning/threads/`, an event not under `planning/timeline/`, or a scene outside `manuscript/` → `W201` at `schema`.
6. **W202** applies to a scene filename prefix (location `sequence`), a `ch-NNN-` folder that holds a `chapter.md` (location `chapter`), and an `act-NN-` folder that holds an `act.md` (location `act`).
7. A file that fails to parse (`E100`, `E101`, `E006`) gets no other diagnostics, and is not a link target.
8. Unknown non-`x-` fields → `I401` at the field name, one per field.
9. Body link scan skips fenced code blocks and inline code.
10. Required-field checks use spec §11.1. Type checks: integers for `act`, `chapter`, `sequence`, `series_number`, `word_target`; number for `order`; lists for `characters`, `locations`, `plot_threads`, `events`, `aliases`, `previous_slugs`, `setup`, `payoff`, `scenes`, `tags`, `sources`, `links`, `genre`, `pen_names`; enum values as listed in the spec.
11. **Locations fixed during build:** whole-file diagnostics (`E100`, `E101`, `W101`, `W203`, `W204`) use `""`. `E006` uses `schema`. `W302` uses `payoff`. Unresolved `[@cite]` in a body uses `line N`. A `variant_of` to a missing scene → `E301` at `variant_of`.
12. Two diagnostics with the same (code, file, location) collapse to one, e.g. two broken links on one line.

## Fixtures

All fixture text is synthetic. **No user manuscript text, ever.**

### `fixtures/valid/salt-orchard/` — the reference book

Required by TEST-STRATEGY.md:

- 2 acts, 3 chapters (1, 2, 3), at least 6 scenes; plus chapter 0 prologue.
- Linked characters, locations, objects, at least one faction and one lore entry.
- At least one plot thread with setup and payoff.
- At least two timeline events.
- One research note and one source cited as `[@cite-key]`.
- One planning doc (`planning/plan.md`).
- Unicode prose: accented Latin, em dash, curly quotes, one non-Latin script line, one emoji.
- HTML comments: `<!-- note: … -->`, one `<!-- sf:anchor … -->` pair, one opaque comment.
- A deliberate **continuity contradiction** for M05 (the validator does NOT detect it): codex says Maren's eyes are grey; one scene says green. Documented in `fixtures/valid/salt-orchard/contradiction.md` (a plain note, no front matter).
- One `x-` field and one variant scene.
- Expected result: **zero diagnostics**. `expected.json` holds the full ordered scene ID list and timeline.

### `fixtures/valid/library/` — library and series

`library.md` with one pen name; series `tidewater/` holding two books (`series_number` 1 and 2); one standalone book. Zero diagnostics.

### `fixtures/valid/spec-example/`

A byte copy of `storyforge-v2-production-plan/spec/examples/salt-orchard-mini/`. Expected: exactly `I402`, `W201`, `W202`, `W301` as the blind reader found (see `evidence/M00-J02/blind-reader-output.txt`), and the same 7-scene order.

### `fixtures/invalid/<code>-<short-name>/`

Each is a **minimal valid book plus exactly one defect** and an `expected.json`:

```json
{ "diagnostics": [ { "code": "E204", "file": "manuscript/…/0010-a.md", "location": "sequence" } ] }
```

The validator output (code, file, location) must equal this list exactly, as a set. No extras.

| Case | Defect |
|---|---|
| `E006-future-schema` | scene with `schema: storyforge.scene/v2` |
| `E100-bad-yaml` | unparseable front matter |
| `E100-unclosed-fence` | opening `---`, no closing |
| `E101-anchor` | YAML anchor/alias |
| `E101-tag` | `!!str` tag |
| `E102-missing-field` | scene without `sequence` |
| `E102-bad-id` | ID containing `I` |
| `E102-scalar-for-list` | `characters: maren-hollis` |
| `E102-bad-enum` | scene `status: done` |
| `E103-path-escape` | `cover: ../outside.jpg` |
| `E201-duplicate-id` | two scenes share an ID |
| `E202-duplicate-series-number` | library: two books in a series with `series_number: 1` |
| `E203-duplicate-book-slug` | library: two books with the same slug |
| `E204-duplicate-sequence` | two scenes, same chapter and sequence |
| `E205-act-mismatch` | scenes of one chapter with different acts |
| `E206-act-decreases` | chapter 3 in act 1 after chapter 2 in act 2 |
| `E207-duplicate-chapter-md` | two `chapter.md` with the same number |
| `E208-duplicate-slug` | entry and thread with the same slug |
| `E301-broken-body-link` | `[[nobody]]` in a scene body |
| `E301-broken-reference` | `pov: nobody` |
| `E301-missing-cite` | `[@no-such-source]` |
| `E302-wrong-kind` | `pov: brass-key` (a thread) |
| `W101-too-deep` | library: `book.md` three levels down |
| `W201-misfiled-scene` | scene in the wrong chapter folder |
| `W201-entry-type-folder` | `type: location` under `codex/characters/` |
| `W202-prefix-mismatch` | `0015-x.md` with `sequence: 20` |
| `W203-bad-filename` | `Chapter One Notes.md` (plain note, no front matter) |
| `W204-bom` | scene file starting with a UTF-8 BOM |
| `W301-previous-slug` | link via `previous_slugs` |
| `E102-event-state` | event `state` item with an unknown `event` word (M05-J01) |
| `E301-event-state` | event `state` slug that resolves to nothing |
| `E302-event-state` | event `state` location value that is a character, not a location |
| `W307-duplicate-exception` | two `planning/continuity/` exceptions with one fingerprint |
| `W308-suggestion-target-missing` | a `suggestions/` document whose `target` id is not a live document (M05-J06) |
| `W314-comment-target-missing` | a `comments/` document whose `target` id is not a live document (M07-J03) |
| `W315-plugin-api-newer` | a `_plugins/<id>/plugin.md` manifest whose `api` is greater than the API major this StoryForge serves (M08-J02) |
| `E102-plugin-permission` | a plugin manifest with an unknown permission, at `permissions[i]` (M08-J02) |
| `E102-suggestion-hunk` | a suggestion whose hunk `lines` disagrees with its diff block (M05-J06) |
| `W302-paid-no-payoff` | thread `status: paid`, `payoff: []` |
| `W303-archived-target` | link to an entry under `archive/` |
| `I401-unknown-field` | scene with `mood: cold` |
| `I402-cross-book` | `[[other-book:someone]]` |

Every code in spec §11 has at least one case. A case may produce a second diagnostic only if the spec forces it (e.g. `E201` reports both files); `expected.json` lists all of them.

## Done

- `npm test` in `packages/format` passes.
- Every invalid case matches its `expected.json` exactly.
- Both valid projects and the spec example match their expected results.
- `sf-validate` exit codes behave as above on one valid and one invalid fixture.

## M05-J01 additions (additive within v1)

Event `state` (E102 / E301 / E302 at `state[i].slug|event|value`), `codex/_types` `values` (E102 at `values`), the `continuity-exception` kind (required `slug`, `fingerprint`, `rule`, `title`; E102 for a bad fingerprint or an empty body at `body`; W201 outside `planning/continuity/`) and `W307` (duplicate fingerprint, at `fingerprint`). `@storyforge/format` also exports `readText`, `STATE_EVENTS` and `FINGERPRINT_RE` for `@storyforge/continuity`.
