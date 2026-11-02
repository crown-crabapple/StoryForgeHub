# StoryForge v2

Markdown-first novel studio. Plan: `E:\StoryForgeHub\storyforge-v2-production-plan`.

- `packages/format/` — format v1 validator and fixtures (M00-J03).
- `packages/manuscript/` — safe scene insert/move/renumber (M00-J04).
- `packages/core/` — `@storyforge/core`: the `FileRepository` interface, `FsRepository` and config.
- `apps/server/` — local, read-only JSON API plus the built web app, bound to `127.0.0.1`.
- `apps/web/` — React + Vite UI (library view and book view).

## Run

Easiest: `StoryForge.cmd` (Windows) or `./storyforge.sh` (macOS, Linux) installs on the first run, builds, starts and opens the browser. Full instructions, where your data lives and how to back up or remove StoryForge: `docs/install.md`. `node apps/server/src/main.mjs --help` lists every command and flag.

By hand: needs Node 24 (see `.nvmrc`; `>=22` works).

```sh
npm ci
npm run build
npm start -- --library <path-to-library-or-book>
```

Then open `http://127.0.0.1:4317/`. `--port <n>` or `STORYFORGE_PORT` changes the port; `STORYFORGE_LIBRARY` can replace `--library`; with neither, StoryForge opens the library you used last (else a `StoryForge` folder in your home folder). `--open` opens the browser. For UI work run the server as above and `npm run dev` (Vite proxies `/api` to port 4317).

`npm run lint` and `npm test` check the whole repo.

## Layer rule

```text
apps/web        talks to the server over /api only (no node:*, no @storyforge/* imports)
apps/server     calls the FileRepository interface; no filesystem access except src/static.mjs
packages/core   the only module that reads project files is src/fs-repository.mjs
```

ESLint (`eslint.config.mjs`) enforces this. Details: `docs/decisions/0001-local-web-app-stack.md` and `docs/contracts/M01-J01-app-boundary.md`.

## Documentation

- [Installing and running](docs/install.md)
- [Getting started with the sample book](docs/getting-started-sample.md)
- [What is in a book folder](docs/format.md)
- [Backing up and restoring](docs/backup-restore.md)
- [Moving from the old StoryForgeHub](docs/migration.md)
- [Privacy and the optional AI workshop](docs/privacy-ai.md)
- [Troubleshooting](docs/troubleshooting.md)
