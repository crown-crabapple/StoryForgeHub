# StoryForgeHub — UI plan: the write experience (2026-11-01)

> Source: the StoryForgeHub vs Novelcrafter UI comparison (2026-11-01). Goal: bring the
> storyboard, outline, write mode, codex popups, and passage notes up to (and past)
> Novelcrafter, without breaking the guarantees the app already has.

---

## Guardrails (read first, apply to every phase)

1. **`chapters.body` stays canonical.** Markdown remains the single stored format. Scene-level
   editing works on *slices* of the chapter body and splices back. No new prose storage.
   Exports, the MCP `save_chapter` path, revisions, and `body_hash` concurrency all keep working
   unchanged.
2. **Round-trip gate.** Any change to `editor/src/codex-md.js` or the serializer must pass
   `npm test` in `editor/` (the corpus round-trip suite). Scene break bytes (`***`, `* * *`,
   `---`, `___`) must survive exactly.
3. **No prose pollution.** Highlights, mention styling, and note anchors are ProseMirror
   *decorations*, never marks or inline syntax written to Markdown.
4. **Permissions.** Reuse `user_can($book, 'edit'|'comment'|'manage')` and the action whitelist
   at the top of `htdocs/index.php`. Viewers with `comment` may add/reply/resolve notes; only
   `edit` may change prose or scene metadata.
5. **Migrations** follow the existing pattern: `ensure_*()` in `src/repo.php` with
   `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN` in try/catch, plus the same
   columns added to `schema.sql`.
6. **Rebuild the bundle** (`cd editor && npm run build`) whenever `editor/src` changes, and commit
   `htdocs/assets/app/editor.js` + `editor.css` with the source.
7. **Small PRs.** One phase per branch/PR. Each phase ends with tests green and a short entry in
   a `CHANGES-<date>-<phase>.md` file, matching the repo's existing convention.

---

## Phase 1 — Codex card everywhere (quick win)

**Today:** hover card exists only on the reader page (`case 'chapter'`, "Phase 9a" JS) and shows
name, type, one-line detail. In the editor, clicking a mention converts it to a `[[wiki-link]]`
(`handleClickOn` in `editor/src/main.js`).

**Build**
- Move the card into the editor bundle as a shared module (`editor/src/codex-card.js`) used by
  both the reader page and the TipTap view. Remove the inline duplicate from `index.php`.
- Trigger: hover shows the card after ~250 ms; click pins it (Esc or outside-click closes).
- Card content: type badge, name, aliases, the entry's key fields (the `- **Label:** value`
  lines), first ~200 chars of body, up to 3 related entries (from `Related:`), mention count.
  Extend the `window.__scene.meta` payload in PHP to carry these.
- Card actions: **Open** (entry page), **Peek** (opens Phase 6 side panel; hidden until then),
  **Link here** (the old click-to-wikilink behavior, now an explicit button; edit role only).

**Done when:** the same card works in reader and editor (rich mode); clicking prose no longer
silently rewrites it; round-trip suite green.

---

## Phase 2 — Scene metadata + richer Grid cards

**Today:** `scenes` rows are derived from `md_split_scenes()` on save and keyed by `ordinal`;
the table already has `summary`, `label`, `note`, `seq`, but `summary` has no UI. Grid cards
show title, words, label, note.

**Build**
- Add columns: `pov_slug`, `subtitle`. (Keep `summary`, `label`.)
- **Scene identity:** today metadata is re-attached by ordinal, so inserting a scene mid-chapter
  shifts every summary down one. Fix by matching on content: when `reconcile_scenes` runs, match
  old→new scenes by best similarity of the first/last ~200 chars (fall back to ordinal). Add a
  PHP test for insert, delete, and reorder cases. **Ask Stephen** before choosing an alternative
  such as an invisible `<!-- scene:id -->` marker in the prose.
- Grid card: show the summary when set (else first ~2 lines of prose, muted), codex chips for
  entries mentioned in that scene (computed from the existing mention targets against the scene
  slice), POV badge.
- Inline edit: pencil on a card opens a small popover (summary textarea, POV select, label);
  saves via a new `scene_meta_save` action (JSON).
- Manuscript toolbar: add a **View** popover — card width (S/M/L), card height (S/M/full),
  show/hide codex chips — stored in `localStorage` (try/catch).
- Scene filter box: client-side filter by text in title/summary/chips.

**Done when:** summaries survive inserting a new scene before them; chips match the "In this
scene" rail counts; viewers see but cannot edit.

---

## Phase 3 — Anchored margin notes (Google-Docs style)

**Today:** `chapter_notes` stores `quote` + `note` + status + author, keyed by `chapter_file`.
Created only from the reader page via "⚑ Flag this"; shown as a list under the chapter; the
editor rail lists open notes read-only.

**Schema** (`ensure_chapter_notes`)
- Add: `parent_id INT NULL` (replies), `scene_ordinal INT NULL`, `anchor_start INT NULL`,
  `anchor_end INT NULL` (offsets into the chapter Markdown at creation), `prefix VARCHAR(64)`,
  `suffix VARCHAR(64)`, `detached TINYINT DEFAULT 0`, `updated_at`.

**Anchoring algorithm** (`editor/src/notes-anchor.js`, unit-tested in `editor/test/`)
1. Try `quote` at `anchor_start` exactly.
2. Else search for `prefix+quote+suffix`, then `quote` alone; if several hits, pick the one
   nearest the old offset.
3. Else fuzzy match (normalize whitespace and quotes); if nothing ≥ 0.8 similarity, mark
   `detached`.
4. On every successful chapter save, re-resolve open notes server-side (port the same logic to
   PHP in `src/notes.php`) and persist new offsets, so anchors don't drift.

