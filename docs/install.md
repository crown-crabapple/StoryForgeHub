# Installing and running StoryForge

StoryForge runs on your own computer. You start a small program, and your browser shows the app at an address that only your computer can reach
(`http://127.0.0.1:4317/`). There is no account, no sign-in and no cloud service.

## What you need

- **Node.js 22 or newer** (24 is what the project is built and tested with). Get it from <https://nodejs.org>. To check: open a terminal and type `node --version`.
- **A browser.** Any current one.
- **The internet, once**, on the first run, so the app can fetch the pieces it is built from. After that StoryForge never needs it (see "What leaves your computer").

## First run

1. Get the StoryForge folder onto your computer (clone or unzip it) and open it.
2. **Windows:** double-click `StoryForge.cmd`. **macOS or Linux:** open a terminal in the folder and run `./storyforge.sh`.
3. The first time, the launcher installs what StoryForge needs and builds the app. This takes a few minutes and prints a lot of text; that is normal. Later runs skip this
   and start in a few seconds. (It runs again by itself if the dependency list changed, for example after you update StoryForge.)
4. Your browser opens on StoryForge. Leave the terminal window open while you write; closing it stops StoryForge. Your work is saved in your files as you go.

Which books you see:

- If you have used StoryForge before, it opens **the library you used last**.
- On the very first run it has no library yet, so it uses a folder called **`StoryForge` in your home folder** (created for you). Make a new book there, or choose
  **Open folder...** in the Library to point StoryForge at the folder where your books already are.
- To choose a library yourself, add `--library <folder>` (for example `StoryForge.cmd --library D:\Books`), or set the `STORYFORGE_LIBRARY` environment variable.

Other options go the same way: `--port 5000` uses another port. Everything the command line can do (rebuild an index, export, back up, restore, check receipts) is listed by:

```sh
node apps/server/src/main.mjs --help
```

You can also start it without the launcher: `npm ci`, `npm run build`, then `npm start -- --open`.

## Where your data lives

| What | Where | Is it yours to keep? |
| --- | --- | --- |
| **Your books** | Each book is a **folder** of Markdown files. The folder is everything the author wrote: scenes, notes, the Codex, plans, suggestions, receipts. | **Yes. This is the only thing that matters.** |
| The index | `.storyforge/` inside each book folder. A cache that makes searching and lists fast. | No. It is **disposable**: delete it any time and StoryForge rebuilds it from the files. |
| Settings for you | `%APPDATA%\StoryForge` on Windows, `~/.config/storyforge` on macOS and Linux (or `$XDG_CONFIG_HOME/storyforge`). It holds the list of recent libraries and your AI provider settings, **including a key if you chose "save the key in the settings file"** (it is stored as plain text). | Optional. |

Nothing else is written anywhere. In particular, StoryForge keeps no copy of your books outside the book folders.

## How to back up

Your book folder is the book, so any ordinary copy of it is a backup: copy it to another drive, a USB stick, a sync folder or a Git repository. Because the files are
plain Markdown, they stay readable in any text editor for as long as you keep them.

StoryForge can also make a single Markdown backup file for you:

- In the app, open the book and use **Back up book...** (top bar). It gives you a `.zip` of the book's files.
- From the terminal: `node apps/server/src/main.mjs backup --library <folder> --book <book-folder-name> --out my-book.zip` (add `--provenance` to include the receipts).

To get a book back, use **Restore from backup...** in the Library, or `node apps/server/src/main.mjs restore --from my-book.zip --to <new or empty folder>`. A restored
folder is the same files, byte for byte, and StoryForge builds its index again on first open.

## What leaves your computer

**Nothing**, unless you set up an AI provider yourself.

- The app listens on `127.0.0.1` only, so nobody else on your network can reach it.
- There is no tracking, no update check and no sign-in.
- **AI is optional and off until you turn it on.** If you add a provider in **Settings**, turn it on for a book and press Send, only then is the text you were shown in the
  preview sent to that provider (a model on this computer, or a cloud service you chose). Nothing a model writes changes your book until you apply it.

## Upgrade

1. Close StoryForge (the terminal window).
2. Replace the StoryForge program folder with the new version (unzip over it, or `git pull` if you cloned it). Your books are not in that folder, so they are not touched.
3. Run the launcher again (`StoryForge.cmd` or `./storyforge.sh`). If the dependency list changed it installs and builds again by itself; otherwise it starts in a few seconds.

Indexes rebuild by themselves when their format changed, so the first open of a book may take a moment longer. An upgrade does not rewrite your book files. If you run StoryForge for
a group on a server, [Self-hosting](self-hosting.md) has its upgrade steps.

## Removing StoryForge

1. Delete the StoryForge program folder.
2. Optionally delete the settings folder (see "Where your data lives"). That forgets your recent libraries and any AI settings, including a saved key.

Your **book folders are not touched**; they stay exactly where they are and open in any editor.

## If something goes wrong

- *"StoryForge needs Node.js 22 or newer"*: install a current Node.js from <https://nodejs.org> and run the launcher again.
- *"another StoryForge instance is using this library"*: StoryForge is already running for that library (look for another terminal window, or its browser tab). Only one at a time may change a library.
- *The port is in use*: start with another one, `--port 5000`.
- *The index looks wrong*: delete the `.storyforge` folder inside the book, or run `node apps/server/src/main.mjs rebuild --library <folder>`.
- *A file is reported as unreadable*: the app keeps working and shows which file and why. Fix it in any text editor and the message clears.
