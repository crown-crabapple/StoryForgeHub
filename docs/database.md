# Running StoryForge with a database

This page is for the person who runs StoryForge as a hosted app. The database is the canonical copy of the writing. The decision is in [ADR 0004](decisions/0004-hosted-database-canonical.md); the rules are in [the hosted foundation contract](contracts/H0-hosted-foundation.md). If you write alone on your own computer, or run [shared mode](self-hosting.md) from a folder, you do not need a database.

## What the database holds

In Phase 1 the database is a document store. It holds:

- every library file (manuscript, Codex, planning, and so on), byte for byte;
- the change log, and the content each change replaced or removed (this is what Undo uses);
- scene restore points (the newest 4 per scene);
- the shared-mode data: accounts, sessions, invites, share links and the audit log;
- a receipt for each import.

It does not hold per-machine settings (appearance profiles, recent libraries, AI provider settings). Those stay in the server's config folder.

The Markdown folder is no longer the source of truth. It is what you import from and export to.

## Three kinds of database URL

Every database option takes one of these:

| URL | What it is | Use it for |
| --- | --- | --- |
| `postgres://user:password@host:5432/dbname` (or `postgresql://`) | A PostgreSQL server. | A hosted server. |
| `pglite:<folder>` | PostgreSQL running inside the StoryForge process, kept in a folder. One writer. | Trying it out, local development. |
| `pglite:memory` | The same, in memory. Gone when the process ends. | Tests and dry runs. |

StoryForge never prints the password of a `postgres://` URL; it shows `***` instead. A URL given as `--database` is visible to other users of the machine in the process list. For the `db` commands, set `STORYFORGE_DATABASE` in the environment instead: they read it when `--database` is not given.

## First-time setup

You need PostgreSQL 16 or newer. Install it with your system's package manager.

Give StoryForge its own role and its own database. The role owns that database and nothing else: it is not a superuser, and it cannot create roles or other databases.

```sh
sudo -u postgres createuser --pwprompt storyforge
sudo -u postgres createdb --owner storyforge storyforge
```

`createuser` asks for the password. The same in SQL:

```sql
CREATE ROLE storyforge LOGIN PASSWORD 'CHANGE_ME';
CREATE DATABASE storyforge OWNER storyforge;
```

Put the URL in the server's environment file (`/etc/storyforge/storyforge.env` for a systemd install; mode `600`):

```sh
STORYFORGE_DATABASE=postgres://storyforge:CHANGE_ME@127.0.0.1:5432/storyforge
```

Keep PostgreSQL on `127.0.0.1` (or a private network) unless you have a reason not to.

Then create the tables:

```sh
node apps/server/src/main.mjs db migrate
```

It prints the migrations it applied, or says the database is up to date. Each migration runs in one transaction. A migration that fails is rolled back, and the ones before it stay applied. There are no down-migrations: to go back, restore a backup (see [backup-restore.md](backup-restore.md)).

## Import an existing library

Import reads a Markdown library folder, and the shared-mode data folder if you give one, and writes it into the database. The source folder is only read, never changed.

1. **Dry run.** Without `--write`, nothing is written, not even the tables:

   ```sh
   node apps/server/src/main.mjs db import /srv/storyforge/library --shared-data /var/lib/storyforge/shared-data
   ```

2. **Read the report.** It lists the files and their size; the documents by kind; the books with their scene counts; the validation findings; the restore points found and kept; the shared-mode documents; and every path that was skipped, with the reason. Validation errors are reported but do not block the import. Dot-entries, symbolic links and the `.storyforge/` cache are skipped. Only `.storyforge/revisions/` is read, and only the newest 4 restore points of each scene are kept.

3. **Import.**

   ```sh
   node apps/server/src/main.mjs db import /srv/storyforge/library --shared-data /var/lib/storyforge/shared-data --write
   ```

   Run `db migrate` first: `--write` refuses a database that has no tables.

Import is one-time and safe to repeat:

- Importing the same folder again changes nothing and says so. A folder counts as the same when its file names and contents are the same.
- A folder that has changed since the first import is refused while the library already holds files: `refused: the library already holds files and this folder is different from the one imported before`.
- A dry run against a library that already holds files says that a real import would be refused.

