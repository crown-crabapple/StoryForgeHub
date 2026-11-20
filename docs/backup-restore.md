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
