# Change: scene metadata + richer Grid cards (UI plan Phase 2, 2026-11-01)

Phase 2 of `UI-PLAN-write-experience-2026-11-01.md` (the plan file itself is added on the
Phase 1 branch, PR #2).

Before this change, scene metadata (label, summary, planning order) was re-attached by
**position** on every save. Inserting a scene mid-chapter shifted every summary down by
one. Every save also deleted and re-created the rows, so a Grid page left open sent label
and reorder updates to ids that no longer existed. Now scenes keep their identity by
**content**, the summary has a UI, and Grid cards show much more.

## Files changed
- `src/repo.php`
  - `ensure_structure()`: new `scenes` columns `pov_slug`, `subtitle`, `anchor_head`,
    `anchor_tail` (the anchors hold the first and last ~200 characters of the scene's prose,
    used only for matching).
  - `reconcile_scenes()` matches old rows to the new split in three passes:
    1. identical content (body hash), with identical copies paired in order;
    2. best average similarity of opening and closing text, at least 0.5
       (`SCENE_MATCH_MIN`);
    3. same ordinal among whatever is left (for example, a scene rewritten wholesale).

    Matched rows are **updated in place, so ids are stable**. Unmatched old rows are
    deleted and unmatched new scenes are inserted with no metadata. Label, summary, POV,
    subtitle and `seq` follow the scene. Prose is never touched.
  - `save_scene_meta()`: saves any subset of summary, label, POV and subtitle. It is limited
    to one book, the label must be one of `SCENE_LABELS`, and the POV must be a Characters
    entry in the same book.
  - `scene_grid_data()`: per-scene Codex chips, computed live with `scan_mentions()` (the
    same matcher as the mentions index), plus a short plain-text preview.
- `htdocs/index.php`
  - New JSON action `scene_meta_save`. In `book_gate()` it needs `edit`, and the book is
    resolved from the scene id (IDOR-safe), like `thread_status`.
  - Grid cards show:
    - the summary, or the scene's opening lines in muted italics;
    - the subtitle;
    - a **POV** badge;
    - chips for the entries mentioned in that scene (count shown when more than 1).
  - **✎** opens a popover (summary, POV, label, subtitle). It saves without a reload and
    updates the card in place. It does reload when the label moves a scene in or out of
    the word count.
  - Toolbar:
    - **View ▾**: card width S/M/L, card height S/M/Full, Codex chips on/off. Stored in
      `localStorage` (`codexGridView`), with failures caught.
    - **Filter** box: searches the title, subtitle, summary (or the preview when there is
      no summary), POV and chip names.
  - **Viewers** see summaries, chips and labels (as a pill) but no ✎, label dropdown, drag
    handles, act dropdown or acts manager. The server already refused their writes; now the
    UI matches.
- `htdocs/assets/style.css`: Grid card, View, filter and popover styles.
- `schema.sql`: adds the `acts` and `scenes` tables. They only existed through
  `ensure_structure()` before.
- `tests/php/scenes_test.php` (new, 27 checks).

## Migration
Automatic. `ensure_structure()` adds the four columns on first use. Existing rows have
empty anchors, so on the first save after deploy, unchanged scenes match by hash and
edited ones fall back to ordinal (the old behavior), and every save after that stores
anchors. For a fresh install, `schema.sql` now has both tables.

## Deploy
Deploy `htdocs/` and `src/`. No editor bundle change.

## How to test by hand
1. **Manuscript → Grid.** Cards show the scene's opening lines (muted) and chips for the
   Codex names in each scene.
2. Click **✎** on a card. Write a summary, pick a POV, set a label and a subtitle, then
   **Save**. The card updates with no reload. Reload the page: the values are still there.
3. **Edit prose** on that chapter. Add a new scene at the very top (text, then `***`) and
   save. Back in the Grid, your summary is still on the same scene, now second, and the
   new scene has none. Also try deleting a scene, swapping two, and editing a sentence
   inside the summarized scene: the summary stays with its scene each time.
4. **View ▾**: switch width, height, and chips. Reload: the choices are remembered.
5. Type a character's name in the filter. Only scenes that mention them (or have them as
   POV) stay visible, with an "N of M scenes" count.
6. Sign in as a **viewer** on the book. The Grid shows the same data with no ✎, label
   dropdowns, drag handles or acts manager.
7. `php tests/php/scenes_test.php`.

## Behavior notes
- **When matching gives up:** if a scene is rewritten so heavily that neither its opening
  nor its closing ~200 characters stay at least ~50% similar, it keeps the metadata of
  whatever scene now sits at its position (the old behavior). A scene rewritten wholesale
  **and** moved in the same save can therefore pick up a neighbor's summary.
- **Chips vs the "In this scene" rail:** the rail counts the whole chapter, despite its
  name. Chips count each scene's prose, with author comments and title headings removed.
  Across a chapter the chips add up to the rail's count for the prose itself (tested); the
  rail can be higher when a name appears in a heading or an `<!-- note -->`.
- **POV:** only offered when the book's profile has a Characters database.
- **Chapter heading:** a scene's leading heading moves with its text, so a
  chapter's `# Title` belongs to whichever scene is first.

## Deferred
- No editor-side scene UI (Phase 4's Write page uses `scene_meta_save`).
- The POV badge isn't linked to `chapter_cast` (continuity) POV yet.
- `schema.sql` additions were not executed against MariaDB (no scratch database here;
  `migrate()` doesn't read `schema.sql`). They mirror `ensure_structure()` column for
  column.
- Browser (Playwright) run not done (no Chromium on the box). Verified instead with the
  Grid's own scripts in jsdom against the real app (`php -S` over seeded SQLite: 13
  checks) and HTTP checks for the permission refusals.