`--library-id <id>` picks which library in the database the command works on. The default is `main`. Use the same id every time.

## Run the server

```sh
node apps/server/src/main.mjs serve --database <url> --library /var/lib/storyforge/library-copy
```

(Phase 1.) `serve --database` reads the URL from `STORYFORGE_DATABASE` when `--database` is not given, and takes `--library-id <id>` (default `main`). `--library` is required: it is the folder for the copy. `serve --database` does the following at start:

1. It applies any pending migrations.
2. It refuses an empty database: `run storyforge db import first`.
3. It makes the `--library` folder a private on-disk copy of the database, and records that in a marker file, `.storyforge/db-copy.json`. It refuses a folder that holds files but has no marker, and a folder whose marker is for another library id.
4. It rebuilds the copy from the database, then serves it.

Every write goes to the database first, in one transaction. The copy on disk is updated after the commit. If updating the disk fails, the change is undone in the database too, so a change is either all there or not there.

### The on-disk copy

The `--library` folder is private to the server. Do not edit it, and do not point the server at your Markdown library. At each start the server makes the folder match the database exactly: it writes files that differ, removes files the database does not have, and leaves the `.storyforge/` caches alone (the search index is rebuilt from them as usual). An edit made outside the app is overwritten from the database and written to the log. It is never imported.

To change the writing, use the app. To bring in a folder, use `db import`.

### Fresh setup, shared mode

If you have a library to import but no shared-mode data (accounts, audit log), import the library, then create the owner in the database:

```sh
node apps/server/src/main.mjs db import /srv/storyforge/library --write
node apps/server/src/main.mjs shared init --owner <username> --database <url> --library /var/lib/storyforge/library-copy --shared-data /var/lib/storyforge/shared-data
node apps/server/src/main.mjs serve --shared --database <url> --library /var/lib/storyforge/library-copy --shared-data /var/lib/storyforge/shared-data
```

`shared init`, `shared reset-owner` and `audit verify` all accept `--database` (or `STORYFORGE_DATABASE`) and `--library-id`. They make the `--shared-data` folder match the database first, then write to the database before the folder, so the owner is not lost when `serve --database` rebuilds the folder at the next start. `audit verify` checks the audit lines held in the database.

If the `--shared-data` folder already holds files (accounts, invites, an audit log) but the database has no shared data yet, `serve --database` and these commands refuse to start instead of deleting them. Import that folder first with `db import ... --shared-data <dir> --write`, or point `--shared-data` at an empty folder for a fresh setup.

### Known limits (Phase 1)

- An outside edit to a non-Markdown file in the copy (an image under `assets/`, for example) is not noticed while the server runs. It is put right at the next restart.
- An outside edit that races a save can make that save be refused with a conflict. The database is never wrong; a restart rebuilds the copy.
- Library switching is off in database mode: the server serves one library from its database. `POST /api/library/open` answers 409 `DATABASE_MODE`, and the web app does not offer "Open folder".

## Check the database

```sh
node apps/server/src/main.mjs db status
```

It shows the database (without its password), the library id, each migration as applied or pending, the number of files and empty folders, and the last 5 changes. On a database that has not been migrated it says so.

## Export a Markdown copy

At any time, the database can be written back out as a library folder:

```sh
node apps/server/src/main.mjs db export /srv/export/library --shared-out /srv/export/shared-data
```

- The folder must not exist or must be empty. Export never writes into a folder that has files in it.
- The library files are written exactly as stored. The restore points go back to `.storyforge/revisions/`.
- `--shared-out` writes the shared-mode documents to a second folder. Without it they are not exported.
- The result opens in file mode, and importing it again gives the same data.

Export needs no running server, and it works on a copy of the database as well as on the live one.

## What changed for self-hosters

- You run PostgreSQL. In file mode there is no database service.
- The Markdown folder is not the canonical copy. Back up the database (see [backup-restore.md](backup-restore.md)).
- The server's `--library` folder is a copy that is rebuilt at start, so it is not a backup.
- Accounts, invites and the audit log move into the database. They are imported with `--shared-data`.
- File mode still works. `serve` without `--database` is unchanged: see [install.md](install.md) and [self-hosting.md](self-hosting.md).
