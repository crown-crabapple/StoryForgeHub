# ADR 0005 — Rich-text chapter editor on TipTap (ProseMirror)

**Status:** accepted 2026-11-19 (owner: hosted plan, "Formatting: rich-text controls; authors never need to work with Markdown syntax"). **Supersedes:** [ADR 0002](0002-scene-editor-codemirror.md). **Job:** hosted plan, Phase 0. Built in Phase 2.

## Context

- ADR 0002 picked CodeMirror 6 editing Markdown text because the files were canonical, and every byte had to survive a save. TipTap was rejected then only because it rewrote 12 of 31 Markdown constructs on the first save.
- With the database canonical ([ADR 0004](0004-hosted-database-canonical.md)), the editor's own document is the stored form. Markdown is touched twice: once on import and on each export. Lossy round trips no longer happen on every save.
- The plan asks for one continuous chapter with fixed scene breaks, a notes margin, inline entity candidates, inline diagnostics and passage-anchored comments.

## Decision

| Concern | Choice |
| --- | --- |
| Library | **TipTap 3** on **ProseMirror** (both MIT), pinned exact versions. |
| Stored form | One ProseMirror JSON document **per scene**, with a `schema_version` number. The chapter editor shows the chapter's scenes as one view, joined by non-editable scene-break nodes that carry the scene id. Scene records stay fixed; they are created, renamed and reordered only from the chapter outline. |
| Schema (v1) | Blocks: paragraph, heading (2–4), blockquote, bullet and ordered list, horizontal rule (in-scene break `***`), hard break. Marks: bold, italic, underline, strike, small caps, code, link. Story nodes: `entityMention` (inline mark with entry id + state), `authorNote` (inline note, replaces `<!-- note: -->`), `anchor` (stable id for comments and findings, replaces `sf:anchor`). Unknown imported constructs become a `rawImport` inline node that keeps the original Markdown text and shows a warning. |
| Ranges | Comments, mentions and findings point at `{scene_id, anchor_id?, from, to}` in ProseMirror positions, plus a short quote of the text. When text moves, positions are mapped through the editor's transaction mapping; if the quote no longer matches, the item becomes "detached" and is shown for review, never silently moved. |
| Save | Debounced autosave of changed scenes only, with the scene's version number for optimistic concurrency. A restore point is taken at save boundaries (plan Phase 2). |
| Markdown | Import: Markdown → schema v1 with a per-construct report. Export: schema v1 → Markdown with the FORMAT-v1 conventions. A golden-file test proves import → export → import is stable. |
| Schema changes | A new `schema_version` comes with an upgrade function in `packages/db`, run on read and written back on the next save. |

**Amendment (2026-11-20, owner decision "editor first"):** in Phase 2 the stored form stays the scene's Markdown body, through the existing routes and `base_sha256`. The browser converts it with `@storyforge/format/rich`, which is lossless on read and refuses a save that would not read back the same ([phase 2 design](../plans/phase2/design.md)). The JSON-per-scene stored form and version-number concurrency above arrive with the typed `scene` table, later.

## Consequences

- The `apps/web` CodeMirror scene editor, its decorations and the Markdown formatting commands are replaced in Phase 2. The Read view renders the JSON instead of Markdown.
- The M13 findings layer maps Harper and textlint results to Markdown offsets today. In Phase 4 it maps them to ProseMirror ranges, by running the checkers on a plain-text projection of each scene that keeps a position map.
- The legacy `codex-md.js` TipTap Markdown layer can seed the importer, but import/export rules are owned by `packages/format`.
- Real-time co-editing is a non-goal (plan §6). ProseMirror's collaboration plugins keep that open for later.

## Rejected

- **Keep CodeMirror with Markdown** — authors would still see Markdown syntax, against the owner's decision.
- **Lexical, Slate, Quill** — workable, but TipTap/ProseMirror has the strongest model for marks, decorations, position mapping and future collaboration, and the legacy app already used it.
- **One document per chapter** — makes scene reorder, per-scene history and per-scene notes harder. The chapter view joins scenes instead.
