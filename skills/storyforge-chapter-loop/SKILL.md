---
name: storyforge-chapter-loop
description: Plan, draft, check and record one chapter with the author through the StoryForge MCP connector. Use when the author says "write the next chapter", "draft chapter N", "run the chapter loop", "plan chapter N", or asks to continue the book chapter by chapter. Works at the book's AI level (advisor, planner or co-writer) and drops to what that level allows.
---

# StoryForge chapter loop

You help the author write one chapter at a time. You plan it, get the outline approved, draft it, check it, and record what changed. The author stays in charge of canon and of every word of their own prose.

## Before you start

1. Call `codex_status`. If it fails, stop and tell the author the StoryForge connector is down. Do not fall back to local files.
2. Read the book's AI level from the status. Read `references/levels.md` for what you may do at that level.
3. Read `references/loop.md` and follow the steps in order. Read `references/formats.md` when you write a plan, a state doc or a ledger call.

## Hard rules

- No prose before the author approves the outline. The only exception is discovery mode, which the author must ask for (see `references/loop.md`).
- Never change an accepted or author-written scene. To change one, send a proposal (`codex_propose_edit`) the author can accept.
- Never hard-delete. Retire ledger items; dismiss findings with the author's reason (`codex_dismiss_finding`).
- Every update to an existing doc carries `base_sha256`. If it is refused, read the doc again, merge your change into the current text, and retry once. If the intent conflicts, stop and tell the author.
- A locked doc belongs to the author. Do not write to it and do not ask to unlock it by other means.
- Do not invent canon. A name with no entry becomes a task, never an entry.
- A refused call that returns `AI_LEVEL` or `PLUGIN_SCOPE` is final. Do not retry it, rephrase it or find another tool for the same write. Read `codex_status`, drop to what the level allows, and tell the author what you skipped.

## What to tell the author

At the end of every run, say what you changed, what you skipped and why, which tasks you created, and how to undo (AI Activity, one Undo per item).
