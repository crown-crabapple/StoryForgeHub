# M08-J04 contract — responsive, accessible, offline and performance hardening

Binding: DECISIONS 1, 5, 6, 8; M06-J03 a11y audit, contrast tests, 800 px layouts, large synthetic book (`apps/server/test/large-helpers.mjs`); M07-J03b stale-save path (409 STALE → suggestion); M07-J04 themes, typography and layouts; the read-speed cache (`b9bff1e`).

## 1. Target widths and devices

| Class | Width | What must work |
|---|---|---|
| Desktop | ≥ 1200 px | everything (reference layout) |
| Tablet | 768–1199 px | library, book, editor with one side panel at a time (rail or inspector as an overlay drawer), Codex, Outline, Board, Insights, Settings |
| Phone | 360–767 px | library, open a book, read and write a scene, scene list, Codex read and edit, comments, suggestions review, export/backup; planning views (Board, Matrix, Timeline) show a readable list fallback instead of the 2D canvas |

**Layout rules:**
- No horizontal page scroll at 360 px.
- Touch targets are at least 44 px on phone.
- Side panels become off-canvas drawers with a visible toggle (`aria-expanded`, focus trap, Escape closes, focus returns).
- Focus mode and full screen work at every class.
- Split editor and pinned-reference panel (M07-J04 pinned rail) collapse to a tab switch below 900 px.

**Typography:** the M07-J04 typography settings apply at every width; the minimum font size is 16 px on phone for inputs (no iOS zoom). Reduced motion is honoured everywhere (existing test extended to drawers).

## 2. Keyboard and screen-reader checks

**Render-level audit (`a11y-audit.test.mjs`):**
- Extended to each core view at 1280, 900, 600 and 360 px. Width is simulated by the layout props/classes the app uses, plus a CSS check that the media queries exist for each rule set.
- The audit covers names, roles, landmarks, one `h1`, labelled controls and no positive tabindex.

**Keyboard walks:**
- Two flows at tablet and phone classes, drawers included: create book → write → add scene → reorder → export; and open Codex entry → edit → save.

**Screen-reader semantics:**
- Live regions for save state, toasts, the timer and drawer open/close are present and polite.
- The editor has `aria-label` and `aria-describedby` for its status.
- Checked in render tests. A manual screen-reader pass is listed for the owner (NVDA steps in RESULT).

## 3. Offline editing in server mode (shared mode)

The browser keeps **at most one pending buffer per scene** in IndexedDB (an extension of the existing draft-store). It is a queue of unsent saves, never a second authoritative copy:
- Each entry is `{ bookId, sceneId, baseSha256, text, savedAt }`.
- Each entry is deleted as soon as the server confirms the save, or turns it into a stale-save suggestion.
- The UI shows "Offline: 2 scenes waiting to save" while entries exist.

**Reconnect:**
- The queue drains in order using the normal save route with the stored base sha.
- When the base still matches, the save happens.
- When it does not match, the M07-J03b path applies: `409 STALE`, the buffer becomes a suggestion, and the compare view opens. Nothing is lost.
- A reload while offline restores the buffer into the editor with a banner: "Not saved yet — will save when back online".

**Never:**
- the queue is never read by the server;
- it is never exported;
- it is never used as content when the server has newer text.

Personal mode keeps the existing local draft-store behaviour.

## 4. Performance benchmarks — `npm run bench`

**Fixtures (synthetic, generated, never committed as user text):**

| Name | Size |
|---|---|
| `S` | the salt-orchard sample |
| `M` | 1 book, 60 chapters, 320 scenes, about 130k words (the M06-J03 large book) |
| `L` | 3 books of `M` in one series with 200 shared entries |
| `XL` | 1 book, 1,500 scenes, about 600k words |

**Measured, each median of 5:**
- cold and warm open of the library and of a book;
- open a scene, warm;
- search across the book;
- full index rebuild;
- incremental reconcile after 1 and after 50 outside edits;
- Markdown, DOCX, EPUB and PDF export;
- backup and restore;
- `validate()` of the library.

**Output:**
- `bench/results/<date>-<machine-hash>.json`, with node version, OS, CPU model and RAM;
- a Markdown table appended to `docs/performance.md` with the declared limits (for example "Comfortable up to M; XL works, rebuild about N s").

**Thresholds** become `*.large.mjs` assertions only where stable on this machine. Scene open warm under 300 ms is already asserted. Everything else is recorded, not asserted.

## 5. Acceptance

1. Core flows pass the keyboard and render-level screen-reader checks at 1280, 900, 600 and 360 px. There is no horizontal scroll at 360 px: a CSS rule test, plus a coordinator browser check at 375 and 768 using the browser pane's mobile and tablet presets.
2. Offline edits resolve safely:
   - a test with a fake network shows queue → reconnect → saved;
   - queue → reconnect after another user saved → suggestion plus compare, nothing lost;
   - reload while offline → buffer restored;
   - the queue is emptied once confirmed.
3. Performance results for S, M, L and XL are recorded in `docs/performance.md` from `npm run bench`, with the fixture generator committed so anyone can reproduce them.
4. `npm ci && npm run build && npm run lint && npm test` pass on a clean clone. `npm run bench` runs from a clean clone.
