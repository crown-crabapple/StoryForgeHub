# Format v1 fixtures

Synthetic only. No user manuscript, no real people, no text from any real project. Every name, place and sentence is invented.

The bytes in this folder are exact (`.gitattributes` marks `packages/format/fixtures/**` as `-text`): LF line endings, UTF-8, no BOM, except where a fixture is *about* those things (`invalid/W204-bom`, and one CRLF scene in `valid/salt-orchard`).

## `valid/`

| Folder | What it is |
|---|---|
| `salt-orchard/` | The reference book. 2 acts, chapters 0 to 3, 7 ordered scenes plus a variant and an archived scene; codex (characters, locations, faction, objects, lore), a plot thread with setup and payoff, timeline events, a research note and a cited source, a planning doc, Unicode prose, all three HTML comment forms, an `x-` field, a `.storyforge/` decoy. Zero diagnostics. |
| `codex-graph/` | Synthetic book for the Codex model and graph (M04-J01): all five built-in entry types, a custom `ship` type with `codex/_types/ship.md`, a custom `spell` type without a type file, relations in both directions, one alias (`Skipper`) shared by two entries, and three scenes using front-matter references, `[[links]]` and plain-name mentions (one scene both links and mentions the same entry). Exactly two diagnostics: `W304` on each of the two entries. |
| `library/` | A library with one pen name, a series `tidewater/` (two books, `series_number` 1 and 2) and one standalone book. Zero diagnostics. |
| `continuity-cases/` | Synthetic book for the continuity engine (M05-J01): one positive and one near-miss negative per rule (CF1 text, canon note and custom `values`; TL1a/b/c; KN1; ST1a/b; TH1a/b). Zero diagnostics; `expected-continuity.json` holds the exact findings. |
| `suggestion/` | `salt-orchard` plus `suggestions/2026/20261102-140322-arrival-eyes.md`: a pending suggestion with three hunks on Arrival (M05-J06). Zero diagnostics. |
| `continuity-exception/` | `salt-orchard` plus `planning/continuity/maren-eyes.md` (suppresses its CF1) and `old-note.md` (names no finding: a stale exception). Zero diagnostics; `expected-continuity.json` has the finding under `suppressed` and the stale exception. |
| `spec-example/` | Byte copy of the spec's `salt-orchard-mini` example, `.storyforge/` decoy included. Exactly four diagnostics: `I402`, `W201`, `W202`, `W301`. |
| `tidewater/` | Shared series world (M07-J01): series `tidewater/` with labels, shared `ilse-hollis` and `port-aldine` entries and a shared `vessel` type with typed fields; books `salt-orchard-2` and `low-tide` that use `ilse-hollis` by bare slug with no copy, a `[[low-tide:the-lost-ledger]]` cross-book link, a book-local `port-aldine` shadowing the shared one, labels on scenes and entries; a library template `_templates/mystery-arc/`; and a standalone book `pilgrims-road` that must not see the shared entries. Exactly one diagnostic: `W309` on the shadowing entry. |

`salt-orchard/expected-continuity.json` pins the one finding the continuity engine reports for it (CF1, Eyes Grey vs green). `expected.json` in each valid folder holds the expected `diagnostics`, and where relevant the scene `order` (IDs), the chronological `timeline` (event slugs) and the `excluded` scenes (variant, archived).

### Intentional contradiction in `salt-orchard`

The codex says Maren's eyes are grey; one scene says green. This is deliberate, it is a test input for the M05 continuity engine, and the validator must NOT report it. See `valid/salt-orchard/contradiction.md`. Do not "fix" it.

## `invalid/`

One folder per defect, named `<code>-<short-name>`. Each is a minimal valid book (or a library root for `E202`, `E203`, `W101`) with exactly one defect. `expected.json` lists every diagnostic that defect forces, as `{ code, file, location }` (file relative to the folder). The validator's output must match that list exactly as a set; messages are not compared.

## Regenerating

`test/build-fixtures.mjs --write` regenerates `invalid/*`, `valid/salt-orchard` (and its `expected-continuity.json`), `valid/continuity-cases`, `valid/continuity-exception`, `valid/suggestion`, `valid/library` and `valid/spec-example/expected.json`. The committed files are the source of truth; the script is only a convenience and does nothing without `--write`. It never touches the spec-example copy.

`test/build-world-fixtures.mjs --write` regenerates `valid/tidewater` and the M07-J01 invalid cases (`E210`, `E303`, `W309`, `W311`, `W312`, `I403`, `E102-label-*`, `E102-field-*`, `E102-template-shape`, `E301-shared-private-link`, `E302-cross-book-reference`, `E208-shared-duplicate-slug`, `W303-cross-book-archived`) the same way.

The M07-J02 invalid cases (`W313-task-target`, `E102-goal-shape`, `E102-task-shape`, `E301-goal-scope`, `W201-task-folder`) are hand-written minimal books (the committed files are the source of truth; no generator).
