# M13-J02 contract — Harper grammar checks (editing and publishing, milestone 1)

Binding: M13-J01 (finding contract, prose projection, capability states, `checks` preference, `finding-marks.js`); M03-J02 (editor buffer and save); M07-J04 (preferences, inspector sections, shortcut registry); M12 §1 (the `ai-level` write path this copies).

J02 checks the open scene's English grammar and spelling with Harper, locally, in a Web Worker. It is off until the author turns it on for a book. A correction is an ordinary author edit (J01 §7). Nothing is sent anywhere.

## 1. Dependency

- `harper.js` **3.2.0** exactly, a production dependency of `apps/web` (Apache-2.0; its one dependency `fflate` is MIT). Added with `npm install -w apps/web harper.js@3.2.0 --save-exact`; `package-lock.json` changes only for it.
- The WASM ships in the web build as a same-origin asset: the worker imports `slimBinary` from `harper.js/slimBinary`, whose `new URL(..., import.meta.url)` Vite emits as a hashed file. Not the `*Inlined` builds (27 MB of JS).
- `HARPER_VERSION = '3.2.0'` is a constant in `apps/web/src/grammar/harper-adapter.js`; a test checks it equals the installed `harper.js` version in `apps/web/package.json`.
- `apps/server/src/static.mjs` serves `.wasm` as `application/wasm` (needed by `WebAssembly.instantiateStreaming`).
- The checker is loaded only when grammar checks are on for the open book: the worker is created with `new Worker(new URL('./harper.worker.js', import.meta.url), { type: 'module' })` on first use, never at app start.
- `docs/editing-publishing.md`: the Harper row says pinned 3.2.0, the WASM size (about 20 MB) and that it loads only when enabled.

## 2. Settings (extends `checks` v1, additively)

`preferences.checks.grammar` in `book.md` gains three optional keys. `checks.version` stays `1`.

```yaml
checks:
  grammar:
    enabled: true
    language: en
    dialect: american        # american | british | australian | canadian | indian
    words: [Mara, Kestrel]   # the book dictionary
    rules: { SpellCheck: false }   # Harper rule name -> false to turn it off
```

- `BUILTIN.checks.grammar` becomes `{ enabled: false, language: 'en', dialect: 'american', words: [], rules: {} }`.
- `words`: a list of 0 to 5,000 strings, each 1 to 64 characters, no whitespace at either end, no line break. Duplicates are a problem.
- `rules`: a map of rule name (`/^[A-Za-z][A-Za-z0-9]{0,63}$/`) to `false`. `true` is refused (absent means default); anything else is `E102`.
- Wrong values are `E102` at the exact location, as in J01.
- Personal (cross-book) dictionaries are not in J02 (§9).

### Write route

`POST /api/books/:b/checks/grammar`, body (every field optional, at least one):

```json
{ "enabled": true, "dialect": "british", "addWords": ["Mara"], "removeWords": ["Kestral"], "disableRules": ["SpellCheck"], "enableRules": ["LongSentences"] }
```

- `200 { ok: true, grammar }` with the book's resulting `checks.grammar` map. `unchanged: true` when nothing changed. `400 BAD_ARGS` for a bad field (the message names it), `404` for an unknown book, `409 CONFLICT` when `book.md` changed underneath.
- `addWords` adds words not already present, in order, after the existing ones; `removeWords` removes exact matches. `enableRules` deletes the rule's entry. A word or rule name that fails §2 is `400`.
- Policy class `write` (`apps/server/src/policy.mjs`): a writer may add a name to the book dictionary. The route is listed wherever the route-table test lists routes.
- Core: `withGrammarChecks(bytes, patch)` in `packages/core/src/fs-writes.mjs`, modelled on `withAiLevel`: edits only the front matter's `preferences.checks.grammar` through the YAML Document (comments kept), keeps CRLF if the head has CRLF, copies the body bytes unchanged, refuses a non-map `preferences`, `checks` or `grammar` with `BAD_ARGS`. `setGrammarChecks(bookId, patch)` writes through `store.write(rel, buf, { baseSha256 })` and reconciles like `setAiLevel`. Added to the repository typedef.
- Reads: the existing `GET /api/preferences?book=<id>` returns the effective `checks.grammar`.

## 3. Prose projection additions (J01 §5)

`projectProse` also handles:

- `[[target]]` Codex links project as one placeholder `X` (readers see a name there); in `[[target|label]]` everything but `label` is left out, with no placeholder.
- Citations `[@key]` project as one placeholder `X`.
- Placeholders are flagged in `projection.placeholders`, and `isWholeRange` is false over one, so no finding covers or sits across them.

The web copy is updated with it (the copy test enforces this).

