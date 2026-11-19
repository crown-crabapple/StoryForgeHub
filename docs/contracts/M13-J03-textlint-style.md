# M13-J03 contract — Style checks with textlint (editing and publishing, milestone 2)

Binding: M13-J01 (findings, projection, capability states, `checks`), M13-J02 (grammar panel, editor controller, `withGrammarChecks` pattern), M05-J01/J02 (continuity exceptions: one Markdown file per dismissal, fingerprint, stale list, archive to restore), M05-J04 (`applyAiRewrite`, `selectRange`, `spliceReplacement`, `writeWithReceipt`), M05-J07 (receipts), the AI stream job pattern in `apps/server/src/ai-routes.mjs` (in-memory job, polled GET, POST cancel).

J03 adds an optional, per-book style review. textlint is the framework; the rules are StoryForge's own, curated and pinned in this repository. Style findings are advice: they never change text unless the author applies one. Nothing is sent anywhere. The name is **Style checks** everywhere (the editor's "Check scene" is the M05-J06 report and stays as it is).

## 1. Dependencies and the engine package

- New workspace package `packages/style` (`@storyforge/style`, AGPL-3.0-only, server-only), depending on `@textlint/kernel` **16.1.1** and `@textlint/textlint-plugin-text` **16.1.1** exactly (MIT; with their dependencies 13 MIT packages, about 2 MB; no network or dynamic loading code). The Markdown plugin is not used: the J01 projection already turns Markdown into prose.
- eslint: `packages/style/src/**` gets the same no-`fs` block as `packages/continuity`, and `child_process` is banned there too. The network boundary already covers it.
- `apps/server` depends on `@storyforge/style`. Nothing in `apps/web` imports textlint.
- `RULES` in `packages/style/src/rules/index.mjs` is a fixed, frozen table of rule id -> rule module. The engine passes only entries of this table to `TextlintKernel.lintText`. Rule ids, options and book settings are data; no setting can name a module, a path or a package. A unit test greps `packages/style/src` for `import(`, `require(`, `createRequire`, `eval`, `new Function`.
- `docs/editing-publishing.md`: the textlint row says pinned 16.1.1, kernel and text plugin only, rules in-repo.

## 2. Rules (all ids are fixed)

Each rule reports through textlint on the **projected** text (J01 §5) and the engine maps every report back to the body. Defaults in brackets.

| Id | Default | What it reports | Replacement |
|---|---|---|---|
| `preferred-terms` | on, no terms | an `avoid` spelling from the author's list, whole word (Unicode letters/digits as word characters), case-insensitive unless `caseSensitive: true` | the `use` spelling, with the first letter's case copied from the match |
| `repeated-words` | on | the same word twice in a row separated only by spaces or one line break (case-insensitive), e.g. `the the`; not across punctuation (`very, very` is allowed) | the first word alone |
| `punctuation` | on, every style `null` (nothing checked until chosen) | a quote, dash or ellipsis that differs from the chosen style: `quotes: curly | straight`, `dashes: em | em-spaced | en-spaced`, `ellipsis: character | dots` | the chosen form |
| `repeated-phrases` | **off** | advisory: a phrase of `minWords` (4) to 8 words appearing again within `window` (300) words, ignoring phrases made only of common words | none; `related` lists the other occurrences |
| `long-paragraphs` | **off** | advisory: a paragraph over `maxWords` (220) words | none |
| `isolated-lines` | **off** | advisory: `minRun` (6) or more one-line paragraphs in a row, each under 12 words | none |

- Categories: `preferred-terms` -> `terminology`; `repeated-words` -> `repetition`; `punctuation` -> `punctuation`; `repeated-phrases` -> `repetition`; `long-paragraphs`, `isolated-lines` -> `rhythm`.
- `preferred-terms`, `repeated-words`, `punctuation` are severity `warning`, `advisory: false`. The other three are `info`, `advisory: true`.
- Curly quotes: a `"` or `'` is opening when it follows the start of a line, whitespace, or one of `([{—–`; otherwise closing. A `'` between two letters is an apostrophe (`’`). The quote style follows the book's dialect (J02 `dialect`) only in labels; the characters are always “ ” ‘ ’.
- `engine: 'textlint'`, `engineVersion: '16.1.1'`, `ruleId` the id above.

