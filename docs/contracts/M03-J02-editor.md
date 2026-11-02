# M03-J02 contract — scene editor and safe autosave

Binding: [ADR 0002](../decisions/0002-scene-editor-codemirror.md) (CodeMirror 6, text-preserving), DECISIONS 1, 6, FORMAT-v1 §1.1, §1.7, §1.8, contracts M01-J02 (body PUT with `base_sha256`, 409 conflict), M01-J04 (watcher/reconcile), M02-J01 (tokens, SaveStatus), M03-J01. Reference: `design/screens/Editor.dc.html` (centre column).

Dependencies (exact pins, published ≤ 2026-10-18): `@codemirror/state@6.7.6`, `@codemirror/view@6.43.14`, `@codemirror/commands@6.11.1`, `@codemirror/language@6.13.1`, `@codemirror/lang-markdown@6.5.2`, `@lezer/markdown@1.8.0`, `@lezer/highlight@1.2.5` (and whatever exact peers they require at those versions). Nothing else.

## 1. Editing model

- The editor buffer is the scene **body only**. Saving sends the body through the existing `PUT …/body` (front-matter bytes kept by the server). Front matter is never in the buffer.
- **Line endings** detected on load: all-LF → default; all-CRLF → `EditorState.lineSeparator.of('\r\n')` and serialise with `state.sliceDoc(0, len, state.lineBreak)`; **mixed** → editor opens **read-only** with a notice and a **"Normalise line endings…"** button (preview shows the count of lines changing; applying saves once with the majority ending).
- **Byte rule:** loading a body and serialising without edits yields the identical string; an edit changes only the edited range. A trailing newline (or its absence) is kept exactly.
- Pure editor logic lives in `apps/web/src/editor/` modules that work on `EditorState` without a DOM (testable in `node --test`): `buffer.js` (load/serialise/line endings), `commands.js`, `wordcount.js`, `save-controller.js`.

## 2. Look (reference centre column)

- Literata 18/1.7, prose measure (`72ch`), comfortable padding, scene title above (serif 28, read-only here — rename is the J01 command) and the meta line (chapter · status · POV · words).
- Decorations only (text unchanged): Markdown highlighting; `**bold**`/`*italic*` styled with dimmed markers; headings sized; `<!-- note: … -->` dimmed italic with a "note" label; other comments dimmed; `[[slug|Label]]` with the label emphasised in accent and brackets dimmed; `[@cite]` styled; `***` centred dimmed; fenced code monospace.
- Toggle **"Show Markdown marks"** (default on = dimmed; off = markers nearly hidden but still present and selectable). Persisted per user (localStorage, safe).
- Placeholder in an empty scene: "Start writing…".

## 3. Commands (insert/wrap text only — never rewrite other text)

| Command | Key | Effect |
|---|---|---|
| Bold | Ctrl/Cmd+B | wrap selection in `**…**`; toggle off if already exactly wrapped |
| Italic | Ctrl/Cmd+I | wrap in `*…*` (toggle likewise) |
| Link to Codex/thread | Ctrl/Cmd+K | opens a small picker of entries/threads/events (new read route below); inserts `[[slug]]` or `[[slug\|selected text]]` |
| Author note | Ctrl/Cmd+Alt+M | inserts `<!-- note:  -->` with caret inside, or wraps selection |
| Scene break | Ctrl/Cmd+Enter | inserts a line `***` with blank lines around |
| Undo / Redo | Ctrl/Cmd+Z / Shift+Ctrl/Cmd+Z, Ctrl+Y | CodeMirror history (session) |
| Save now | Ctrl/Cmd+S | immediate save (prevents the browser dialog) |
| Split here | from the J01 scene menu | uses the caret line as `atLine` (replaces the J01 line-number field) |

A small toolbar above the text exposes Bold, Italic, Link, Note, Scene break, "Show Markdown marks" — real `button`s with `aria-label` and `aria-pressed` where they toggle.

New read-only route: `GET /api/books/:b/objects?kinds=entry,thread,event` → `[{ id, kind, slug, title, type }]` from the index (files fallback). (Also lets the inspector show names instead of slugs — do that: POV/characters/locations/threads chips show the entry `name`/thread `title`, slug in `title` attribute.)

## 4. Word counts

`wordcount.js` implements exactly the same rule as `@storyforge/index` `countWords` (non-space runs after removing HTML comments and fenced code). The web build can't import packages, so the function is duplicated; a test runs both over every fixture body and random strings and asserts equal results. Live scene count in the footer; selection count when text is selected ("12 of 840 words").

