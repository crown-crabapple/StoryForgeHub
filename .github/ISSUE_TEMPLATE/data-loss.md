---
name: Data-loss report
about: Text or files went missing, changed unexpectedly or could not be restored
title: "Data loss: "
labels: data-loss
assignees: ""
---

**Stop writing in the affected book first, and make a copy of its folder.** Then check `.storyforge/trash/` inside the book folder and your latest backup (see [Backing up and restoring](../../docs/backup-restore.md)); most lost text can be recovered from there.

**Do NOT paste, attach or describe any manuscript content in this issue.** Not scene text, not entry text, not file contents, not screenshots that show your writing. Report file names, counts, sizes, error codes and the order of events only. If a maintainer needs more, they will ask for a made-up reproduction.

**What was lost or changed** (for example "one scene file is empty", "the last two saves are missing"; no text from it)

**Roughly when, and what you were doing just before** (editing, moving a scene, importing, restoring, a crash, the computer going to sleep)

**Do you have a backup or a copy of the folder?** yes / no / partly

**Did anything report a problem?** The red "needs attention" notice, a problems-list code such as `E102`, or a message in the terminal (copy the code and message, not any text from your book).

**What does `node apps/server/src/main.mjs repair --library <your library>` print?** (It only prints a plan; it does not change anything without `--apply`.) Remove folder names that identify you.

**Where**

- StoryForge version:
- Mode: personal / shared / Docker
- Operating system:
- Is the library on a network drive, a cloud-synced folder (OneDrive, Dropbox, iCloud) or an external disk?
