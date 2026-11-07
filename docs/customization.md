# Customizing StoryForge

You can change how StoryForge looks, which panels and features are on, which keys do what, and add your own AI prompts. None of it changes what your book **means**: the manuscript order, your Codex and the Markdown bytes of every file are the same whatever you choose.

Everything about how things look lives in a **profile**, a small file on this computer. A profile never writes to a book, to `library.md` or to any file in your library. Project-level choices (which features a book may use) live in `library.md` and `book.md`, which you edit by hand.

## Where a setting can come from

There are four layers.

| Layer | Where it lives | What it holds |
|---|---|---|
| Built-in | the program | every setting's default; the dark reference theme |
| Library | `preferences:` in `library.md` (your files, portable) | project defaults for the whole library |
| Book | `preferences:` in `book.md` (your files, portable) | the same keys, for one book |
| Profile | `profiles/<name>.json` in StoryForge's settings folder (this computer only) | your theme, type, layout, shortcuts and personal feature choices |

### Which one wins

| Kind of setting | Keys | Order (the last one wins) |
|---|---|---|
| **Project** | `modules`, `labels`, `export` | built-in, then your profile, then `library.md`, then `book.md` |
| **Appearance** | `theme`, `typography`, `layout`, `shortcuts` | built-in, then `library.md`, then `book.md`, then your profile |

In words: for how things **look and feel**, the person at the keyboard always wins. For **which features are on**, the project wins, so a book can say "no AI for this book" and no profile can turn it back on. A feature the project says nothing about follows your profile.

Settings that are mappings (typography, layout, shortcuts, modules) are merged key by key: a profile that sets only `size` keeps the `family` from the library. Settings > Which setting wins shows where each non-default value comes from.

A value that is wrong in `library.md` or `book.md` is ignored when settings are resolved, and the checker tells you: an unknown key is `I401`, a wrong kind of value is `E102` at `preferences.<key>`.

### Example: a book that must not use AI

In `book.md`:

```yaml
---
schema: storyforge.book/v1
id: book_01JQ8ZM9S346Q3D25VT4F5V37E
slug: salt-orchard
title: The Salt Orchard
profile: fiction
status: drafting
preferences:
  modules:
    ai: false
  typography:
    size: 20
---
```

## Profiles

A profile is chosen in this order:

1. `--profile <name>` on the command line (`node apps/server/src/main.mjs --library D:/Books --profile night`),
2. the `STORYFORGE_PROFILE` environment variable,
3. the profile called `default`.

Names are lower-case letters, digits, hyphen and underscore, up to 40 characters. In **Settings > Profile** you can switch profiles, or create one. Switching changes your choices at once; it never touches a library. Two people (or two moods) can open the same library with different profiles and see the same book, the same order and the same files.

A profile is the JSON file `<settings folder>/profiles/<name>.json`, next to `recent.json`. On Windows the settings folder is `%APPDATA%\StoryForge`; elsewhere it is `$XDG_CONFIG_HOME/storyforge` or `~/.config/storyforge`.

## Themes

Settings > Theme offers **Dark** (the reference look and the default), **Light**, **High contrast**, and your own custom themes. "Follow the project" removes your own choice so `library.md` or `book.md` decides.

Every built-in theme passes the same contrast checks as the dark one: body text 4.5:1 or better on every surface, the accent readable as text and as a focus ring, and state colours (error, warning, ok) readable and different from the accent by lightness, not by hue alone.

### Making a custom theme

Open "Custom theme" in Settings > Theme. A theme is a name and a colour for any of these tokens, each written `#RRGGBB`:

`--bg`, `--surface`, `--surface-2`, `--divider`, `--border`, `--text`, `--text-2`, `--text-3`, `--muted`, `--accent`, `--accent-ink`, `--danger`, `--warning`, `--ok`

Tokens you leave alone keep the dark reference value. Choose **Check contrast**: any pair below the readable minimum is listed with its ratio, for example `--text on --bg: 2.31:1 (needs 4.5:1)`. You can still apply a theme that fails, but only after you tick "I understand and want to apply it anyway".

