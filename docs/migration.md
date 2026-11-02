# Moving from the old StoryForgeHub

This page takes your books from a legacy StoryForgeHub (the web version with a database) into StoryForge folders. It is safe to rehearse: the import writes only into a **new
folder**, never changes the old app or its database, and you can repeat it as often as you like.

The steps in short: make a dump, do a dry run, import into a new folder, read the reconciliation, import again and compare, open the books, then delete the index and rebuild it.

## What you need

- StoryForge, installed and working ([install.md](install.md)).
- A fresh backup of the old server, made the way you already make them. Check its date before you start.
- PHP on the machine that can reach the old database. PHP is only needed to make the dump; the import itself needs only Node.js.

## 1. Make the dump

The dump script is `tools/legacy-dump/dump.php` in the StoryForge folder. It only reads. It does not change the old app or its database.

1. Copy `dump.php` to the machine that can reach the old database.
2. Run it there against the live database:

   ```sh
   php dump.php --dsn <PDO DSN> [--user <user> --password-env <VARIABLE>] --out <new empty folder>
   ```

   The DSN looks like `sqlite:/path/to/file.sqlite` or `mysql:host=127.0.0.1;dbname=<database>;charset=utf8mb4`. Give the database password through an environment
   variable (`--password-env`), not on the command line. The script prints the tables it read.
3. Pack the output folder, copy it to your own computer and remove the copies from the server.

The dump holds your manuscripts, so keep it on your own computer and out of any shared or synced folder. Passwords, login tokens and similar secrets are not copied. Account
tables are listed with row counts only, and the user table keeps just an id and a display name.

You now have a folder with `manifest.json` and `tables/*.jsonl`. Unpack it if you packed it. Below it is `<dump>`.

## 2. Dry run

```sh
node apps/server/src/main.mjs import-legacy --dump <dump> --dry-run --report plan.md
```

A dry run writes nothing except the report file you name (which must be a new file, outside the dump). Without `--report` the report is printed. It lists, per book, how many
legacy rows become how many files, the new chapter and scene order, anything that needs your attention, and what happens to every table. It ends with "Nothing was written."

Add `--book <slug>` (repeatable) to limit it to some books, and `--json plan.json` for the plan in machine-readable form.

Exit code 0 means every row has a place and there are no errors. Exit code 1 means there is something to read first.

## 3. Import into a new folder

```sh
node apps/server/src/main.mjs import-legacy --dump <dump> --into D:/Books-from-legacy --report reconcile-1.md
```

- `--into` must be a folder that does not exist or is empty. It is refused if it is a file, is inside the dump, or is inside a folder named `legacy-StoryForgeHub`. Nothing is written when it is refused.
- The books appear in one step: the folder is complete or not there at all.
- StoryForge then checks every book for format problems and compares the written files with the dump.
- It writes nothing else into the folder: no report, no index.
- If it finds a problem it keeps the folder for you to look at and exits with 1. It never deletes anything.

## 4. Read the reconciliation

The reconciliation compares the dump with the files on disk, not with the plan. For each book it runs eight checks and shows the legacy value next to the new one:

| Check | What it compares |
| --- | --- |
| counts | chapters, scenes, entries per type, documents, events, threads, sources, log rows, history files |
| ids | every expected id is present once, and none is extra |
| order | chapter and scene order against the old order |
| text-hashes | the text of each chapter, entry, note and revision, by hash |
| codex-links | every relation and every `[[link]]` resolves, or is listed |
| notes | every note page and chapter comment is present |
| archive/revisions | archived rows are under `archive/`, every revision has one file |
| coverage | every row is found on disk or has a stated reason for not being imported |

A difference is *explained* when it has a reason the report states (for example a link changed to its slug, or a cache that is not imported). Anything else is *unexplained*.
**Unexplained must be 0.** The report shows ids, paths, counts and hashes, never your text.

To check an import again later, or one made on another day:

```sh
node apps/server/src/main.mjs import-legacy --dump <dump> --reconcile D:/Books-from-legacy
```

It is read-only and exits 1 on any unexplained difference.

## 5. Import a second time and compare

```sh
node apps/server/src/main.mjs import-legacy --dump <dump> --into D:/Books-from-legacy-2
node apps/server/src/main.mjs import-legacy --compare D:/Books-from-legacy D:/Books-from-legacy-2
```

The same dump always gives the same files and ids. `--compare` says whether two libraries are byte-identical (it ignores `.storyforge/`) and names the files that differ if
not. Exit 0 means identical. When it does, delete the second folder.

## 6. Open the books

```sh
node apps/server/src/main.mjs --library D:/Books-from-legacy --open
```

Open each book. Check the chapter and scene order against the old app, and a few Codex entries. Scenes are made by splitting each old chapter on its scene-break lines; the
text is kept exactly.

## 7. Delete the index and rebuild

The index is only a cache. Prove that it is by deleting it. Close StoryForge, delete the `.storyforge` folder inside each book, and run:

```sh
node apps/server/src/main.mjs rebuild --library D:/Books-from-legacy
```

Then open the books again and look at the same things. Nothing should have changed. You can run `--reconcile` once more too.

## What is not imported, and why

| Not imported | Why |
| --- | --- |
| Derived caches: mentions, prose analysis, the threads cache, the scenes cache, claim sources, exercises, sync state | StoryForge rebuilds what it needs from the text. Copying a cache would copy its mistakes. |
| Accounts and server-only rows: users, members, activity, locks, tokens | StoryForge is one person on one computer. It has no accounts. Passwords and tokens are never dumped. |
| Series as folders | A series name is kept on the book as text. StoryForge does not create series folders from it. |
| Anything that fits no field | Kept as data, unchanged, in `legacy/tables/`. Old revisions are in `legacy/history/`. See [format.md](format.md). |

## What you may notice

- A `[[link]]` in a scene to a name that does not exist is kept exactly as written, so the book shows a broken-link error for it. The report lists these as `unknown-link`.
- References to a chapter (in the story ledger or events) point at that chapter's first scene. If a chapter has no scenes the reference stays in the thread text for you to fix.
- A prologue becomes chapter 1, with its old number kept in the scene's `x-legacy-num` setting.
- Some tables (state events, knowledge facts, canvas, captures, dictionary, continuity exemptions) are checked by count, not row by row.

## If you want to start again

Delete the new folder and import again. The old app and the dump are not changed by any step. See [troubleshooting.md](troubleshooting.md) if a step is refused.
