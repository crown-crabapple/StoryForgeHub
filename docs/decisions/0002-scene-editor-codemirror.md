# ADR 0002 — Scene editor: CodeMirror 6 editing the Markdown text directly

**Status:** accepted 2026-11-01. **Job:** M03-J02 (task 1: "Select editor technology only after proving Markdown/front-matter/comment preservation requirements").

## Evidence

Spike (17 scene bodies: every salt-orchard and spec-example scene + a 77-line torture body; LF and CRLF; no-edit and one-word-edit): `storyforge-v2-production-plan/evidence/M03-J02/editor-spike-REPORT.md`.

| Candidate | No-edit byte-identical (LF) | CRLF kept | Constructs rewritten (of 31) |
|---|---|---|---|
| TipTap 2 + legacy `codex-md.js` (rich-text model) | **0 / 17** (drops final newline on all; 2 bodies changed content, incl. an `sf:anchor` comment glued to prose) | 0 / 17 | **12** (`_x_`→`*x*`, hard breaks, blank-line runs, soft wraps joined, `*` bullets, `~~~` fences, `__init__` as bold, escapes, link titles…) |
| CodeMirror 6 + `lang-markdown`, per-file `EditorState.lineSeparator` | **17 / 17** | **17 / 17** | **0** |

A one-word edit changed no other line in either candidate — but TipTap normalises every lossy construct on the first save, edit or not.

## Decision

The scene editor is **CodeMirror 6** editing the Markdown body as text. "Rich" comes from **decorations**, never from re-serialising:

- Markdown syntax highlighting; headings/emphasis styled in place; author comments dimmed; `[[links]]` styled with their label emphasised; `***` breaks centred. Syntax characters stay in the text (optionally dimmed), so what's on disk is exactly what's typed.
- Formatting commands (bold, italic, link, note) **insert or wrap text** (`**…**`, `*…*`, `[[…]]`, `<!-- note: … -->`) — they never rewrite other text.
- Front matter is never shown in the editor; it's edited through the J01 field commands. The editor buffer is the body only; save = original front-matter bytes + buffer (J02 body-replacement rule).

### Line endings

- Detect each file's line ending on open. All-LF → default; all-CRLF → `EditorState.lineSeparator.of('\r\n')` and read back with `state.sliceDoc(0, state.doc.length, state.lineBreak)` (`doc.toString()` would return LF).
- **Mixed** endings → open **read-only** with a notice and an explicit **"Normalise line endings…"** command (preview, then a single save). No silent change.

## Rejected

- **TipTap/ProseMirror** (incl. the legacy hardened layer): a document-model round trip rewrites authors' Markdown — contradicts DECISIONS 1 and the M03-J02 acceptance ("untouched prose preserved").
- **Plain `<textarea>`**: byte-safe but no syntax styling, weak undo, poor large-document performance.
- **Milkdown/other WYSIWYG Markdown editors**: same document-model round-trip risk as TipTap.

## Consequences

- Authors see Markdown markers (styled). A "reading view" (rendered, read-only) already exists from M02.
- We add `history()`, keymaps and our own bold/italic/link/note commands; word count stays ours (`countWords`).
- Dependencies (exact pins, ≥ 14 days old): `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/language`, `@codemirror/lang-markdown` (+ its `@lezer/*` peers).