## 4. The worker and the adapter

- `apps/web/src/grammar/harper.worker.js`: owns one `LocalLinter` (`{ binary: slimBinary, dialect }`). Messages in: `{ type: 'configure', dialect, words, rules }`, `{ type: 'check', requestId, sceneId, body }`, `{ type: 'dispose' }`. Messages out: `{ type: 'ready' }`, `{ type: 'result', requestId, findings }`, `{ type: 'unsupported', requestId, reason }`, `{ type: 'error', requestId, message }`. It never calls `fetch` itself; the only request is Harper loading the WASM asset from the app's own origin.
- `check`: projects the body (`projectProse`), and if the projected text is at least 200 characters and `isLikelyEnglish` is false, answers `unsupported` ("This scene does not look like English. Grammar checks support English only."). Otherwise runs `organizedLints(text, { language: 'plaintext' })` (the projection already removed Markdown), computes `source.sha256` with `crypto.subtle` over the LF body, and converts with the adapter. Every Harper `Lint`/`Suggestion` is freed after conversion.
- `apps/web/src/grammar/harper-adapter.js` (pure, no Harper import, Node-testable): `toFindings({ sceneId, body, projection, sha256, organized })` where `organized` is `Record<ruleName, Array<{ start, end, kind, message, problem, suggestions: Array<{ kind: 'Replace'|'Remove'|'InsertAfter', text }> }>>` (plain data the worker extracts). For each lint:
  - range: `toBodyRange(projection, start, end)`; dropped if null or if `body.slice(from, to)` is empty. Dropped too unless `isWholeRange(projection, start, end)` (added to `prose-map.mjs` in J02): a lint across left-out text, such as the double space where inline code was, would delete that text if applied.
  - `engine: 'harper'`, `engineVersion: HARPER_VERSION`, `ruleId`: the rule name.
  - category from Harper's kind: `Spelling`, `Typo` -> `spelling`; `Punctuation`, `Formatting`, `Capitalization` -> `punctuation`; `Style`, `Readability`, `Redundancy`, `Enhancement`, `WordChoice`, `Repetition`, `Regionalism` -> `style`; everything else -> `grammar`.
  - `style` findings are `advisory: true`, severity `info`; others `advisory: false`, severity `warning`.
  - replacements: `Replace` -> its text; `Remove` -> `''`; `InsertAfter` -> `original + text`. Duplicates removed, at most 8.
  - `id` from `findingId`; every finding passes `findingProblems`.
- `apps/web/src/grammar/grammar-controller.js` (pure, Node-testable; takes an injected `createWorker()` and `setTimeout`/`clearTimeout`): one per open scene editor.
  - States are J01 capability states. `disabled` when the book has grammar off; `ready` once configured; `running` while a check is in flight; `completed`, `failed`, `cancelled`, `unavailable` (with `reason`) as J01 §4. `subscribe(fn)` gets `{ state, reason, findings, checkedAt }`.
  - `docChanged(version, body)`: remembers the latest snapshot and (re)starts a 1,200 ms pause timer. When it fires, sends one `check` if none is in flight; if one is in flight, marks a follow-up so exactly one more check runs after it with the newest snapshot (coalescing).
  - `checkNow()`: the explicit Check scene action; no pause.
  - A result is used only if its snapshot version equals the editor's current version; otherwise it is discarded and a fresh check is scheduled. Used results go to the editor through `setFindings` (which already drops any finding whose text no longer matches).
  - Ignored occurrences (§6) are filtered out before `setFindings`.
  - `configure(grammarSettings)` re-sends dictionary, rules and dialect and re-checks; `dispose()` terminates the worker.
  - Worker errors and a worker that cannot start give `failed` (with the message), never "no problems".

## 5. Author experience

- **Settings.** A "Grammar checks" section in Settings next to the AI level (`apps/web/src/ai/SettingsView.jsx`), per book: an on/off switch labelled "Check grammar and spelling (English)", a dialect select, the book dictionary as a list with a Remove button per word, and the turned-off rules with a Turn back on button each. It says checks run on this computer and nothing is sent anywhere, and that the checker is a download-free part of StoryForge of about 20 MB loaded only when on.
- **Underlines.** In the scene editor, J01's `finding-marks` draws them.
- **Panel.** A new right-rail section `grammar` ("Grammar"), in the Review tab before `continuity`. Added to `INSPECTOR_SECTIONS` in both `packages/format/src/preferences.mjs` and `apps/web/src/prefs/appearance.js` (the parity test enforces both). Shows:
  - the state in words: off (with a link to Settings), loading the checker, checking, `N` suggestions, no suggestions, the unavailable reason, or the failure. "No suggestions" appears only in `completed`.
  - a **Check scene** button (also the command below).
  - each finding: its category, the flagged text (a button that selects it in the editor), the message, then buttons: one per replacement ("Replace with ‘x’", "Delete" for `''`), **Ignore**, **Add to dictionary** (spelling only), **Turn off this rule**.
  - a Codex hint: when a spelling finding's text equals a Codex entry's name or alias (`GET /api/books/:b/codex/entries`, exact, case-sensitive), the finding is labelled "Codex name" and **Add to dictionary** comes first. Codex names are never added silently.
  - The list is a list of `<section>`/`<li>` with buttons only; every control is reachable by keyboard and has an accessible name; the count is announced in an `aria-live="polite"` region.