## 5. Save state and autosave — `save-controller.js` (pure state machine)

States: `clean` → (edit) `dirty` → (debounce 1500 ms after last change, or blur, or Ctrl+S, or route change) `saving` → `saved` (new `base_sha256` from the response) | `conflict` (409) | `offline` (network error/5xx).

- `offline`: retry with backoff (2, 4, 8, 16, 30 s cap) while keeping the buffer; SaveStatus "Can't reach StoryForge — retrying"; edits continue. On success → `saved`.
- `conflict`: **stop autosaving**; banner "This scene changed outside the editor." with **Compare** (side-by-side: your text vs the file on disk, line diff highlighted), **Keep mine** (explicit save with the disk's current sha as base — overwrite after confirm), **Use the file's version** (discard buffer, reload; buffer copied to the local draft store first), **Save mine as a copy** (creates a normal new scene right after this one, titled "<title> (my version)", holding the buffer, via `createScene`). Never merge automatically.
- **Local draft store:** every dirty buffer is mirrored (debounced 500 ms) to IndexedDB (fallback localStorage; failures ignored) keyed by `bookId/sceneId`, with the base sha. Cleared after a successful save. On opening a scene, if a draft exists whose text differs from the file: banner "You have unsaved changes from <time>." with **Restore** (loads draft into buffer, state `dirty`) / **Discard** (draft moved to a "discarded drafts" list kept 7 days, not destroyed). If the file's sha differs from the draft's base, Restore goes through the conflict flow.
- Leaving with unsaved changes: in-app navigation saves first (waits up to 3 s, else keeps the draft and goes); `beforeunload` prompts only when a save is pending/failing.
- The top-bar SaveStatus (J01 shell) reflects the controller: Saved <time> · Saving… · Unsaved changes · Can't reach StoryForge — retrying · Changed outside — choose what to keep.

## 6. Raw file escape hatch

Scene menu → **Edit raw file…** opens the whole file (front matter + body) in a plain CodeMirror (no decorations) with a warning line. Save → new route `PUT /api/books/:b/scenes/:s/raw` `{ content, base_sha256 }` (write-guarded): server writes the whole file only if `validate()` afterwards shows **no new errors** for that book (else 422 with the diagnostics, nothing kept); conflicts → 409 as usual. Lets an author fix front matter by hand without leaving the app.

## 7. External edits while open

Watcher (J04) reconcile → if the open scene's file sha changes and the buffer is `clean` → reload silently (keep caret near the same line) and show a brief "Updated from disk" note; if `dirty` → go to `conflict` immediately (don't wait for the next save).

## 8. Acceptance

1. **Round trip (pure, node --test):** for every scene body in every valid fixture + the spike's torture body (`evidence/M03-J02/editor-spike-REPORT.md` describes it; recreate an equivalent synthetic torture body in the test), LF and CRLF: load → serialise = identical; one inserted word changes only that line; each command on a selection changes only the selection's line(s) as specified.
2. **End to end (server + core):** edit a scene body via the PUT route the way the editor does, reopen → front matter bytes identical, author comments, Unicode, `[[links]]`, `[@cite]`, `***` and every untouched line identical; `validate()` clean.
3. **Forced save interruption is recoverable:** (a) server process killed mid-save via the store fault point (child process) → on restart the file is old or new (J02 store guarantee) and the client's draft still holds the text; restoring it and saving yields the edited body. (b) Network failure → controller goes `offline`, retries, succeeds after the server returns (fake fetch + fake timers). (c) Browser closed with unsaved text → draft restored on reopen (draft store logic with a fake storage).
4. **Conflicts:** external edit while dirty → `conflict`; each of the four choices does exactly what §5 says; no automatic merge; no text lost (buffer always ends up in the file, the draft store, or a new scene).
5. **Word count:** web `wordcount` == index `countWords` on all fixture bodies + 1000 generated strings.
6. **Raw edit route:** valid change saved; change introducing an error → 422 with diagnostics and file unchanged; 409 on stale base; 403 without guard.
7. **Objects route** returns names; inspector shows names (render test).
8. **Manual (coordinator, real browser):** type, bold/italic/link/note via keys and toolbar, undo/redo, autosave indicator, external edit while clean (reload) and dirty (conflict + Compare), CRLF scene editing keeps CRLF on disk, mixed-endings scene opens read-only.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
