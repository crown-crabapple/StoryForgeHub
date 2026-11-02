# Troubleshooting

Commands below use `node apps/server/src/main.mjs`; `--help` lists them all. Exit codes: 0 fine, 1 failed or needs a hand repair or errors found, 2 usage or the library could
not be opened, 3 another instance holds the library.

## "no library given"

```text
storyforge: no library given: pass --library <path>, set STORYFORGE_LIBRARY, or start StoryForge once and open a library so it is remembered
```

Terminal commands such as `rebuild` need to know which folder to work on. Pass `--library <folder>`, or set `STORYFORGE_LIBRARY`. `<folder>` is the folder that holds your
books. `serve`, the launchers and the app never give this error: they use the library you used last, else a `StoryForge` folder in your home folder.

## The port is in use

Start on another port: `--port 5000` (or `STORYFORGE_PORT=5000`). `--port 0` picks a free one. The address is always `127.0.0.1`.

## "another StoryForge instance is using ..." (exit 3)

```text
storyforge: another StoryForge instance is using <folder> (pid ..., port ...). Lock file: <folder>/.storyforge-lock
```

Only one StoryForge may change a library at a time. The commands `rebuild` and `repair --apply` count as changing it, so they stop with this message while the app is running on
the same library. Look for another terminal window or browser tab running StoryForge and close it, then run the command again. The message names the process and port. If that
process is gone (for example after a crash), StoryForge takes the lock over by itself.

## The index looks wrong

Symptoms: lists or search disagree with the files, or the status button in the top bar says "Index unreadable" or "Index out of date". The index is a cache, so:

- In the app: open the status button, then **Rebuild index**.
- Or stop StoryForge and run `node apps/server/src/main.mjs rebuild --library <folder>`.
- Or stop StoryForge and delete the `.storyforge` folder inside the book; it is rebuilt on the next start.

None of these touch your writing.

## Repair

If the status panel offers **Repair...**, or you want to see what could be tidied, print the plan from a terminal:

```sh
node apps/server/src/main.mjs repair --library <folder>
```

Without `--apply` it changes nothing and says so. Read the plan, then run `repair --library <folder> --apply` (with StoryForge stopped) to carry it out. A file listed as
unrepairable, and exit code 1, means that file has to be fixed by hand in a text editor.

## Warnings and errors about files

StoryForge checks every file against the book format and reports problems with the file, the place in it and a code beginning `E` (error) or `W` (warning). The app keeps
working. Open the file in any text editor and fix what the message names; the message clears.

Common ones:

| Code | Meaning | What to do |
| --- | --- | --- |
| `E100` | front matter is not closed or not readable | add the missing closing `---`, check indents |
| `E102` | a field is missing or the wrong type | fix the named field |
| `E204` | two scenes in one chapter have the same sequence | change one `sequence` number |
| `E301` | a `[[link]]` or reference points at nothing | fix the name, or create the entry |
| `W201`, `W202` | folder or file name does not match the scene's numbers | the numbers win; rename if you want them to agree |
| `W301` | a link works only through an old name | update the link |

The same checks run on a book you import ([migration.md](migration.md)); a link in an old scene to a name that never existed shows as `E301`.

## Restore refuses

- **`RESTORE_TARGET_NOT_EMPTY ... already exists and is not empty`:** restore only writes into a folder that does not exist or is empty. Choose a new folder name.
- **The backup is refused as corrupt or as having unsafe paths:** nothing was written. The zip is damaged or was changed after it was made. Use another copy of the backup.
- In the app, the new folder name must be one name made of lower-case letters, digits and `-`.

See [backup-restore.md](backup-restore.md).

## Other refusals

- **`OUT_EXISTS ... use --force to replace it`:** `export` and `backup` will not overwrite a file. Pick a new `--out`, or add `--force`.
- `--out` inside the book folder is refused. Write the file somewhere else.
- `import-legacy --into` refuses a folder that is not empty, is a file, or is inside the dump. Pick a new folder. See [migration.md](migration.md).

## Receipts verify fails

`receipts verify --library <folder> --book <slug>` is read-only. It exits 1 when it finds integrity problems and changes nothing. Each problem has a code:

| Code | Meaning |
| --- | --- |
| `RCPT_PARENT_MISSING` | a receipt refers to a parent receipt file that is not there |
| `RCPT_PARENT_ALTERED` | a parent receipt file changed after it was recorded |
| `RCPT_OBJECT_MISSING` | a saved before/after copy of a file is missing |
| `RCPT_OBJECT_ALTERED` | a saved copy no longer matches its name |
| `RCPT_DIFF_MISMATCH` | a receipt's recorded change does not turn its "before" into its "after" |
| `RCPT_CHAIN_GAP` | a receipt does not start where the previous one for that scene ended |
| `RCPT_MALFORMED` | a receipt file is not a valid receipt |

`RCPT_UNRECORDED` is information only: a scene's text differs from its last receipt, which happens with changes not yet recorded or made while StoryForge was closed.

StoryForge never rewrites or "fixes" receipts. Typical causes are a book restored without its `provenance/` folder (backups leave it out unless you ask), or files in
`provenance/` edited or deleted by hand. Restore the folder from a backup that included it.

## A file is reported as unreadable

See "Warnings and errors about files" above, and [install.md](install.md), "If something goes wrong".
