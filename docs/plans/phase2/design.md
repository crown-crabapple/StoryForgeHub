# Phase 2 — Chapter-first Write mode: design

Owner decision 2026-11-20: **editor first**. Scenes stay Markdown on the server, through the existing routes. The browser converts Markdown to the editor's document on load and back on save. A typed `scene` table with JSON as the stored form comes later (amends ADR 0005 "Stored form" for Phase 2 only).

## Pieces

| Job | What | Where |
| --- | --- | --- |
| P2-J1 | Lossless Markdown ⇄ rich-document converter (schema v1) | `packages/format/src/rich.mjs` (+ tests) |
| P2-J2 | Chapter editor: TipTap 3, all scenes of a chapter in one view, fixed scene breaks, per-scene autosave | `apps/web/src/chapter/` |
| P2-J3 | Scene-notes margin (author notes + summary per scene, collapsible), quiet chrome, save-state chip | `apps/web/src/chapter/` |
| P2-J4 | Outline controls from the chapter view: new scene, rename, reorder, move (existing routes) | `apps/web/src/chapter/`, `Outline.jsx` |
| P2-J5 | Restore points: newest 4 automatic per scene; restore from the chapter view | `packages/core/src/revisions.mjs`, web |
| P2-J6 | Read view renders the rich document (no Markdown syntax visible) | `apps/web/src/reading/` |

## The converter contract (P2-J1) — data safety

`markdownToDoc(body)` → `{ doc, report }`, `docToMarkdown(doc)` → `string`.

1. **Lossless read:** for every string `b`, `docToMarkdown(markdownToDoc(b).doc) === b`. Anything the schema cannot reproduce byte-for-byte becomes a `rawBlock` or `rawInline` node holding the exact text (shown read-only as "kept as written").
2. **Stable write:** `docToMarkdown(d)` re-parses its own output and throws `RichSerializeError` if the result is not the same document (after normalising: empty paragraphs dropped, adjacent text merged). The editor never saves on a throw; it shows an error and keeps the draft.
3. Unedited scenes are never saved. A scene is saved only when its serialized Markdown differs from what was loaded.
4. Mixed line endings → the whole body is one `rawBlock` and the scene opens read-only (as today). CRLF bodies round-trip as CRLF.

## Schema v1 (JSON, ProseMirror shape)

Blocks: `paragraph`, `heading` (level 2–4), `blockquote` (one paragraph), `bulletList` / `orderedList` → `listItem` → `paragraph`, `horizontalRule` (`***`, an in-scene break), `rawBlock {text}`.
Inline: `text` (marks), `hardBreak {soft}` (a newline inside a paragraph), `authorNote {text}` (`<!-- note: … -->`), `cite {key}` (`[@key]`), `rawInline {text}` (other HTML comments incl. `sf:anchor`, images, anything not exact).
Marks: `bold {delim}`, `italic {delim}`, `strike`, `code`, `link {href}`, `entityMention {slug, form: 'bare'|'label', state: 'confirmed'}` (`[[slug]]`, `[[slug|label]]`).
Block attr `gap`: the exact separator before the block. Doc attrs: `lead`, `trail`, `eol`.

## Chapter editor (P2-J2)

- Load the chapter's scenes (GET each scene, like ReadView). Build one doc: `sceneBreak {sceneId, title}` (atom, not editable, not deletable) before each scene's blocks.
- A transaction filter rejects any step that removes or splits a `sceneBreak`; Backspace at a scene start does nothing.
- On change: split the doc at scene breaks, serialize each scene, and hand changed ones to a **per-scene save controller** (the existing pure `save-controller.js`, one per scene, `PUT …/body` with `base_sha256`). Conflicts, stale and offline states show per scene, inline under its break.
- The old CodeMirror scene editor stays reachable as **Source** (per scene) for features not yet ported (findings, suggestions, AI rewrite, raw construct editing). The chapter editor is the default Write view.
- `bridge.jsx` keeps its contract: `sceneId` = scene at the cursor, `flush` flushes all scenes, `jumpToLine` scrolls to the scene (best effort).

## Restore points (P2-J5)

H0 §2.2: newest **4** automatic restore points per scene. Manual and "before restore" snapshots are deliberate and stay outside the cap. Taken on the first save of a session and every 15 minutes of editing (as today), and before a restore.

## Out of scope (later phases)

Entity detection and review queue (Phase 3), findings and continuity marks in the rich editor (Phase 4), comments anchored to rich ranges (Phase 4/5), typed scene table (later).
