# Editing and publishing tools

M13 adds four optional checks and previews: grammar, style review, EPUB validation and a book interior preview. All of them are off until the author turns them on, and all of them run on your own computer. The shared contracts are in [`docs/contracts/M13-J01-findings-foundation.md`](contracts/M13-J01-findings-foundation.md).

## Planned integrations

Versions are the latest published when this table was written (2026-11-18, from `npm view` and `gh release view`). A version is a candidate until the job that uses it pins it.

| Integration | Job | Candidate version | Licence | Runtime need | Shipped as | Allowed by licence check? |
|---|---|---|---|---|---|---|
| Harper (`harper.js`), grammar | J02 | 3.2.0 (pinned) | Apache-2.0 (its dependency `fflate` is MIT) | none beyond the browser; runs in a web worker | JS and a WASM file (about 20 MB, 8.4 MB gzip) in the web build; the WASM loads only when grammar checks are on for the book | yes |
| textlint (`@textlint/kernel`, `@textlint/textlint-plugin-text`), style review | J03 | 16.1.1 (pinned; kernel and text plugin only) | MIT | Node.js, on the server (`packages/style`) | production dependency; the rules are StoryForge's own, in this repository (no `textlint-rule-*` packages, no dynamic loading) | yes |
| Paged.js (`pagedjs`), book interior preview | J05 | 0.4.3 (pinned) | MIT (its bundled dependencies are MIT, ISC, CC0-1.0 and BSD-3-Clause) | the browser | production dependency of `apps/server`; only `dist/paged.js` is served by the StoryForge server (`/interior-assets/paged.js`); preview only in J05, the matching PDF is J06 | yes |
| Browser renderer for PDF | J06 | to confirm in J06: `playwright-core` 1.65.1 or `puppeteer-core` 25.18.1 | Apache-2.0 (both) | an installed Chromium | optional dependency the author installs | yes |
| EPUBCheck (`w3c/epubcheck`), EPUB validation | J04 | 5.4.0 (released 2026-09-15; tested with 5.4.0, another 5.x runs with a note, any other major version is `unavailable`) | BSD-3-Clause (its distribution also holds Saxon-HE MPL-2.0, ICU4J Unicode-3.0 and W3C/SAX components) | Java 8 or newer | author-installed, not bundled and never downloaded by StoryForge: the licences of its bundled components are outside StoryForge's production allow-list and the zip is 33 MB. the real EPUBCheck tests run only when `STORYFORGE_EPUBCHECK_JAR` is set and are skipped otherwise | not applicable (not shipped) |

"Allowed by licence check" means the SPDX identifier is in `LICENSE_ALLOW` in `scripts/checks.mjs`. StoryForge is AGPL-3.0-only.

Java and the browser renderer are optional. StoryForge never installs them for you. If one is missing, the matching check reports `unavailable` with a reason. It is never shown as "no problems found".

## Grammar checks

Grammar and spelling checks are off until you turn them on for a book. They run on this computer. Nothing is sent anywhere.

To turn them on, open Settings > Grammar checks and tick "Check grammar and spelling (English)" for the book. The same section sets the dialect (American, British, Australian, Canadian or Indian English), lists the book dictionary with a Remove button per word, and lists the rules you turned off with a Turn back on button each.

The checker loads the first time a scene is checked. It is about 20 MB and is part of StoryForge, so there is nothing to download. A check runs about 1.2 seconds after you stop typing. **Check scene** in the Checks panel, or Ctrl+Alt+G ("Check grammar now"), checks at once.

