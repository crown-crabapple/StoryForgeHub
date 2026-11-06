# M05-J01 contract — continuity rules, findings and exceptions

Binding: FORMAT-v1 §1.3 (IDs), §1.8 (links), §4.2 (scene order), §5 (entries, `fields`), §5.1 (`_types`), §6.1 (threads), §6.2 (events, chronological order, narrative position), §7 (research is non-canon unless `canon: true`), §11; DECISIONS 1, 5; contracts M04-J01 (link resolver, mentions), M04-J04 (timeline).

The engine is **deterministic** (same files → same findings, same order, same fingerprints), **read-only** (it never writes a file), and **evidence-based** (every finding names at least one exact source location; most name two). It never edits prose or canon.

## 1. Format additions (additive within v1)

### 1.1 Event `state` — what changes at an event

Optional list on `storyforge.event/v1`:

```yaml
state:
  - { slug: pell, event: died }
  - { slug: grafting-knife, event: holder, value: maren-hollis }
  - { slug: maren-hollis, event: location, value: port-aldine }
  - { slug: ferry-bell, event: lost }
  - { slug: maren-hollis, event: learns, value: the-key-opens-the-sluice }
  - { slug: tobin-reyes, event: knows, value: the-key-opens-the-sluice }
```

| `event` | `slug` must be | `value` |
|---|---|---|
| `died`, `revived` | character entry | — (must be absent) |
| `destroyed`, `lost`, `found` | any entry | — (must be absent) |
| `holder` | object entry | character entry slug, or `""` (nobody) |
| `location` | character or object entry | location entry slug |
| `learns` | character entry | fact key (a slug-shaped string; not a link) |
| `knows` | character entry | fact key — an **assertion** that the character already knows it here |

The `event` vocabulary deliberately matches the Claude-Book state-event vocabulary (`died|revived|destroyed|lost|found|holder|location`) plus `learns`/`knows`.

Validator: unknown `event`, missing/extra `value`, non-slug fact key → `E102` at `state[i].event` / `state[i].value`; `slug`/`value` that doesn't resolve → `E301`; resolves to the wrong entry type → `E302` (location `state[i].slug` / `state[i].value`). Fixtures: `invalid/E102-event-state`, `invalid/E301-event-state`, `invalid/E302-event-state`.

### 1.2 Field vocabularies — `_types` `values`

`codex/_types/<type>.md` may add `values:` — a map field label → list of allowed words, e.g. `values: { Eyes: [grey, green, blue, brown, hazel] }`. Used only by the fact rule (§3.1). Not enforced on entries. Malformed → `E102`.

### 1.3 Continuity exceptions — `planning/continuity/<slug>.md`

```markdown
---
schema: storyforge.continuity-exception/v1
id: note_01…
slug: maren-eyes-are-green-on-purpose
fingerprint: cf1-3b9e0c1d2a4f5e6b      # exactly one finding fingerprint
rule: CF1
title: Maren's eyes look green in the hut glass
created: "2026-11-02"
intentional: true                      # optional; only ever written as true
---
Rationale written by the author (free Markdown). Required to be non-empty.
```

- Suppresses **only** the finding with exactly that fingerprint. Nothing else.
- `intentional` is optional and must be `true` or `false` (`E102` otherwise). `true` means "this is on purpose"; absent means "acknowledged". Both suppress the same way. The engine reports it as `suppressed[].exception.intentional` (boolean).
- Removing (or archiving) the file restores the finding.
- Validator: missing `fingerprint`/`rule`/`title`, fingerprint not matching `^[a-z0-9]{2,4}-[0-9a-f]{16}$`, empty body → `E102`. Two exceptions with the same fingerprint → `W307` on each (new code) at `fingerprint`.
- The `planning/continuity/` folder is exempt from the "planning doc" kind (these are their own kind); W201 applies if a continuity-exception file lives elsewhere.
- Add `continuity-exception` to §11.1 required fields: `slug`, `fingerprint`, `rule`, `title`.

Update FORMAT-v1 (§6.2 `state`, §5.1 `values`, new §6.4 continuity exceptions, §11 `W307`, §11.1) with "*(Added 2026-11-02, M05-J01; additive within v1.)*" marks.

## 2. The engine — new package `@storyforge/continuity`

