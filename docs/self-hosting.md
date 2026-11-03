# Self-hosting StoryForge (shared mode)

This page is for the person who runs StoryForge for a small group on a server or a home machine: a few writers, editors and reviewers who log in with their own accounts. If you
write alone on your own computer you do not need any of this; see [Installing and running](install.md).

Shared mode is optional and sits on top of the same files. The library is still a folder of Markdown on the server's disk, and nothing moves into a database. Without
`--shared` StoryForge has no accounts and listens on `127.0.0.1` only. Everything the command line can do is listed by:

```sh
node apps/server/src/main.mjs --help
```

## What you run

One program, one port (4317), three folders:

| Folder in the container | What it holds | Back it up? |
| --- | --- | --- |
| `/library` | The Markdown library: every book, as ordinary files. This is the canonical copy of the writing. | **Yes** |
| `/shared-data` | Accounts, sessions, invites, share links and the audit log (small JSON files). Never inside the library, so a book backup never contains accounts. | **Yes** |
| `/config` | The server user's settings: recent libraries, appearance profiles, AI provider settings (a key lives here only if you chose to save it in the settings file). | Optional |

Inside each book, `.storyforge/` is a disposable cache (the search index). **Do not back it up**; it is rebuilt from the files.

There is no database service. When the index format changes in a new version, StoryForge rebuilds each book's index by itself.

## Install

All three ways end the same: the server prints a **one-time setup link** for the owner, the owner opens it, chooses a password and is logged in. The link works once and
lasts 30 minutes. Nothing is ever e-mailed; the link appears in the log (or the terminal) of whoever started the server.

Before you start, decide the address people will use, for example `https://write.example.org`. Anything that can be reached from other computers must be served over **HTTPS**:
passwords and session cookies must not cross a network in the clear (see "TLS" below).

### Option A: Docker Compose

You need Docker with the Compose plugin. All files are in `deploy/`.

```sh
cd deploy
cp storyforge.env.example storyforge.env        # then edit it: STORYFORGE_OWNER and STORYFORGE_PUBLIC_URL
mkdir -p library config shared-data
sudo chown -R 10001:10001 library config shared-data   # the container runs as user 10001, not root
docker compose up -d --build
docker compose logs storyforge                  # look for "Open this link within 30 minutes ..."
```

- Put your existing books in `deploy/library/` (each book is a folder; a folder of books is a library). An empty library works too; create the first book in the app.
- Compose publishes the app on `127.0.0.1:4317` of the host only. Put a TLS reverse proxy in front of it (below), or use the optional `caddy` service described in
  `deploy/compose.yaml`.
- `deploy/storyforge.env.example` explains every setting, line by line. The ones you will touch: `STORYFORGE_OWNER` (the owner's user name, used once, on the first start,
  when the shared data has no owner), `STORYFORGE_PUBLIC_URL` (the address people type) and `STORYFORGE_PORT`.
- `STORYFORGE_MODE=personal` runs without accounts. It listens on `127.0.0.1` inside the container, which only helps with `network_mode: host`. The container refuses personal
  mode on any other address, as the command line does.
- Open the setup link in a browser. It is built from `STORYFORGE_PUBLIC_URL`, and the server accepts requests for that host only, so the proxy and its DNS name have to work before
  you can use the link. For a first trial on the same machine, set `STORYFORGE_PUBLIC_URL=http://127.0.0.1:4317` in `storyforge.env`. (Inside a container the server listens on `0.0.0.0`, and without a public URL it would refuse the host name `127.0.0.1:4317` that your browser sends.)

### Option B: bare Node with systemd

You need Node.js 22 or newer (24 is what StoryForge is tested with) and a Linux server with systemd. The steps are at the top of `deploy/storyforge.service`; in short:

```sh
sudo useradd --system --home-dir /var/lib/storyforge --create-home --shell /usr/sbin/nologin storyforge
# put the program in /opt/storyforge (git clone or unzip), then, in that folder:
npm ci && npm run build && npm prune --omit=dev
sudo mkdir -p /etc/storyforge /srv/storyforge/library /var/lib/storyforge/shared-data
sudo cp deploy/storyforge.env.example /etc/storyforge/storyforge.env     # edit: owner, public URL, STORYFORGE_HOST=127.0.0.1
sudo chown -R storyforge:storyforge /srv/storyforge /var/lib/storyforge
sudo cp deploy/storyforge.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now storyforge
journalctl -u storyforge                         # the setup link is here
```

The unit runs `node deploy/entrypoint.mjs` as the unprivileged `storyforge` user, the same script the container runs. Behind a proxy on the same machine, set
`STORYFORGE_HOST=127.0.0.1` so that only the proxy can reach the app.

Without the unit file you can do the same by hand:

