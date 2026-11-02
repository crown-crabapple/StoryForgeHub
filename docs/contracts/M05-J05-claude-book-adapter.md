# M05-J05 contract — Claude-Book local adapter

Binding: CLAUDE-BOOK-INTEGRATION.md (adapter contract, modes, canon rule); DECISIONS 1, 5, 9, 10; contracts M04-J01 (resolver), M04-J04 (timeline/notes), M05-J01 (event `state`, findings). Audit of `E:\Claude-Book-main` (2026-11-02): context packs are built today by the orchestrator through hosted `codex_*` tools; agents are pure file-in/file-out under `.work/<book>/`; the only local deterministic tool is `scripts/style/style_checker.py` (stdlib Python, writes `<repo>/.work/chapter-NN-tech-report-<uuid8>.md`, chapter number taken from the **file name**); the "continuity check" is the hosted `codex_continuity_check`, reading ledgers only.

The adapter **replaces the `codex_*` reads** (workflow steps 2, 5, 8) and turns step-12 write-backs into proposals. It does not change Claude-Book's rules, templates, agent prompts or scripts.

## 1. Package and CLI

- New package `@storyforge/claude-book` (`packages/claude-book`), depends on `@storyforge/format` and `@storyforge/continuity`. No network, no SQLite, no npm deps.
- CLI: `node packages/claude-book/bin/sf-claude-book.mjs <command> --book <book folder> --framework <Claude-Book root> [--work-id <name>]`.
  - `--framework` defaults to env `CLAUDE_BOOK_ROOT`; must contain `CLAUDE.md` and `scripts/style/style_checker.py` → else exit 2.
  - `--work-id` defaults to the book `slug`; the work dir is `<framework>/.work/<work-id>/` (created if missing).
  - Exit codes: 0 ok, 1 findings with errors (for `check`), 2 usage/IO error.
- Commands this job: `context --chapter <n>` and `style --scene <id|path> | --chapter <n>` and `review-request --chapter <n>` (§4). (`check`/`plan`/`suggest`/`co-write`/`publish` are M05-J06.)
- Adapter version `ADAPTER_VERSION = 1` written into every generated file's header/manifest.

## 2. Write boundary

- Writes **only** under `<framework>/.work/<work-id>/` and reads the style checker's own output from `<framework>/.work/`. It never writes into the book folder, never creates `.storyforge/` there, never edits anything else in the framework.
- Every run writes `<work>/adapter-manifest.json`: `{ adapter_version, book_root, book_id, chapter, generated: [paths], sources: [{ path, sha256 }] }` (sources = every canonical file read).
- Each run of `context` replaces `<work>/context/` entirely (it is "rebuilt each chapter; never edit by hand") — delete-then-write is allowed **only** inside `<work>/context/`.

## 3. Context pack — `context --chapter <n>`

Chapter numbering: Claude-Book `NN` = v2 `chapter` number (§4.1); "up to chapter n" = scenes with chapter < n in book order; the target chapter's scenes are the candidate. Output in `<work>/context/`, same names and shapes as `.work/kethra/context/`:

