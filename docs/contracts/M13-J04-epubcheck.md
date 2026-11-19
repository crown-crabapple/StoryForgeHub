# M13-J04 contract — EPUBCheck validation (editing and publishing, milestone 3)

Binding: M13-J01 §3–§4 (`storyforge.validation/v1`, `outcomeOf`, `isCleanValidation`, capability states), M05-J03 (export: `exportBook`, `renderEpub`, `verifyExport`), the J03 scan job pattern (`apps/server/src/style-scans.mjs`), `packages/store` single-writer rule.

J04 lets an author check an exported EPUB with EPUBCheck, locally. It never changes the manuscript. A passing check means the file conforms to the EPUB specification; it does not mean the book is well edited, fully accessible or accepted by a retailer, and the app says so.

## 1. EPUBCheck and Java are the author's own installs

- StoryForge does **not** bundle or download EPUBCheck or Java. EPUBCheck's distribution includes components under licences outside StoryForge's production allow-list (Saxon-HE MPL-2.0, ICU4J Unicode-3.0, W3C/SAX) and is 33 MB. The author installs Java (8 or newer) and EPUBCheck themselves and tells StoryForge where they are.
- Tested version: **EPUBCheck 5.4.0** (release zip SHA-256 `33350c61038e71dfb3d45a76aed04bf5481e6d5500cb780f6e98db8bbd15a28c`). Another 5.x version runs with a note "tested with 5.4.0"; any other major version is `unavailable` ("StoryForge supports EPUBCheck 5").
- Per-machine settings in the user config file `tools.json` (`packages/store` `readUserConfig`/`writeUserConfig`): `{ "java": <absolute path to java or java.exe> | null, "epubcheckJar": <absolute path to epubcheck.jar> | null }`.
- Discovery order: `tools.json`, then the environment variables `STORYFORGE_JAVA` and `STORYFORGE_EPUBCHECK_JAR`, then (Java only) `JAVA_HOME/bin/java[.exe]`, then `java` on `PATH`. EPUBCheck has no automatic search beyond these.
- Routes (policy class `admin`: in shared mode only the owner):
  - `GET /api/tools` -> `{ java, epubcheckJar }` as saved (nulls when unset).
  - `PUT /api/tools` `{ java?, epubcheckJar? }`: each an absolute path string or `null`. `java`'s file name must be `java` or `java.exe`; `epubcheckJar` must end in `.jar`; the file must exist (checked through a read-only `stat` in the allowed read module). `400` otherwise.
  - `GET /api/tools/status` -> `{ java: { state, path, version, reason }, epubcheck: { state, path, version, reason } }`, `state` one of `ready`, `unavailable`. It runs `java -version` and `java -jar <jar> --version` (each with a 15 s timeout). It reports, never installs.

## 2. Running EPUBCheck safely

