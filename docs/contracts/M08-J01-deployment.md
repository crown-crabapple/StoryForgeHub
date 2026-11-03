# M08-J01 contract — local, Docker and self-hosted deployment

Binding: DECISIONS 1, 5, 7, 9, 12; M06-J03 launcher and `docs/install.md`; M07-J03 shared mode (`serve --shared`, `shared init`, `audit verify`); owner decision 2026-11-02: no live Docker run on the build machine. Docker files are written and checked statically, and the container's start-up path is tested without Docker.

## 1. Local paths (exist; tighten)

- **Single user:** `StoryForge.cmd` / `storyforge.sh` (M06-J03). Nothing changes except that `docs/install.md` gains a short "Upgrade" section: replace the StoryForge folder, then run the launcher; indexes rebuild by themselves on a schema change.
- **Local development:** a new `docs/development.md` covering `npm ci`, `npm run dev` (if it exists; otherwise document the build plus start loop), test commands, workspace map, lint boundaries, and where fixtures live.

## 2. Container image — `deploy/Dockerfile`

- **Base:** `node:24-bookworm-slim` pinned by digest comment, plus tag. Multi-stage: `npm ci` and `npm run build` in a build stage, then a runtime stage with `npm ci --omit=dev`, or a copy of the built tree with production `node_modules` only.
- **User:** runs as a non-root user (uid 10001) with a read-only app directory.
- **Volumes:**
  - `/library`: the author's Markdown library, mounted from the host so that storage stays user-controlled;
  - `/config`: the per-user config folder, holding profiles, recent libraries and AI settings;
  - `/shared-data`: accounts, sessions and audit in shared mode.

  None of them is inside the image.
- **Entrypoint:** `deploy/entrypoint.mjs`, a Node script and therefore testable without Docker. It reads env:
  - `STORYFORGE_MODE`: `personal` | `shared`, default `shared` in the container;
  - `STORYFORGE_PUBLIC_URL`;
  - `STORYFORGE_PORT`, default 4317;
  - `STORYFORGE_HOST`, default `0.0.0.0` in shared mode;
  - `STORYFORGE_OWNER`: when set and the shared data has no owner, it runs `shared init` once and prints the setup link to the log;
  - `XDG_CONFIG_HOME=/config`, `STORYFORGE_LIBRARY=/library`.

  It then execs `node apps/server/src/main.mjs serve …`.
- **Personal mode in a container:** it binds 127.0.0.1 inside the container, which is only useful with `network_mode: host`. The docs say so, and the entrypoint refuses `personal` with a non-loopback host, as the CLI does.
- **No telemetry:** no network call at start-up or at runtime unless the author configures an AI provider. Existing zero-traffic rules apply.
- `HEALTHCHECK` uses `GET /api/health` via `node -e` (curl is not in slim).
- `.dockerignore` excludes `node_modules`, `.git`, test fixtures not needed at runtime, and any `.storyforge/`.

## 3. Compose — `deploy/compose.yaml`

- **Service `storyforge`:**
  - built from `deploy/Dockerfile`;
  - three bind mounts or named volumes (`./library`, `./config`, `./shared-data`);
  - `restart: unless-stopped`;
  - env from `deploy/storyforge.env.example`, documented line by line;
  - the port published on `127.0.0.1:4317` by default.
- An optional commented `caddy` service shows TLS termination with automatic certificates. It is not enabled by default.
- **No database service.** The index is SQLite inside each book's `.storyforge/`, a disposable cache. Schema migrations are "rebuild on version change" (existing behaviour); this is documented.

## 4. Operations — `docs/self-hosting.md`

- **Install:**
  - Docker Compose;
  - bare Node with systemd (a unit file example, `deploy/storyforge.service`);
  - a reverse proxy with TLS (Caddy and nginx snippets).

  Each path ends at the setup link and the first login.
- **Upgrade:** pull/rebuild, restart. Indexes rebuild themselves. Shared-data file versions are checked at start; unknown versions stop the server instead of being rewritten.
- **Backups:**
  - what to back up: the `library/` folder, which is canonical, and `shared-data/`, which holds accounts and audit;
  - what not to back up: `.storyforge/`, which is a cache;
  - the in-app per-book backup;
  - a restore drill.
- **Authentication and session security:**
  - summary of M07-J03 (scrypt, cookie flags, roles, rate limits, audit);
  - TLS is required for non-loopback access;
  - rotating the owner password;
  - re-issuing a setup link;
  - revoking every session by removing and re-inviting a member.
- **Operational recovery:**
  - a corrupt shared-data file stops the server, with the file named;
  - `audit verify`;
  - a lost owner password: stop the server, then use `shared init --owner <same name>` while that owner has no password. Otherwise, a documented manual reset that removes the `pw` record of that user in `users.json` and re-issues setup. This needs a new CLI command, `shared reset-owner --owner <name>`. It holds the library lock, works only for an existing owner, and clears that owner's password and sessions, then prints a setup link.
- **Privacy:** no telemetry, no update checks, no account with anyone. AI only when configured. Where every byte lives.

## 5. Tests (no Docker needed)

1. **`deploy/entrypoint.mjs`:**
   - Spawned with env as the container sets it, on temp dirs for `/library`, `/config` and `/shared-data`, and a copy of the `salt-orchard` fixture as the library.
   - With `STORYFORGE_OWNER` it prints a setup link once, and not again on a second start.
   - The server answers `/api/health` and `/api/auth/me`. For the test the host is overridden to 127.0.0.1.
   - A second start keeps the data.
2. **`shared reset-owner`:**
   - It refuses while the library is locked.
   - It refuses a non-owner.
   - It clears the password and every session of that owner, and the old password no longer logs in.
   - The setup link works; the audit has `owner.reset`.
3. **Static checks of the Docker files**, parsing the text, no Docker:
   - the Dockerfile uses a non-root `USER`;
   - it declares `/library`, `/config` and `/shared-data`;
   - it has no `curl | sh`;
   - the base image is pinned;
   - the entrypoint is `deploy/entrypoint.mjs`;
   - the compose file publishes on `127.0.0.1` by default;
   - it mounts the three folders;
   - it contains no secrets;
   - `.dockerignore` excludes `node_modules` and `.git`.
4. **Same sample project, both paths:**
   - personal mode via the launcher's start command, and shared mode via the entrypoint, each on its own copy of `salt-orchard`;
   - each opens the book;
   - `validate` gives 0 errors;
   - a backup made in each restores into a new folder and validates;
   - the two restores are byte-identical.
5. **No telemetry:** both start-ups under the network-recorder preload (M05-J04 tests) make zero outbound connections.

## 6. Acceptance

- The contract §5 tests pass.
- `docs/self-hosting.md`, `docs/development.md` and the install upgrade section exist, and every command they name exists in `--help`.
- `npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
- **Open item (owner decision):** a live `docker compose up` on a machine with Docker, then open the sample, run validate, and restore a backup. The steps are listed in RESULT for the owner to run.
