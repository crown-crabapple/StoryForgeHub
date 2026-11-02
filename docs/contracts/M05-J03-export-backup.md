# M05-J03 contract — manuscript export and portable backup

Binding: FORMAT-v1 §1.7 (HTML comments / app annotations — never exported to readers), §3.3 (book.md), §4.2 (order), §4.4 (variants), §4.5 (act/chapter labels), §8 (archive), §9 (`.storyforge/` disposable); DECISIONS 1, 5, 6, 7, 12.

Export **reads** the canonical files and produces bytes. It never writes into the book folder, never changes a canonical file, and needs no SQLite index.

## 1. Package `@storyforge/export`

No new npm dependencies. Zip via a small in-house writer/reader using `node:zlib` (`deflateRawSync`, `inflateRawSync`, `crc32`). PDF written by hand (§3.4).

### 1.1 Manuscript model — `assembleManuscript(bookRoot, options) → Manuscript`

- Scenes in §4.2 order; excluded: variants, archived, and scenes whose `status` is in `options.excludeStatuses` (default `[]`).
- Grouped into acts → chapters with §4.5 labels (`chapter.md`/`act.md` titles when present).
- Scene body processing: front matter removed; HTML comments (incl. `<!-- note: … -->` and `sf:` anchors) removed; `[[slug|label]]` → `label`, `[[slug]]` → the target's display name (entry `name`, thread/event `title`; unresolved → the slug text); Markdown kept otherwise.
- Options: `excludeStatuses: string[]`, `sceneTitles: boolean` (default false — scenes separated by a scene break `* * *`), `includeActs: boolean` (default true when the book has >1 act), `titlePage: boolean` (default true: title, subtitle, author/pen name from book.md).
- Returns `{ title, subtitle, author, parts: [{ label, chapters: [{ label, title, scenes: [{ id, title, markdown }] }] }], excluded: [{ id, reason }] }`.

### 1.2 Formats — `exportBook(bookRoot, format, options) → { bytes: Buffer, filename, mime, warnings: string[] }`

