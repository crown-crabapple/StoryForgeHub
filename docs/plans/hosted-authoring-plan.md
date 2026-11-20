# StoryForge hosted authoring redesign

**Status:** proposed product and delivery plan — 2026-11-19 (updated the same day against `v2` at `a109703`)  
**Owner decisions captured:** hosted personal app; database is canonical; smooth authoring over file-first workflows; sharing will begin with invitations.

## 0. Where `v2` stands today

This plan starts from a working product, not a blank page. As of `a109703`:

| Area | What exists | What the redesign does with it |
| --- | --- | --- |
| Storage | Markdown library on disk is canonical (ADR 0001, FORMAT-v1); journaled writes, recovery, and a disposable `node:sqlite` search index per book. | Superseded. Becomes the **import source** (Phase 1) and one **export target** (Phase 5). The import fixture is built from it. |
| Editor | CodeMirror 6 editing Markdown text per scene (ADR 0002). | Superseded by the rich-text chapter editor (Phase 2). ADR 0002 is replaced in Phase 0. |
| Accounts and sharing | Shared mode (`--shared`): accounts, sessions, invites, share links, audit log, roles, per-book scope — stored as JSON files beside the library. | Kept as the **behaviour spec**. Roles, invite flow, and audit rules move into the database; the JSON store gets a one-time import. Phase 1 and Phase 5 build on it rather than starting over. |
| MCP / v1 API | `codex_*` tools over `/api/v1`, OAuth 2.1 sign-in, AI level per book. | **Must keep working.** Tool names and shapes stay stable; their handlers move onto the database. Covered by the v1 contract tests in every phase. |
| Codex, planner, canvas, timeline, clues, arcs | Built on the file model. | Data moves to database records (Phase 1); views are re-pointed, not rewritten, unless Phase 3–4 change them. |
| Editing and publishing (M13) | Milestones 0–4 merged: findings foundation (prose mapping), Harper grammar, textlint style, EPUBCheck, Paged.js interior preview. Milestone 5 (PDF export and hardening) not started. | Checkers and the EPUB/Paged.js pipeline are reused. The findings layer maps to Markdown offsets today and must be **re-anchored to rich-text ranges** (Phase 4). |
| Hosting | Already runs on a hosted server behind Caddy in shared mode. | Deployment target for the database version; adds PostgreSQL and backups (Phase 1). |
| CI | Workflow runs the full `npm run ci` on three operating systems. A one-job Linux fast check (lint + build) is written but **not yet committed** to `v2`. | Land the fast check as its own small PR before Phase 1. |

## 1. Product outcome

StoryForge becomes a calm hosted novel-writing application. An author works in a continuous chapter editor with scene breaks, an unobtrusive Codex, contextual entity information, and precise diagnostics. Markdown is no longer the working storage format: it is one of several reliable exports and an import source for existing libraries.

The primary user is a personal author. The data model and permissions leave room for invited collaborators later, without making the everyday writing experience feel collaborative or busy.

## 2. Decisions

| Area | Decision |
| --- | --- |
| Hosting | Hosted web application with authenticated accounts. |
| Source of truth | Application database, not a Markdown folder. |
| Existing libraries | One-time Markdown import; preserve scene order, front matter, Codex entries, planning/timeline material, comments, and revision history. Keep the imported folder untouched as an archive. |
| Writing unit | A chapter is edited as continuous rich text, divided by fixed scene records created and reordered in the chapter outline. |
| Formatting | Rich-text controls; authors never need to work with Markdown syntax. |
| Entity linking | Detect likely entity mentions; show them as subtle dotted/colored candidates until confirmed. Do not interrupt drafting. |
| Ambiguity | Defer ambiguous links to a review queue. Codex entries include nicknames/aliases. |
| Codex | Right panel provides current-scene context cards and a searchable full Codex. |
| Scene notes | Collapsible margin alongside the prose. |
| Diagnostics | Inline highlight/message at the relevant text or field plus a quiet compact issue count; warnings never block writing. |
| Planning | Rich notes and visual timeline/board views. |
| History | Automatic rolling restore points; retain the newest three or four versions. |
| Comments | Passage-anchored comments now, shaped for future threaded feedback. |
| Exports | Full book: Markdown, DOCX, EPUB. Selected chapters: Markdown. |
| Sharing | Invite people with a role: reader/commenter or editor. |
| Routine CI | One Linux fast check: install, lint, and production build. Full validation remains a deliberate release gate. |