```sh
node apps/server/src/main.mjs shared init --owner ilse --library /srv/storyforge/library --shared-data /var/lib/storyforge/shared-data --public-url https://write.example.org
node apps/server/src/main.mjs serve --shared --library /srv/storyforge/library --shared-data /var/lib/storyforge/shared-data --host 127.0.0.1 --public-url https://write.example.org
```

### Option C: a reverse proxy with TLS

StoryForge speaks plain HTTP; a reverse proxy in front of it adds HTTPS. Whatever you use, pass the `Host` header through and set `STORYFORGE_PUBLIC_URL` (or `--public-url`)
to the exact address people use. The server checks the `Host` and `Origin` headers against it.

**Caddy** (certificates are fetched and renewed by themselves). `deploy/Caddyfile.example`:

```caddyfile
write.example.org {
	encode zstd gzip
	reverse_proxy storyforge:4317
}
```

Use `127.0.0.1:4317` instead of `storyforge:4317` when StoryForge runs on the same machine outside Docker.

**nginx** (bring your own certificate, for example from certbot):

```nginx
server {
    listen 443 ssl;
    server_name write.example.org;
    # ssl_certificate and ssl_certificate_key as issued for this name

    client_max_body_size 512m;             # book restores and attachments are uploaded through the proxy

    location / {
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }
}
server {
    listen 80;
    server_name write.example.org;
    return 301 https://$host$request_uri;
}
```

Behind a proxy, StoryForge sees the proxy as the only client. Its login rate limit per address therefore counts the proxy; the per-user-name limit still protects each
account.

## First login

1. Open the setup link from the log. Choose a password (10 to 256 characters, and not your user name). You are logged in as the owner.
2. In the app, open **Members and sharing** and **invite** people: pick a role and send them the link yourself (nothing is e-mailed). Roles:
   - **owner**: everything, including members, invites, share links, AI settings, backup and restore;
   - **editor**: write and edit;
   - **reviewer**: read, comment and suggest; **viewer**: read.
3. A read-only **share link** for one book works without an account (read, or read and export), always with an expiry and always revocable.

If the setup link ran out (30 minutes) before it was used, see "Re-issuing a setup link" below.

## Upgrade

1. Take a backup first (below).
2. **Docker:** get the new version (`git pull` or unzip over the old folder), then `docker compose up -d --build` in `deploy/`.
   **Bare Node:** replace the program folder, run `npm ci && npm run build && npm prune --omit=dev`, then `sudo systemctl restart storyforge`.
3. Indexes rebuild themselves when their format changed. Your books are not rewritten.
4. The shared-data files carry a format version, which is checked at every start. A version this release does not know **stops the server** with the file named; it is never
   rewritten. Restore the shared-data backup or install the newer release.

## Backups

**Back up** (a plain copy of the folders is enough, taken while the server is stopped or by a snapshot of the disk):

- the `library/` folder: it is the canonical copy of everything the writers wrote;
- the `shared-data/` folder: accounts, invites, share links, the audit log and `secrets.json` (AI keys and webhook secrets, encrypted; see "Secrets" below). If the key lives in
  `shared-data/secrets-key.json`, a copy of the folder holds both the lock and its key: set `STORYFORGE_SECRETS_KEY` instead and back the key up somewhere else.

**Do not back up** `.storyforge/` inside the books: it is a cache.

