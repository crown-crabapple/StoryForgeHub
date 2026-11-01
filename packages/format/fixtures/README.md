# Format v1 fixtures

Synthetic only. No user manuscript, no real people, no text from any real project. Every name, place and sentence is invented.

The bytes in this folder are exact (`.gitattributes` marks `packages/format/fixtures/**` as `-text`): LF line endings, UTF-8, no BOM, except where a fixture is *about* those things (`invalid/W204-bom`, and one CRLF scene in `valid/salt-orchard`).

## `valid/`

| Folder | What it is |
|---|---|
| `salt-orchard/` | The reference book. 2 acts, chapters 0 to 3, 7 ordered scenes plus a variant and an archived scene; codex (characters, locations, faction, objects, lore), a plot thread with setup and payoff, timeline events, a research note and a cited source, a planning doc, Unicode prose, all three HTML comment forms, an `x-` field, a `.storyforge/` decoy. Zero diagnostics. |
| `library/` | A library with one pen name, a series `tidewater/` (two books, `series_number` 1 and 2) and one standalone book. Zero diagnostics. |
| `spec-example/` | Byte copy of the spec's `salt-orchard-mini` example, `.storyforge/` decoy included. Exactly four diagnostics: `I402`, `W201`, `W202`, `W301`. |

`expected.json` in each valid folder holds the expected `diagnostics`, and where relevant the scene `order` (IDs), the chronological `timeline` (event slugs) and the `excluded` scenes (variant, archived).

### Intentional contradiction in `salt-orchard`

The codex says Maren's eyes are grey; one scene says green. This is deliberate, it is a test input for the M05 continuity engine, and the validator must NOT report it. See `valid/salt-orchard/contradiction.md`. Do not "fix" it.

## `invalid/`

One folder per defect, named `<code>-<short-name>`. Each is a minimal valid book (or a library root for `E202`, `E203`, `W101`) with exactly one defect. `expected.json` lists every diagnostic that defect forces, as `{ code, file, location }` (file relative to the folder). The validator's output must match that list exactly as a set; messages are not compared.

## Regenerating

`test/build-fixtures.mjs --write` regenerates `invalid/*`, `valid/salt-orchard`, `valid/library` and `valid/spec-example/expected.json`. The committed files are the source of truth; the script is only a convenience and does nothing without `--write`. It never touches the spec-example copy.
