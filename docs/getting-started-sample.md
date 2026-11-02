# Getting started with the sample book

The StoryForge folder includes a small made-up book, *The Salt Orchard*, to try everything on. This page copies it, opens it, rebuilds its index, edits a scene and exports
a manuscript. It assumes StoryForge is installed ([install.md](install.md)).

Copy the sample first. Do not open it where it is: it is part of StoryForge's own test files, and editing it there changes them.

## 1. Copy the sample into a new library folder

The sample is the folder `packages/format/fixtures/valid/salt-orchard`. A library is a folder that holds books, so make one and copy the sample into it. Run these from the
StoryForge folder.

Windows (PowerShell):

```powershell
mkdir $HOME\sample-library
Copy-Item -Recurse packages\format\fixtures\valid\salt-orchard $HOME\sample-library\salt-orchard
```

macOS or Linux:

```sh
mkdir ~/sample-library
cp -r packages/format/fixtures/valid/salt-orchard ~/sample-library/salt-orchard
```

From here on, `<library>` means the new `sample-library` folder.

## 2. Start with that library

Windows: `StoryForge.cmd --library %USERPROFILE%\sample-library`. macOS or Linux: `./storyforge.sh --library ~/sample-library`.

Or by hand, after `npm ci` and `npm run build`:

```sh
node apps/server/src/main.mjs --library <library> --open
```

Your browser opens on the Library, which shows *The Salt Orchard*. Open it. It has a prologue and three chapters in two acts, a Codex of characters, places and objects, and
plot threads and a timeline. Keep the terminal open while you work. `Ctrl+C` stops StoryForge.

## 3. Rebuild the index

The index in `.storyforge/` is a cache. In the app, open the status button in the top bar and press **Rebuild index**.

From a terminal, stop StoryForge first (the command needs the library to itself), then:

```sh
node apps/server/src/main.mjs rebuild --library <library>
```

It prints `salt-orchard: index rebuilt (7 scenes)`.

To see that nothing depends on the index, stop StoryForge, delete the `.storyforge` folder inside `salt-orchard`, and run `rebuild` again. The book is unchanged.

## 4. Edit a scene

1. In the book, open the scene **Arrival** (chapter 1).
2. Click in the **Scene text** area and type a sentence. It is saved as you go.
3. Open `<library>/salt-orchard/manuscript/act-01-low-water/ch-001-the-drowned-rows/0010-arrival.md` in a text editor. Your sentence is in the file, below the settings block.

You can also go the other way: edit that file in a text editor and save, and StoryForge picks the change up.

## 5. Export a manuscript

An export reads the book and never changes it. Scenes come out in book order. Notes written as `<!-- note: ... -->`, alternate versions and archived scenes are left out.

### In the app

1. Open the book and choose **Export...**.
2. Pick **Markdown** or **Word** (the dialog also offers EPUB and PDF).
3. Press **Export**. Your browser downloads `salt-orchard.md` or `salt-orchard.docx`.

### From a terminal

```sh
node apps/server/src/main.mjs export --library <library> --book salt-orchard --format markdown --out salt-orchard.md
node apps/server/src/main.mjs export --library <library> --book salt-orchard --format docx --out salt-orchard.docx
```

`--format` is `markdown`, `docx`, `epub` or `pdf`. `--out` will not replace a file that exists unless you add `--force`. Open the Markdown file in any editor and look for the
sentence you added to *Arrival*. An export can run while StoryForge is open.

## 6. Back up the sample

```sh
node apps/server/src/main.mjs backup --library <library> --book salt-orchard --out salt-orchard-backup.zip
```

To restore it somewhere new, and for the same thing in the app, see [backup-restore.md](backup-restore.md). To see what the files hold, see [format.md](format.md).

When you are done, delete the `sample-library` folder. The sample inside StoryForge was never touched.
