# M07-J04 contract — themes, layouts, shortcuts, modules and prompt workflows

Binding: DECISIONS 1, 8 (the reference look is the default), 9 (AI optional; nothing sent without the author choosing); M02-J01 visual system (`theme/tokens.css`); M05-J04 AI workshop (preview-then-send, context disclosure); M06-J03 a11y rules (contrast, focus, reduced motion); M07-J01 (`library.md`, labels).

Customization never changes what a book **means**. The manuscript order, canon and Markdown bytes are the same under every profile.

## 1. Where preferences live, and precedence

| Layer | Where | Holds |
|---|---|---|
| Built-in | code | every key's default; the reference dark theme |
| Library | `library.md` `preferences:` map (author data, portable) | project defaults: `modules`, `labels` display, export defaults |
| Book | `book.md` `preferences:` map (author data, portable) | the same keys as library, for one book |
| Profile | user config `<config>/profiles/<name>.json` (per machine, not author data) | appearance: `theme`, `typography`, `layout`, `shortcuts`; personal `modules` overrides |

**Precedence (documented in `docs/customization.md`, shown in Settings):**
- **Project keys** (`modules`, export defaults): built-in < profile < library < book. A project can require a module off, e.g. no AI for this book.
- **Appearance keys** (`theme`, `typography`, `layout`, `shortcuts`): built-in < library < book < profile. The person at the keyboard always wins on how things look.

**Modules:** a module the project turns **off** cannot be turned on by a profile. A module the project leaves unset follows the profile.

**Format rules:**
- An unknown key in `preferences` → `I401` (as for unknown fields).
- A wrong value type → `E102` at `preferences.<key>`.
- `preferences:` is **additive within v1**.

**Profiles:**
- Chosen with `--profile <name>`, or `STORYFORGE_PROFILE`, or the profile switcher in Settings. The default name is `default`.
- They are stored as JSON next to `recent.json` (same config folder rules as today).

## 2. Themes and typography

**Themes:**
- `dark` (the reference, default), `light`, `high-contrast`, and custom themes.
- A custom theme is a map from token names (`--bg`, `--surface`, `--text`, `--gold`, …, the names in `theme/tokens.css`) to colours.
  - Stored in the profile, and optionally exported/imported as a `.json` file.
- Every built-in theme passes the M06-J03 contrast test.
- A custom theme failing a contrast pair shows which pair, with its ratio, before it can be applied. The author can still apply it after confirming.
- Light and high-contrast get their own `contrast.test.mjs` runs.

**Typography:**
- Manuscript font from system stacks only (no downloaded fonts): serif (reference), sans, mono, and an accessibility stack (`Atkinson Hyperlegible`, `Verdana`, sans-serif, used if installed).
- Size 14–24 px, line height 1.4–2.0, paragraph spacing, letter spacing 0–0.12 em, and measure (line length) 50–100 ch or "full width".
- These are CSS variables only.

## 3. Layouts and panels

- Which side panels are shown, their widths (resizable with mouse **and** keyboard, `role=separator` with `aria-valuenow`), and pinned panels in the right rail (order and which sections).
- Named layouts: `Writing`, `Planning`, `Review`, and custom ones saved from the current state, in the profile.
- Switching layout never reloads the page or loses an unsaved buffer.
- Below 900 px the M06-J03 collapse rules still apply.

## 4. Shortcuts

- A single registry of commands, with an id, a label and a default binding. The editor commands, navigation and dialogs that exist today all move into it.
- Settings → Shortcuts lists every command with its binding. It allows rebinding (capture a key chord), removing a binding, and resetting.
- **Conflicts:** two commands on one chord in the same scope → refused, with both names shown.
- **Reserved chords** cannot be taken: browser/OS ones (Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+L, Ctrl+Tab, F5, Alt+F4) and Tab, Shift+Tab and Escape.
- A shortcuts cheat-sheet dialog (`?` / Shift+/) lists the active bindings.

## 5. Feature modules

- Modules: `ai`, `continuity`, `receipts`, `suggestions`, `timeline`, `board`, `threads`, `insights` (J02), `tasks` (J02), `research`.
- A module that is off:
  - its navigation entries and panels disappear;
  - its write routes return `403 MODULE_OFF`, with nothing written;
  - its files stay on disk untouched and are still validated.
- **Turning `receipts` off** stops new receipts and shows a warning that the provenance chain gets a gap. Verification then reports `RCPT_CHAIN_GAP` as today.
- **`ai` off** means the AI transport is never called. This is tested through the existing zero-traffic test, with the module off.

## 6. Custom prompt components and workflows

**Prompt components** live in `<library>/_prompts/<slug>.md` (author data):

```yaml
---
schema: storyforge.prompt/v1
id: note_…
slug: tighten-dialogue
name: Tighten dialogue
inputs: [selection, scene, pov-entry]    # selection | scene | chapter | entries | threads | pov-entry | notes
task: rewrite                            # chat | rewrite
---
Rewrite the selected dialogue so each line does one job. Keep {{pov-entry.name}}'s voice.
```

- `{{selection}}`, `{{scene}}`, `{{chapter}}`, and `{{<input>.<field>}}` placeholders.
- An unknown placeholder → `E102` at `body`, with the line.
- `_prompts/` is skipped by the book scanner, like `_templates/`.

**Workflows** live in `<library>/_prompts/workflows/<slug>.md`:
- `schema: storyforge.prompt-workflow/v1`, `steps: [prompt-slug, …]`.
- Each step's output becomes the next step's `{{previous}}`. Each step is a separate preview-then-send, so the author approves every send.

**Running a component or workflow:**
- The **context preview** (M05-J04) lists every input it will send: which scene, which entries, byte and token estimate.
- Nothing is sent before the author presses Send.
- Rewrites still produce suggestions/diffs. Nothing is applied automatically.

## 7. Acceptance

1. **Two profiles, one project:**
   - Profile A: light theme, sans 18 px, layout `Planning`, Ctrl+Shift+K rebound.
   - Profile B: dark, serif, layout `Writing`, defaults.
   - Open the same fixture library under A, then B, in two server runs with different `--profile`.
   - Sha256 of every file in the library outside `.storyforge/` is identical before, between and after. `book.md` / `library.md` are not changed by profile choices.
   - The manuscript order from `GET …/structure` is identical.
   - Rendered CSS variables differ as configured (SSR or computed-style test).
2. **Precedence table test:** for every key class, the right layer wins, including "project off beats profile on".
3. **Shortcut conflicts and reserved chords are refused.** The registry covers every existing shortcut (test lists the commands found in the code vs the registry).
4. **Modules:** each module off removes its nav/panels and refuses its writes with nothing written. `ai` off sends zero network traffic.
5. **Prompts:** parse, the placeholder errors, the preview lists exactly the selected sources, and nothing is sent without Send (zero-traffic test).
6. **A11y:** contrast for every built-in theme; the keyboard walk for theme switch, layout switch, rebinding a shortcut, and running a prompt.
7. `npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
