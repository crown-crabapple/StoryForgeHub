# M01-J01 contract — v2 application boundary (read-only)

Stack and layers: [ADR 0001](../decisions/0001-local-web-app-stack.md). Format: `E:\StoryForgeHub\storyforge-v2-production-plan\spec\FORMAT-v1.md`. Design tokens: `E:\StoryForgeHub\storyforge-v2-production-plan\design\README.md`.

## Repo layout after this job

```text
package.json            private, "workspaces": ["packages/*", "apps/*"], scripts below, engines node >=22
package-lock.json       committed
.nvmrc                  24
eslint.config.mjs       flat config; boundary rules below
packages/format/        (exists, unchanged except package.json scripts if needed)
packages/manuscript/    (exists, unchanged except package.json scripts if needed)
packages/core/          NEW — @storyforge/core
apps/server/            NEW — @storyforge/server
apps/web/               NEW — @storyforge/web (React + Vite)
```

Root scripts: `build` (builds apps/web), `lint` (eslint .), `test` (runs every workspace's `test`), `start` (builds web if needed, then starts server). `npm ci && npm run build && npm run lint && npm test` must pass on a clean clone.

## `@storyforge/core`

### FileRepository interface (JSDoc typedef in `src/repository.mjs`)

All methods async. Read-only in this job. All paths returned are relative to the library root, forward slashes.

```ts
interface FileRepository {
  libraryInfo(): Promise<{ root: string; title: string | null; diagnostics: Diagnostic[] }>;
  listBooks(): Promise<BookSummary[]>;                  // sorted by series slug, series_number, then title
  getBook(bookId: string): Promise<BookDetail | null>;  // by book ID (book_…)
  getScene(bookId: string, sceneId: string): Promise<SceneDoc | null>;
  getDiagnostics(bookId?: string): Promise<Diagnostic[]>;
}
type BookSummary = { id, slug, title, series: string|null, series_number: number|null, status, path, scene_count, word_count, error_count, warning_count };
type BookDetail  = BookSummary & { acts: { act, label, chapters: { chapter, label, title|null, scenes: SceneSummary[] }[] }[], excluded: Excluded[] };
type SceneSummary = { id, title, position, act, chapter, sequence, status, pov: string|null, word_count, path };
type SceneDoc    = SceneSummary & { front_matter: object, body: string };   // body exactly as on disk (after front matter)
```

- `word_count` = count of `\S+` runs in the body after removing HTML comments and fenced code. Computed, never stored.
- Diagnostic is the `@storyforge/format` shape.

### FsRepository

`createFsRepository(libraryRoot)` implements the interface on disk, using `validate()` from `@storyforge/format` for structure and order. It is the **only** module in the repo (outside packages/format and packages/manuscript) allowed to import `node:fs`. It caches nothing between calls in this job (M01-J03 adds the index).

A `libraryRoot` that holds `book.md` directly is treated as a one-book library.

### Config

`loadConfig({ argv, env })` → `{ libraryRoot, host: '127.0.0.1', port }`. Order: `--library <path>` arg, then `STORYFORGE_LIBRARY` env. Port: `--port`, `STORYFORGE_PORT`, default `4317`. Missing library → clear error, exit 2. Host is always `127.0.0.1` in this job (no flag to change it).

## `@storyforge/server`

`node apps/server/src/main.mjs --library <path>` serves:

| Route | Response |
|---|---|
| `GET /api/health` | `{ ok: true, version, library }` |
| `GET /api/library` | `libraryInfo()` |
| `GET /api/books` | `listBooks()` |
| `GET /api/books/:bookId` | `getBook()` or 404 `{ error: 'not_found' }` |
| `GET /api/books/:bookId/scenes/:sceneId` | `getScene()` or 404 |
| `GET /api/books/:bookId/diagnostics` | `getDiagnostics(bookId)` |
| `GET /*` | static files from `apps/web/dist` (SPA fallback to `index.html`) |
| any non-GET | 405 `{ error: 'read_only' }` |

- JSON with `content-type: application/json; charset=utf-8`.
- Refuse requests whose remote address is not loopback (403), and whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (403; DNS-rebinding guard).
- Static serving must not escape `dist/` (path traversal → 404).
- Export `createServer({ repository, webRoot })` so tests can run it on port 0 with a fake or real repository.

## `@storyforge/web`

React + Vite, plain `.jsx`. Talks only to `/api/*` via `fetch`.

- **Library view** (`/`): list of books (title, series, scene count, word count, status, warning/error counts).
- **Book view** (`/books/:bookId`): left column = manuscript tree (act → chapter → scenes in order); centre = selected scene's body rendered as plain preformatted text with the Literata font (no Markdown rendering yet; read-only); right column = diagnostics for the book.
- Keyboard: every book and scene is a real `<a href>` or `<button>`; Tab reaches them in order; Enter opens.
- Styles: CSS custom properties from the design tokens (`--bg #0E0E10`, `--surface #16161A`, `--divider #26262C`, `--border #2A2A31`, `--text #ECECEF`, `--text-2 #A1A1AA`, `--muted #8B8B95`, `--accent #E0A64B`), Inter for UI, Literata for scene text (Google Fonts link). No component library. This is a skeleton; M02-J01 builds the real visual system.
- Dev: `npm run dev -w @storyforge/web` with a Vite proxy of `/api` to `http://127.0.0.1:4317`.

## Lint boundary rules (eslint `no-restricted-imports`)

- `apps/web/**`: forbid `node:*`, `fs`, `path`, and any `@storyforge/*` import.
- `apps/server/**`: forbid `node:fs`, `node:fs/promises`, `fs` (static file serving goes through a small helper in `apps/server/src/static.mjs`, which is the one allowed exception, listed in the config).
- `packages/core/src/**` except `fs-repository.mjs`: forbid `node:fs`, `node:fs/promises`, `fs`.

## Acceptance

1. `npm ci && npm run build && npm run lint && npm test` pass on a clean clone (no `.storyforge/`, no DB, no env vars except none).
2. `node apps/server/src/main.mjs --library packages/format/fixtures/valid/salt-orchard` serves the book; `GET /api/books/<id>` returns the 7 scenes in the fixture's expected order.
3. The fixture folder is byte-identical after starting the server and calling every route (read-only).
4. Lint fails if a forbidden import is added (tested by a lint test fixture or a test that runs eslint on a temp file).
5. Server rejects a request with `Host: evil.example` (403) and any POST (405).

## Tests (test-author)

- `packages/core/test/`: FsRepository on salt-orchard, library, spec-example and one invalid fixture (diagnostics surfaced, no throw); word counts on a fixed body; scene body exact bytes; read-only (hash snapshot before/after); config precedence.
- `apps/server/test/`: every route (status, shape, 404s, 405, 403 Host, traversal 404) using `createServer` on port 0 with the real FsRepository on a temp copy of salt-orchard.
- `apps/server/test/boundary.test.mjs`: eslint (run via its Node API from the repo root config) rejects `import fs from 'node:fs'` in an apps/web file and an apps/server route file.
