# AI workspace

The AI workspace lets Claude work through a whole book with you: plan a chapter, draft it, check it, and keep notes on who knows what. You choose how much it may do, and you can undo any of it.

## 1. Turn it on

Open the book's settings and turn on the **AI workspace** module. It is off by default, and while it is off the AI can only read and suggest, as described in [mcp.md](mcp.md).

## 2. Pick an AI level

Choose a level for each book:

| Level | The AI may |
|---|---|
| Advisor | read, suggest edits, add tasks and notes, run checks |
| Planner | also change the plan, canvases, workspace docs, ledgers and chapter state |
| Co-writer | also create new chapters and scenes with draft text |

The level always wins. A connection with more permissions than the level still gets only what the level allows. Only you can change the level, lock or unlock docs, and set continuity thresholds.

## 3. Connect Claude

Follow [mcp.md](mcp.md) to make a connection under Settings, **AI connections (MCP)**. Give it the permissions the level needs: `read` and `propose` for Advisor, plus `plan` and `workspace` for Planner, plus `draft` for Co-writer. The **Integrations** module must be on for the book.

If a call is refused with `AI_LEVEL`, the book's level does not allow it. With `PLUGIN_SCOPE`, the connection lacks the permission. Claude will say what it skipped.

## 4. Install the chapter-loop skill

The skill is in `skills/storyforge-chapter-loop/`. Copy that folder into your Claude skills folder (for Claude Code, `.claude/skills/` in your project or in your home folder). Then ask Claude things like "plan chapter 5", "write the next chapter" or "run the chapter loop".

The loop checks the book's level, finds the next chapter, makes a plan, and waits for you to approve the outline before it writes any prose. After the draft it checks continuity, records the chapter's state, and tells you what it did.

## 5. What AI Activity shows

AI Activity lists everything the AI did in the book: plans saved, docs written, ledger items, drafts created, tasks, writing-log entries. Each item has an **Undo**.

The AI never changes a scene you have written or accepted. It can only suggest an edit, which you accept or decline. New chapters and scenes it creates are marked as AI drafts. Words the AI writes are logged as AI words, so Insights can show the human and AI share.

## 6. Undo and archive

- To undo one thing, open AI Activity and press **Undo** on its item.
- Nothing is hard-deleted. To drop a promise or question, the AI retires it; to drop a finding, it dismisses it with a reason, and you can restore it.
- Locked docs (finished chapters' state) refuse AI writes. Unlock them yourself if you need to change them.
- Anything you do not want in the book can be moved to the trash or archived as usual, like any other file.