Suggestions appear underlined in the scene and in the **Grammar** group of the **Checks** section of the right panel (see [Style checks](#style-checks) for the Style group). Each one shows its kind (Spelling, Grammar, Punctuation or Style), the flagged text and Harper's message. A button selects the text in the scene. The buttons on a suggestion are:

- **Replace with** a suggested text, or **Delete**. This is an ordinary edit, and Undo (Ctrl+Z) reverses it. If the text changed since the check, nothing is replaced and the scene is checked again.
- **Ignore** hides this occurrence until you close the scene.
- **Add to dictionary** (spelling only) adds the word to the book dictionary.
- **Turn off this rule** turns the rule off for the book. You can turn it back on in Settings.

When a spelling suggestion matches the name or an alias of a Codex entry, it is marked "Codex name" and **Add to dictionary** comes first. Names are never added for you.

The settings are saved in `book.md` under `preferences.checks.grammar`. See [customization.md](customization.md#grammar-checks).

Limits:

- English only. A scene of 200 characters or more that does not look like English shows the panel message "This scene does not look like English. Grammar checks support English only."
- There is no dictionary shared across books.
- Ignored suggestions are forgotten when you close the scene.
- Harper's own rules and wording are used as they are.
- A Codex link (`[[name]]`, or the target part of `[[name|label]]`) and a citation (`[@key]`) are read as one placeholder word, and no suggestion covers or crosses one.

## Style checks

Style checks are off until you turn them on for a book. They run on this computer. Nothing is sent anywhere. They are advice: no text changes unless you press a replacement.

To turn them on, open Settings > Style checks and tick "Check style" for the book. The same section has a switch and the options for each of the six rules below. Each change is saved at once.

The rules are built into StoryForge. A book's settings can switch a rule on or off and change its options, but cannot add a rule or name one. A book that names another rule is `E102` and the rule is never run.

| Rule | Default | What it flags | Options |
|---|---|---|---|
| Preferred terms | on, no pairs | a spelling from your "avoid" list, as a whole word, ignoring capitals. The replacement is your preferred spelling, with the first letter's case copied from the flagged text | pairs of a spelling to use and up to 20 spellings to avoid; "Match capital letters exactly" per pair |
| Repeated words | on | the same word twice in a row, separated only by spaces or one line break (`the the`). `very, very` is not flagged. The replacement is the word once | none |
| Punctuation style | on, but nothing is checked until you choose | quotes, dashes or ellipses that differ from your choice. The replacement is the form you chose | Quotation marks: curly or straight. Dashes: em dash without spaces, em dash with spaces, or en dash with spaces. Ellipsis: one character (…) or three dots (...). "Not checked" is the default for each |
| Repeated phrases (advice) | off | a phrase of 4 to 8 words that comes back within 300 words, ignoring phrases made only of common words. No replacement; the card links the other places | Shortest phrase (3 to 8 words), Look ahead (50 to 2000 words) |
| Long paragraphs (advice) | off | a paragraph of more than 220 words. No replacement | Longest paragraph (50 to 2000 words) |
| Run of short lines (advice) | off | 6 or more one-line paragraphs in a row, each under 12 words. No replacement | Shortest run (3 to 30 lines) |

With quotes set to curly, a quote after the start of a line, a space or one of `( [ {` and the dashes opens a quote, any other quote closes one, and a `'` between two letters is an apostrophe. A numeric range such as 1990–1995 is not flagged as a dash.

### In the editor

The right panel's **Checks** section (it was labelled "Grammar" before style checks) has a **Grammar** group and a **Style** group. When style checks are off for the book, the Style group says so and links to Settings. Style suggestions are checked about 1.5 seconds after you stop typing. **Check scene**, or Ctrl+Alt+G, checks grammar and style at once.

A style card shows the rule, "Advice" for the three advisory rules, the flagged text (a button that selects it in the scene), the message and the other places for a repeated phrase. The buttons are the replacement, which is an ordinary edit that Ctrl+Z reverses, and **Dismiss**. Dismiss in the panel has no note field; add a note from the Style checks page. When Harper's grammar check and a style rule both flag the same text for the same concern (repeated words, dashes, quotes, ellipses), only the Style card is shown.

### The Style checks page

The book's **Style checks** tab (after Insights, Tasks and AI Workspace; it has no feature switch) checks more than the open scene. When style checks are off it says so and links to Settings.

1. Choose what to check: the whole manuscript, one chapter, or chosen scenes (a checkbox per scene, grouped by chapter). Archived and excluded scenes are not checked.
2. Press **Run**. A progress bar shows "12 of 48 scenes". **Cancel** stops the scan before the next scene and keeps what it found so far. Only one scan of a book can run at a time.
3. Results are grouped **By rule** or **By chapter**; the choice is kept in the address as `?group=`. Each card shows the rule and its category, the chapter and scene, the flagged text, the message, and the buttons below.
   - **Open** opens the scene in the editor with the text selected.
   - A replacement button changes the scene and shows **Undo**. If the scene changed since the scan, nothing is changed and the card says to run the scan again. After you apply one replacement in a scene, the other cards of that scene wait for a new scan.
   - **Dismiss** takes an optional note, then **Dismiss this suggestion**.
4. With Repeated phrases on and more than one scene scanned, phrases that come back in different scenes are also reported, marked "Across scenes", each with links to the other scenes.

Below the results:

- **Dismissed** lists your dismissals, each with **Restore**. A restored suggestion comes back on the next scan.
- **No longer matching** lists dismissals whose scene was scanned without finding that passage again, each with **Remove**.

### Dismissals

A dismissal is a Markdown file in the book, `planning/style/<slug>.md`, with the rule, the scene, the flagged text, the date and your note. It hides the finding for that passage only. The match uses the flagged text and up to 24 characters either side of it, so when you edit the passage the dismissal stops hiding anything and is listed under **No longer matching** after the next scan of that scene. Restore and Remove archive the file; they never delete it.

### Receipts

Applying a replacement from the Style checks page writes a receipt: operation `author.edit`, actor `author`, workflow `check`, with a summary of the form `Style check: “original” -> “replacement” (rule-id)`. Receipts for style checks never mention AI.

### Limits

- A small set of rules, written for English. Authors cannot add rules or rule packages.
- Repeated phrases compares runs of words, not meaning.
- A scan runs on this computer's StoryForge server, one scene at a time. Its results are kept in memory, not saved, until the next scan of the book or 30 minutes after it finished.
- A scan covers at most 5,000 scenes. A scene of more than 2,000,000 characters is skipped and listed as a problem. Only the first 20,000 suggestions are kept; check a smaller part of the book to see the rest.
- Saved dismissals cover style suggestions only. Grammar **Ignore** still lasts until you close the scene.

The settings are saved in `book.md` under `preferences.checks.style`. See [customization.md](customization.md#style-checks).

## Validating an EPUB

EPUBCheck is the standard tool for testing an EPUB file against the EPUB specification. StoryForge can run it on an export, on your computer, and show the result in plain words. It never changes your manuscript and sends nothing anywhere.

### Install the two tools yourself

StoryForge does not bundle, download or install EPUBCheck or Java. EPUBCheck's download includes components under licences StoryForge does not ship, and it is 33 MB.

1. **Java 8 or newer.** Any Java runtime works; Temurin is a free one. Download page: https://adoptium.net/temurin/releases/ (choose the JRE or JDK for your system). Check it with `java -version` in a terminal.
2. **EPUBCheck 5.** Download the zip from the releases page: https://github.com/w3c/epubcheck/releases (this was tested with 5.4.0, `epubcheck-5.4.0.zip`). Unzip it somewhere you will keep it. The file you need is `epubcheck.jar` inside the unzipped folder. Another 5.x version runs with the note "tested with 5.4.0"; any other major version is reported as unavailable.
3. In StoryForge open **Settings, EPUB validation (optional)**, enter the whole path to the `java` program (`java.exe` on Windows) and to `epubcheck.jar`, choose **Save**, then **Check setup**. It says whether each is ready and, if not, why.

If a field is empty StoryForge looks, in this order, at the settings of your computer `STORYFORGE_JAVA` and `STORYFORGE_EPUBCHECK_JAR`, then `JAVA_HOME`, then the `java` on your `PATH`. EPUBCheck is only found if you name it. In shared mode only the owner can change these settings. They are saved per computer in the file `tools.json` of the StoryForge settings folder, not in a book.

### Run a check

1. Open **Export**, choose **EPUB** and tick **Validate with EPUBCheck**. StoryForge remembers the choice for the book (`preferences.checks.epub.validate`).
2. Choose **Export and check**. The dialog stays open, shows "Checking the EPUB…" and has **Cancel**. A cold run takes a few seconds.
3. The result is one of **Passed**, **Passed with warnings**, **Failed**, **Not checked** (you cancelled), **Validator unavailable** (Java or EPUBCheck is missing or not usable; the reason is shown and "Set it up in Settings") or **Check could not run** (a process problem, with the detail). Only the first two are ever shown as a pass.
4. The messages are listed by severity: a plain explanation for common problems, EPUBCheck's own code and message, where it is (file, line, column) and, when the problem is in your text, a link to the scene or chapter. Problems in the package file, the navigation document or the stylesheet have no link.
5. **Download EPUB** gives the exact file that was checked, whatever the outcome: a failed check never hides it. **Download report** gives `report.json` with the result, the explanations and EPUBCheck's own report summary.

Each check builds the EPUB once and checks those exact bytes. A later export needs its own check. One check runs per book at a time. Only the manuscript EPUB is checked, not the provenance summary or the evidence package.

### Limits

- EPUBCheck checks the file against the EPUB standard. It does not check editing, full accessibility or whether a store will accept the book. A pass is not a promise about any of those.
- You install and update Java and EPUBCheck. StoryForge only finds and runs them.
- Messages link to a scene only when EPUBCheck's line falls inside one scene of that chapter file; otherwise they link to the chapter.
- Results are kept in memory until the next check of the book or 30 minutes; they are not saved in the book.

## Book interior preview (experimental)

The interior preview lays your manuscript out as the inside of a printed novel, in your browser, so you can see pages, margins, running heads and chapter openings before you decide anything. It is a preview only: it makes no file, and your existing PDF export is unchanged.

1. Open **Export** and choose **Book interior (experimental)**. The page opens at `/books/<id>/interior`; it is not a tab.
2. On the left, set the trim size (6 x 9 or 5.5 x 8.5 inches), the font (Literata or Inter), the font size and line spacing, the four margins (the inside margin is on the spine side of every page), where chapters start (always on a right-hand page, or on the next page), the scene break, running heads, page numbers, and the text of the copyright page, a dedication and an About the author page. Changes are saved to the book (`preferences.interior` in `book.md`) 800 ms after you stop typing.
3. Choose **Refresh preview**. The page lays the book out with Paged.js, shows the pages in a frame, and says "142 pages in 3.1 s" (or why the layout failed).
4. Nothing re-renders by itself. When the book or the settings no longer match the preview, **Preview out of date** shows; the page asks every 5 seconds while it is visible and after each save.

The **Report** lists the page count and words; Markdown the preview flattens or drops (images, tables, footnotes, lists, block quotes and code) with a link to each scene; characters your chosen font does not have, which show in a fallback font; and what the layout check found on the pages, with page numbers: clipped text, headings left at the foot of a page, single lines at the top or bottom of a page (widows and orphans, listed for review, not prevented) and any difference between the text on the pages and the text of the book.

### Limits

- Experimental. A preview of a printed interior; not print-ready, not checked by any printer or store, and no PDF/X.
- One template (a novel). No images, tables, footnotes, lists or block quotes as such: they are flattened or left out, and reported.
- Widows and orphans are listed for review. Paged.js 0.4.3 does not apply `widows` or `orphans`, so they are not prevented.
- Long books take time to lay out in the browser, and all the pages stay in memory.
- Whether a character is in the font is judged from the font's declared character ranges, which is an approximation.
- The preview is made on the server from the same manuscript as the other exports, kept in memory for 30 minutes (the latest five per book) and never saved in the book. It is never shared through a share link. The preview page runs only StoryForge's own scripts and cannot reach the network.
- The matching PDF is a later job (J06).

## No downloads at run time

- Nothing is downloaded while StoryForge runs. Every asset a check needs is in the install, or is something you installed yourself.
- StoryForge sends no network traffic that you did not ask for. Your text is not sent anywhere by these checks.
- Imported books never run JavaScript rules.
- The existing manuscript PDF export stays as it is.

## What these checks do not promise

- A passing EPUB validation means the file conforms to the EPUB specification. It does not mean the book is well edited, accessible, or accepted by a retailer.
- Grammar and style findings are suggestions. They are never applied for you; a replacement is applied only when you press it.
- The book interior is experimental. It is not print-certified, and there is no PDF/X output.

## Updating this table

Each job (J02 to J06) updates its own row when it pins a version: the exact version, the licence read from the package, the runtime need and how it ships. Replace any "to confirm" cell at that point.
