# M13-J01 contract — Findings foundation (editing and publishing, milestone 0)

Binding: M03-J02 (the editor buffer, line endings, save state machine, CodeMirror history as undo); M05-J04 (body-relative editor offsets, `rawOffset`, `selectRange`); M05-J07 (receipts); M07-J04 (preferences and layers).

M13 adds four optional, local-only integrations: Harper grammar checks (J02), a curated textlint style review (J03), EPUBCheck validation (J04) and an experimental Paged.js book interior (J05, J06). J01 adds only what they share: the finding contract, the validation result contract, capability states, prose source mapping, the `checks` preference and an editor layer that shows a finding and applies one of its replacements. J01 adds no checker, no dependency, no route and no network code.

## 1. Where the code lives

- `packages/format/src/findings.mjs`: the finding contract, the validation result contract and capability states. Pure: no `node:*` import, no I/O.
- `packages/format/src/prose-map.mjs`: prose projection and offset conversion. Pure, same rules.
- Both are exported from `@storyforge/format` (`packages/format/src/index.mjs`).
- The web app cannot import `@storyforge/*`. It keeps byte-identical copies at `apps/web/src/findings/findings.js` and `apps/web/src/findings/prose-map.js`. A web test reads both pairs and fails if a copy differs from its source (the copy may differ only in a first-line comment that names the source file). Change the package file, then copy it.

## 2. A finding

Schema `storyforge.finding/v1`. A plain JSON object:

| Field | Meaning |
|---|---|
| `schema` | `'storyforge.finding/v1'` |
| `id` | Stable id: `fnd_` + 16 lower-case hex. `findingId(f)` derives it from `engine`, `ruleId`, `sceneId`, `range.from`, `range.to` and `original` with a pure, documented 64-bit FNV-1a hash. Not a security hash. |
| `engine` | `/^[a-z][a-z0-9-]{0,31}$/`, for example `harper`, `textlint`, `sample` |
| `engineVersion` | Non-empty string, at most 64 characters |
| `ruleId` | Non-empty string, at most 128 characters |
| `category` | One of `grammar`, `spelling`, `punctuation`, `style`, `terminology`, `repetition`, `rhythm` |
| `severity` | One of `error`, `warning`, `info` |
| `advisory` | `true` for subjective style findings: never shown as an error, never auto-applied |
| `message` | Non-empty string, at most 1,000 characters |
| `sceneId` | `scene_` + 26-character ULID |
| `source` | `{ sha256, length }`: the SHA-256 (64 lower-case hex) of the checked body text, UTF-8 encoded, with every CRLF as LF; `length` is that text's UTF-16 length |
| `range` | `{ from, to }`: integers, `0 <= from < to <= source.length`. Body-relative UTF-16 code units, every line break counting 1. These are CodeMirror document positions in the scene editor and the offsets `selectRange` takes. Neither end may split a surrogate pair. |
| `original` | The exact text at `range` in the checked body (LF line breaks) |
| `replacements` | Array of 0 to 8 strings. May be empty. A replacement may be the empty string (delete). |

- `findingProblems(f)` returns a list of `{ field, message }`; empty means valid. It checks every rule above it can check without the body.
- `findingMatches(f, body)` is true only when `body` (LF line breaks) has `source.length` UTF-16 units and `body.slice(range.from, range.to) === original`. It does not hash.
- A finding is **stale** when its range no longer holds `original` in the current text, or when an edit touched its range. A stale finding is never applied and never shown.

## 3. A validation result

Schema `storyforge.validation/v1`. Kept apart from findings: it is about an exported file, not a passage.

| Field | Meaning |
|---|---|
| `schema` | `'storyforge.validation/v1'` |
| `validator`, `validatorVersion` | e.g. `epubcheck`, `5.x.y`. `validatorVersion` is `null` only when the outcome is `unavailable` or `not-checked` |
| `artifact` | `{ kind, sha256, name }`: `kind` is `epub` or `pdf`; `sha256` of the exact file checked; `name` the file name only (no folder) |
| `checkedAt` | ISO 8601 UTC time, or `null` when nothing ran |
| `outcome` | One of `passed`, `passed-with-warnings`, `failed`, `not-checked`, `unavailable`, `error`, `cancelled` |
| `messages` | Array of `{ code, severity, message, location, sceneId, chapterId }`. `severity` is one of `fatal`, `error`, `warning`, `info`, `usage`. `location` is `{ path, line, column }` or `null`. `sceneId`/`chapterId` are set only when the mapping is exact; otherwise `null`. |
| `report` | `{ path }` (relative to the export folder) or `null` |
| `detail` | Plain-language text for `unavailable`, `error` and `cancelled`; `null` otherwise |