## 3. Experience map

```text
Library → Series → Book → Chapter writer
                         ├─ continuous rich prose / fixed scene breaks
                         ├─ collapsible scene-notes margin
                         ├─ inline entity candidates and diagnostics
                         └─ right panel: current-scene cards | full searchable Codex

Review queue ← unconfirmed or ambiguous entity mentions
Planning     ← rich notes | timeline | board
Export       ← Markdown | DOCX | EPUB
Share        ← invited readers/commenters | editors
```

## 4. Architecture direction

The current local, file-canonical design is intentionally superseded. Before implementation, replace ADR 0001 (local file-canonical stack) and ADR 0002 (CodeMirror Markdown editor) with hosted-application and rich-text-editor ADRs, and revise the contracts that promise Markdown canon or no account requirement. ADR 0003 (story planner) stays; its storage section is amended.

### Service model

- React web client served as a hosted application.
- Authenticated HTTP API with authorization at every book and series boundary.
- Relational production database (PostgreSQL) with a migration tool and transactional writes.
- Object storage only for optional uploads/media; manuscript and structured authoring data remain in the database.
- Background worker/queue for import, export, mention analysis, and diagnostics so drafting stays responsive.
- Automated encrypted database backups and an author-accessible export path.

### Core records

| Record | Essential fields / relationships |
| --- | --- |
| User | account identity and membership roles. |
| Series | owner, title, shared world/Codex scope, ordered books. |
| Book | series, title, metadata, ownership, ordered chapters. |
| Chapter | book, title, ordered scenes, chapter-level rich document projection. |
| Scene | chapter, order, rich-text document, notes, status, metadata, word count. |
| Codex entry | series- or book-scoped type, name, aliases, structured fields, rich details, relations. |
| Mention | scene range, candidate entry, confidence, state (`suggested`, `confirmed`, `dismissed`, `ambiguous`). |
| Diagnostic | source rule, severity, target record/range/field, message, resolution state. |
| Planning item | rich note, timeline event, board card, links to story records. |
| Comment | anchored text range, author, thread, state, permissions. |
| Restore point | rolling scene/document snapshot with creation reason and retention policy. |
| Membership | subject, book or series scope, role (`owner`, `editor`, `commenter`, `reader`). |
| Import/export job | source/target, progress, warnings, downloadable result, audit metadata. |

Use stable UUIDs for database records. Store editor documents as structured JSON with a schema version; derive export formats from that document. Do not reproduce Markdown front matter internally—map it to typed fields and preserve unrecognized imported fields in an `import_metadata` JSON column until the author resolves them.

## 5. Delivery phases

### Phase 0 — Freeze the target and retire conflicting assumptions

1. Write the hosted/database ADR and an explicit Markdown import/export compatibility policy.
2. Audit existing contracts, API documentation, tests, launch scripts, and user documentation for file-canonical or loopback-only assumptions.
3. Define the rich-text document schema, database schema, access model, and backup/recovery policy.
4. Add a migration test fixture containing all preserved legacy material.
5. Freeze the `/api/v1` and `codex_*` tool contracts as a compatibility suite that every later phase must pass.
6. Map the shared-mode JSON store (accounts, invites, share links, audit log, roles) onto the new membership model.
7. Decide whether M13 Milestone 5 (PDF export) is built on the file model now or deferred to Phase 5.

**Exit criteria:** the new contracts make database authority, hosted authentication, role permissions, exporter fidelity, retention, and recovery testable.

### Phase 1 — Hosted foundation and data migration

1. Move the existing shared-mode accounts, sessions, and roles into PostgreSQL (with migrations); add series/book ownership. Keep OAuth 2.1 MCP sign-in working.
2. Implement books, chapters, fixed scenes, rich documents, Codex entries with aliases, notes, planning data, comments, and restore points.
3. Build an idempotent Markdown importer with dry-run report and per-record warnings.
4. Archive the original import folder without altering it; provide an import receipt linking its source fingerprint to the resulting book.
5. Build API integration tests for authentication, tenancy isolation, ordering, and rollback.

**Exit criteria:** a representative current library imports without loss of the required material; a second import is safe; imported data can be read and edited from the hosted app.