### Engine API (`packages/style/src/index.mjs`, pure, no I/O)

- `STYLE_RULE_IDS`, `STYLE_DEFAULTS` (the table above as data), `TEXTLINT_VERSION`.
- `async checkStyle({ sceneId, body, settings, sha256 })` -> `Finding[]`. `body` has LF line breaks. Runs every enabled rule on `projectProse(body).text` with the text plugin (`ext: '.txt'`). Each message's `range` is mapped with `toBodyRange`; a finding **with replacements** is dropped unless `isWholeRange`; one without replacements keeps its mapped range. Every finding passes `findingProblems`.
- `crossSceneRepeats(scenes, settings)` where `scenes` is `[{ sceneId, body, sha256 }]` in book order -> advisory `repeated-phrases` findings for phrases that recur in **different** scenes of the scanned scope (same `minWords`), each with `related`. Runs only when `repeated-phrases` is on. Distinct from the per-scene rule; labelled "Across scenes".

## 3. Finding contract addition (J01 §2, additive)

- Optional `related`: up to 20 `{ sceneId, from, to, text }` (body-relative ranges in that scene; `text` at most 200 characters). `findingProblems` validates it. Web copy updated.

## 4. Settings (`checks.style`, additive within `checks` v1)

```yaml
checks:
  style:
    enabled: true
    rules:
      preferred-terms: { enabled: true, terms: [ { use: grey, avoid: [gray] } ] }
      repeated-words: { enabled: true }
      punctuation: { enabled: true, quotes: curly, dashes: em, ellipsis: character }
      repeated-phrases: { enabled: false, minWords: 4, window: 300 }
      long-paragraphs: { enabled: false, maxWords: 220 }
      isolated-lines: { enabled: false, minRun: 6 }
```

- `rules` keys must be the six ids; anything else is `E102` (so an imported book naming another rule or a package is refused, and never run). Each rule map allows only its own keys. `terms`: up to 500 entries; `use` 1–64 characters; `avoid` 1–20 strings of 1–64 characters, none equal to `use`. Numbers are whole numbers: `minWords` 3–8, `window` 50–2000, `maxWords` 50–2000, `minRun` 3–30.
- `BUILTIN.checks.style` is `{ enabled: false, rules: STYLE_DEFAULTS }` (format holds its own copy of the defaults; a test compares it with `@storyforge/style`).
- Route `POST /api/books/:b/checks/style`, body `{ enabled?, rules?: { <id>: <that rule's whole map> } }`, at least one field; a given rule map replaces that rule's map. `200 { ok, style, unchanged? }`, `400`, `404`, `409` as J02 §2. Core `withStyleChecks` / `setStyleChecks` copy `withGrammarChecks` / `setGrammarChecks`. Policy class `write`.

## 5. Dismissals

- A dismissal is one Markdown file `planning/style/<slug>.md` (copying continuity exceptions, M05-J02):

```markdown
---
schema: storyforge.style-dismissal/v1
id: note_<ULID>
slug: <slug>
fingerprint: sty-<16 hex>
rule: repeated-words
scene: scene_<ULID>
text: "had had"
created: 2026-11-18
---
Optional note from the author.
```

- `styleFingerprint(finding, body)` = `sty-` + the first 16 hex of SHA-256 over `JSON.stringify([ruleId, sceneId, original, before, after])`, where `before`/`after` are up to 24 characters of body text either side of the range. It is in `packages/style` (server) and matches `FINGERPRINT_RE`. When the passage changes, the fingerprint changes and the dismissal no longer hides anything: it is listed as **stale** (a finding with that fingerprint was not seen in the last scan of its scene) and can be archived.
- The format validator knows the new schema (required fields, `FINGERPRINT_RE`, `rule` one of the six ids, `scene` a scene id; duplicates are `W307`-style warnings).
- Core: `createStyleDismissal(bookId, { fingerprint, rule, sceneId, text, note? })` and `archiveStyleDismissal(bookId, slug)` copy `createContinuityException` / `archiveContinuityException` (store batch, verify hook, `opId`, `undo`), and `listStyleDismissals(bookId)`.
- Routes: `POST /api/books/:b/checks/style/dismissals` (create), `DELETE /api/books/:b/checks/style/dismissals/:slug` (archive = restore the finding). Policy `write`.
- Grammar "Ignore" stays session-only (J02 §6).

