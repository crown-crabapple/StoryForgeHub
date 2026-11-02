# M06-J03 contract — recovery, accessibility and packaging

Binding: DECISIONS 1, 5, 6, 8; contracts M01-J02 (store, recovery), M01-J03/J04 (index, reconcile), M02-J01 (visual system, contrast), M03 (editor, reorder), M05-J03 (backup/restore, export). Design: `design/README.md`.

## 1. Real-sized recovery

- **Generator:** `packages/format/test/build-large.mjs` (or a `tools/` script) builds a deterministic synthetic book, no user text: 3 acts, 60 chapters, 320 scenes (~130 000 words of generated prose from a fixed word list and seed), 220 Codex entries with fields/relations/links, 40 threads, 120 timeline events with `state`, 30 research notes, 10 continuity exceptions, a few suggestions and receipts. Generated into a temp dir at test time (not committed), validates clean.
- **Tests on it** (with time budgets, generous on CI: assert and report times):
  1. Delete `.storyforge/` → restart → index rebuilt; every API answer (book tree, scenes, Codex, threads, timeline, notes, continuity, receipts verify) equals the answers before deletion. Rebuild time recorded (budget 30 s).
  2. Backup → restore into an empty folder → byte-identical, validates, opens with no index, rebuild equals original answers.
  3. Interrupted writes: for a body save, a move with renumbering and a suggestion accept, inject each store fault point (`__faults`) → after restart/recovery the book is either fully before or fully after (bytes), never mixed; `validate()` clean.
  4. External edits: 50 scene files rewritten outside the app within 2 s → reconciled within 10 s; the index equals a full rebuild.
  5. Invalid files: corrupt 5 files (bad YAML, duplicate id, broken link, BOM, truncated) → the app stays up, lists exactly those problems, every other scene opens and saves; fixing the files clears them.
- Report times in RESULT; no test may sleep blindly (poll with deadlines).

## 2. Accessibility audit and fixes (core views)

Views: Library, New book, Editor (rail, focus mode), Board, Outline, Codex, Timeline, Notes, Continuity, Suggestions review, Export/Backup dialogs, Settings.

- **Keyboard:** every action reachable and operable by keyboard; logical tab order; no traps (dialogs trap focus inside and return it on close; Escape closes); visible skip link to main content; the reorder keyboard path (Alt+↑/↓ from M03/M04) works in rail, Board and Timeline.
- **Focus visible:** every focusable element shows a focus ring meeting 3:1 against its background (`:focus-visible`), never removed.
- **Contrast:** text ≥ 4.5:1 (≥ 3:1 for large text and UI parts) — extend the existing `contrast.test.mjs` to every color pair used by the new M05 styles.
- **Responsive:** usable at 1280×800 and 1024×768; rail and sidebars collapse below 900 px without horizontal page scroll; dialogs fit 768 px wide.
- **Reduced motion:** `prefers-reduced-motion: reduce` disables transitions/animations (one CSS block + a test that it exists and covers the animated selectors).
- **Screen-reader labels:** every button/link has an accessible name (no icon-only without `aria-label`), landmarks (`header`, `nav`, `main`, `aside`), headings in order, live region for save status and toasts, form fields labelled, errors linked with `aria-describedby`; duplicate aria-labels between rail and board menus (M04 follow-up) fixed.
- **Tests:** a render-level audit test (no new dependencies) that renders each core view (existing SSR harness) and asserts: no button/link without a name, no `img` without `alt`, every input has a label, no duplicate `id`, no positive `tabindex`, landmarks present. Plus the contrast and reduced-motion tests.
- **Manual (coordinator):** keyboard-only walk in a real browser: create a book → write a scene → reorder a scene (keyboard) → export Markdown; screenshots of focus rings.

## 3. Packaging — local install and run

- `npm start` stays. Add launchers: `StoryForge.cmd` (Windows) and `storyforge.sh` (macOS/Linux) at the repo root that: check Node ≥ 22 (plain message if missing), run `npm ci` and build on first run (or when `package-lock.json` changed), then start the server and **open the browser** (new `--open` flag in `main.mjs`, uses the OS opener; no network).
- **Library choice:** without `--library`, use the last library from the user config (`recent.json`, already written by the host), else show the Library screen's "Open folder…" first-run path — never fail with "no library given" as in M04 owner testing; the CLI message names the flag and the env var when it must fail.
- `node apps/server/src/main.mjs --help` lists every command and flag (serve, rebuild, repair, continuity, export, backup, restore, receipts verify, import-legacy).
- **Docs:** `docs/install.md` — requirements, first run, where data lives (each book folder = all author data; `.storyforge/` per book = disposable cache; user config dir `%APPDATA%\StoryForge` / `~/.config/storyforge` = recent libraries, AI settings incl. any saved key; nothing else), how to back up, how to remove StoryForge (delete the app folder; optionally the config dir; book folders are untouched), and that no data leaves the machine unless an AI provider is configured.

## 4. Acceptance

1. Recovery tests 1–5 pass on the large book; times recorded.
2. Restore a complete project from a Markdown backup alone (tests 2) — and the coordinator does it by hand from the UI.
3. Accessibility tests pass; manual keyboard-only create/write/reorder/export walk completed with screenshots.
4. Launchers: on Windows, `StoryForge.cmd` from a clean clone installs, builds, starts and opens the browser on the last library (coordinator runs it); `--help` complete; `docs/install.md` written.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone (the large-book tests may be in a separate `npm run test:large` script if they exceed 3 minutes; then they're run for the RESULT and the gate).