### Exporting and importing a theme

- **Export as a file** saves the theme as `<name>.theme.json`:

  ```json
  { "schema": "storyforge.theme/v1", "name": "Paper", "tokens": { "--bg": "#FFFFFF", "--text": "#101010" } }
  ```

- **Import a file** reads such a file into the editor. Nothing is applied until you check the contrast and choose Apply theme. A file that is not valid JSON, has another schema, or has a bad colour is refused with a message.

## Typography

Settings > Typography changes the manuscript text only, and only through CSS variables:

| Setting | Range |
|---|---|
| Font | Serif (the reference), Sans, Monospace, Accessibility (Atkinson Hyperlegible, then Verdana, used if installed) |
| Size | 14 to 24 px |
| Line height | 1.4 to 2.0 |
| Space between paragraphs | 0 to 2 em |
| Letter spacing | 0 to 0.12 em |
| Line length | 50 to 100 characters, or full width |

Fonts are system fonts only; nothing is downloaded.

## Layouts and panels

A layout says which side panels show, how wide they are, and which sections the right panel shows and in what order.

- **Writing** (the default: chapters on the left, everything on the right), **Planning** (wider panels, events and research first) and **Review** (no chapter panel; continuity, suggestions and receipts first).
- Settings > Layout switches layouts, hides or shows either panel, reorders the right panel's sections, and **saves the current layout under a name** of your own.
- The right panel's sections are `goal`, `scene`, `plan`, `linked`, `notes`, `events`, `research`, `continuity`, `comments`, `suggestions`, `problems`, `revisions`, `receipts` and `book-problems`. `plan` (shown as "Plan", after Scene facts) holds the scene's planning fields; it belongs to the `planner` feature, so it is hidden when that feature is off. The Planning layout pins it.
- Switching layout never reloads the page and never loses text you have not saved yet.
- Resize a panel by dragging its edge, or Tab to the edge (it is a separator with a value) and use Left and Right arrows (Shift for bigger steps, Home and End for the limits).
- Below 900 px wide the narrow-screen rules still apply: one column, the chapters behind a button.

## Shortcuts

Press **?** anywhere (or choose Shortcuts in the top bar) for the cheat sheet: every command with the key it has right now.

Settings > Shortcuts lists every command. **Change** waits for the keys you press; **Remove** unbinds the command; **Reset** puts the default back.

- Two commands in the same place (editor, chapter list, Board, Timeline, everywhere) cannot share a chord. The message names both commands.
- These chords cannot be used at all: Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+L, Ctrl+Tab, F5, Alt+F4, Tab, Shift+Tab and Escape. Escape and Tab in dialogs are fixed.
- Chords are written `Mod+Alt+Shift+Key`; `Mod` is Ctrl (Cmd on a Mac). In a profile, `{"shortcuts": {"focus.toggle": "Mod+Shift+K"}}` rebinds focus mode; `null` removes a binding.

Default commands: `editor.bold` Ctrl+B, `editor.italic` Ctrl+I, `editor.link` Ctrl+K, `editor.note` Ctrl+Alt+M, `editor.sceneBreak` Ctrl+Enter, `editor.save` Ctrl+S, `focus.toggle` Ctrl+Shift+F, `help.shortcuts` ?, `outline.moveUp` / `outline.moveDown` Alt+Up / Alt+Down, `board.moveUp` / `board.moveDown` / `board.chapterBack` / `board.chapterForward` Alt+arrows, `timeline.moveUp` / `timeline.moveDown` Alt+Up / Alt+Down.

## Features (modules)

Settings > Features turns features on and off: `ai`, `continuity`, `receipts`, `suggestions`, `timeline`, `board`, `threads`, `insights`, `tasks`, `research`, `planner` (Story Planner: causal links, scene plans and the story plan), `integrations`.

