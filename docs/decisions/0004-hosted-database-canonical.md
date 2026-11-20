# ADR 0004 — Hosted app with PostgreSQL as the source of truth

**Status:** accepted 2026-11-19 (owner: "start Phase 0" of [the hosted authoring plan](../plans/hosted-authoring-plan.md)). **Supersedes:** [ADR 0001](0001-local-web-app-stack.md) for storage, binding and accounts. ADR 0001's runtime, language, HTTP, UI, test and lint choices stand. **Job:** hosted plan, Phase 0.

## Context

- Since M01 the Markdown library folder has been the only source of truth, and the app has had no database service and no required account (ADR 0001, FORMAT-v1).
- The owner has chosen a hosted, personal writing app where the database is canonical, authoring is rich text, and sharing starts with invitations ([plan §2](../plans/hosted-authoring-plan.md#2-decisions)).
- A lot of `v2` stays useful: shared-mode accounts, invites, roles and the audit log; the `/api/v1` surface and the `codex_*` MCP tools; the continuity rules; the M13 checkers and the EPUB / Paged.js pipeline ([plan §0](../plans/hosted-authoring-plan.md#0-where-v2-stands-today)).
- This machine has no Docker. Tests must not need a database service to be running.

## Decision

| Concern | Choice | Why |
| --- | --- | --- |
| Source of truth | **PostgreSQL** (16 or newer). Every manuscript, Codex, planning, comment, history, account and membership record lives in it. | Transactions, constraints and concurrent access for a hosted, multi-user app. The plan names it. |
| Markdown library | **Import source and export target only.** A one-time, idempotent import with a dry-run report; the source folder is never written. Markdown export stays byte-stable where the format allows. | The owner wants smooth authoring over file-first workflows, and keeps existing libraries. |
| Driver | `pg` (node-postgres), hand-written SQL, no ORM. | Matches ADR 0001's "small in-repo pieces, no framework". SQL stays readable in review. |
| Migrations | Numbered plain `.sql` files in a new `packages/db/migrations/`, applied in order by a small in-repo runner that records them in a `schema_migrations` table inside one transaction each. | No tool to learn; reversible by restore, not by down-migrations. |
| Tests and local dev | **PGlite** (`@electric-sql/pglite`, Apache-2.0): real Postgres compiled to WebAssembly, in process. Each test gets a fresh in-memory database; local dev can use a PGlite data folder. CI and release also run the suite once against a real PostgreSQL. | No Docker or database service needed to run `npm test`. Same SQL dialect as production. |
| Ids | **Keep today's ids**: a kind prefix plus a 26-character ULID (`scene_…`, `entry_…`, `note_…`, `usr_…`), stored as the text primary key. New records get new ids of the same form. | A ULID is as stable, sortable and unique as the UUID the plan names, and keeping the format means every id an author, a tool or a link already holds keeps working through `/api/v1` and MCP. (Deliberate change from the plan's "UUIDs".) |
| Accounts and sessions | The shared-mode account, session, invite, share-link, role and audit records move into tables with the same meanings. Cookie sessions and OAuth 2.1 (MCP sign-in) keep their current flows. An account is required to use the hosted app. | Already built and tested; only the storage changes. |
| Authorization | Checked on the server at every series and book boundary, from the `membership` table. Roles: `owner`, `editor`, `commenter`, `reader` — today's `reviewer` and `viewer` renamed, same ranks and the same class rules (`policy.mjs` `NEEDS`). The shared-mode API keeps accepting the old names. | Plan §2 Sharing. Replaces the JSON per-book scope without changing who may do what. |
| Binding | Hosted behind the existing reverse proxy (Caddy) over HTTPS. `127.0.0.1` stays the default only for development. | The app is already deployed this way in shared mode. |
| The repository seam | `/api/v1`, the web routes and the MCP tools keep calling one repository interface (today `packages/core` `fs-repository.mjs`). Phase 1 adds a database repository behind the same interface. The file repository stays only for import and export. | Lets the API and tools stay stable while storage changes underneath. |
| Background work | A job table in the same database, polled by an in-process worker, for import, export, mention analysis and diagnostics. No separate queue service. | One fewer service to run and back up. |
| Media | Uploaded files in object storage or a disk folder, referenced from the database. Manuscript text never lives there. | Plan §4. |
| Backups | Nightly encrypted `pg_dump` kept off the server, plus a restore drill before each release. An author can export their books as Markdown at any time. | Plan §4 and §7 "Data recovery". Details in the Phase 0 contract. |

## What changes for existing guarantees

- "The files are the truth" (FORMAT-v1, M01 contracts) is **retired**. FORMAT-v1 now describes the import and export format.
- "Runs with no account and no database" (ADR 0001, install docs) is **retired** for the hosted app.
- The `/api/v1` routes and `codex_*` tool names, inputs and outputs are **kept**. A compatibility suite pins them from Phase 0 on (see the Phase 0 contract).
- `base_sha256` optimistic-concurrency checks are **kept** in the API. With a database the server hashes the record's canonical text form, so clients see no change.

## Consequences

- Phase 1 adds `packages/db` (schema, migrations, runner) and a database repository. Every later phase builds on it.
- Two runtimes for the tests: PGlite for speed everywhere, real PostgreSQL once in release CI. Any SQL that PGlite cannot run is a bug to fix, not to skip.
- Self-hosters now run PostgreSQL. `docs/self-hosting.md` and `docs/install.md` are rewritten in Phase 1.
- The legacy, file-only desktop mode is no longer developed. It stays readable through Markdown export.

## Rejected

- **Keep files canonical, add a database cache** — this is today's design. It cannot give transactions across scenes, Codex and comments, and it blocks the rich-text editor.
- **SQLite as the production database** — fine for one writer, but weak for a hosted, concurrent, multi-user server. It also needs a second migration path later.
- **An ORM (Prisma, Drizzle, Sequelize)** — adds a build or codegen step and hides the SQL. Not worth it for about 20 tables.
- **Docker Postgres for tests** — not available on this machine, and slow to start.