### Phase 2 — Chapter-first Write mode

1. Replace raw Markdown editing with a rich-text chapter editor that renders scenes in one continuous reading/writing flow.
2. Add chapter-outline controls to create, rename, reorder, and move fixed scenes.
3. Add collapsible scene-note margins and autosave states.
4. Make the default writer chrome quiet: prose and scene boundaries first, optional controls second.
5. Create automatic restore points at meaningful save boundaries and prune to the newest four versions per document.

**Exit criteria:** an author can draft, navigate, reorder, restore, and read a complete chapter without opening a file or seeing Markdown syntax.

### Phase 3 — Codex and entity-aware writing

1. Add all initial entry types: character, location, item, faction, lore, creature, language, magic system, and custom types.
2. Build mention detection and candidate confidence rules; never block typing.
3. Render unconfirmed mentions with accessible subtle dotted/color treatment.
4. Add the review queue, alias/nickname matching, confirm/dismiss controls, and deferred ambiguity resolution.
5. Implement inline entity cards and a right panel with two modes: current-scene context and full Codex search.
6. Permit quick confirmation and adding a note from an entity card; reserve structural edits for the full entry experience.

**Exit criteria:** a new character mention can be detected, confirmed, navigated, and shown in scene context without author-maintained tags.

### Phase 4 — Diagnostics and planning without noise

1. Adapt continuity and validation rules to database records and rich-text ranges. Re-anchor the M13 findings layer (Harper, textlint) from Markdown offsets to rich-text ranges.
2. Render diagnostics inline at the relevant prose range or Codex field, with an optional compact issue summary.
3. Treat warnings as non-blocking; restrict blocking behavior to data-integrity failures.
4. Build linked rich planning notes, a timeline, and a board view.
5. Link planning records and diagnostics back to the actual scene or Codex evidence.

**Exit criteria:** every visible issue navigates to its exact source, and authors can keep drafting while warnings exist.

### Phase 5 — Export, sharing, and hardening

1. Produce full-book Markdown, DOCX, and EPUB exports from the database; add selected-chapter Markdown export. Reuse the M13 EPUBCheck validation and Paged.js interior preview.
2. Verify export ordering, prose fidelity, scene separators, entity-link text behavior, and deterministic metadata where possible.
3. Carry the existing invitation flow and roles onto the database; tighten them to reader/commenter and editor; ship comments as threaded feedback.
4. Add backup/restore drills, rate limits, audit logs for sharing, accessibility review, and performance testing on large books.
5. Define the intentional release process: full `npm run ci`, migration rehearsal, export regression suite, and backup/restore drill.

**Exit criteria:** an owner can invite a person, maintain correct role boundaries, export a publishable book, and restore the database through a rehearsed path.

## 6. Non-goals for the first hosted release

- Real-time multi-cursor editing.
- Automatic acceptance of detected entity links.
- AI-generated prose or analysis in the main writing loop.
- Unlimited revision retention.
- A public read-only link.
- Requiring users to manage Markdown folders or Git.

## 7. Validation matrix

| Risk | Required proof |
| --- | --- |
| Import loss | Fixture with every required source category; record counts, ordering, metadata mapping, comments, and history assertions. |
| Writer loss | Autosave/reload and restore-point tests across each scene in a chapter. |
| Wrong entity link | Alias, ambiguity, confirm, and dismiss tests; no automatic confirmation. |
| Noisy diagnostics | UI tests asserting source-range navigation and non-blocking warning behavior. |
| Export loss | Golden Markdown/DOCX/EPUB outputs and re-import/readback checks where applicable. |
| Sharing leak | Authorization tests for every role, series/book boundary, comment action, and export route. |
| Data recovery | Scheduled backup restore rehearsal against a clean environment. |

## 8. Sequencing and next implementation slice

The CI simplification is written but not yet on `v2`; land it as its own small PR first. The next coding work should be **Phase 0**, not a partial editor rewrite: agree on the hosted-data ADR, select the deployment/database and authentication approach, and turn the import fixture into executable migration requirements. That prevents building the new writing UI on the current file-canonical repository interface.

After Phase 0, deliver Phase 1 as the first vertical slice: sign in, create a series/book/chapter/scene, import one legacy book, and show the imported chapter through the hosted API. Only then begin the rich Write mode.
