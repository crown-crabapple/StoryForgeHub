# M04-J01 contract — Markdown-backed Codex model and graph

Binding: FORMAT-v1 §1.4 (slugs), §1.8 (links, resolution), §5 (entries), §6 (threads, events), §11 (diagnostics); DECISIONS 1, 5; contracts M01-J03 (index), M03-J04 (entry preview route). Design: `design/screens/Codex.dc.html`.

## 1. Format additions (additive, v1)

### 1.1 Type definitions — `codex/_types/<type>.md` (optional)

```yaml
---
schema: storyforge.codex-type/v1
id: note_01…            # prefix note
type: ship              # lower-case word; the entry `type` it describes
name: Ship              # display name (singular)
plural: Ships           # display name (plural); folder stays codex/<type>s/
fields: [Captain, Home port, Tonnage]   # default field labels for new entries
---
Optional description shown in the Codex sidebar.
```

- Built-in types (`character`, `location`, `faction`, `object`, `lore`) may also have a `_types` file to customise display name/fields; built-in folders are unchanged.
- The `_types/` folder is exempt from the W201 folder rule. Two type files for the same `type` → `E209` (new). A type file whose `type` isn't a lower-case word → `E102`.
- Entries with a custom `type` and no type file are still valid (display name = type, title-cased).

### 1.2 Diagnostics added

| Code | Sev. | Meaning |
|---|---|---|
| E209 | error | Two `_types` files define the same type |
| W304 | warning | An alias (or name) is shared by two entries — mention matching is ambiguous for it (reported on each entry, location `aliases[i]` or `name`) |
| W305 | warning | `related[i].to` points at the entry itself |

Update FORMAT-v1 §5 and §11 text accordingly (the coordinator edits the spec; the implementer updates the validator).

## 2. One link resolver (fixes the M01-J03 follow-up)

`@storyforge/format` exports `extractLinks(result)` (or equivalent) returning every explicit reference as records `{ src_id, src_path, location, raw, target_id, target_kind, resolution }` — the same records `validate()` uses internally to emit E301/E302/W301/W303/I402. `@storyforge/index` builds its `links` table **from these records only** (delete its own resolution code). Index == files tests must keep passing.

## 3. Graph

Edges are of two kinds and are never mixed:

| kind | Source | Examples |
|---|---|---|
| `explicit` | front-matter references and body `[[links]]` (the link records) + entry `related` | scene → character (`characters`), scene → entry (`[[maren-hollis]]`), entry → entry (`related`, label = `as`) |
| `inferred` | name/alias mentions in scene bodies (existing `mentions` table) **minus** pairs that already have an explicit edge | scene → entry ("Maren" appears in text) |

Each edge: `{ from, to, kind, rel, label?, source: { path, location } , count? }` where `rel` ∈ `pov`, `character`, `location`, `thread`, `event`, `link`, `related`, `mention`.

- Pure function `buildGraph(result, mentions)` in `@storyforge/index` (no DB) and the same edges from the index (`graph` table or a query). **Index == files for the graph** is a hard requirement.
- Route `GET /api/books/:b/graph?node=<id>&kinds=explicit,inferred` → `{ nodes: [{ id, kind, type, name }], edges: [...] }` (whole book if no `node`; otherwise the node and its neighbours).
- Route `GET /api/books/:b/entries/:id` (M03-J04) gains `appears_in: [{ scene_id, title, position, rel, kind }]` (explicit first, then inferred) and `related: [{ id, name, as, direction: 'out'|'in' }]` (incoming `related` shown as reverse).

## 4. Fixture

Extend `packages/format/fixtures/valid/salt-orchard` **only if needed** — prefer a new fixture `packages/format/fixtures/valid/codex-graph/` (synthetic): one book with all five built-in types + one custom type (`ship`, with a `_types/ship.md`) + one custom type without a type file (`spell`), relations in both directions, aliases (incl. a shared alias → W304, so this fixture's `expected.json` lists that warning), a self-relation is NOT included (W305 goes in an invalid case), scenes referencing entries via front matter, `[[links]]`, and plain-name mentions. Add invalid cases `E209-duplicate-type`, `W304-shared-alias`, `W305-self-relation`.

## 5. Acceptance

1. Every fixture entity and relation exists in Markdown and validates (expected diagnostics exactly).
2. **Graph identical** from files (`buildGraph`) and from a fresh index, and again after deleting `.storyforge/` and rebuilding — on `codex-graph`, `salt-orchard`, `spec-example`.
3. Explicit vs inferred never mixed: a scene that both links `[[maren-hollis]]` and mentions "Maren" yields one explicit edge and no inferred edge for that pair; a scene that only mentions yields one inferred edge with `count`.
4. `links` table rows == `extractLinks` records (index uses the shared resolver); all existing index/link tests pass.
5. New diagnostics: E209, W304 (on each entry), W305 — invalid cases match `expected.json` exactly; coverage test updated.
6. Routes: graph (whole + node), entry `appears_in`/`related` incl. reverse direction; 404s.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
