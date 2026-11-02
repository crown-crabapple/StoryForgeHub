# ADR 0001 — Local web app on Node, React and built-in SQLite

**Status:** accepted 2026-11-01 (owner chose "local web app"). **Job:** M01-J01.

## Context

- The project folder of Markdown files is the only source of truth ([FORMAT-v1](../../../storyforge-v2-production-plan/spec/FORMAT-v1.md), DECISIONS 1–5).
- The app must run with no database service and no cloud account, and later be self-hostable (Docker, multi-user server in M07–M08).
- M00 already produced two plain-ESM Node packages: `@storyforge/format` (validator) and `@storyforge/manuscript` (safe ordering ops).
- The legacy app (PHP 8.3 + MySQL, TipTap editor) is DB-first; its server code can't be reused. Its TipTap Markdown layer (`editor/src/codex-md.js`) can.
- The UI must match the reference design (`design/README.md`): dark graphite, gold accent, three-column workspaces.

## Decision

| Concern | Choice | Why |
|---|---|---|
| Shape | A local server bound to `127.0.0.1`, opened in the browser | Same code later runs on a server or in Docker. Desktop wrapper possible later without a rewrite. |
| Runtime | Node 24 LTS (`>=22`) | Already used by M00; has built-in `node:sqlite` and `node --test`. |
| Language | Plain ES modules + JSDoc, `.mjs` / `.jsx` | Matches M00; no compile step for the core; type hints without a TypeScript build. |
| HTTP | `node:http` + a small in-repo router | Local JSON API with a handful of routes; no framework dependency. |
| UI | React + Vite | Largest ecosystem; TipTap has first-class support (M03). |
| Index | `node:sqlite` (M01-J03) | No native add-on to compile; disposable cache only. |
| Tests | `node --test` everywhere | One runner; already in use. |
| Lint | ESLint flat config, incl. import boundaries | Enforces the layer rules below. |
| Packaging | npm workspaces, exact pinned versions, committed `package-lock.json`, `.nvmrc` | Reproducible clean checkout. |

Dependency rule: pin exact versions, each published at least 14 days before it is added.

## Layers (enforced by lint)

```text
apps/web        React UI      → talks only to the HTTP API (fetch). No node:*, no packages/* imports.
apps/server     HTTP API      → calls the FileRepository interface only. No node:fs in routes.
packages/core   domain + FileRepository interface + FsRepository (the ONLY module that reads project files)
packages/manuscript, packages/format   used by packages/core
```

## Rejected

- **Desktop shell (Tauri/Electron):** second toolchain, harder self-hosting. Can wrap the web app later.
- **Reusing the legacy PHP app:** database is authoritative there; contradicts DECISIONS 1 and 5.
- **TypeScript build:** extra compile step for little gain at this size; revisit if the codebase grows past what JSDoc handles.
- **Express/Fastify:** not needed for a local JSON API of under 20 routes.

## Consequences

- The browser cannot touch files; every read and write goes through the server and `FileRepository`.
- The server must refuse non-loopback connections until M07 adds auth.
- `node:sqlite` is still marked experimental in Node 24; if its API changes, only `packages/core`'s projection module is affected.
