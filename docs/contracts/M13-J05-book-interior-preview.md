# M13-J05 contract — Book interior preview with Paged.js (editing and publishing, milestone 4)

Binding: M05-J03 (export: `assembleManuscript`, `cleanBody`, `parseBlocks`, `parseInline`, `epubChapters`, exclusion rules), M13-J04 (export dialog, job pattern), M07-J04 (preferences), `packages/store` single writer.

J05 adds an **experimental** read-only "Book interior" preview: the manuscript laid out as a printed novel interior with Paged.js, in the browser, from the same manuscript representation as the other exports. The existing manuscript PDF stays exactly as it is. J05 adds no PDF export; J06 adds a PDF made from the same snapshot, stylesheet and fonts. Nothing here is "print-ready", retailer-certified or PDF/X, and the app never says so.

## 1. Dependencies

- `pagedjs` **0.4.3** exactly (MIT; its bundled dependencies MIT/ISC/CC0/BSD-3), a production dependency of `apps/server`. Only `node_modules/pagedjs/dist/paged.js` is served (the non-polyfill build: it does not auto-run).
- `@fontsource-variable/literata` **5.3.0** and `@fontsource-variable/inter` **5.3.0** (OFL-1.1) become production dependencies of `apps/server` too (they already are of `apps/web`). Fonts are served from these packages.
- Served under `GET /interior-assets/<name>` by `apps/server/src/static.mjs` from a **fixed allow-list** of files (paged.js, the Literata and Inter latin and latin-ext woff2 files for `wght` normal and italic, and the boot script of §5), with the right MIME types and `cache-control: no-cache`. No other path under `/interior-assets/` resolves.
- `docs/editing-publishing.md`: the Paged.js row says pinned 0.4.3, served by the StoryForge server, preview only in J05.

## 2. Layout settings (`interior`, a new versioned project key)

`preferences.interior` in `book.md` (project key: built-in < profile < library < book), validated in `packages/format/src/preferences.mjs`:

```yaml
interior:
  version: 1
  template: novel            # the one template in J05
  trim: 6x9                  # 6x9 | 5.5x8.5 (inches)
  font: literata             # literata | inter
  fontSize: 11               # points, 9–14 (whole or half points)
  lineHeight: 1.35           # 1.1–1.8
  margins: { inside: 0.75, outside: 0.5, top: 0.6, bottom: 0.6 }   # inches, 0.25–1.5
  chapterStart: right        # right | any
  sceneBreak: asterisks      # asterisks | ornament | blank
  runningHeads: true         # book title on left pages, chapter title on right pages
  pageNumbers: true
  frontMatter:
    copyright: ""            # plain text, up to 2,000 characters; default "Copyright © <year> <author>. All rights reserved."
    dedication: ""           # plain text, up to 1,000 characters; omitted when empty
  backMatter:
    aboutAuthor: ""          # plain text paragraphs, up to 4,000 characters; omitted when empty
```

- `BUILTIN.interior` is exactly the values above (empty strings for the three texts). Unknown keys and out-of-range values are `E102` at the exact location; `version` other than 1 is `E102` "saved by a newer StoryForge".
- Route `POST /api/books/:b/interior/layout` `{ <any of the keys above> }` (shallow merge; `margins`, `frontMatter`, `backMatter` replace as wholes) -> `200 { ok, interior, unchanged? }`. Core `withInteriorLayout`/`setInteriorLayout` copy the J03/J04 pattern. Policy `write`.

## 3. The interior document (`packages/export/src/interior.mjs`, pure)