- `packages/store`: `withScratchDir(prefix, async (dir) => …)` creates a private folder under the OS temp folder, gives `dir` with `write(name, bytes)` and `read(name, { maxBytes })` and `path(name)` (plain file names only), and removes the folder when the callback settles, including on throw and cancel. The existing synchronous `withScratchFile` is unchanged.
- `packages/export/src/epubcheck.mjs`:
  - `detectJava({ javaPath, env, spawn })` -> `{ state, path, version, reason }`: parses `java -version` stderr (`/version "(\d+)(?:\.(\d+))?/`, `1.8` -> 8), requires 8 or newer.
  - `detectEpubCheck({ java, jarPath, spawn })` -> `{ state, path, version, reason }` from `--version` (`EPUBCheck v(\d+\.\d+\.\d+)`).
  - `runEpubCheck({ java, jar, epubBytes, name, signal, timeoutMs = 120000, spawn })` -> `{ ok: true, report, stdout, stderr, exitCode, elapsedMs } | { ok: false, kind: 'unavailable'|'timeout'|'cancelled'|'crashed'|'bad-output', detail }`. It writes the EPUB into a scratch dir, runs `java -jar <jar> <file> --json <dir>/report.json -q` with an **argument array** (`spawn(java, [...], { cwd: dir, windowsHide: true, env: <PATH, SystemRoot, TEMP/TMP, JAVA_HOME only>, stdio: ['ignore','pipe','pipe'] })`), never a shell, never a title or path in a command string. stdout/stderr are kept to the first 256 KB each; the report may be at most 20 MB. On timeout or `signal` abort it kills the process (and its tree on Windows via the spawned process only) and returns `timeout`/`cancelled`; the scratch folder is always removed. `ENOENT` -> `unavailable`. Exit code is not trusted to tell validation failure from a crash: the JSON report decides; missing or unparsable JSON -> `bad-output`.
  - `toValidation({ run, artifact, sourceMap })` -> a `storyforge.validation/v1` result (J01 §3): `validator: 'epubcheck'`, `validatorVersion` from `checker.checkerVersion`, `checkedAt`, `artifact { kind: 'epub', sha256, name }`, `messages` from EPUBCheck `messages[]` (`ID` -> `code`, severity `FATAL|ERROR|WARNING|INFO|USAGE` -> lower case, `message`, `locations[0]` -> `{ path, line, column }` with `-1` -> `null`, extra locations kept in a `more` count), outcome by `outcomeOf`. Run failures map to `unavailable` (with the reason) or `error` (process failure: timeout, crash, bad output) or `cancelled`; never to a pass.
  - `explainEpubCheck(code)` -> a short plain-language explanation for common codes (at least `RSC-001`, `RSC-005`, `RSC-007`, `RSC-008`, `RSC-012`, `OPF-*` group, `NAV-*` group, `PKG-*` group, `HTM-*` group, `CSS-*` group), else `null` (the UI then shows EPUBCheck's own message). The original code and message are always shown too.
- Lint: `child_process` stays allowed only where needed: `packages/export/src/epubcheck.mjs`. Add a block banning `child_process` in the rest of `packages/export/src` and in `apps/server/src` except the files that already spawn (keep existing ones working; list them).

## 3. Export source map

- `epubSourceMap(manuscript)` in `packages/export/src/epub.mjs`, computed from the same `epubChapters` data as `renderEpub` (the EPUB bytes do not change): `{ '<path inside EPUB>': { chapterId, chapterLabel, scenes: [{ sceneId, firstLine, lastLine }] } }` for every chapter XHTML file. Lines are 1-based lines of that XHTML file as written.
- A message whose location path is a chapter file and whose line falls in one scene's lines gets that `sceneId`; otherwise it gets the chapter's `chapterId` (when the chapter has one) and `sceneId: null`. Other files (OPF, nav, CSS) get neither. No guessed line matches.

## 4. Validation jobs

- `POST /api/books/:b/export/validations`, body = the EPUB export options the GET export route takes (`sceneTitles`, `excludeStatuses`, `include` (`manuscript` only; `summary`/`evidence` are `400` for validation), `scenes`), -> `202 { validationId }`. It builds the EPUB once with `exportBook(..., 'epub')` (an immutable snapshot of the manuscript at that moment, after `verifyExport`), hashes it, and checks those exact bytes. One running validation per book (`409 VALIDATION_RUNNING`).
- `GET /api/books/:b/export/validations/:id` -> `{ state: 'running'|'completed'|'cancelled'|'failed', result: <storyforge.validation/v1> | null, explanations: { <code>: text }, sources: { <sceneId>: { title, chapterLabel } }, filename }`.
- `POST /api/books/:b/export/validations/:id/cancel` -> stops and removes temporary files; result outcome `cancelled`.
- `GET /api/books/:b/export/validations/:id/file` -> the exact EPUB bytes that were checked (download, same headers as export), available whatever the outcome.
- `GET /api/books/:b/export/validations/:id/report` -> a downloadable report: `report.json` with the validation result, the explanations and EPUBCheck's raw `checker` block. A later export needs its own validation; results are never reused for different bytes.
- Jobs live in memory (copy the J03 scan manager: injectable clock, kept until the next validation of that book or 30 minutes). Policy class `read` for status/file/report, `write` for start/cancel (it runs a process on the server). Never a share link.
- When Java or EPUBCheck is missing the job completes immediately with outcome `unavailable` and the reason; the EPUB file is still downloadable.

## 5. Author experience (Export dialog)

- With EPUB selected the dialog shows **Validate with EPUBCheck**, a checkbox remembered per book as the existing `checks.epub.validate` preference (route `POST /api/books/:b/checks/epub { validate }`, core `withEpubChecks`/`setEpubChecks` copying the J03 pattern, policy `write`).
- Export with the box unticked: unchanged (download as today).
- Export with it ticked: the dialog stays open, shows "Checking the EPUB…" with **Cancel**, then the outcome in words: **Passed**, **Passed with warnings**, **Failed**, **Not checked** (cancelled), **Validator unavailable** (with the reason and "Set it up in Settings"), **Check could not run** (process error, with detail). Never shown as passed unless the outcome is `passed` or `passed-with-warnings`.
- Messages listed by severity: the plain explanation (when known), the original code and EPUBCheck message, the location (file, line, column), and a link to the scene or chapter when mapped (§3). **Download EPUB** (always) and **Download report** buttons. A failed check never hides the file.
- The limits sentence is always visible under the outcome: "EPUBCheck checks the file against the EPUB standard. It does not check editing, full accessibility or whether a store will accept the book."
- **Settings > EPUB validation (optional)**: the two path fields with Save, a **Check setup** button showing `GET /api/tools/status`, and plain instructions: install Java 8 or newer and EPUBCheck 5 (tested 5.4.0) yourself; StoryForge never downloads them. No web addresses in the app (the no-network test forbids them); the docs give the download page.

## 6. CI

- No CI job installs Java or EPUBCheck (dropped by the maintainer, 2026-11-18). `.github/workflows/ci.yml` is unchanged.
- `packages/export/test/epubcheck-real.test.mjs` runs the real EPUBCheck when `STORYFORGE_EPUBCHECK_JAR` (and Java) are available: the sample book's export **passes**; a copy with the nav document removed and a copy referencing a missing image **fail** with `RSC-001`/`RSC-007` mapped to the right chapter (and scene when the line is inside one); a non-zip file fails with a `PKG-*` fatal; cancellation removes the scratch folder. When they are not available the tests skip with a notice, in CI too.
- Unit tests with a fake `spawn` cover every `runEpubCheck` failure kind, output caps, the argument array (no shell), env filtering, and `toValidation` mapping.

## 7. Never

- No download or install of Java or EPUBCheck by StoryForge. No network.
- No shell command strings. No book title or user text in process arguments (only the scratch file name `book.epub` and fixed flags).
- No manuscript change. No reuse of a result for different bytes.
- No "passed" for `unavailable`, `error` or `cancelled`.

## 8. Proof

- Unit and real tests above; `packages/store` tests for `withScratchDir` (cleanup on success, throw, abort; refuses folder names).
- `apps/server/test`: tools routes (admin only in shared mode, path validation), status with a fake detector, validation job lifecycle with a fake runner (completed, failed, unavailable, cancelled, `409` second run), file and report downloads return the exact checked bytes, `checks/epub` route; route tables and policy.
- `apps/web/test`: Export dialog with the checkbox remembered, each outcome state, messages with explanations and source links, downloads always offered, limits sentence; Settings section; house rules; no URL in the built app.
- Manual proof before the PR: with Java and EPUBCheck 5.4.0 set in Settings, export the sample book with validation: Passed; cancel a run; point the jar setting at nothing: Validator unavailable with the file still downloadable.

## 9. Known limits

- The author installs Java and EPUBCheck; StoryForge only finds and runs them.
- A cold EPUBCheck run takes a few seconds.
- Mapping goes to the scene only when the reported line is inside one scene in the chapter file; otherwise to the chapter.
- EPUB conformance is not editorial quality, full accessibility or retailer acceptance.