- **Apply** uses `applyFinding(view, id, index)` (J01 §7). A `STALE` result shows "The text changed; checking again" and triggers `checkNow()`. Undo is Mod+Z as for any edit.
- **Add to dictionary / Turn off this rule** call the §2 route, then `configure()`; the finding disappears after the re-check.
- **Command** `editor.checkScene`, label "Check grammar now", scope `editor`, default binding `Mod+Alt+G`, files listing every file that handles it. It does nothing visible when checks are off except the panel's off state.
- **Editor bridge** (`apps/web/src/editor/bridge.jsx`) gains what the panel needs: the controller's snapshot and subscription, `applyFinding(id, index)`, `selectBodyRange(from, to)`, `checkNow()`, `ignoreFinding(id)`.

## 6. Ignore this occurrence

- Ignoring is per scene for the editing session: the key is `ruleId`, `original` and up to 24 characters of body text either side of the range. A later check that yields a finding with the same key hides it. Closing the scene forgets it.
- Saved, reviewed dismissals that survive reopening are J03's (they need passage-change detection).

## 7. Never

- No `fetch`, `XMLHttpRequest`, `WebSocket` or remote URL in `apps/web/src/grammar/` (the J01 network test covers this folder too).
- No checking when grammar is off, including the worker not being created.
- No change to the text except through `applyFinding`.
- No Harper code in `apps/server` or `packages/*`.

## 8. Proof

- `packages/format/test/checks-preferences.test.mjs`: `dialect`, `words`, `rules` valid and each refusal; defaults.
- `packages/format/test/prose-map.test.mjs`: `[[Mara]]` dropped, `[[Mara|she]]` keeps `she`, `[@key]` dropped, offsets exact.
- `packages/core` or `apps/server/test`: `withGrammarChecks` keeps comments, CRLF and body bytes, refuses non-maps, adds/removes words and rules; `setGrammarChecks` writes and reports `unchanged`; the route's 200, 400, 404 and policy class; a book reopened (fresh repository) still has its words.
- `apps/server/test`: `.wasm` is served as `application/wasm`.
- `apps/web/test/harper-adapter.test.mjs`: kinds to categories, replacement kinds, dedupe and cap, ranges exact after emoji, smart quotes, accented names and CRLF-origin text, and inside `*emphasis*` and link labels; every finding passes `findingProblems`; `HARPER_VERSION` equals the dependency version.
- `apps/web/test/grammar-controller.test.mjs` with a fake worker and fake timers: pause then one check; rapid edits coalesce to one follow-up; a result for an old version is discarded and re-checked; ignore keys hide repeats; worker error gives `failed`; unsupported gives `unavailable` with reason; disabled creates no worker.
- `apps/web/test/harper-real.test.mjs`: runs the real `LocalLinter` from `harper.js` in Node (load the WASM as a `data:application/wasm;base64,` URL read from `node_modules`, so it works on Windows), projects real Markdown scenes, runs the adapter, and asserts: "an test" gives a finding at exactly `an` with replacement `a`; a misspelling after an emoji, smart quotes and "Zoë" is placed exactly; a misspelling inside `<!-- note: ... -->` or a code block gives nothing; applying the replacement to the body yields the expected sentence. Allowed to take a few seconds.
- `apps/web/test/finding-marks.test.mjs` or a new test: a correction applied after an unrelated edit elsewhere still changes exactly its word; after an edit inside its word it is refused; undo restores.
- House rules: registry, onClick, responsive CSS and copy tests pass with the new command, panel and section.
- Manual proof before the PR: the app in a browser with a sample book, grammar on, a typo underlined, corrected, undone; DevTools network shows only same-origin requests.

## 9. Known limits

- English only. Other languages show the unavailable state.
- Personal dictionaries across books are not in J02.
- Ignored occurrences last for the editing session only.
- About 20 MB is loaded the first time checks run in a session.
- Harper's own rule set and wording are used as they are.