**In the app**, the owner can make a per-book Markdown backup: open the book and use **Back up book...** (a `.zip`, byte-for-byte the book's files). From a terminal:

```sh
node apps/server/src/main.mjs backup --library /srv/storyforge/library --book my-novel --out my-novel.zip --provenance
```

**A restore drill** (do it once, before you need it, on any computer, not on the live server):

1. Copy a backup `.zip` out, or copy the `library/` folder to a scratch place.
2. Restore the zip into a new folder: `node apps/server/src/main.mjs restore --from my-novel.zip --to /tmp/restored`.
3. Look at the plan: `node apps/server/src/main.mjs repair --library /tmp/restored` should say "nothing to repair" for a healthy book; then open the folder with
   `node apps/server/src/main.mjs --library /tmp/restored` and check the book opens and the diagnostics list is empty.
4. To restore accounts, put the `shared-data/` copy back with the server stopped. Check it afterwards with
   `node apps/server/src/main.mjs audit verify --shared-data <the restored folder>`.

## Secrets (AI provider keys and webhook secrets)

Every secret StoryForge keeps goes into one key store, never into a book, a backup, an export, a receipt or a log. In shared mode (and in the container image) the store is the
`shared-data/` folder, so it works with no operating-system key store:

- `shared-data/secrets.json` holds the secrets **encrypted** (AES-256-GCM).
- The 32-byte key is `STORYFORGE_SECRETS_KEY` (base64; make one with `openssl rand -base64 32`), set in `storyforge.env`. If it is not set, StoryForge creates
  `shared-data/secrets-key.json` (readable by the service user only) on first use.
- **Back the key up separately.** If the key is lost or wrong, Settings shows "cannot unlock stored keys", nothing that needs a key is sent, and the owner enters the AI keys again
  (webhook secrets: revoke and create the webhook again). Nothing else is lost, and a key is never silently replaced by an empty one.
- On a Windows, macOS or Linux desktop (personal mode) the operating system's own store is used instead (DPAPI, the keychain, the Secret Service) and the files live in the user
  settings folder. `STORYFORGE_SECRETS_BACKEND=file-key` forces the encrypted-file store.
- Moving a key from the plain-text settings file to the store ("Move key to secure storage") is recorded in the audit log, without the key.

## Authentication and session security

What shared mode does for you (details in `docs/contracts/M07-J03-shared-mode.md`):

- **Passwords** are hashed with scrypt (N=32768, r=8, p=1, per-password salt); the server never stores or logs a password. A wrong user name and a wrong password answer the same way.
- **Sessions:** a random 32-byte token in the cookie `sf_session`; only its hash is stored. The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when the public URL is https.
  A session ends after 14 days idle or 30 days in all, on logout, on a password reset, and when the member is removed or disabled.
- **Writes** need the app's own header, a same-origin `Origin`, and the `SameSite=Strict` cookie.
- **Roles** are enforced on the server for every route; the interface only hides what you cannot do. A route nobody classified is refused.
- **Rate limits:** 5 failed logins per user name and 20 per address in 15 minutes, then a wait.
- **Audit:** every login, failure, invite, share use, role change and reset is appended to `shared-data/audit.jsonl`, a hash chain in which a changed or cut-off line is detected.
- **Files:** the shared-data folder is created readable by its owner only (mode 0700) where the system supports it.

**TLS is required for anything that is not loopback.** The server starts without it but prints a warning; terminate TLS in a reverse proxy and pass its https address as the
public URL.

### Rotating the owner password

Stop the server, then run `shared reset-owner` (see below): it clears the owner's password and every session of that owner and prints a new setup link. The owner opens it and
chooses a new password. Another member's password changes the same way: remove the member in the app and invite them again.

### Re-issuing a setup link

- An invite link that lapsed: the owner creates a new invite in the app.
- The owner's own first setup link lapsed before it was used: stop the server and run `shared init --owner <same name>` again (the commands under "A lost owner password", with `init` instead of `reset-owner`). While that owner has no password it prints a new link.
- Once the owner has a password, use `shared reset-owner`.

### Revoking every session of a member

Remove the member in the app (all their sessions end at once) and invite them again with a new link. For the owner, use `shared reset-owner`.

## Operational recovery

- **A damaged shared-data file.** The server refuses to start and names the file: `the shared data cannot be used: ... (nothing was changed; fix or move that file)`. Nothing is
  ever reset silently. Restore that file from your backup, or move the whole folder away and start again with `STORYFORGE_OWNER` set (that makes new accounts; the library is
  untouched).
- **Check the audit log:** `node apps/server/src/main.mjs audit verify --shared-data <dir>` (or `--library <path>`). Exit 0: the chain is intact. Exit 1: a line was changed or the
  end was cut off, and the message says where.
- **A lost owner password.** Stop the server (the command refuses while the library is in use), then run `shared reset-owner` as the user the server runs as.

  With Docker:

  ```sh
  cd deploy
  docker compose stop storyforge
  docker compose run --rm --entrypoint node storyforge apps/server/src/main.mjs shared reset-owner --owner ilse --shared-data /shared-data --public-url https://write.example.org
  docker compose start storyforge
  ```

  With bare Node:

  ```sh
  sudo systemctl stop storyforge
  sudo -u storyforge node apps/server/src/main.mjs shared reset-owner --owner ilse --library /srv/storyforge/library --shared-data /var/lib/storyforge/shared-data --public-url https://write.example.org
  sudo systemctl start storyforge
  ```

  It works only for an existing, enabled owner (any other name is refused and nothing changes). It clears that owner's password and signs the owner out everywhere, writes
  `owner.reset` to the audit log and prints a new one-time setup link, valid 30 minutes.
- **"another StoryForge instance is using ..." (exit 3):** the server (or a command) already holds the library. Stop it first. After a crash the lock is taken over by itself.

## Privacy

- **No telemetry, no update checks, no account with anyone.** StoryForge makes no network call at start-up or while running, in any mode.
- **AI is off until the owner sets it up.** Only then is text that the author was shown in a preview sent to the provider the owner chose. In shared mode the owner decides whether
  members may use it.
- **Where every byte lives:** books and share links' content in the library folder on your disk; accounts, sessions, invites and the audit log in `shared-data/`; the index cache
  in each book's `.storyforge/`; settings (and a provider key, only if saved in the settings file) in `config/`; provider keys and webhook secrets, encrypted, in `shared-data/secrets.json` (shared mode). Nothing is kept anywhere else, and the container image holds none of it.
