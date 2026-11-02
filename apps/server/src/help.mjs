// The text of `node apps/server/src/main.mjs --help`: every command and flag the CLI knows (M06-J03). Kept in one place so a test can check it lists them all.

export const HELP_COMMANDS = ['serve', 'rebuild', 'repair', 'continuity', 'export', 'backup', 'restore', 'receipts verify', 'import-legacy'];

export const HELP = `StoryForge - a Markdown-first novel studio that runs on this computer.

Usage: node apps/server/src/main.mjs [command] [options]
       (npm start -- [options], StoryForge.cmd or storyforge.sh run the same thing)

Commands
  serve                       Serve the library in the browser (the default when no command is given).
  rebuild                     Rebuild every book's index (the .storyforge/ cache) from the files.
  repair                      Print the repair plan for every book; with --apply, carry it out.
  continuity                  Print the continuity findings (read-only).
  export                      Write one book as markdown, docx, epub or pdf.
  backup                      Write one book as a Markdown backup (.zip).
  restore                     Restore a backup into a new or empty folder.
  receipts verify             Check the provenance receipts of one book (read-only; exit 1 on integrity problems).
  import-legacy               Plan the import of a legacy StoryForgeHub dump (needs --dry-run for now; writes nothing).

Options
  --library <path>            The library folder (a folder holding one or more books). Without it StoryForge uses the
                              STORYFORGE_LIBRARY variable, then the library you used last, then a StoryForge folder in
                              your home folder (serve only).
  --port <n>                  Port for serve (default 4317; 0 picks a free one; or set STORYFORGE_PORT). Always on 127.0.0.1.
  --open                      serve: open the browser on the running app (no network; uses the system's opener).
  --book <slug>               continuity, export, backup, receipts verify, import-legacy: which book.
  --json [file]               continuity, receipts verify: machine-readable output; import-legacy: write the plan as JSON to this new file.
  --apply                     repair: write the plan (without it nothing is changed).
  --format <f>                export: markdown, docx, epub or pdf.
  --include <what>            export: manuscript (default), summary or evidence.
  --out <file>                export, backup: the file to write.
  --force                     export, backup: overwrite an existing --out file.
  --provenance                backup: include provenance/ (the receipts).
  --from <file.zip>           restore: the backup to read.
  --to <folder>               restore: a new or empty folder.
  --dump <dir>                import-legacy: the folder made by tools/legacy-dump/dump.php.
  --dry-run                   import-legacy: plan and report only (required).
  --report <file.md>          import-legacy: also write the report to this new file.
  --help, -h                  Show this help.

Environment
  STORYFORGE_LIBRARY          Library folder when --library is not given.
  STORYFORGE_PORT             Port when --port is not given.

Exit codes
  0 ok   1 failed, or needs hand repair, or errors found   2 usage, or the library cannot be opened   3 another instance holds the library

Examples
  node apps/server/src/main.mjs --library D:/Books --open
  node apps/server/src/main.mjs backup --library D:/Books --book my-novel --out my-novel.zip --provenance
  node apps/server/src/main.mjs restore --from my-novel.zip --to D:/Restored
`;
