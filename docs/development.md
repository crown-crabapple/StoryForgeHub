# Developing StoryForge

For people who change StoryForge itself. To write with it, see [Installing and running](install.md); to run it for a group, see [Self-hosting](self-hosting.md).

You need Node.js 22 or newer (24 is what the project is built and tested with) and npm.

## Set up

```sh
npm ci            # installs every workspace from package-lock.json
npm run build     # builds the web app into apps/web/dist (the server serves it)
```

`npm ci` is also what the launchers run on the first start. There is nothing else to install; no database server, no service.

## Run it while you work

There are two loops. Both need the server, because the web app only talks to `/api`.

1. **Server:** `npm start -- --library ./dev-library` builds the web app if `apps/web/dist` is missing and then serves the library on `127.0.0.1:4317`. The same thing without the
   helper: `node apps/server/src/main.mjs --library ./dev-library --port 4317`. Use a throwaway folder for `--library`, never a library you care about. Restart the server after you
   change server or package code.
2. **Web app, with hot reload:** in another terminal, `npm run dev`. Vite serves the web app and proxies `/api` to `http://127.0.0.1:4317`, so the server from step 1 must be running
   on that port. Open the address Vite prints.

Without `npm run dev` the loop is: edit the web app, `npm run build`, reload the browser at `http://127.0.0.1:4317/`.

To try shared mode locally (loopback only):

```sh
node apps/server/src/main.mjs shared init --owner dev --library ./dev-library --shared-data ./dev-shared
node apps/server/src/main.mjs serve --shared --library ./dev-library --shared-data ./dev-shared
```

`--shared-data` must not be inside the library. Open the setup link that `shared init` prints. Everything the command line can do is listed by `node apps/server/src/main.mjs --help`.

## Tests, lint and build

| Command | What it does |
| --- | --- |
| `npm test` | Every workspace's tests (`node --test`). Run from the repository root. |
| `npm test -w @storyforge/server` | One workspace. Workspace names are in each `package.json`, for example `@storyforge/core`, `@storyforge/format`. |
| `node --import ./scripts/test-isolate-config.mjs --test apps/server/test/launch.test.mjs` | One test file. The `--import` points the per-user config folder at a temporary folder so a test never touches your real settings; the workspace scripts do the same. |
| `npm run test:large` | The slow large-library tests (`*.large.mjs`), kept out of the normal run. |
| `npm run lint` | ESLint over the whole repository, including the boundary rules below. |
| `npm run build` | The web build. |

Before you hand work over: `npm run build && npm run lint && npm test`.

The tests never need the internet, Docker or a browser. Tests that need a server start a real one on `127.0.0.1` with port `0` (a free port) in a temporary folder.

## Workspace map

```text
apps/web            React app (Vite). Talks to the server over /api only.
apps/server         The HTTP server and the command line (src/main.mjs, help.mjs, shared-cli.mjs, ...). Tests in apps/server/test.
packages/format     The book-folder format: parse and validate Markdown files (the validator).
packages/manuscript safe scene insert, move and renumber, and repair planning.
packages/core       The domain model, the FileRepository, the library lock and the config.
packages/store      The only package that writes files (atomic writes, locks, the user config folder).
packages/index      The SQLite index (a disposable cache inside .storyforge/).
packages/continuity, receipts, suggestions, export, templates, ai, claude-book, legacy-import, shared
                    continuity rules, provenance receipts, suggestions, export and backup, new-book templates, the optional AI workshop,
                    the Claude-Book adapter, the old-StoryForgeHub importer, and shared-mode accounts (shared).
deploy/             Dockerfile, compose.yaml, the container entrypoint, a systemd unit and a Caddy example.
scripts/            The launcher (launch.mjs), npm start (start.mjs) and the test config isolation.
docs/               User docs; docs/contracts holds the job contracts the code is built against.
```

## Lint boundaries

`eslint.config.mjs` enforces these; a violation is a lint error, not a convention.

- **Files are written only in `packages/store`.** Reads are allowed only in `packages/format`, `packages/templates/src`, `packages/core/src/fs-repository.mjs` and
  `apps/server/src/static.mjs`. `apps/server` and the other packages must not import `node:fs`.
- **Outbound network I/O exists in one place:** `packages/ai/src/transport.mjs`. Everywhere else in `packages/**` and `apps/server/**` the `fetch` and `WebSocket` globals and
  `node:https`, `node:net`, `node:tls`, `node:dgram`, `node:http2`, `undici` and `node:http` are errors (the server may only import `node:http` to create its listener).
  Tests are exempt.
- **`node:sqlite` is only for `packages/index/src`.**
- **`apps/web` is browser code:** no Node built-ins and no `@storyforge/*` imports.
- `scripts/` and `deploy/` are launchers, not part of the app; they may use Node built-ins directly.

## Where the fixtures live

- `packages/format/fixtures`: the sample books and the error cases for the validator. `valid/salt-orchard` is the sample book most tests copy to a temporary folder; its
  `expected.json` holds the expected validator output. These folders are excluded from lint.
- `packages/manuscript/fixtures`: the manuscript package's own cases.
- `apps/server/test/fixtures`: small helpers for server tests (a self-signed test certificate, crash-test child scripts).
- `apps/server/test/helpers.mjs` has `copyFixture('valid/salt-orchard')` and `snapshot()` (a hash of every file, to prove that something did not change).

A test never writes into a fixture folder; it copies the fixture first.

## The deployment tests

`apps/server/test/deploy-*.test.mjs` cover the container without Docker: the entrypoint is started with Node on temporary folders that stand in for `/library`, `/config` and
`/shared-data` (with the host overridden to `127.0.0.1`), and the Dockerfile, compose file and examples are checked as text. Docker itself is not part of `npm test`.
