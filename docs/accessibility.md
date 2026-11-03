# Accessibility

What StoryForge promises for people who use a keyboard, a screen reader, a small screen or reduced motion, what the automatic tests check, and the screen-reader pass the owner does by hand.

## Screen sizes

| Class | Width | What works |
|---|---|---|
| Desktop | 1200 px and wider | everything, in the reference layout |
| Tablet | 768 to 1199 px | library, book, editor with one side panel at a time, Codex, Outline, Board, Insights, Settings |
| Phone | 360 to 767 px | library, open a book, read and write a scene, scene list, Codex read and edit, comments, suggestions review, export and backup; Board, Matrix and Timeline show a list instead of the 2D canvas |

Layout rules:

- **No horizontal page scroll at 360 px.** Wide things (the Matrix table, the Board's columns on a tablet, long tables) scroll inside their own box and never widen the page.
- **Side panels are drawers.** Below 1200 px the right panel ("Details") is an overlay drawer. Below 900 px the chapters rail ("Chapters") is one too. Only one is open at a time. The button has `aria-expanded` and `aria-controls`, an open drawer keeps Tab inside it, Escape or a tap outside closes it, and focus goes back to the button that opened it. The page behind an open drawer is `inert`.
- **Split and pinned panels become a tab switch.** Below 900 px the text and its panels are one at a time, switched with the Chapters and Details buttons.
- **Touch targets are at least 44 px** on a phone (buttons, navigation links, selects, text fields, and checkboxes through their label).
- **Fields are 16 px** on a phone, so iOS does not zoom the page when one is focused. The editor text follows the typography setting and never goes below 16 px there.
- **Focus mode and full screen** work at every size.
- **Reduced motion** is honoured everywhere, drawers included.

## What the automatic tests check

These run in `npm test` (no browser, no screen reader):

- `apps/web/test/a11y-audit.test.mjs`: every core view is rendered and audited at **1280, 900, 600 and 360 px** (names, roles, landmarks, one `h1`, labelled fields, no positive `tabindex`, no duplicate ids). A render has no window, so the width is simulated with the same switch the drawers read. It also checks the drawers (collapsed and open, at each width), the focus-trap logic, the live regions, and two **keyboard walks** at tablet and phone widths with the drawers included: *create a book, write, add a scene, reorder, export* and *open a Codex entry, edit, save*. A walk checks that every control a step needs is a named stop in the tab order, and that anything inside a closed drawer is reached through its toggle.
- `apps/web/test/a11y-styles.test.mjs`: focus rings, reduced motion, the 900 px fold, dialogs that fit.
- `apps/web/test/responsive-styles.test.mjs`: the drawers, the phone fallbacks, 44 px targets, 16 px fields, reduced motion for the drawers, and the overflow rule below.
- `apps/web/test/contrast.test.mjs`, `theme-colors.test.mjs`: colour pairs in every theme.

### The overflow rule at 360 px

A stylesheet rule must not force the page wider than a 360 px window. `responsive-styles.test.mjs` flags a rule that, outside the phone media query,

- sets `width`, `min-width` or `flex-basis` to a fixed length wider than 360 px (a length inside `min()`, `max()`, `clamp()` or `calc()` can shrink, so it is fine), or
- sets `grid-template-columns` to fixed tracks whose smallest sizes add up to more than 360 px,

unless the same selector is replaced in a media query of 767 px or wider, or the rule scrolls inside its own box (`overflow: auto`). This is a pragmatic check of the stylesheet. It cannot see an unbroken long word, a wide image or a component that sizes itself in JavaScript, so a person also checks 375 px and 768 px in a browser's device mode (below).

### Live regions

Save state, toasts, the sprint timer, the Board's move announcements, the drawer open and close message and the offline bar are all polite status regions (`role="status"`, `aria-live="polite"`). Each one is on the page before it has anything to say, so a change is read out. Nothing uses `assertive`. The editor's text area is named "Scene text" and its status line is polite.

## Manual pass with a screen reader (for the owner)

NVDA is free (nvaccess.org). Use it with Firefox or Chrome on Windows. Do this once per release, at three widths: a normal window, then 768 px, then 375 px (the browser's device mode, or a narrow window). Turn on NVDA's speech viewer (NVDA menu, Tools, Speech viewer) so you can copy what it said.

Keys: `Insert+F7` lists headings, links and landmarks; `D` moves between landmarks; `H` between headings; `Tab` between controls; `Insert+Space` toggles browse and focus mode.

| # | Do this | NVDA should say | OK? |
|---|---|---|---|
| 1 | Open StoryForge. Press `Tab` once. | "Skip to content" (a link). Enter moves to the page. | |
| 2 | Press `Insert+F7`, Landmarks. | banner, Project navigation, main, and in a book Manuscript navigation and Inspector (complementary). | |
| 3 | Library: press `H`. | One heading for the page; "New book" is a button you can reach with `Tab`. | |
| 4 | Open a book. At 375 px press `Tab` to the first buttons after the navigation. | "Chapters, button, collapsed" then "Details, button, collapsed". | |
| 5 | Press Enter on **Chapters**. | "Chapters panel opened" and "Chapters, button, expanded". Focus is now inside the list of scenes. | |
| 6 | Press `Tab` many times. | Focus stays inside the open panel and wraps from the last control to the first. | |
| 7 | Press `Escape`. | "Chapters panel closed". Focus is back on the Chapters button. | |
| 8 | Repeat 5 to 7 with **Details** (also at 768 px, where Chapters is a column and only Details is a drawer). | The same, with "Details panel opened / closed". | |
| 9 | Pick a scene, then `Tab` into the text. | "Scene text, edit, multi line" (or similar). | |
| 10 | Type a sentence and wait two seconds. | "Saving" then "Saved" at the time of the save. No double speech. | |
| 11 | Press `Ctrl+Shift+F` (focus mode). | The bar and navigation disappear; the text keeps focus. `Ctrl+Shift+F` again brings them back. | |
| 12 | Board: select a card, press `Alt+Down`. | A spoken move message ("Moved ... down"). | |
| 13 | At 375 px open Board, then Threads in Matrix mode, then Timeline. | Board: chapters one under the other. Matrix: each thread is a heading with its scenes and roles. Timeline: a note that the plot is left out, then the events in order. | |
| 14 | Insights: start a sprint timer. | The time left is available as status text; nothing interrupts typing. | |
| 15 | A dialog (for example Export): press Enter on its button. | "Export, dialog". Focus is inside; `Escape` closes it and focus returns to the button. | |
| 16 | Shared mode only: turn the network off (browser developer tools, Network, Offline) and type in a scene. | "Can't reach StoryForge, retrying", then "Offline: 1 scene waiting to save". | |
| 17 | Turn the network back on. | "One scene that was waiting is saved." (or, if someone else saved first, that the text is kept as a suggestion to review). | |
| 18 | Reload the page while offline, open the same scene. | "Not saved yet, will save when back online" and your text is in the editor. | |

Write down any step where NVDA is silent, says something wrong or leaves focus somewhere unexpected, with the width you were using, and send it on. A failing step is a bug even if the automatic tests pass.

## Also check in a real browser (375 px and 768 px)

These need eyes, not a screen reader, and are the part the render tests cannot see: no sideways scrolling at 375 px on the library, a book, the editor, Codex, Board, Matrix and Timeline; the drawers slide in and out and are not clipped; the on-screen keyboard does not cover the line you are typing; at 768 px the chapters stay a column and Details opens as a drawer; with the system's reduced-motion setting on, the drawers appear without sliding.
