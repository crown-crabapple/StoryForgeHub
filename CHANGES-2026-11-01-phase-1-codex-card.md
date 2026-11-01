# Change: Codex card everywhere (UI plan Phase 1, 2026-11-01)

Phase 1 of `UI-PLAN-write-experience-2026-11-01.md`. The hover card used to exist only on
the chapter reader (inline "Phase 9a" JS) and showed name, type and one line of detail.
In the rich editors, clicking a highlighted mention silently rewrote it as `[[slug]]`.
Now one shared card works on the reader and in every rich editor that highlights
mentions. Clicking prose never edits it: linking is an explicit button.

## Files changed
- `editor/src/codex-card.js` (new): the card.
  - Hovering a mention for ~250 ms shows it. Click pins it. Esc or a click outside closes it.
  - Content: type badge, name, detail, aliases, up to 4 key fields, a ~200-char excerpt,
    up to 3 related entries (linked), and counts ("N in this chapter · N in manuscript").
  - Actions: **Open →** (entry page) and **Link here** (edit role only). Link here turns
    that one highlight into a `[[slug]]` node and refuses if the highlight is stale.
    **Peek** is not rendered until the Phase 6 side panel exists.
  - On the reader, a plain click pins instead of navigating. Ctrl/⌘/Shift/middle-click
    still open the entry as before.
- `editor/src/mentions.js` (new): the P5 mention highlighter, moved out of `main.js`
  unchanged except that **`handleClickOn` is removed**. It's in its own file so the tests
  can load it without booting the page bundle.
- `editor/src/main.js`: attaches the card to the chapter, entry and generic (note /
  workspace) rich views, plus a new `bootReader()` for `#chapterbody a.mention`. The card
  closes on any editor update and when switching to raw Markdown.
- `editor/src/editor.css`: `.codex-card` styles (extends `.mention-card` in `style.css`).
- `htdocs/assets/app/editor.js`, `editor.css`: rebuilt.
- `src/repo.php`: `build_codex_card_meta($book_id)` returns card data for every entry in a
  book in 5 queries (no per-entry `entry_to_struct`). The manuscript count is
  `SUM(mentions.cnt)` for live chapters, from the mentions index.
- `src/layout.php`: `codex_db_colors()` (replaces 4 copies of the colour-map loop) and
  `scene_script()`, which emits `window.__scene` with `JSON_HEX_TAG|JSON_HEX_AMP`. Entry
  excerpts now go into an inline `<script>`, so a `</script>` in entry text must not be
  able to close it.
- `htdocs/index.php`:
  - `chapter`: card data via the helper, inline Phase 9a card removed, editor bundle now
    loaded on this page. The scene rail script is unchanged.
  - `chapter_edit`: same data; `canLink = user_can(book,'edit')`. Removed the unused
    `targets/meta/db` keys from `window.__ed` (nothing read them; they would have doubled
    the payload).
  - `entry_edit`, `note_page` (edit), `workspace_doc` (edit): `__scene` now carries the
    card data, so the card works there too and clicking no longer rewrites those either.
- Tests: `tests/php/codex_card_test.php` (14 checks), `editor/test/codex-card.test.mjs`
  (10 tests).
- `editor/README.md`: describes the new click behavior and the new source files.

No new POST actions, so the action whitelist and `book_gate()` are unchanged. Nothing
writes to `chapters.body` except Link here, which inserts the same `[[slug]]` the old
click did. Highlights stay ProseMirror decorations.

## Migration
None. No schema change.

## Deploy
Deploy `htdocs/` and `src/` as usual (the bundle is prebuilt). Node isn't needed on the
server.

## How to test by hand
1. Open a chapter that mentions Codex entries (the reader page, `?p=chapter&id=…`).
   - Hover a dotted-underlined name for about ¼ s. The card appears. Move the mouse onto
     the card: it stays. Move away: it hides.
   - Click the name. The card pins (accent border) and the page doesn't navigate. Esc,
     or a click elsewhere, closes it. Ctrl/⌘-click the name: the entry opens as before.
   - Check the content: badge, aliases ("Also"), key fields, excerpt, related links,
     "N in this chapter · N in manuscript". There is no Link here button.
2. **Edit prose** on the same chapter (rich mode).
   - Click a dashed-underlined name. The card pins and the status still says **Saved**
     (nothing changed).
   - Press **Link here**. That one name becomes a `[[slug]]` chip and the status changes to
     Unsaved. Toggle to Markdown to see `[[slug]]` in the buffer.
   - Type anywhere while a card is pinned: the card closes.
3. Sign in as a **viewer** on that book and open `chapter_edit` by URL. The card works
   but has no Link here button.
4. Edit an entry, a note, or a workspace doc whose prose mentions another entry (rich
   mode). Same card, same behavior.
5. Give an entry an Overview containing `</script><b>x</b>` and open a chapter that
   mentions it. The card shows the text literally and the page is intact.
6. `cd editor && npm test` (28 pass) and `php tests/php/codex_card_test.php`.

## Behavior notes
- The **manuscript count comes from the mentions index**, which is rebuilt by **Reindex
  mentions**, `bin/reindex.php`, or a diagnostics run, not on every chapter save. It can
  lag. The "in this chapter" count is computed live with the same algorithm as the
  scene rail.
- **Link here keeps the old target**: it inserts `[[slug]]`, so an alias such as
  "The Warden" becomes a chip showing the slug. That matches the pre-Phase-1 click.
  `[[slug|The Warden]]` would preserve the visible text; left for a decision.
- The card attaches to the rich view only. Raw-Markdown mode has no highlights and so no
  card, as before.

## Deferred
- **Peek** button: Phase 6 (codex side panel).
- Card on `[[wiki-link]]` chips (only auto-detected mentions get it today).
- Browser (Playwright) smoke for the card. Not run: no Chromium on the box. Verified
  instead by running the built bundle in jsdom against the pages served by `php -S` over
  a seeded SQLite DB.