- `renderInterior(manuscript, layout)` -> `{ html, css, report }`:
  - `html`: the body content as semantic HTML: `<section class="front title-page">` (title, subtitle, author), `<section class="front copyright-page">`, optional `<section class="front dedication">`, then for each chapter `<section class="chapter" id="ch-<n>" data-chapter="<chapterId or empty>">` with `<h2 class="chapter-title">` (label and title as the other exports give them) and each scene as `<div class="scene" id="<sceneId>">` with `<p>` paragraphs, `<h3>` for Markdown headings, and scene breaks per `sceneBreak`; part headings when the manuscript has parts (`includeActs`) as `<section class="part">`; optional `<section class="back about-author">`.
  - Text comes from the same `parseBlocks`/`parseInline` as the EPUB (export `runsHtml` as a shared helper rather than copying it). All text is escaped; no raw HTML from the manuscript ever reaches the document. Exclusion, scene order and emphasis match the EPUB exactly (same `assembleManuscript` options).
  - `css`: the template's stylesheet with the layout's values: `@page { size: 6in 9in }` (or 5.5x8.5); mirrored margins with `@page :left` / `:right` (inside on the spine side: right margin of left pages, left margin of right pages); `@page :blank` and named pages `front` and `chapter-start` with no running head and no page number on `front`, no running head on `chapter-start`; running heads via `string-set` (book title on left pages, chapter title on right pages) when `runningHeads`; page number bottom-centre via `counter(page)` when `pageNumbers`; `break-before: right` (or `page` for `any`) on chapters; `break-after: avoid` and `break-inside: avoid` on headings; first paragraph of a chapter and after a scene break not indented, others indented 1.5em; `hyphens: auto` with `lang` from the manuscript. Fonts via `@font-face` pointing at `/interior-assets/...` with a fallback stack ending in the system `serif`/`sans-serif`.
  - `report`: `{ words, scenes, chapters, unsupported: [{ kind: 'image'|'table'|'footnote'|'list'|'blockquote'|'code', sceneId, count }], missingGlyphs: [{ char, codePoint, count, sceneIds }] }`. `unsupported` lists Markdown the prototype flattens or drops (found by scanning each scene's Markdown). `missingGlyphs` lists characters outside the chosen font's `unicode-range` coverage (read once from the fontsource CSS files for the subsets StoryForge serves); such characters render in the fallback font. Coverage by `unicode-range` is an approximation and is documented as such.
- Determinism: same manuscript and layout -> byte-identical `html` and `css`.

## 4. Snapshots

- `POST /api/books/:b/interior/snapshots` `{ layout? }` (layout defaults to the book's effective `interior`; a given layout is validated like §2 and not saved) -> `201 { snapshotId, fingerprint, report }`. The server assembles the manuscript once (default export options: no excluded statuses unless the book's export settings say so, `sceneTitles: false`), renders §3, and stores `{ html, css, layout, fingerprint, report, createdAt }` in memory (latest 5 per book, 30 minutes).
- `fingerprint` = SHA-256 over the rendered `html` + `css`. `GET /api/books/:b/interior/fingerprint` -> `{ fingerprint }` for the current manuscript and effective layout, so the page can show **Preview out of date** without re-rendering in the browser.
- `GET /api/books/:b/interior/snapshots/:id/preview.html` -> a complete HTML document (§5). `404` when the snapshot expired.
- Policy `read` for all (a viewer may preview). Never a share link.

## 5. The preview document and its isolation

- The document: `<!doctype html><html lang="<lang>"><head><meta charset="utf-8"><title>…</title><style>` the §3 css `</style><script src="/interior-assets/paged.js"></script><script src="/interior-assets/interior-boot.js"></script></head><body>` the §3 html `</body></html>`. No inline script.
- Response headers: `content-type: text/html; charset=utf-8`, `cache-control: no-store`, `x-content-type-options: nosniff`, and `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`.
- The web page shows it in `<iframe sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer">`. Safe because the document contains only escaped manuscript text and StoryForge's own scripts, and the CSP blocks every other script and every network request (`connect-src 'none'`).
- `apps/server/assets/interior/interior-boot.js` (served as `/interior-assets/interior-boot.js`): moves the body content into a template, waits for `document.fonts.ready`, runs `new Paged.Previewer().preview(content, [{ [location.href]: cssText }], document.body)` with the CSS passed as text (no request), then measures and publishes `window.storyforgeInterior = { state: 'done'|'failed', pages, ms, problems: [...] }` and posts `{ type: 'storyforge-interior', ...summary }` to `parent` (same origin):
  - `clipped`: a page whose content box overflows (`scrollHeight > clientHeight + 1`), with page number.
  - `strandedHeading`: a page whose last block is a heading.
  - `widow`/`orphan`: a page that starts with a paragraph fragment of one line, or ends with a paragraph fragment of one line (measured from line boxes). These are **for review**: Paged.js 0.4.3 does not apply `widows`/`orphans`, and CSS alone is not treated as proof.
  - `missingText`: compares the concatenated text of all pages with the text of the source body (whitespace-normalised); any difference is reported (proves no omitted or duplicated prose in the preview).
  - Errors in layout -> `state: 'failed'` with the message.

## 6. The page

- **Export > Book interior (experimental)** in the Export dialog opens `/books/:b/interior` (a new full-page view; not a tab in the nav). Plus the editor-free route works directly.
- Left: controls for every §2 setting (trim, font, size, line spacing, four margins, chapter start, scene break, running heads, page numbers, copyright, dedication, about the author). Changes are saved through the layout route (debounced 800 ms) and mark the preview **out of date**; nothing re-renders until **Refresh preview**.
- Right: the iframe at the snapshot's `preview.html`, a status line ("Laying out pages…", "142 pages in 3.1 s", "Layout failed: …"), and a **Report** panel: page count, words, the `report` of §3 (unsupported content with links to scenes, missing glyphs with the fallback note), and the boot problems of §5 grouped (clipped, stranded headings, widows/orphans to review, missing text) with page numbers.
- **Preview out of date** shows when `GET .../fingerprint` (polled every 5 s while the page is visible, and after each settings save) differs from the snapshot's. Refresh creates a new snapshot.
- A fixed note: "Experimental. A preview of a printed interior; not print-ready, not checked by any printer or store, and no PDF/X." The existing **PDF** export option in the dialog is unchanged.
- House rules: controls are labelled inputs/buttons; the view is keyboard usable; no URLs in the web bundle; responsive.css untouched (the view may be desktop-only with a plain note at narrow widths).

## 7. Never

- No network from the preview (CSP `connect-src 'none'`, no external URL anywhere in the document or CSS).
- No manuscript HTML passthrough; no inline scripts; no script but `paged.js` and the boot file.
- No change to `renderPdf` or the EPUB/DOCX/Markdown outputs.
- No print-ready, retailer or PDF/X wording.

## 8. Proof

- `packages/format/test`: `interior` validation (each refusal), defaults, versioning.
- `packages/export/test/interior.test.mjs`: every included scene id appears exactly once and in EPUB order; excluded scenes absent; the concatenated text of the HTML equals the EPUB's text for the same manuscript (whitespace-normalised); emphasis and scene breaks match; escaping (a scene containing `<script>` and `&` renders as text); trim and margin values and the `:left`/`:right` mirroring in the CSS; running-head and page-number rules absent when off and absent on `front`/`chapter-start`/`:blank`; `chapterStart` right vs any; front/back matter included only when set; unsupported and missing-glyph reports on fixtures (an image, a table, a footnote; a CJK character and an emoji with Literata); determinism.
- `apps/server/test`: snapshot lifecycle, fingerprint changes with text or layout, `preview.html` headers (exact CSP) and that the body has no `<script` but the two allowed `src`s, `/interior-assets/` allow-list (an unlisted name is `404`, path tricks refused), layout route, policy, route tables.
- `apps/web/test`: the view in states (loading, laid out with report, out of date, failed), controls labelled, Export dialog entry, house rules.
- Manual proof before the PR (real browser, the app): the sample book and a generated long book (~60,000 words) lay out without `missingText` problems; pages are 6x9 and 5.5x8.5 (measured), inside margin is on the spine side on both left and right pages, no running head on title/copyright/chapter-opening/blank pages, chapters start on right-hand pages, a Unicode fixture reports missing glyphs; layout time recorded.

## 9. Known limits

- One template. No images, tables, footnotes, lists or block quotes as such (flattened or dropped, and reported).
- Widows and orphans are listed for review, not prevented.
- Long books take time to lay out in the browser; all pages stay in memory.
- Glyph coverage is judged from the font's declared `unicode-range`.
- Preview only; the matching PDF is J06.

## 10. Manual proof results (2026-11-18, Chromium in the app's browser pane)

- Sample book: 15 pages at 6x9 (576 x 864 CSS px); inside margin 0.75 in on the spine side of both left and right pages; chapters and part titles start on right-hand pages with blank pages inserted; no running head or page number on title, copyright, part-title and blank pages.
- A generated ~98,000-word book: 140 pages in 4.7–27 s; left pages carry the book title and right pages the chapter title; no `missingText`, `clipped` or `strandedHeading` problems; 92 paragraphs split across pages, every fragment 2 lines or more (Chromium applies its default `widows`/`orphans` of 2 inside Paged.js's columns), so no widow/orphan flags.
- Fixed during the check: an empty numbered page before each part title (the part wrapper is now its own section); the left running head (now a literal title in `@page :left`); widow/orphan detection (now counts line boxes of split fragments only).
- Open for J06: `preview.html` opened as a top-level page (not in the frame) did not lay out in the pane's browser; the J06 renderer loads it directly and must check this first.
