# Performance

How fast StoryForge is on books of different sizes, how to measure it yourself, and the sizes it is comfortable with. Everything here is measured on synthetic text that a generator writes into a temporary folder; no user text is read, written or committed.

## Run it yourself

```
npm run bench                          # all four fixtures, median of 5 runs, writes bench/results/<date>-<machine-hash>.json and appends a table below
npm run bench -- --fixtures S,M        # only these fixtures
npm run bench -- --reps 3              # fewer runs (a quick look)
npm run bench -- --budget-min 15       # stop starting new runs of a fixture after this long; what finished is recorded
npm run bench -- --no-doc              # do not append to this file
```

The generators are in `bench/` (`fixtures.mjs`, `gen-book.mjs`) and are deterministic: the same code writes the same bytes. Nothing needs the network. The fixtures are deleted when the run ends.

## Fixtures

| Name | What it is |
|---|---|
| `S` | the salt-orchard sample book |
| `M` | 1 book, 60 chapters, 320 scenes, about 130,000 words (the large book of the M06-J03 recovery tests) |
| `L` | 3 books of `M` in one series, with 200 shared entries in the series' own Codex |
| `XL` | 1 book, 1,500 scenes, about 600,000 words |

## What is measured

Each number is the median of 5 runs (the raw runs are in the results file).

- **Open the library / a book, cold and warm.** Cold is the first call on a new repository (its read cache is empty). The operating system's file cache is not emptied, so a first start after a reboot is slower than the cold numbers. Warm is the second call on the same repository, with the file watcher running as it does in the app.
- **Open a scene, warm.** `getScene` on a repository that already read the book.
- **Search across the book.** One full-text query on a fresh index.
- **Full index rebuild.** Drop and rebuild the search and link index of the book from its files.
- **Incremental reconcile** after 1 and after 50 scene files were edited outside StoryForge (the index re-reads only the files that changed). `S` has fewer than 50 scenes, so there that many files were edited.
- **Export** Markdown, DOCX, EPUB and PDF of the whole book (with the check that the file matches the manuscript).
- **Backup and restore** of one book as a zip, and **`validate()`** of the whole library.

## Method and caveats

- One machine, one run of the harness, other programs left running. The numbers say how things scale, not what a particular computer will do. Run `npm run bench` on yours.
- Times are wall clock in milliseconds from `performance.now()`. The browser is not involved: these are the costs of the server side (the repository, the index, the exporters). Drawing a long outline or a big Board in the browser is a separate cost that this harness does not measure.
- The median of 5 hides the first run of a fixture, which is slower because the operating system's file cache and the JavaScript engine are cold. For the library and book opens that first run is the real "just started the app" cost; it is in the results file under `runs_ms` (for example `M`, open the library: first run 505 ms, the other four about 55 ms).
- Restore writes many small files and its time varies a great deal between runs on Windows (for `M`: 1.6 s in one full run and about 15 s in the next, while the same restore alone took 2 s). Antivirus scanning of freshly written files is the likely cause; it was not confirmed. Treat a restore time as a range, not a point.
- Only `Scene open warm under 300 ms` is asserted by a test (`npm run test:large`); everything else is recorded, not asserted, because it moves with the machine.

## Declared limits

From the run below (one machine; see the caveats). These are what StoryForge is tested at, not hard stops.

- **Comfortable up to `M` and `L`** (one book of 320 scenes and 130,000 words, or three such books in a series with 200 shared entries, 960 scenes and 390,000 words in all). Opening a scene that was read before takes about a millisecond, a search about 0.1 s, and a full index rebuild about 2 s. The first open of a book after the app starts is the slowest step: about 0.6 s for `M` and about 3.4 s for the three-book `L`.
- **`XL` works** (one book of 1,500 scenes and about 616,000 words): a full index rebuild takes about 3.4 s, an incremental reconcile after outside edits about 1.3 s, a search about 0.2 s, any export between 0.6 s and 2 s (PDF is the slowest), a backup about 1.2 s and a restore about 3 s. The first open of the book is about 1.4 s.
- **Not measured, so not promised:** books bigger than `XL`; more than three books in a library; the browser's cost of drawing a very long outline, Board or Timeline (this harness runs on the server side only); a library on a network drive or a slow disk.
- **Hard limits that apply anyway:** a restore refuses a backup with more than 20,000 files or more than 2 GB (`DEFAULT_RESTORE_LIMITS`); `XL` has about 1,850 files and 4 MB, far inside.
- **Asserted by a test:** a warm scene read stays under 300 ms and seven concurrent reads under 1.5 s on a library of three `M` books (`npm run test:large`). Nothing else here is asserted: the numbers move with the machine.

## Results

### Run 2026-11-02, machine 1d39062a, commit 640de03

Node v24.18.0, Windows_NT 10.0.22631 (win32 x64), AMD Ryzen 7 5700G with Radeon Graphics (16 threads), 16278 MB RAM. Median of 5 runs; raw numbers in `bench/results/2026-11-02-1d39062a.json`.

| Fixture | S | M | L | XL |
|---|---|---|---|---|
| Size | 8 scenes, 250 words, 1 book, 12 KB | 320 scenes, 130k words, 1 book, 1.1 MB | 960 scenes, 390k words, 3 books, 3.3 MB | 1500 scenes, 616k words, 1 book, 4.0 MB |
| Open the library, cold (new repository) | 6 ms | 55 ms | 214 ms | 113 ms |
| Open the library, warm | 7 ms | 51 ms | 195 ms | 108 ms |
| Open a book, cold (new repository) | 37 ms | 620 ms | 3.4 s | 1.4 s |
| Open a book, warm | 10 ms | 105 ms | 117 ms | 229 ms |
| Open a scene, warm | 1 ms | 1 ms | 2 ms | 1 ms |
| Search across the book | 11 ms | 100 ms | 124 ms | 219 ms |
| Full index rebuild | 73 ms | 2.0 s | 2.0 s | 3.4 s |
| Incremental reconcile after 1 outside edit | 26 ms | 601 ms | 999 ms | 1.3 s |
| Incremental reconcile after 50 outside edits | 37 ms | 1.4 s | 1.1 s | 1.3 s |
| Export Markdown | 13 ms | 334 ms | 238 ms | 599 ms |
| Export DOCX | 17 ms | 337 ms | 303 ms | 936 ms |
| Export EPUB | 16 ms | 339 ms | 301 ms | 956 ms |
| Export PDF | 15 ms | 538 ms | 554 ms | 2.0 s |
| Backup (zip) | 29 ms | 528 ms | 475 ms | 1.2 s |
| Restore (from that zip) | 89 ms | 15.8 s | 1.6 s | 3.1 s |
| validate() of the library | 18 ms | 245 ms | 651 ms | 455 ms |
| Whole fixture (generation excluded) | 7.3 s | 2 min 21 s | 3 min 22 s | 2 min 27 s |
