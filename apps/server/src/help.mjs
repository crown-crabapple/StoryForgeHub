// The text of `node apps/server/src/main.mjs --help`: every command and flag the CLI knows (M06-J03). Kept in one place so a test can check it lists them all.

export const HELP_COMMANDS = ['serve', 'rebuild', 'repair', 'continuity', 'export', 'backup', 'restore', 'receipts verify', 'shared init', 'shared reset-owner', 'audit verify', 'import-legacy'];

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
  shared init                 Create the owner account for shared mode and print the one-time setup link (--owner <username>).
  shared reset-owner          Lost owner password: clear it and every session of that owner, print a new setup link (--owner <username>; stop the server first).
  audit verify                Check the shared-mode audit log chain (exit 1 when a line was changed or the end was cut off).
  import-legacy               Import a legacy StoryForgeHub dump into a NEW folder (--into), check it against the dump (--reconcile),
                              compare two imports (--compare), or only plan it (--dry-run; writes nothing).

Options
  --library <path>            The library folder (a folder holding one or more books). Without it StoryForge uses the
                              STORYFORGE_LIBRARY variable, then the library you used last, then a StoryForge folder in
                              your home folder (serve only).
  --port <n>                  Port for serve (default 4317; 0 picks a free one; or set STORYFORGE_PORT). On 127.0.0.1 unless --shared and --host say otherwise.
  --shared                    serve: optional shared mode (accounts, roles, invites, read-only share links, audit log) on top of the same library.
                              Without it nothing changes: no accounts, 127.0.0.1 only. Run "shared init --owner <username>" once first.
  --shared-data <dir>         serve --shared, shared init, shared reset-owner, audit verify: where accounts and the audit log live (default: a folder in your config folder named
                              after the library; refused inside the library).
  --host <addr>               serve --shared: the address to listen on (default 127.0.0.1). Anything else without --shared is refused (exit 2).
  --public-url <url>          serve --shared, shared init, shared reset-owner: the address people use, e.g. https://write.example.org behind a TLS reverse proxy. A non-loopback --host
                              without an https --public-url starts with a warning.
  --owner <username>          shared init, shared reset-owner: the owner's user name (3-32 characters: a-z, 0-9, dot, underscore, hyphen).
  --profile <name>            serve: the appearance profile to use (theme, type, layout, shortcuts; kept on this computer, never in a book).
                              Without it STORYFORGE_PROFILE, then the profile called default.
  --open                      serve: open the browser on the running app (no network; uses the system's opener).
  --book <slug>               continuity, export, backup, receipts verify, import-legacy: which book.
  --json [file]               continuity, receipts verify: machine-readable output; import-legacy: write the plan (or the reconciliation) as JSON to this new file.
  --apply                     repair: write the plan (without it nothing is changed).
  --format <f>                export: markdown, docx, epub or pdf.
  --include <what>            export: manuscript (default), summary or evidence.
  --out <file>                export, backup: the file to write.
  --force                     export, backup: overwrite an existing --out file.
  --provenance                backup: include provenance/ (the receipts).
  --from <file.zip>           restore: the backup to read.
  --to <folder>               restore: a new or empty folder.
  --dump <dir>                import-legacy: the folder made by tools/legacy-dump/dump.php.
  --dry-run                   import-legacy: plan and report only (writes nothing).
  --into <folder>             import-legacy: write the books into this new (or empty) library folder, validate them and reconcile them
                              against the dump. Refused when the folder is not empty, is a file, or is inside the dump or the legacy app.
  --reconcile <folder>        import-legacy: check an existing imported library against the dump (read-only; exit 1 on any unexplained difference).
  --compare <A> <B>           import-legacy: say whether two libraries are byte-identical (ignores .storyforge/; read-only; exit 1 when they differ).
  --report <file.md>          import-legacy: write the report (plan, or reconciliation) to this new file instead of printing it.
  --help, -h                  Show this help.

Environment
  STORYFORGE_LIBRARY          Library folder when --library is not given.
  STORYFORGE_PORT             Port when --port is not given.
  STORYFORGE_PROFILE          Profile name when --profile is not given.

Exit codes
  0 ok   1 failed, or needs hand repair, or errors found   2 usage, or the library cannot be opened   3 another instance holds the library

Examples
  node apps/server/src/main.mjs --library D:/Books --open
  node apps/server/src/main.mjs backup --library D:/Books --book my-novel --out my-novel.zip --provenance
  node apps/server/src/main.mjs restore --from my-novel.zip --to D:/Restored
`;
