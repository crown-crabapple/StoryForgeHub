# Editing and publishing tools

M13 adds four optional checks and previews: grammar, style review, EPUB validation and a book interior preview. All of them are off until the author turns them on, and all of them run on your own computer. The shared contracts are in [`docs/contracts/M13-J01-findings-foundation.md`](contracts/M13-J01-findings-foundation.md).

## Planned integrations

Versions are the latest published when this table was written (2026-11-18, from `npm view` and `gh release view`). A version is a candidate until the job that uses it pins it.

| Integration | Job | Candidate version | Licence | Runtime need | Shipped as | Allowed by licence check? |
|---|---|---|---|---|---|---|
| Harper (`harper.js`), grammar | J02 | 3.2.0 (pinned) | Apache-2.0 (its dependency `fflate` is MIT) | none beyond the browser; runs in a web worker | JS and a WASM file (about 20 MB, 8.4 MB gzip) in the web build; the WASM loads only when grammar checks are on for the book | yes |
| textlint (`textlint`, `@textlint/kernel`), style review | J03 | 16.1.1 (both) | MIT | Node.js, on the server | production dependency; the `textlint-rule-*` packages are chosen in J03 | yes |
| Paged.js (`pagedjs`), book interior preview | J05 | 0.4.3 | MIT | the browser | to confirm in J05 | yes |
| Browser renderer for PDF | J06 | to confirm in J06: `playwright-core` 1.65.1 or `puppeteer-core` 25.18.1 | Apache-2.0 (both) | an installed Chromium | optional dependency the author installs | yes |
| EPUBCheck (`w3c/epubcheck`), EPUB validation | J04 | 5.4.0 (released 2026-09-15) | BSD-3-Clause | a Java runtime; minimum version to confirm in J04 | not on npm (GitHub release zip); vendored or author-installed, to be decided in J04 | yes |

"Allowed by licence check" means the SPDX identifier is in `LICENSE_ALLOW` in `scripts/checks.mjs`. StoryForge is AGPL-3.0-only.

Java and the browser renderer are optional. StoryForge never installs them for you. If one is missing, the matching check reports `unavailable` with a reason. It is never shown as "no problems found".

## Grammar checks

Grammar and spelling checks are off until you turn them on for a book. They run on this computer. Nothing is sent anywhere.

To turn them on, open Settings > Grammar checks and tick "Check grammar and spelling (English)" for the book. The same section sets the dialect (American, British, Australian, Canadian or Indian English), lists the book dictionary with a Remove button per word, and lists the rules you turned off with a Turn back on button each.

The checker loads the first time a scene is checked. It is about 20 MB and is part of StoryForge, so there is nothing to download. A check runs about 1.2 seconds after you stop typing. **Check scene** in the Grammar panel, or Ctrl+Alt+G ("Check grammar now"), checks at once.

Suggestions appear underlined in the scene and in the **Grammar** section of the right panel. Each one shows its kind (Spelling, Grammar, Punctuation or Style), the flagged text and Harper's message. A button selects the text in the scene. The buttons on a suggestion are:

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

## No downloads at run time

- Nothing is downloaded while StoryForge runs. Every asset a check needs is in the install, or is something you installed yourself.
- StoryForge sends no network traffic that you did not ask for. Your text is not sent anywhere by these checks.
- Imported books never run JavaScript rules.
- The existing manuscript PDF export stays as it is.

## What these checks do not promise

- A passing EPUB validation means the file conforms to the EPUB specification. It does not mean the book is well edited, accessible, or accepted by a retailer.
- Grammar and style findings are suggestions. Style findings are advisory and are never applied for you.
- The book interior is experimental. It is not print-certified, and there is no PDF/X output.

## Updating this table

Each job (J02 to J06) updates its own row when it pins a version: the exact version, the licence read from the package, the runtime need and how it ships. Replace any "to confirm" cell at that point.