**UI (chapter editor and reader page)**
- Highlight anchored ranges with a ProseMirror decoration plugin (open = soft yellow, focused =
  stronger, resolved = none). In raw-Markdown mode, show the rail without highlights.
- Right **margin rail**: each card aligned to the top of its highlight; on collision, push later
  cards down; the focused card slides up to its anchor. Detached notes pinned at the top under
  "Text changed — note no longer anchored."
- Create: select text → floating **Comment** button, or Ctrl/⌘+Alt+M → new card in the rail
  with the cursor in it. A general (unanchored) note is still possible from the rail header.
- Card: author, date, body, replies, **Reply / Resolve / Reopen / Send to Tasks / Delete**.
  Clicking a highlight focuses its card and vice versa.
- Rail header filter: All / Open / Mine; **Hide notes** toggle.
- The existing "In this scene" rail moves into a tab beside **Notes** so the right column has
  two tabs instead of stacking.
- New JSON actions: `note_create`, `note_reply`, `note_update`, `note_status`, `note_delete`
  (keep the old form posts working until the reader page is migrated, then remove them).

**API / MCP**
- `api.php`: `notes` (GET by book + chapter, include anchors and replies) and `note_add`
  (POST book, chapter, quote, note, optional parent). Claude can then leave line-level review
  notes instead of rewriting prose. Update `skill-storyforge/SKILL.md` to describe the tools and
  the rule "comment, don't rewrite, when asked to review." **Flag:** the `codex-mcp` service
  that wraps `api.php` may live outside this repo; list what it needs rather than guessing.

**Done when:** a note survives edits before and after its passage; deleting the passage
detaches it (never deletes it); notes never appear in exported Markdown; tests for the anchor
resolver in both JS and PHP agree on a shared fixture file.

---

## Phase 4 — Unified Write page with scope (book / act / chapter / scene)

**Build**
- New page `?p=write&book=…&scope=book|act|chapter|scene&id=…`. Header: scope picker grouped
  by act (like Novelcrafter: "Everything", then each act's "Full act" and its chapters, with
  scenes as a nested level), plus words / pages (250 words a page) / read time for the scope.
- Render the scope as a vertical flow: act header → chapter header → scene blocks. Each scene is
  its own TipTap instance over its **slice** of the chapter body (split on the break line,
  keeping the exact marker bytes).
- **Saving:** per chapter, re-join slices with their original markers and call the existing
  save path with that chapter's `body_hash`. Autosave per chapter (reuse `chapter_autosave`).
  A conflict on one chapter shows the existing conflict UI for that chapter only.
- Lazy-mount editors (IntersectionObserver) so a 100k-word book stays responsive; unmounted
  scenes render as static HTML.
- **Scene meta column** to the right of each scene: "Ch N · Scene M · words", summary
  (editable, Phase 2 action), POV, label, codex chips, Actions menu (open in Grid, history, copy,
  new scene after, archive scene = move slice to a snippets/archive doc). Margin notes from
  Phase 3 share this column (notes tab vs meta tab, or notes beside meta on wide screens).
- **Add new** controls between scenes: new scene (inserts a break + empty slice), new chapter.
- Keep `chapter_edit` working; once Write is stable, make the chapter page's "Edit prose" link
  to `write?scope=chapter`. Don't delete `chapter_edit` in this phase.

**Done when:** editing scenes in two chapters at once saves both correctly; byte-for-byte
round trip of an untouched book through the Write page (add a Playwright check in
`editor/test/browser-smoke.mjs`); presence/soft-lock covers every chapter in scope.

---

## Phase 5 — Focus, Format, and the scene strip

- **Focus** toggle: hide sidebars, meta column and notes; full-screen API when available; Esc
  exits. Optional typewriter scroll (keep the caret line at ~40% of the viewport).
- **Format** popover (per user, `localStorage`): font (serif/sans/mono), size, line height,
  paragraph spacing, first-line indent, page width, alignment, scene divider style (display
  only), colorize codex mentions on/off.
- **Scene strip:** thin vertical bar at the right edge, one tick per scene sized by word count,
  current scene highlighted, open-note ticks in yellow; click to scroll.

---

## Phase 6 — Outline and Matrix views + codex side panel

- **Outline** (`?p=manuscript&view=outline`): single centered column; act → chapter → scene
  summary blocks; inline-editable summaries; drag to reorder (reuse `reorder_*` actions; scene
  reorder stays planning-only, as today).
- **Matrix** (`view=matrix`): rows = scenes, columns = codex entries (filter by database:
  characters by default), cell = mention count or POV marker; **Swap axes**; sticky headers.
- **Codex side panel:** dockable left or right on Write and chapter pages; tabs **Details**
  (read; edit with `edit` role), **Mentions** (scene list with snippets, from the mention index),
  **History** (existing entry revisions). Wire the card's **Peek** button to it.

---

## Order and dependencies

| Phase | Depends on | Size |
| --- | --- | --- |
| 1 Codex card | — | 1–2 days |
| 2 Scene metadata + Grid | — | 2–3 days |
| 3 Margin notes | — (works in today's editor) | 4–6 days |
| 4 Write page with scope | 2 | 5–8 days |
| 5 Focus / Format / strip | 4 | 2–3 days |
| 6 Outline, Matrix, side panel | 1, 2 | 3–5 days |

## Open questions for Stephen (ask before the phase that needs them)

1. Phase 2: content-similarity matching for scene identity, or an invisible scene-id marker in
   the prose?
2. Phase 3: should Claude's notes (via MCP) be visually distinct (e.g., a "Claude" author chip)
   and filterable?
3. Phase 4: should "archive scene" move the text to a Workspace doc, a new snippets table, or
   the chapter's revision history only?
4. Where does the `codex-mcp` service source live, if not in this repo?
