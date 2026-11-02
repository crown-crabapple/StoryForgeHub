# M02-J01 contract — visual system and app shell

Reference screens (read the source; they are the visual target, not code to ship):
`E:\StoryForgeHub\storyforge-v2-production-plan\design\screens\{Home,Editor,Codex}.dc.html`, tokens in `…\design\README.md` (incl. "Known override": library = cover cards, built in M02-J02, not here).

## Rules

- **No fake features.** Anything shown must work, or be clearly marked as coming later. The reference's **Share** button and **account avatar** are left out until M07 (collaboration). The **Timeline / Places / Notes / Codex** tabs exist and route to a real page that says what it will hold and which milestone delivers it (M04) — no mock data.
- **No network by default** (DECISIONS 9 spirit, README "no telemetry"): fonts are **self-hosted**. Replace the Google Fonts link with `@fontsource-variable/inter` and `@fontsource-variable/literata` (OFL; pin exact versions published ≥ 14 days ago; if a variable package doesn't exist, use the static `@fontsource/*` with weights 400/500/600 and Literata italic 400). After this job the built app makes **zero** requests to any host but its own.
- Plain CSS with custom properties, no CSS framework, no component library, no CSS-in-JS.

## 1. Tokens — `apps/web/src/theme/tokens.css`

| Group | Tokens |
|---|---|
| Surfaces | `--bg #0E0E10`, `--surface #16161A`, `--surface-2 #1C1C21` (hover), `--divider #26262C`, `--border #2A2A31` |
| Text | `--text #ECECEF`, `--text-2 #D4D4D8` (prose), `--text-3 #A1A1AA` (secondary), `--muted #8B8B95` (labels) |
| Accent | `--accent #E0A64B`, `--accent-soft` = accent at 16% alpha, `--accent-ink #141414` (text on accent) |
| States | `--danger` / `--warning` / `--ok` (pick shades that pass contrast on `--bg` and `--surface`; danger must differ from accent in lightness, not hue alone) |
| Type | `--font-ui: 'Inter Variable', Inter, system-ui, sans-serif`; `--font-prose: 'Literata Variable', Literata, Georgia, serif`; UI sizes 12/13/14/15/17; headings (serif) 22/28/30; prose 18px/1.7, measure `max-width: 72ch` (≈ reference 720px) |
| Space | 4px base: `--s1 4px` … `--s8 32px` |
| Radius | `--r-control 8px`, `--r-input 10px`, `--r-card 12px` |
| Focus | `--focus` 2px solid accent ring, 2px offset, on `:focus-visible` only |
| Layout | `--rail 260px`, `--inspector 340px`, `--topbar 56px` |

Accent is swappable: the four reference accents (`#E0A64B`, `#E8743B`, `#6FA8DC`, `#7FB685`) exist as `[data-accent=…]` overrides on `<html>`; default gold. (Choosing one is a setting in M07; this job just makes it possible and tested.)

**Contrast rule (tested):** every text token on every surface it's used on ≥ 4.5:1; `--muted` is never used on `--border`/`--surface-2` fills (measured 4.22:1 on `#2A2A31`).

## 2. Shell — `apps/web/src/shell/`

| Part | Behaviour |
|---|---|
| `TopBar` | Logo (link to `/`), **BookSwitcher** (button showing current book's initial + title + chevron; opens a listbox of books; Up/Down/Enter/Escape; Home/End; type-ahead optional), **SaveStatus**, **SearchBox** (existing), **IndexStatus** dot (existing). Height `--topbar`. |
| `SaveStatus` | Derived from real state: `Saved <time>` (last successful write or last reconcile time), `Saving…` (a write in flight), `Can't save — file changed outside` (last write got 409), `Read-only` (no book open). Icon + text, never colour alone. |
| `ProjectNav` | Under the top bar inside a book: Manuscript · Codex · Timeline · Places · Notes as real links (`/books/:id`, `/books/:id/codex`, …). Active tab: white text + 2px accent underline + `aria-current="page"`. Left: nothing yet ("New entry" from the Codex reference arrives with M04). |
| `Workspace` | Three regions: `<nav aria-label="Manuscript">` rail (`--rail`), `<main>` centre (prose measure), `<aside aria-label="Inspector">` (`--inspector`). ≥ 1200px: three columns. 760–1199px: rail + main; inspector moves below main. < 760px: one column; rail becomes a disclosure button "Chapters". No horizontal page scroll at any width ≥ 320px. |
| `Inspector` | Section component with uppercase 12px muted heading (reference style). For a scene: **In this scene** (POV, characters, locations, plot threads — names resolved via existing data where available, else slugs), **Scene notes** (`<!-- note: -->` comments from the body, read-only), **Problems** (diagnostics for this file), and **Book** problems below. |
| Skip link | "Skip to content" first in tab order, visible on focus. |
| Landmarks | `header`, `nav`, `main`, `aside` with labels; one `h1` per page. |

## 3. Pages restyled into the shell

- **Library (`/`)**: keep the existing list for now (cover cards are M02-J02), restyled with tokens. Add the reference's **"Start something new"** section heading with one honest action: "Open a folder…" is M02-J03 → show the section with text "Creating and opening books arrives in the next update." (no buttons that do nothing).
- **Book view (`/books/:id`)**: reference Editor layout — rail = manuscript outline (act → chapter → scenes, word counts, current scene highlighted with `--accent-soft` fill and accent text, "can't be read" marker from J04 kept), centre = scene title (serif 28) + meta line + prose (Literata 18/1.7). The prose display is read-only and never alters stored text: HTML comments render dimmed and italic (still visible), and wiki-links `[[slug|Label]]` render as their label with an accent dotted underline. The raw view from J04 stays for broken files. Right = Inspector.
- **Codex / Timeline / Places / Notes** tabs: a page with the tab active and a short paragraph: what it will show, "arrives in M04". Real links back.
- Status panel, banner, Repair dialog (J04) restyled with tokens; all dialogs trap focus, close on Escape, return focus to the opener.

## 4. Keyboard

Every action reachable by Tab in visual order; visible focus everywhere; BookSwitcher and dialogs fully keyboard-operable; in the manuscript rail, Up/Down move between scene links and Enter opens (roving tabindex optional — plain Tab must also work).

## 5. Tests (node --test, no browser)

`apps/web/test/` (new; add `"test"` script to apps/web package.json):
- `contrast.test.mjs`: parse `tokens.css` (all accent variants), assert the contrast table in §1 (text tokens × surfaces they're allowed on ≥ 4.5; accent-ink on accent ≥ 4.5; state colours on bg/surface ≥ 4.5; danger vs accent lightness differ by ≥ 10 L* units).
- `render.test.mjs`: `react-dom/server` `renderToStaticMarkup` of TopBar, ProjectNav, Workspace, Inspector, SaveStatus (each state), BookView with fixture data (pass data via props/a test provider — no network): landmarks present, exactly one `h1`, `aria-current` on active tab, every `onClick` element is a `<button>` or `<a href>`, no `<div onClick>`, skip link first.
- `no-network.test.mjs`: after `npm run build`, scan `apps/web/dist/**` for `http://` / `https://` URLs other than `http://www.w3.org/` namespaces and licence comments → none (fonts self-hosted).
- `prose-render.test.mjs`: wiki-link display transform and comment dimming never change the source string (pure function tests).

## Acceptance

1. Desktop (1440×960) screenshots of Library, Book view (Salt Orchard, scene "The Key" selected), and the Codex placeholder; visibly the reference look (graphite surfaces, gold accent, serif prose, three columns, top bar + project nav). Saved to evidence with the matching reference screenshots.
2. Contrast tests pass for all accent variants.
3. Keyboard: Tab from page load reaches skip link → logo → book switcher → search → status → nav tabs → manuscript rail → main → inspector, in that order; BookSwitcher operable with keys; dialogs trap and return focus. (Manual check by coordinator + render tests.)
4. Responsive: at 1024 and 390 widths no horizontal scroll; rail/inspector reflow as specified (manual screenshots).
5. Zero external requests in the browser network log on load.
6. `npm ci && npm run build && npm run lint && npm test` pass on a clean clone; existing 464 tests unaffected.
