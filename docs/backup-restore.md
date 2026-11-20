# Backing up and restoring a book

This page has two parts. The first covers file mode: a book folder is the book, so a copy of the folder is a backup (see [install.md](install.md)). The second covers a server that runs with a database, where the database is the canonical copy: see [Database (hosted)](#database-hosted).

## File mode

This is the procedure for file mode, the single-file backup StoryForge makes and how to put it back.

### What a backup holds

A backup is one `.zip` of the book folder, byte for byte:

- Everything in the folder (manuscript, Codex, planning, research, assets, archive, suggestions, `legacy/`, and so on).
- **Not** `.storyforge/`, which is rebuilt.
- **Not** `provenance/` (the receipts), unless you ask for it.

The backup carries a check value in the zip comment. A restore compares it first and refuses a backup that does not match.

A backup never contains your AI provider settings or key. Those live in your settings folder, not in the book.

### Back up

In the app: open the book and choose **Back up book...** in the top bar. Tick **Include receipts (provenance)** to add the receipts. Your browser downloads the zip.

From a terminal:

```sh
node apps/server/src/main.mjs backup --library D:/Books --book my-novel --out my-novel.zip
node apps/server/src/main.mjs backup --library D:/Books --book my-novel --out my-novel.zip --provenance
```

`--book` is the book's slug, which is the `slug:` line in its `book.md`. `--out` will not replace an existing file unless you add `--force`, and it will not write inside the book folder.

### Restore

In the app: on the Library, choose **Restore from backup...**, pick the zip and name the new folder. The restored book opens.

From a terminal:

```sh
node apps/server/src/main.mjs restore --from my-novel.zip --to D:/Restored
```

- The target folder must not exist or must be empty. Restore never merges into, or overwrites, a folder that already has files in it.
- If the zip is damaged, has unsafe paths, or does not match its check value, nothing is written.
- The restored folder is the same files as the original. It has no `.storyforge/` yet; StoryForge builds the index when you open the book, or run:

```sh
node apps/server/src/main.mjs rebuild --library D:/Restored
```

### Try it once

Do this before you need it. Back up a book, restore it into a new folder, open both, and compare chapter order and a few Codex entries. For a book you care about, also
compare the two folders with a file-comparison tool: they should be identical apart from `.storyforge/`.

If a restore is refused, see [troubleshooting.md](troubleshooting.md).

## Database (hosted)

When StoryForge runs with `--database` (see [database.md](database.md)), the database is the canonical copy. The Markdown folder passed as `--library` is a private copy that is rebuilt at start. It is not a backup.

### Nightly backup

Dump the whole database each night, encrypt the dump, and copy it off the server:

```sh
pg_dump --format=custom --host=127.0.0.1 --username=storyforge --file=storyforge-2026-01-31.dump storyforge
age --recipient <public key> --output storyforge-2026-01-31.dump.age storyforge-2026-01-31.dump
```

- `pg_dump` reads the password from `~/.pgpass` (mode `600`) of the user that runs it, so it never appears in a command line.
- Encrypt with `age` or `gpg`, with a key that is not kept on the server. A copy that sits on the server is not a backup.
- Keep 7 daily, 4 weekly and 3 monthly dumps.
- Keep the `shared-data` secrets key (`STORYFORGE_SECRETS_KEY`, see [self-hosting.md](self-hosting.md)) and the server's config folder in the same off-server routine. They are not in the database.

### Nightly backup of a bare server

For a server with a local PostgreSQL, `deploy/storyforge-db-backup.sh` does the nightly backup. `storyforge-db-backup.timer` starts `storyforge-db-backup.service` every night at 03:30 (up to 20 minutes later, at random; a night missed while the server was off runs at the next boot). The script, as root:

- dumps the database with `pg_dump --format=custom`, run as the `postgres` user over the local socket (peer authentication, so no password is involved);
- makes a tar of the config folder (`/var/lib/storyforge/config`) if it exists;
- encrypts both with `age` to a public key and writes `db.dump.age` and `config.tar.gz.age`. Nothing is written unencrypted, and without a recipient the script stops;
- keeps 7 daily, 4 weekly (Sunday) and 3 monthly (the 1st) sets in `/var/backups/storyforge/{daily,weekly,monthly}`. The weekly and monthly sets are hard links to the daily files;
- copies `/var/backups/storyforge` to `STORYFORGE_BACKUP_COPY_TO` with `rsync -a --hard-links` (never `--delete`), if that is set. Without it the script says the backup is on this server only.

The config folder is in the backup. The shared-data secrets key is not, unless it is under that folder: keep `STORYFORGE_SECRETS_KEY` in your off-server routine.

**Make the key pair off the server.** On another computer:

```sh
age-keygen -o storyforge-backup.key
```

Keep `storyforge-backup.key` there, with a second copy somewhere safe. Without it the backups cannot be read by anyone. Only the `public key: age1...` line goes to the server.

**Install the timer.** On the server, install `age` (`apt install age`), then:

```sh
sudo cp deploy/storyforge-backup.env.example /etc/storyforge/backup.env
sudo chmod 600 /etc/storyforge/backup.env
sudo cp deploy/storyforge-db-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now storyforge-db-backup.timer
```

Edit `/etc/storyforge/backup.env`: set `STORYFORGE_BACKUP_AGE_RECIPIENT` to the public key and, as advised, `STORYFORGE_BACKUP_COPY_TO` to an rsync target (for example `backup@backup.example.org:storyforge/`). The commented lines in that file show the other settings and their defaults. The service runs `/opt/storyforge/deploy/storyforge-db-backup.sh`.

**Run it once by hand** and read the result:

```sh
sudo systemctl start storyforge-db-backup && journalctl -u storyforge-db-backup
```

The log says where the set was written and whether it was copied off the server.

**Restore.** Stop the server first. Decrypt on the computer that holds the private key, or copy the key to the server for the restore and remove it afterwards:

```sh
sudo systemctl stop storyforge
age --decrypt -i storyforge-backup.key db.dump.age | sudo -u postgres pg_restore --clean --if-exists -d storyforge
sudo systemctl start storyforge
```

`--clean --if-exists` drops the existing objects in the database before it recreates them from the dump. Then check that the server is up with `/api/status` (for example `curl http://127.0.0.1:4317/api/status` on the server) and open the app. To restore the config folder, decrypt `config.tar.gz.age` the same way and unpack it into `/var/lib/storyforge/config` with `tar --extract --gzip`.

Practise the restore into a scratch database first: see the restore drill below, and [H0 section 4](contracts/H0-hosted-foundation.md#4-backup-and-recovery) for the rule.

### Restore drill

Do this before every release, and once before you need it. Use a clean database, not the live one:

1. Decrypt the dump and create an empty database: `createdb --owner storyforge storyforge_drill`.
2. Restore into it: `pg_restore --no-owner --role=storyforge --dbname=storyforge_drill storyforge-2026-01-31.dump`.
3. Apply any newer migrations: `node apps/server/src/main.mjs db migrate --database postgres://storyforge@127.0.0.1:5432/storyforge_drill`.
4. Check it: `node apps/server/src/main.mjs db status --database <the same url>`. It should list every migration as applied, and the file count should match the live database.

Then drop the drill database.

### The author's Markdown export

An independent escape hatch that does not depend on the server's backups: `db export` writes the library as plain Markdown files.

```sh
node apps/server/src/main.mjs db export /srv/export/library --shared-out /srv/export/shared-data
```

The target folder must be new or empty. See [database.md](database.md#export-a-markdown-copy).
