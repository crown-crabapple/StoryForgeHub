# M02-J02 contract — library with cover cards, series, search and filters

Binding: DECISIONS 8 (cover-card library — overrides the Home reference's table), FORMAT-v1 §3 (library, series, book; `cover`, `cover_color`), [M02-J01](M02-J01-visual-system.md) tokens and shell. Design source: `E:\StoryForgeHub\storyforge-v2-production-plan\design\screens\Home.dc.html` (take its colours, top bar and "Start something new" section only — see `design/README.md` "Known override").

## Data

### `listBooks()` / `BookSummary` gains (from `book.md` + `series.md` + `library.md`)

`subtitle`, `pen_name` (slug), `pen_name_display` (name from `library.md` `pen_names`, else null), `genre` (list), `word_target`, `language`, `series_title` (from `series.md`), `archived` (`status === 'archived'`), `cover_color`, `cover_state` (`'image'|'none'|'missing'|'unsupported'|'outside'`), `cover_url` (`/api/books/:id/cover?v=<sha8>` when `cover_state === 'image'`, else null), `blurb` (first paragraph of `book.md` body, plain text, ≤ 280 chars), `index_state` (from J04 status).

- `cover_state`: no `cover` field → `none`; path escapes the book or isn't under `assets/` → `outside`; extension not `.png/.jpg/.jpeg/.webp/.gif` → `unsupported`; file missing → `missing`; else `image`. `?v=` is the first 8 hex of the image's sha256 (cache-busting).
- The index (J03) must return the same values as the file path (index == files equality test must keep passing): store the new fields in index meta.

### `libraryInfo()` gains `series: [{ slug, title, status, book_ids: [...] }]` (ordered by series slug; books by `series_number`).

### New: `getCover(bookId)` → `{ bytes, contentType, sha256 }` or `null` (reads through the existing read-only path; realpath containment as the store does).

## Server

| Route | Notes |
|---|---|
| `GET /api/books/:b/cover` | 200 with image bytes; `content-type` from extension (`image/png|jpeg|webp|gif`); `x-content-type-options: nosniff`; `cache-control: private, max-age=31536000, immutable` when `?v=` matches the current sha, else `no-cache`; 404 when `cover_state !== 'image'`; refuse > 10 MB (413-style 404 with `error:'too_large'`). Never serves SVG or anything outside `assets/`. |

No write routes in this job (setting a cover/colour from the UI comes with book settings later; authors set them in `book.md`).

## Library page (`/`)

Layout (reference look; tokens from J01):

1. Page header: "Library" (serif) + count ("3 books").
2. **Start something new** card (unchanged honest text until J03).
3. **Toolbar** (one row, wraps on narrow): filter input "Filter by title, series or pen name" (client-side, instant); status chips (All · Planning · Drafting · Revising · Complete — real `button`s with `aria-pressed`); "Show archived" toggle (off by default); sort select (Series order · Title A–Z).
4. **Search inside books** — the existing top-bar search already searches content. On the library page, when the top-bar query is non-empty, cards are filtered to books with hits, each card shows "N matches" and the first snippet; clearing the query restores the grid. (Uses `/api/search`; books without a fresh index show "Indexing…" instead of being hidden.)
5. **Sections**: one per series ("The Tidewater Books" — series title, status, book count), books in `series_number` order with "Book 1", "Book 2" labels; then **Standalone**. Empty sections are not shown.
6. **Cover card** (`<a href="/books/:id">`, whole card is the link): 2:3 cover; title (serif), subtitle, pen name display, status chip, words (and `word_target` progress bar with text "42,100 of 90,000 words", `role="progressbar"` with aria values), scene count, error/warning badges, "Archived" badge.

### Covers

- `image` → `<img src=cover_url alt="Cover of <title>">`, `object-fit: cover`.
- Otherwise a **generated cover** (pure CSS/SVG in React, no canvas): background = `cover_color` or a colour picked deterministically from the book id from a fixed palette of 8 dark tones that all give ≥ 4.5:1 with the cover text colour; title in Literata, pen name below, thin accent rule. `alt`/aria label "Generated cover for <title>".
- `missing` / `unsupported` / `outside` → generated cover **plus** a small badge "Cover not found" / "Cover type not supported" / "Cover must be in assets/" (with `title` tooltip explaining what to fix in `book.md`).

### States

- **Empty library** (no books found): illustration-free message "No books here yet." + the library path + "Creating books arrives in the next update."
- **Invalid book** (J04 `index_state === 'invalid'` or error_count > 0): card shows a "Needs attention" badge; link still opens the book.
- **Loading**: skeleton cards (same size, no shimmer animation if `prefers-reduced-motion`).
- **API error**: inline error with Retry button.
- Filters producing no results: "No books match" + "Clear filters" button.

## Fixture

New valid fixture `packages/format/fixtures/valid/covers/` (zero diagnostics), synthetic text only:

- `library.md` with pen names `r-fenwick` (R. Fenwick) and `a-marsh` (A. Marsh).
- Series `harbour-lights/` (`series.md` title "Harbour Lights", status active) with books `first-light` (series_number 1, `cover: assets/cover.png` — a real small PNG ≤ 20 KB you generate, e.g. a solid-colour 200×300 image) and `second-light` (2, `cover_color: "#2F4A3A"`).
- Standalone `north-road` (no cover, no colour, `word_target: 60000`, status revising), `old-draft` (status archived), `lost-cover` (`cover: assets/missing.png`, file absent), `svg-cover` (`cover: assets/cover.svg`, file present → `unsupported`).
- Each book minimal but valid (book.md + one act + one chapter + one or two scenes), with `expected.json` `{ diagnostics: [] }`.

## Acceptance (test-author)

1. Fixture validates clean; `listBooks` returns the new fields with exact `cover_state` per book (`image`, `none`, `missing`, `unsupported`, …), pen name display names, series title, `archived`, `blurb`.
2. **Index == files** still deep-equal for all valid fixtures including `covers`.
3. **Works after deleting SQLite:** delete every `.storyforge/` in the covers library → `listBooks`/`libraryInfo` (and the library page data) identical to before.
4. Cover route: image bytes + correct content-type + nosniff; `?v=` immutable vs no-cache; 404 for `none`/`missing`/`unsupported`/`outside`; path traversal / SVG never served; unknown book 404.
5. Search filters by book/Codex content: a word that exists only in one book's codex entry → `/api/search` returns only that book; the library's client filter logic (pure function, unit-tested) keeps only that card.
6. Web render tests (node --test + `renderToStaticMarkup`, as in J01): series sections and order, "Book 1/2" labels, standalone section, cover `img` vs generated cover with correct accessible names, badges for missing/unsupported, archived hidden by default and shown with the toggle, status chip filtering, empty library state, no-results state, progressbar aria values; whole card is one link; no nested interactive elements inside the card link.
7. Generated-cover palette: every palette colour and a sample of `cover_color` values give ≥ 4.5:1 with the cover text (pure-function test; if a `cover_color` is too light, the text colour flips to dark — test that too).
8. `npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