| File | Source in v2 | Shape |
|---|---|---|
| `book.md` | `book.md` (front matter rendered as `- **Field:** value` lines + body) | Markdown |
| `style.md`, `structure.md`, `synopsis.md`, `plan.md` | planning docs found by slug or file name (`planning/style.md`, `planning/plan.md`, …; also `title` match case-insensitive). Missing → file containing `_Not provided in the StoryForge project._` | Markdown |
| `previous-chapter.md` | scenes of chapter n−1 in order, bodies joined with `\n\n---\n\n`, comments stripped, links → names | Markdown |
| `previous-scene.md` (new, extra) | last scene before the target chapter's first scene | Markdown |
| `entries-index.md` | every non-archived entry | concatenated pretty JSON objects `{db, slug, name, status, type, detail}`; `db` = plural folder (`characters`…), `type` = Title-cased type, `detail` = `role` or first `fields` value or `""` |
| `characters/<slug>.md`, `locations/`, `factions/`, `objects/`, `lore/`, `<custom plural>/` | each entry relevant to the target chapter (in its scenes' `pov`/`characters`/`locations`/other entry lists, or linked/mentioned in the scene bodies) | `# Name` then `- **Slug:**`, `- **Status:**`, `- **Type:**`, one `- **Label:** value` per field, `- **Related:** [[a]], …` then the entry body |
| `ledger.md` | threads | JSON objects `{slug, kind, title, status, planted_in, payoff_in, characters, notes, updated_at}`; `status` mapped planned→`open`… exactly: planned/planted/developed/open→`open`, paid→`paid-off`, dropped/abandoned→`dropped`, unresolved→`unresolved`; `planted_in`/`payoff_in` = chapter number (string) of the earliest setup/payoff scene or `""`; `notes` = body first paragraph; `updated_at` = file mtime ISO |
| `state-events.md` | events' `state` items except `learns`/`knows`, events with narrative position before the target chapter | JSON objects `{slug, event, chapter, value, note}`; `chapter` = the event's narrative chapter; `note` = event title |
| `knowledge/<slug>.md` | `learns` items for each relevant character before the target chapter | `{ok: true, character, at: "<n-1>", facts: [{fact, knows, learned_in}]}`; `knows` = the fact key with `-` → space |
| `state/current/{characters,inventory,knowledge,situation}.md` | derived: characters (alive/dead, location from `location` state), inventory (holders), knowledge (per character), situation (`_Derived from StoryForge events up to chapter n−1._` + last 5 events as bullets) | Markdown headings + bullets as in `templates/state/*.md` (read the templates for headings) |
| `timeline/history.md`, `timeline/current-chapter.md` | events with narrative position < n (history) / = n (current), story-time order, `## <when> — <title>` + body | Markdown |
| `continuity-check.md` | `checkContinuity` findings whose sources touch chapters ≤ n, written in the orchestrator's prose layout (`# Continuity check - chapter NN candidate`, pass, errors, warnings with titles and file:line evidence, dismissed = suppressed with rationale file) | Markdown |
| `candidate/chapter-NN-candidate.md` (outside `context/`, in `<work>/`) | target chapter's scenes, comments stripped, joined with `\n\n---\n\n` | Markdown |

JSON shapes are compared by a test against a **key schema** file checked into the adapter (`shapes/kethra-context-shapes.json`, produced once from `.work/kethra/context/` by a script that records only key names and value types — no manuscript text). Tests never read `E:\Claude-Book-main` directly.

## 4. Running the existing chain

- `style --chapter n` (or `--scene`): writes the candidate as `<work>/candidate/chapter-NN-candidate.md` (file name carries the chapter number so the checker names its report), runs `python <framework>/scripts/style/style_checker.py --min-words <a> --max-words <b> <candidate>` (`a`,`b` from book.md `x-claude-book: { min_words, max_words }` if present, else 1, 100000), with `cwd` = the script folder; locates the new report in `<framework>/.work/chapter-NN-tech-report-*.md` created after the run started, **copies** it to `<work>/reports/chapter-NN-style-tech-report.md` (leaves the original), and prints PASS/FAIL. Python via `--python <exe>` or `python`; missing → exit 2 with a plain message.
- `review-request --chapter n`: writes `<work>/reports/chapter-NN-review-request.md` — for each reviewer (`style-linter`, `character-reviewer`, `continuity-reviewer` in `analysis/.claude/agents/`): the agent file path, its input files mapped to the generated pack paths, and its expected output path `<work>/chapter-NN-<kind>-report.md`. The LLM reviewers are run by the orchestrator (Claude Code), not by the adapter.

## 5. Acceptance

1. **Valid pack:** salt-orchard `context --chapter 2` produces every file in §3; JSON files parse as concatenated objects whose keys/types match `shapes/kethra-context-shapes.json`; `ledger.md` has `brass-key`; `entries-index.md` lists every entry; `continuity-check.md` contains the Maren eyes CF1 with both file:line sources; deterministic (two runs → identical bytes except `updated_at` which comes from mtimes and is stable).
2. **No canonical change:** the whole book tree (bytes + mtimes + file list) is identical before and after `context`, `style`, `review-request`; no `.storyforge/` created in the book.
3. **Write boundary:** a run with `--framework` set to a temp copy of a minimal framework writes only under `<temp>/.work/<work-id>/` (plus the checker's own report under `<temp>/.work/`); nothing else in the temp framework changes.
4. **Style checker runs:** with Python present, `style --chapter 1` produces the copied report with the `## Verdict` line; test skipped (reported, not passed) when Python is absent.
5. **State derivation:** on `continuity-cases` (M05-J01), dead/holder/location/knowledge values appear in `state-events.md`, `knowledge/<slug>.md` and `state/current/*.md` exactly.
6. **Comparison with the current workflow (coordinator):** run the real chain on salt-orchard chapter 1 with the real `E:\Claude-Book-main`: adapter `context` + `style`, then the `character-reviewer` and `continuity-reviewer` agent prompts run by subagents on the generated pack; record the report headings vs. the kethra reports, and confirm the continuity reviewer sees the eye-colour conflict. Record in RESULT; the book folder unchanged.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.

## Boundary

The existing `codex_*` MCP workflow stays as the supported path until M06. This adapter never calls it and never writes to StoryForgeHub legacy.