The **Plan** tab is a canvas. It is shown when `planner` or `board` is on. With `planner` on it has the plan layers, the plan check, the Inspector, the plan tools, Build your plan canvas and List mode; with only `board` on it is the free canvas. Canvases can be saved when either is on. See [contracts/M10-plan-canvas.md](contracts/M10-plan-canvas.md).

A feature that is **off**:

- disappears from the navigation and the panels (its project tab, its section in the right panel, its views);
- refuses its changes: a request answers `403 MODULE_OFF` and nothing is written;
- keeps its files on disk, untouched, and they are still checked by the validator.

A feature the **project** turns off (in `library.md` or `book.md`) shows as "Set by this project" and cannot be switched on from a profile.

### Receipts off

Turning **receipts** off stops new receipts, and the provenance chain gets a gap. StoryForge asks before it does this and keeps a warning in Settings while it is off. Receipts already on disk are untouched, and verification works as it does today (it reports `RCPT_CHAIN_GAP` wherever a later receipt no longer starts where the one before it ended).

### AI off

With `ai` off StoryForge never calls the AI transport: no request, not even the connection test, leaves your computer. This holds even when a provider is set up.

## Custom prompts

Your own AI prompts are Markdown files in the `_prompts` folder of your library (next to `library.md`). `_prompts` is not a book; it is skipped when books are found, and its files are checked for mistakes.

### A prompt component: `_prompts/tighten-dialogue.md`

```yaml
---
schema: storyforge.prompt/v1
id: note_01JQ8ZP1XPA7Z3DJ8FSSZ5AWSH
slug: tighten-dialogue
name: Tighten dialogue
inputs: [selection, scene, pov-entry]
task: rewrite
---
Rewrite the selected dialogue so each line does one job. Keep {{pov-entry.name}}'s voice.
```

- `slug` is the file name without `.md`; `id` is a `note_` id.
- `inputs` is what the prompt reads: `selection`, `scene`, `chapter`, `entries`, `threads`, `pov-entry`, `notes`.
- `task` is `chat` (a reply to read) or `rewrite` (a proposed replacement for the selection, which needs the `selection` input).
- Placeholders: `{{selection}}`, `{{scene}}`, `{{chapter}}`, `{{previous}}`, and `{{<input>.<field>}}` such as `{{pov-entry.name}}` (fields: entries `name slug type role status body`, threads `title slug kind status body`, notes `title tags body`). `{{scene}}`, `{{chapter}}` and every `body` stand for "the file, included below": the text is sent once, as a file.
- An unknown placeholder is an error (`E102` at `body`, with the line number). Settings > Custom prompts lists any prompt with problems.

### A workflow: `_prompts/workflows/polish.md`

```yaml
---
schema: storyforge.prompt-workflow/v1
id: note_01JQ8ZP1XPA7Z3DJ8FSSZ5AWSJ
slug: polish
name: Polish
steps: [tighten-dialogue, summarise]
---
```

Each step's reply becomes `{{previous}}` for the next step.

### Running one

In the editor choose **Run a prompt...** (it appears when AI is on for the book). Choose the prompt or workflow, pick the entries, threads or notes it asks for, and choose **Preview context**. You see every source it will send (which scene, which entries, bytes and a token estimate) and the exact messages. **Nothing is sent until you press Send.** In a workflow each step has its own preview and its own Send. A rewrite comes back as a suggestion you can review; nothing is applied to your scene unless you accept it.

## Quick reference

| I want to... | Do this |
|---|---|
| Use a different look on this computer | Settings > Theme / Typography / Layout (saved in my profile) |
| Keep two sets of choices | Create a second profile; start with `--profile <name>` |
| Forbid AI in one book | `preferences: { modules: { ai: false } }` in that book's `book.md` |
| Share a custom theme | Export it, send the `.theme.json` file; the other person imports it |
| Rebind a key | Settings > Shortcuts > Change |
| Add my own prompt | A Markdown file in `<library>/_prompts/` |