| format | Output |
|---|---|
| `markdown` | One `.md`: `# Title`, author line, `## Chapter label: title`, scenes joined with `\n\n* * *\n\n`. **Deterministic**: same files + options → identical bytes. LF line endings, UTF-8, no BOM, ends with one `\n`. |
| `docx` | Office Open XML (minimal parts: `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, `word/styles.xml`, `word/_rels/document.xml.rels`, `docProps/core.xml`). Title page; each chapter starts on a new page with a `Heading1`; body paragraphs `Normal` (serif, 12 pt, double spaced, first-line indent); scene break paragraph centred `* * *`; `*em*`/`_em_` → italic, `**strong**` → bold. Opens in Word/LibreOffice. |
| `epub` | EPUB 3: `mimetype` first & **stored** (uncompressed), `META-INF/container.xml`, `OEBPS/content.opf` (dc:identifier = book id, dc:title, dc:creator, dc:language from book.md or `en`, dcterms:modified fixed to the newest scene file's mtime truncated to seconds — never "now", so output is deterministic), `nav.xhtml`, one XHTML per chapter, a small CSS. Spine in chapter order. |
| `pdf` | PDF 1.4, US Letter (A4 option), 1-inch margins, Times-Roman/Italic/Bold (standard 14, WinAnsiEncoding — no font embedding), 12 pt / 24 pt leading, page numbers in the footer, chapter on new page, title page. Characters outside WinAnsi → `?` and one warning listing them. Word-wrap using the standard Times AFM widths (table in source). |

All four are deterministic for fixed input (zip entries in fixed order, fixed zip timestamps = 1980-01-01, no random IDs).

Filename: `<book-slug>.<ext>` (`.md`, `.docx`, `.epub`, `.pdf`).

### 1.3 Export verification — `verifyExport(bytes, format, manuscript) → { ok, problems: string[] }`

Re-reads the produced bytes and checks every included scene appears in canonical order: Markdown — find each scene's first 40 normalised characters in order; DOCX — unzip `word/document.xml`, strip tags, same check; EPUB — spine order equals chapter order and each scene's text is found in its chapter file; PDF — inflate/parse the content streams of each page, collect `Tj`/`TJ` text, same check (hyphen-free wrapping makes this exact). Excluded scenes must **not** appear. `exportBook` runs it and fails (throws `ExportVerificationError`) if `ok` is false.

## 2. Backup and restore

- `createBackup(bookRoot, { includeProvenance = false }) → { bytes, filename }` — zip of the book folder: every file except `.storyforge/**` and (unless `includeProvenance`) `provenance/**`. Paths stored with `/`, relative to the book root, prefixed by the book folder name (`salt-orchard/book.md`). Includes `archive/`, `assets/`, non-schema notes, everything else as-is, **byte for byte**. The zip contains only the book's own files; the manifest lives in the zip comment: JSON `{ "storyforge_backup": 1, "book_id", "files": <count>, "sha256": <hash of sorted path+hash list> }`. Filename `<slug>-backup-YYYYMMDD.zip` (date from `options.now`, default the current date — the only non-deterministic part).
- `restoreBackup(zipBytes, targetDir) → { bookRoot, files, diagnostics }`:
  - `targetDir` must not exist or be an **empty** directory → else `RESTORE_TARGET_NOT_EMPTY`.
  - **Zip-slip safe:** reject the whole archive (write nothing) if any entry name is absolute, contains `..` segments, a backslash, a drive letter, a NUL, or resolves outside `targetDir`; reject symlink entries (external attributes), duplicate names (case-insensitive), more than 20 000 entries, any entry > 200 MB or total > 2 GB uncompressed, compression methods other than 0/8.
  - Verifies the manifest hash; mismatch → `BACKUP_CORRUPT`, nothing written.
  - Writes into a temp sibling directory first, then renames to `targetDir` (or moves contents into the existing empty dir); on any failure removes the temp dir.
  - Runs `validate()` on the result and returns the diagnostics; never creates `.storyforge/`.

## 3. Server, CLI and UI

- `GET /api/books/:b/export?format=markdown|docx|epub|pdf&excludeStatuses=a,b&sceneTitles=0|1&page=letter|a4` → the bytes, `content-type` per format, `content-disposition: attachment; filename="<file>"`, `x-content-type-options: nosniff`, `cache-control: no-store`. Bad params → 400 `{error:'bad_request'}`. Verification failure → 500 `{error:'export_failed', problems}`.
- `GET /api/books/:b/backup?provenance=0|1` → the zip (same headers).
- `POST /api/library/restore?folder=<new-folder-name>` (write-guarded: loopback, Host, `x-storyforge: 1`; raw zip body, `content-type: application/zip`; size cap 512 MB → 413): restores into `<libraryRoot>/<folder>`; `folder` must be a single safe segment (`[a-z0-9-]`, 1–60) → else 400; existing non-empty → 409 `RESTORE_TARGET_NOT_EMPTY`. Then the library rescans so the book appears. Returns `{ bookRoot, diagnostics }`.
- CLI (`apps/server/src/main.mjs`): `export --library <p> --book <slug> --format <f> --out <file>`; `backup --library <p> --book <slug> --out <file.zip> [--provenance]`; `restore --from <file.zip> --to <dir>`. `--out` refuses to overwrite an existing file unless `--force`, and refuses a path inside the book folder.
- UI: in the book view header/menu an **Export…** dialog: format radio (Markdown, Word, EPUB, PDF), "Include scene titles", "Leave out scenes with status…" (checkboxes from the book's statuses), page size for PDF, **Export** → browser download; a **Back up book…** action (with "Include receipts (provenance)" checkbox, unchecked, with one-line explanation) → download. Library screen: **Restore from backup…** (file picker + folder name) → upload → opens the restored book. Follows the existing dialog components and design tokens; keyboard-accessible.

## 4. Acceptance

1. **Order:** for salt-orchard every format renders the included scenes in canonical order (verifyExport passes), variants/archived/trash scenes absent, `<!-- note -->` text absent, links rendered as names.
2. **Determinism:** Markdown/DOCX/EPUB/PDF bytes identical across two runs and on a copy of the book in another folder (pass a fixed backup date for the zip test).
3. **Structure checks:** DOCX parts present and XML well-formed (parse every part with a strict tag-balance check); EPUB `mimetype` first and stored, container/opf/nav valid references, spine order; PDF starts `%PDF-1.4`, xref offsets correct (each `n` offset points at `<num> 0 obj`), page count > 1, every page has a footer number.
4. **Exclusions:** `excludeStatuses: ['idea']` (or whatever status a fixture scene has) removes exactly those scenes; `sceneTitles` adds them.
5. **No writes:** export and backup leave the book tree (bytes + mtimes) unchanged.
6. **Backup round trip:** backup salt-orchard → restore into an empty temp dir → every file byte-identical to the original (excluding `.storyforge/`), `validate()` → `diagnostics: []`, **no `.storyforge/` created**, and the restored book opens via `createFsRepository` and the HTTP API (library listing, book, scenes) — with SQLite never created before the first request needs it (assert no index file exists right after restore).
7. **Restore refusals (nothing written):** non-empty target; zip-slip names (`../x`, `/abs`, `C:\x`, `a\..\b`); symlink entry; duplicate names; bad manifest hash; truncated zip; > entry limit (use a small injected limit in tests).
8. **Routes/CLI:** headers as specified; 400/404/409/413/403 cases; CLI `--out` refuses overwrite and in-book paths.
9. **UI render tests:** export dialog options, backup option, restore dialog.
10. **Manual (coordinator):** open the DOCX in Word or LibreOffice if available, the EPUB's XHTML in the browser, and the PDF in the browser; screenshot each.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