## 6. Checking one scene (the editor)

- `POST /api/books/:b/checks/style/check`, body `{ sceneId, body }` (the editor's current text, LF): runs `checkStyle` on that text with the book's settings, removes dismissed fingerprints, answers `200 { findings }`. Reads no file except `book.md` settings and the dismissal list; writes nothing. `body` over 2,000,000 characters is `413`. Policy `read`. When style checks are off, `200 { findings: [], state: 'disabled' }`.
- The editor's grammar panel (rail section `grammar`, label becomes **Checks**) gains a **Style** group under Grammar. A small style controller (same rules as J02 §4: pause 1,500 ms, one request in flight plus one follow-up, results for an old version discarded) calls this route when style checks are on.
- Grammar and style findings are merged before `setFindings` by `mergeFindings(grammar, style)` (`apps/web/src/findings/merge.js`, pure): two findings with the same `range` and the same concern (`OWNERS` table: Harper's repeated-word, dash, quote and ellipsis rules are owned by the textlint rule of that concern) keep only the owner's finding; everything else is kept. Each group stays visible in the panel; a suppressed duplicate is not shown twice.
- Applying a style finding in the open editor is `applyFinding` (J01 §7), exactly like grammar. **Dismiss** in the panel creates a dismissal (§5) and re-checks.

## 7. Scans (selected scenes, chapter, manuscript)

- `POST /api/books/:b/checks/style/scans`, body `{ scope: { kind: 'scenes', ids: [...] } | { kind: 'chapter', act, chapter } | { kind: 'manuscript' } }` -> `202 { scanId }`. Live (not archived, not excluded) scenes only, in book order. Refused `409 SCAN_RUNNING` if this book already has a running scan; `400` for a bad scope; `200 { findings: [], state: 'disabled' }`-style refusal `409 STYLE_OFF` when style checks are off.
- The scan runs in the server process, one scene at a time, yielding (`setImmediate`) between scenes. Bounds: at most 5,000 scenes; a scene body over 2,000,000 characters is skipped with an error entry; at most 20,000 findings kept (then `truncated: true`).
- `GET /api/books/:b/checks/style/scans/:scanId` -> `{ state: 'running'|'completed'|'cancelled'|'failed', done, total, findings, errors: [{ sceneId, message }], truncated, startedAt, finishedAt, staleDismissals: [slug] }`. Findings carry `sceneId`; the response adds `chapter` labels per scene for grouping. The scan reads scene bodies through the repository (add a repository method that returns many scene bodies, using the existing internal loader).
- `POST /api/books/:b/checks/style/scans/:scanId/cancel` -> stops before the next scene; state `cancelled`, partial findings kept.
- Jobs live in memory (a reconstructible cache); a finished scan is kept until the next scan of that book or 30 minutes. Policy `read` for all three.
- When `repeated-phrases` is on and the scope has more than one scene, `crossSceneRepeats` runs after the last scene.
- Dismissed fingerprints are removed from results; dismissals whose scene was scanned and whose fingerprint was not seen are reported in `staleDismissals`.

## 8. Applying from a scan (scene not open)

- `POST /api/books/:b/scenes/:s/apply-finding`, body `{ baseSha256, from, to, original, replacement, ruleId, engine }`. Core `applyFindingEdit` copies `applyAiRewrite` (`selectRange`, `SCENE_CHANGED` when the file's sha or the text at the range differs, `spliceReplacement`, `writeWithReceipt`) with receipt `operation: 'author.edit'`, `actor: 'author'`, `workflow: 'check'`, summary `Style check: “<original>” -> “<replacement>” (<ruleId>)`. Returns `{ ok, sha256, opId, undo: { opId } }`; undo is the existing `POST /ops/:opId/restore`. Policy `write`.
- The scan's findings carry the scene's file `sha256` (the whole-file hash the route expects) as `fileSha256` alongside the finding, so the page can send `baseSha256`.
- Labels and receipts say "Style check", never "AI".

## 9. The Style checks page

- A book tab **Style checks** (`MORE_TABS`, key `style`), always visible; with style checks off it shows the off state and a link to Settings.
- Scope: whole manuscript, one chapter (select), or chosen scenes (checkbox list of scenes by chapter). **Run** starts a scan; a progress bar "12 of 48 scenes" with **Cancel**; polling every 500 ms while running.
- Results grouped **by rule** or **by chapter** (toggle, remembered in the URL `?group=`). Each card: rule label and category, chapter and scene title, the passage with the flagged text marked, the message, and buttons: **Open** (link to the scene in the editor, selecting the range via `?scene=<id>&at=<from>-<to>`), one per replacement (applies through §8, then shows **Undo**), **Dismiss** (with an optional note field). Advisory cards say "Advice" and show related occurrences as links.
- A collapsible **Dismissed** list (with **Restore**) and **No longer matching** for stale dismissals (with **Remove**).
- Settings: a **Style checks** section next to Grammar checks: on/off per book, and per rule its switch and options (the preferred-terms list editor: add a pair, remove a pair; punctuation selects; number fields for thresholds). Plain note: rules are part of StoryForge, a book's settings cannot add rules.
- All controls are buttons/links/labelled inputs; the progress is a `progressbar` with `aria-valuenow`; the count is `aria-live`.

## 10. Never

- No rule code from a book, a setting, or a path. No npm install at run time. No network.
- No text change except an author's apply (editor transaction or §8 route).
- No AI wording.

## 11. Proof

- `packages/style/test/`: each rule with meaningful fixtures (positive, negative, edge: emoji before, smart quotes, accented words, CRLF-origin LF text, emphasis and links around the word, inside a note or code = nothing), the default-off rules silent until on, `crossSceneRepeats`, `styleFingerprint` stable and changing when the passage changes, every finding passes `findingProblems` and `body.slice(range)` equals `original`, unknown rule ids in settings ignored, the no-dynamic-loading grep.
- Intentional dialogue: a fixture `“No, no, no,” she said.` and `had had` in dialogue: the `had had` finding can be dismissed and stays dismissed on the next scan; editing that sentence makes the dismissal stale.
- `packages/format/test`: `checks.style` validation (every refusal), the dismissal schema, `BUILTIN.checks.style` equals `STYLE_DEFAULTS`.
- `packages/core` / `apps/server/test`: `withStyleChecks`, dismissal create/archive/list (undo works), `applyFindingEdit` (applies, refuses changed scene, receipt is author/check, undo restores), the routes' success and refusals and policy classes, route tables.
- Scans: a chapter scan of a fixture book reports progress (`done` rises), completes, groups; a manuscript scan can be cancelled (`cancelled`, `done < total`, partial findings); a second scan while one runs is `409`; a book whose `book.md` names `textlint-rule-anything` gets `E102` and the scan runs only built-in rules.
- `apps/web/test`: `mergeFindings` ownership; the Style checks page in each state (off, idle, running with progress, completed grouped by rule and by chapter, failed); the Checks panel with both groups; settings section; house rules.
- Manual proof before the PR: the app with the sample book: enable style checks with a preferred term, run a chapter scan, apply one finding and undo it, dismiss one, see it gone on rescan; network requests are same-origin only.

## 12. Known limits

- The rules are a small curated set, English-oriented. No rule packages can be added by authors.
- Scans run in the server process one scene at a time; results are kept in memory, not saved.
- `repeated-phrases` uses simple word n-grams, not meaning.
- Saved dismissals cover style findings only; grammar ignores remain per session.