- `error` is a process failure (the validator crashed, timed out, gave unreadable output). `failed` is a conformance failure. They are never merged.
- `isCleanValidation(r)` is true only for `passed` and `passed-with-warnings`. `not-checked`, `unavailable`, `error` and `cancelled` are never clean.
- `validationProblems(r)` returns `{ field, message }[]` like `findingProblems`.
- `outcomeOf(messages)`: `failed` if any message is `fatal` or `error`, else `passed-with-warnings` if any is `warning`, else `passed`.

## 4. Capability states

`CAPABILITY_STATES`: `ready`, `disabled`, `unavailable`, `running`, `cancelled`, `failed`, `completed`.

- `disabled`: the author has not turned it on. `unavailable`: it is on but cannot run (no Java, unsupported language, asset missing); always carries a reason. `failed`: it ran and broke. Neither `unavailable` nor `failed` nor `cancelled` is ever shown as "no problems found".
- `nextCapability(state, event)` with events `enable`, `disable`, `start`, `finish`, `fail`, `cancel`, `lose` (dependency gone), `restore` (dependency back). Allowed moves:
  - `disabled` -enable-> `ready`; any state -disable-> `disabled`
  - `ready`, `completed`, `failed`, `cancelled` -start-> `running`
  - `running` -finish-> `completed`; -fail-> `failed`; -cancel-> `cancelled`
  - any state except `disabled` -lose-> `unavailable`; `unavailable` -restore-> `ready`
  - Anything else returns the same state unchanged (no throw).
- `mayShowClean(state)` is true only for `completed`.

## 5. Prose projection and source mapping

Engines check prose, not Markdown. Stripping Markdown and reusing the stripped offsets is forbidden. Instead:

- `projectProse(body)` takes the body as the editor holds it (LF line breaks) and returns `{ text, map }`. `text` is what an engine checks. `map` is an `Int32Array` of length `text.length + 1`: `map[i]` is the body offset of `text[i]`, and `map[text.length]` is the body offset just after the last projected unit.
- Left out of `text`: fenced code blocks (``` and ~~~, whole block including fences), HTML comments (this includes `<!-- note: ... -->` scene notes, which are never prose), link destinations `](...)`, reference definitions (`[x]: url` lines), emphasis and strong markers (`*`, `_`, `**`, `__`, `~~`), ATX heading markers (`#` plus one space), blockquote markers (`>` plus one space) and list markers (`-`, `*`, `+`, `1.` plus one space) at line start, and backslash escapes' backslash.
- Placeholders: inline content a reader sees as something (inline code spans, label-less Codex links `[[target]]`, citations `[@key]`, autolinks `<https://...>`, images `![alt](src)`) projects as ONE unit, the character `X`, with `map[i]` the construct's start offset, flagged in `projection.placeholders` (`Uint8Array`, 1 = placeholder; absent means none). `isWholeRange` is false over any placeholder, so no finding may cover one.
- Kept: everything else, including link labels (`[label]`'s `label`), line breaks, and punctuation. A removed non-visible span (comment, marker, destination) between two non-space characters leaves no character; the engine sees the neighbours joined.
- The projection is a small scanner, not a full CommonMark parser. Its limits (indented code blocks, nested brackets, HTML blocks other than comments) are listed in `prose-map.mjs`; on doubt it keeps text rather than drops it.
- `toBodyRange(projection, from, to)` maps a projected `[from, to)` to a body range: `{ from: map[from], to: map[to - 1] + 1 }` when `to > from`, widened if needed so neither end splits a surrogate pair. Empty ranges return `null`.
- Engine unit conversion, each pure and total over valid input:
  - `codePointToUtf16(text, cp)`: code-point index to UTF-16 index.
  - `utf8ToUtf16(text, byteOffset)`: UTF-8 byte offset to UTF-16 index. A byte offset inside a character rounds down to that character's start.
  - `lineColumnToUtf16(text, line, column)`: 1-based line, 0-based UTF-16 column, `\n` line breaks; `null` when out of range.
  - `lfOffsetToRaw(raw, lf)` and `rawOffsetToLf(raw, rawOffset)`: between a raw body that may hold CRLF and the LF view. `lfOffsetToRaw` gives the same answer as `rawOffset` in `packages/core/src/ai-rewrite.mjs`.
- Combining marks (for example `e` + U+0301) are separate UTF-16 units. The projection never splits a base letter from its following combining marks: a range end that lands between them is moved past the marks.

## 6. The `checks` preference

A new project key in `PROJECT_KEYS` (built-in < profile < library < book), validated by `preferenceProblems`:

```yaml
preferences:
  checks:
    version: 1
    grammar: { enabled: false, language: en }
    style: { enabled: false }
    epub: { validate: false }
```

- `BUILTIN.checks` is exactly the map above. A book that sets nothing behaves as it does today: nothing runs.
- `version` must be `1` when present. Any other value is `E102` at `preferences.checks.version` with the message that the book was saved by a newer StoryForge.
- `grammar.enabled`, `style.enabled`, `epub.validate` must be booleans. `grammar.language` must be `en` (the only language J02 supports). Unknown keys at any level are `E102`.
- J01 adds no write route for `checks`. J02 and J04 add the routes they need.
- Rule settings, dictionaries and dismissals are J02/J03 data. They are not part of `checks` v1.

## 7. The editor finding layer

`apps/web/src/editor/finding-marks.js`, added once to the scene editor's extension list next to `continuityMarks()`:

- `setFindings` (StateEffect) replaces the findings shown. Each finding is drawn as a `Decoration.mark` over exactly `range.from..range.to`, class `cm-finding cm-finding-<category>`, with `data-finding` set to the id and an `aria-description` of the message. Advisory findings also get `cm-finding-advisory`. A finding whose range is out of the document, or whose text there is not `original`, is not drawn.
- On every transaction the field maps each live finding through the changes. A finding whose range any change touches (insert inside, delete across, or replace) is dropped as stale. An edit outside it moves it.
- `applyFinding(view, id, index)` returns `{ ok: true }` or `{ ok: false, code }` with `code` one of `NOT_FOUND`, `NO_REPLACEMENT`, `STALE`, `READ_ONLY`. On `ok` it dispatches one transaction: `changes: { from, to, insert: replacements[index] }`, `userEvent: 'input.finding'`, and removes that finding. It checks the live text at the mapped range equals `original` before dispatching; otherwise `STALE` and nothing changes.
- That transaction is an ordinary author edit: it enters CodeMirror history (so Undo restores the text) and is saved by the existing save controller with `base_sha256` (so receipts and the 409 conflict rule apply unchanged). There is no new server route.
- `findings()` export: the live findings after mapping, for a findings panel (J02).
- Theme: a wavy underline for `error`, dotted for `warning` and `info`, colours from the existing theme variables. Works in the high-contrast theme.

## 8. Tool versions and licences

`docs/editing-publishing.md` records, for each planned integration, the candidate pinned version, its licence, its runtime requirement and how it is shipped (bundled asset, production dependency, or an optional dependency the author installs). It states that nothing is downloaded at run time. J02 to J06 update the table when they actually pin a version.

## 9. Proof

- `packages/format/test/findings.test.mjs`: valid and invalid findings and validation results; `findingId` is stable and differs per range; `outcomeOf`; `isCleanValidation` is false for every non-clean outcome; every allowed and refused capability move; `mayShowClean`.
- `packages/format/test/prose-map.test.mjs`: projection and mapping round trips for emphasis, strong, links, images, inline code, fenced code, HTML notes, headings, lists, blockquotes, escapes; surrogate pairs (emoji), combining marks, CRLF, smart quotes and accented names; `codePointToUtf16`, `utf8ToUtf16`, `lineColumnToUtf16`, `lfOffsetToRaw`/`rawOffsetToLf` against hand-computed values. Every test asserts `body.slice(range.from, range.to)` equals the expected word.
- `packages/format/test/customization.test.mjs` (or a new file): `checks` defaults, layering and each `E102`.
- `packages/core/test/`: a finding built from a CRLF scene body with an emoji before the word, passed through `selectRange(bytes, bodyStart, from, to)`, yields `original` (scene body offsets after front matter).
- `apps/web/test/findings-copy.test.mjs`: the two web copies match their package files.
- `apps/web/test/finding-marks.test.mjs` (Node, `EditorState` only, no DOM): a sample finding is decorated at exactly its range, including after an emoji and in a CRLF buffer; an edit before it moves it; an edit inside it drops it; `applyFinding` on a current finding changes exactly the range and `undo` from `@codemirror/commands` restores the previous document; `applyFinding` after the text changed returns `STALE` and changes nothing; `NOT_FOUND` and `NO_REPLACEMENT`.
- No new network code: the network-boundary lint already covers `packages/**`; a web test asserts `apps/web/src/findings/` and `finding-marks.js` contain no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `import(` or `http:`/`https:` URL.

## 10. Known limits

- No checker yet: J01 ships the layer and contracts only. Nothing in the app produces a finding until J02.
- The projection is a scanner with documented limits, not full CommonMark.
- Applying a finding from a scene that is not open in the editor (J03's manuscript scans) needs a server range-replace like `applyAiRewrite` with an author receipt; that is J03's job.
