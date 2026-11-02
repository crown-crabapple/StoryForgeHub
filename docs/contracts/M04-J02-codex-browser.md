# M04-J02 contract — Codex browser, inspector, and entry editing

Reference (binding look): `storyforge-v2-production-plan/design/screens/Codex.dc.html` — category sidebar ("Story bible" with counts), card grid with avatar initial / name / role / blurb / "First seen" / scene count, right inspector (avatar, name, role, facts grid, Arc, **Presence by chapter** bars, **Relationships**, "Open in manuscript"), "New entry" button, "need review" count. Binding data: FORMAT-v1 §5, §5.1; contracts M04-J01 (graph, `appears_in`, `related`, `codex/types`), M03-J01 (preview dialog, `editFrontMatterLine`), M02-J01 (tokens, shell), M01-J02 (single writer).

## 1. Route and layout — `/books/:id/codex` (replaces the M02 placeholder)

- **Left sidebar "Story bible":** one row per type from `codex/types` (display plural, count), built-ins first, then custom types A–Z; an **All** row; an **Archived** row (count). Selected row uses accent-soft fill.
- **Header:** type title (serif), "N entries · M need review" (an entry **needs review** when it has any error or warning diagnostic, or its status is `seed`). Filter input "Search entries" (client-side over name, aliases, field values; plus a "Search text too" toggle that uses `/api/search` kinds=entry). Sort: Name · Most scenes · Recently changed. Status filter chips: All · Seed · Sketch · Canon · Needs review.
- **Card grid** (reference): avatar circle with initial (or `image` if set and served via a safe route like covers — `assets/` only, png/jpg/webp/gif), name, `role` field or type, one-line blurb (first sentence of the first `##` section, ≤ 120 chars), "First seen Ch N" (from `first_appearance` or earliest `appears_in`), "N scenes" (explicit appearances). Status chip. Whole card is a `button` selecting the entry (`aria-pressed`), keyboard: arrows move between cards (grid), Enter selects.
- **Inspector** (right): avatar, name, type · role; **facts grid** from `fields` (label/value; values with `[[links]]` rendered as links); **aliases**; sections — each `##` section of the entry shown as a heading + text (Markdown rendered read-only, same display rules as the editor's reading view: comments dimmed, links as labels); **Presence by chapter**: one bar per chapter (height = scenes in that chapter where the entry appears explicitly; inferred shown as a lighter stacked segment), with an accessible text summary (`role="img"` + `aria-label` "Maren Hollis appears in 3 scenes in chapter 1, …"); **Appears in**: list of scenes (explicit first; inferred tagged "mentioned"), each a link to the scene in the manuscript; **Relationships**: out and in (in shown as "← carried by Brass Key"), each a button selecting that entry; **Open in manuscript**: goes to the first explicit scene; **Edit…**, **Archive…** buttons.

## 2. Create / edit / archive (canonical files only)

All through `@storyforge/manuscript`-style helpers + the store, dry run + preview, refuse on new errors, never delete.

| Action | Effect |
|---|---|
| **New entry** (`POST /api/books/:b/entries`) `{ type, name, slug?, status='seed', fields? }` | creates `codex/<folder>/<slug>.md` with `schema`, `id` (`entry_…`), `slug` (from name, unique across entries/threads/events — else `SLUG_TAKEN`), `type`, `name`, `status`, `fields` (default labels from the type definition with empty values), body `## Overview\n\n`. Folder: built-in folder or `<type>s`. |
| **Edit fields** (`POST …/entries/:id/fields`) `{ name?, status?, role?, aliases?, fields?, related? }` | `name`/`status`/scalar fields: `editFrontMatterLine`. **Lists and maps** (`aliases`, `fields`, `related`): replace that key's block with a freshly written block (YAML flow list for `aliases`, block map for `fields`, block list of `{to, as}` for `related`), **only that block's lines change**; refuse `REFUSED_UNSIMPLE_FIELD` if the existing block uses anchors/tags/comments. Renaming `name` never changes `slug` (links keep working); a separate **Change slug…** action adds the old slug to `previous_slugs` and rewrites nothing else (W301 tells the author where old links remain). |
| **Edit body** | the entry body opens in the M03-J02 editor (same component, body-only PUT `…/entries/:id/body` with `base_sha256`, conflict flow, autosave, draft store). |
| **Archive** (`POST …/entries/:id/archive`) | move to `archive/codex/...`; preview lists every scene/entry that links to it (they'll show W303). **Restore** from the Archived category. |
| **New type** (`POST …/codex/types`) `{ type, name, plural?, fields? }` | creates `codex/_types/<type>.md`; refuses an existing type file (`TYPE_EXISTS`). |

Every write route is write-guarded, supports `dryRun`, returns diffs, and reconciles the index after.

## 3. Navigation from a character to its scenes

Selecting a scene in **Appears in** (or "Open in manuscript") opens `/books/:id?scene=<sceneId>`; in the manuscript inspector (M03-J04 "In this scene"), each entry chip gains **"Open in Codex"** → `/books/:id/codex?entry=<id>`. The Codex page reads `?entry=` and `?type=` from the URL (shareable).

## 4. No hidden DB-only content

Every number and list on the page is derivable from files: the page must render identically (same JSON from the API) with a fresh index and with **no index** (files fallback) — tested.

## 5. Acceptance

1. **Reference scenario with fixture data** (`codex-graph` and `salt-orchard`): types and counts in the sidebar; card grid fields (initial, name, role/type, blurb, first seen, scene count, status); inspector facts, sections, presence bars and their text summary, appears-in (explicit/mentioned), relationships both directions — render tests with fixture JSON + API tests for the data.
2. **Character → linked scenes:** API returns `appears_in` in manuscript order; the "Open in manuscript" link targets the first explicit scene; the manuscript chip links back (render test).
3. **No DB-only content:** every Codex API response identical with a fresh index and with `.storyforge/` deleted (before the rebuild finishes — files fallback).
4. **Create/edit/archive:** new entry file contents exact (incl. type default fields); field edits change only the named lines/blocks (diff check; CRLF file too); slug change adds `previous_slugs` only; archive moves the file and lists W303 sources in the preview; restore; new type file; refusals (`SLUG_TAKEN`, `TYPE_EXISTS`, unsimple block, stale base) write nothing; 403 without guard.
5. **Body edit through the editor:** PUT body keeps front matter bytes; conflict 409 on stale base.
6. **Manual (coordinator, real browser):** browse types, filter, select Maren, see presence bars and relationships, open a linked scene, come back via "Open in Codex", create an entry, edit a field, archive and restore it.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
