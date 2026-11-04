# StoryForge

StoryForge is a Markdown-first novel studio. You write in a web app that runs on your own computer (or on a server you run for a group). Every book is a plain folder of
Markdown files with a small amount of front matter, so the folder is the whole project: you can read it, back it up, version it and open it in any editor without StoryForge.

It has a manuscript editor with a scene tree and boards, a Codex of characters, places and things, timelines and threads, a continuity checker that points at the exact lines
that disagree, export to Markdown, Word, EPUB and PDF, an optional AI workshop, provenance receipts ("keep the receipts"), an optional shared mode with accounts and roles, and an
HTTP API and webhooks for your own tools.

## What you can rely on

- No paywalls.
- No mandatory telemetry (none at all).
- No account required in personal mode.
- Markdown is canonical and the folder is the whole project.
- AI is off until configured, and nothing is sent without preview and Send.
- Receipts are private.

These are release guarantees; the checks behind them (the zero-traffic test, the lint rules that confine network code to two files, the secret scan) are part of `npm run ci`.

## Install

Easiest: `StoryForge.cmd` (Windows) or `./storyforge.sh` (macOS, Linux) installs on the first run, builds, starts and opens the browser. Full instructions, where your data lives and how to back up or remove StoryForge: [docs/install.md](docs/install.md). `node apps/server/src/main.mjs --help` lists every command and flag.

By hand: needs Node 24 (see `.nvmrc`; `>=22` works).

```sh
npm ci
npm run build
npm start -- --library <path-to-library-or-book>
```

Then open `http://127.0.0.1:4317/`. `--port <n>` or `STORYFORGE_PORT` changes the port; `STORYFORGE_LIBRARY` can replace `--library`; with neither, StoryForge opens the library you used last (else a `StoryForge` folder in your home folder). `--open` opens the browser. For UI work run the server as above and `npm run dev` (Vite proxies `/api` to port 4317).

A release is one zip, `storyforge-<version>.zip`, with a `.sha256` file beside it; see [docs/release-checklist.md](docs/release-checklist.md) and [the release notes](docs/release-notes/0.1.0.md).

## Checking the whole repository

`npm run ci` is the one command that is the CI: lockfile check, build, lint, all tests, the large-library tests, named test groups, a UI smoke test, the security and licence checks and the release build. `.github/workflows/ci.yml` runs exactly that on Linux, macOS and Windows. `npm run lint` and `npm test` alone check the code and the tests.

## Layer rule

```text
apps/web        talks to the server over /api only (no node:*, no @storyforge/* imports)
apps/server     calls the FileRepository interface; no filesystem access except src/static.mjs
packages/core   the only module that reads project files is src/fs-repository.mjs
```

ESLint (`eslint.config.mjs`) enforces this. Details: `docs/decisions/0001-local-web-app-stack.md` and `docs/contracts/M01-J01-app-boundary.md`.

Workspaces: `apps/web` (React + Vite UI), `apps/server` (the local server, the command line and the API), and `packages/*` (the format validator, the single writer in `store`, the domain layer in `core`, the index, continuity, export, receipts, AI, shared mode, integrations and the rest).

## Documentation

- [Installing and running](docs/install.md)
- [Getting started with the sample book](docs/getting-started-sample.md)
- [What is in a book folder](docs/format.md)
- [Backing up and restoring](docs/backup-restore.md)
- [Moving from the old StoryForgeHub](docs/migration.md)
- [Privacy and the optional AI workshop](docs/privacy-ai.md)
- [API v1 and webhooks](docs/api.md) and [writing a plugin](docs/plugins.md)
- [Connecting Claude (MCP)](docs/mcp.md)
- [Customization](docs/customization.md)
- [Accessibility](docs/accessibility.md) and [performance](docs/performance.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Self-hosting for a group (Docker, systemd, TLS, backups)](docs/self-hosting.md)
- [Developing StoryForge](docs/development.md) and [contributing](CONTRIBUTING.md)
- [Compatibility: what stays stable between versions](docs/compatibility.md)
- [Release checklist](docs/release-checklist.md), [release notes](docs/release-notes/0.1.0.md) and the [changelog](CHANGELOG.md)
- [Security policy](SECURITY.md) and [code of conduct](CODE_OF_CONDUCT.md)

## Licence

StoryForge is free software under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`). The full text is in [LICENSE](LICENSE). In short: you may use, study, change and share it; if you run a modified version as a network service for other people, you must offer them the source of your version. The books you write with it are yours; the licence covers StoryForge, not your manuscripts.
