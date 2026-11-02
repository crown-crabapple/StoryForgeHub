# Backing up and restoring a book

A book folder is the book, so a copy of the folder is a backup (see [install.md](install.md)). This page covers the single-file backup StoryForge makes and how to put it back.

## What a backup holds

A backup is one `.zip` of the book folder, byte for byte:

- Everything in the folder (manuscript, Codex, planning, research, assets, archive, suggestions, `legacy/`, and so on).
- **Not** `.storyforge/`, which is rebuilt.
- **Not** `provenance/` (the receipts), unless you ask for it.

The backup carries a check value in the zip comment. A restore compares it first and refuses a backup that does not match.

A backup never contains your AI provider settings or key. Those live in your settings folder, not in the book.

## Back up

In the app: open the book and choose **Back up book...** in the top bar. Tick **Include receipts (provenance)** to add the receipts. Your browser downloads the zip.

From a terminal:

```sh
node apps/server/src/main.mjs backup --library D:/Books --book my-novel --out my-novel.zip
node apps/server/src/main.mjs backup --library D:/Books --book my-novel --out my-novel.zip --provenance
```

`--book` is the book's slug, which is the `slug:` line in its `book.md`. `--out` will not replace an existing file unless you add `--force`, and it will not write inside the book folder.

## Restore

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

## Try it once

Do this before you need it. Back up a book, restore it into a new folder, open both, and compare chapter order and a few Codex entries. For a book you care about, also
compare the two folders with a file-comparison tool: they should be identical apart from `.storyforge/`.

If a restore is refused, see [troubleshooting.md](troubleshooting.md).
