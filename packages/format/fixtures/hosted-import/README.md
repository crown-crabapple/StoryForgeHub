# hosted-import

The Phase 0 import fixture for the hosted authoring plan. It is one library, built from `valid/salt-orchard` and extended so that it holds at least one of every record kind and category the database importer (Phase 1) must keep. Synthetic only: every name, id, token hash and password record is invented.

The requirement list is [docs/contracts/H0-hosted-foundation.md](../../../../docs/contracts/H0-hosted-foundation.md) section 6. The executable form of it is `expected-import.json` here; `packages/format/test/hosted-import-fixture.test.mjs` proves the fixture is complete and that the manifest matches the files.

## Layout

| Path | What it is |
|---|---|
| `library.md`, `_templates/`, `_prompts/`, `_plugins/` | The library root: a pen name, a template, a prompt and a workflow, a plugin manifest. |
| `saltmarsh/` | One series: `series.md`, series-shared Codex entries (`codex/`, including `codex/_types/vessel.md`), and two books. |
| `saltmarsh/salt-orchard/` | Book 1 (`series_number` 1): the whole of `salt-orchard`, plus every other kind, archived records, comment, suggestion, receipts, canvas, activity, assets and `.storyforge/revisions` (six restore points for one scene). |
| `saltmarsh/the-salt-road/` | Book 2 (`series_number` 2): two scenes, a thread and an entry. A scene in book 1 links to it with `[[the-salt-road:salt-ledger]]`. |
| `shared-data/` | The shared-mode store (users, members, sessions, invites, shares, settings, plugin tokens, OAuth, webhooks, audit log). It is **not part of the library**: in a real deployment it lives outside it. It is kept inside this folder only so one fixture holds everything the importer reads. |
| `expected-import.json` | Counts, scene order, field mappings, `import_metadata`, expected findings, `rawImport` constructs and restore points. |

## Deliberate findings

`validate()` on this folder reports exactly three diagnostics, all listed under `expected_findings` in the manifest:

- `W303` on thread `brass-key`: `develop` points at the archived scene.
- `E301` on the scene `Ferry`: the unresolved `[[the-ferry-ledger]]` link. This is the one error, and it is required by H0 section 6 ("an unresolved `[[link]]`"); the validator has no softer code for an unresolved body link.
- `I401` on the entry `pell`: the unknown front-matter field `nickname_origin`.

Do not "fix" them. Do not add files under `valid/`; this folder is not a `valid/` case and no other test globs it.