- Depends on `@storyforge/format` only (plus `yaml` if needed). No SQLite, no network, no writes.
- `checkContinuity(bookRoot, opts?) → Promise<ContinuityResult>`; reuses the format loader / link resolver (do not write a second parser). Also exported: `RULES` (id, version, title, severity, description), `fingerprintOf(...)`.
- Only canonical inputs: non-archived scenes that are not variants (§4.4), entries, threads, events, `canon: true` research notes, exceptions. `.storyforge/` is never read.
- Files that fail to parse are skipped and listed in `result.skipped` (their diagnostics are the validator's job).

```ts
ContinuityResult = {
  engine_version: 1,
  findings: Finding[],          // not suppressed, sorted (§2.2)
  suppressed: { finding: Finding, exception: { file, slug } }[],
  stale_exceptions: { file, slug, fingerprint }[],  // exception matching no current finding (info only)
  skipped: string[]
}
Finding = {
  fingerprint: string,          // "<rule lower>-<16 hex>"
  rule: string, rule_version: number,
  severity: 'error' | 'warning' | 'info',
  title: string,                // one line, plain words
  message: string,              // what conflicts with what, quoting both values
  subject: { kind: 'entry'|'thread'|'event'|'scene', id, slug?, name? },
  sources: Source[]             // ≥ 1; ordered: canon/earlier first
}
Source = {
  role: 'canon' | 'text' | 'event' | 'thread' | 'note',
  kind: 'entry'|'scene'|'event'|'thread'|'research',
  id: string,                   // stable front-matter ID
  file: string,                 // book-relative, forward slashes
  heading: string,              // scene title / entry name / event title (+ " › <section>" when in a body section)
  location: string,             // validator style: "fields.Eyes", "state[2]", "line 17"
  line: number,                 // 1-based line in the file
  range: { from: number, to: number } | null,   // 0-based column range of the evidence on that line
  excerpt: string               // the evidence text, ≤ 160 chars, trimmed
}
```

### 2.1 Fingerprint

`fingerprint = <rule lower-case> + '-' + first 16 hex of sha256(JSON.stringify([rule, subject.id, ...sorted source ids, key]))`, where `key` is a rule-specific normalised string (e.g. `"eyes|grey|green"`). **Never** includes line numbers, columns, excerpts, file paths or rule_version — editing other text, moving or renaming a file, or bumping a rule's version keeps the fingerprint. Documented per rule below.

### 2.2 Order

Findings sorted by severity (error, warning, info), then rule id, then first source file, then line, then fingerprint.

## 3. Rules (version 1 each)

Story time = chronological order (§6.2). Book order = §4.2 position. A scene's characters = `pov` ∪ `characters`.

### 3.1 `CF1` fact conflict (warning) — *duplicated facts*

For every entry field `Label: value` where `value` is a single word (after stripping links/quotes) and the label has a vocabulary — from `_types` `values` (§1.2) or the built-in colour vocabulary for labels `Eyes`, `Eye colour`, `Eye color`, `Hair`, `Hair colour`, `Hair color` (colours: black, blue, brown, green, grey/gray, hazel, amber, red, auburn, blond/blonde, white, silver, violet; grey≡gray, blond≡blonde):

- **Text source:** in each scene whose characters include the entry, a paragraph that is attributed to the entry and contains `<word> <noun>` where `<noun>` is the label's noun (`Eyes`→eye/eyes; `Hair`→hair) and `<word>` is in the same vocabulary but ≠ the field value (case-insensitive, synonyms equal). Up to two words may sit between (e.g. "green, salt-ringed eyes" is not required; "green eyes" is).
- **Attribution:** a paragraph is attributed to the entry if it mentions the entry (name, alias, or link — the M04-J01 mention rules) and no other character; **or** the scene's `pov` is the entry and the paragraph mentions no other character.
- **Canon-note source:** a `canon: true` research note that links the entry and has a line `Label: other value` (same vocabulary) → same finding kind with role `note`.
- Sources: [canon field (`location: fields.<Label>`), text/note evidence]. One finding per (entry, label, conflicting value, scene/note). key = `label|value|other` lower-case.

**Acceptance anchor:** salt-orchard yields exactly one CF1: subject `maren-hollis`; sources `codex/characters/maren-hollis.md` (`fields.Eyes`, the line of `Eyes: Grey`) and `manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md` (`line 17`, range covering `green eyes`).

### 3.2 `TL1` timeline impossibilities (error)

- **TL1a dead/destroyed then present:** after a `died` (and before any later `revived`) the character participates in a later event (`characters`, or `state` subject, or the event's scenes list them); same for `destroyed` objects named in a later event's `state` or its scenes' entry lists. Sources: [the `died` event `state[i]`, the later event or scene]. key = `dead|<slug>|<later id>`.
- **TL1b in two places at once:** two events with **equal** `order` both put the same character at different locations (via `location` state, or the event's `characters`+`locations` when it has exactly one location). key = `place|<slug>|<sorted event ids>`.
- **TL1c date runs backwards:** two events with ISO `date`s where higher `order` has an earlier date (compare at the shorter precision). key = `date|<sorted event ids>`.

### 3.3 `KN1` character knowledge (error)

A `knows` assertion for (character, fact) with no `learns` for that pair at a **strictly lower** `order` (a `learns` at equal order counts as known). Sources: [the `knows` state item, the `learns` item if it exists later]. key = `knows|<slug>|<fact>`.

### 3.4 `ST1` possession / location state (warning)

- **ST1a lost then used:** an object `lost` and not yet `found` is given a `holder` (non-empty) or is in a later event's `state` other than `found`. key = `lost|<slug>|<event id>`.
- **ST1b two holders at once:** two events with equal `order` give the same object different non-empty holders. key = `holders|<slug>|<sorted event ids>`.

### 3.5 `TH1` unresolved threads (thread lifecycle in book order)

- **TH1a payoff before setup (error):** the earliest payoff scene comes before the earliest setup scene in book order. Sources: [setup scene, payoff scene]. key = `order|<thread id>`.
- **TH1b never resolved (info):** status `planted`/`developed`/`open` and the last scene of the book is past all its scenes (i.e. the book has a final scene) — reported once. Sources: [thread file `status`]. key = `open|<thread id>`. Threads with `unresolved` or `dropped` are intentional → no finding.

### 3.6 `PL1`-`PL4` planner rules (Story Planner M6, ADR 0003; all version 1, structured records only, never prose)

| Rule | Severity | Finds | Fingerprint key |
|---|---|---|---|
| `PL1` scene not in the flow | info | A scene with no live link in or out. Runs only when the book has at least one live link. Sources: [scene `title`]. | `unlinked|<scene id>` |
| `PL2` transition not documented | info | Two scenes next to each other in reading order, each with a live link, and no direct live link between them in either direction. Subject: the earlier scene. Sources: [both scenes' `title`]. | `transition|<sorted scene ids>` |
| `PL3` beat with no scenes | info | A beat (with an `id`) in a live structure whose `scenes` is missing or empty. Subject: the structure. Sources: [structure `beats`]. | `beat|<structure id>|<beat id>` |
| `PL4` payoff with no setup | warning | A thread with `payoff` scenes and no `setup` scenes. Sources: [thread `payoff`]. | `nosetup|<thread id>` |

Fingerprint subjects and source ids: PL1 (scene; scene), PL2 (earlier scene; both scenes), PL3 (structure; beat), PL4 (thread; thread). Archived links and structures are not live. `Source` gains role `plan` and kind `structure`; `subject.kind` gains `structure`.

## 4. Repository and API

- `repository.getContinuity(bookId)` in `@storyforge/core` → `ContinuityResult` (computed from files on each call; no index needed. Cache in memory keyed by a cheap book file-stat signature is allowed, never on disk).
- `GET /api/books/:b/continuity` → 200 `ContinuityResult`; unknown book → 404 like other routes.
- CLI: `node apps/server/src/main.mjs continuity --library <path> [--book <slug>] [--json]` — prints findings (plain text, one per finding with both sources), exit 0 when no error-severity findings, 1 otherwise. Read-only; does not need the library lock.

No write routes in this job (exception create/remove is M05-J02).

## 5. Fixtures

- `valid/salt-orchard`: unchanged files; add `expected-continuity.json` = the exact `findings` (fingerprints included), `suppressed: []`. Must contain the CF1 of §3.1; any other finding it produces must be listed and justified in the RESULT (the target is exactly one).
- New `valid/continuity-cases` (built by `build-fixtures.mjs`, synthetic, no user text) with one positive case per rule/sub-rule and one near-miss negative case each (e.g. "her green scarf" ≠ eyes; simultaneous events in the same location; `learns` at equal order; thread `unresolved`). Plus `expected-continuity.json`.
- `valid/continuity-exception`: copy of salt-orchard + `planning/continuity/maren-eyes.md` naming the CF1 fingerprint → `findings` lacks it, `suppressed` has it; a second exception with a made-up fingerprint → `stale_exceptions`.
- All three validate with `diagnostics: []` (state/exception additions must not add warnings).

## 6. Acceptance

1. **One reproducible finding:** salt-orchard → exactly the expected list; the CF1 has two sources with exact file/line/range; running twice, and on a copy in another directory, gives byte-identical JSON.
2. **Fingerprint stability:** editing unrelated text in both files (adding lines above the evidence), renaming the scene file, and moving the entry to another folder → same fingerprint, new line numbers. Changing the field value (`Grey`→`Blue`) → a different fingerprint.
3. **Exception suppresses only its fingerprint:** with the exception, the CF1 is in `suppressed`, every other finding unchanged; adding a second CF1 conflict (another scene with "blue eyes") still reports that one; deleting the exception restores the original.
4. **Every rule:** `continuity-cases` → exactly `expected-continuity.json`; each negative case yields nothing.
5. **Validator:** new E102/E301/E302/W307 cases; fixtures README updated; FORMAT-v1 updated.
6. **No writes, no index:** the engine run leaves every file's bytes and mtimes unchanged, and works with `.storyforge/` deleted.
7. **Route + CLI:** route returns the result; 404 unknown book; CLI exit codes 0/1.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
