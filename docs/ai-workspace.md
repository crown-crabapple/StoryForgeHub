# AI workspace

The AI workspace lets Claude work through a whole book with you: plan a chapter, draft it, check it, and keep notes on who knows what. You choose how much it may do, and you can undo any of it.

## 1. Check the module

The **AI Workspace** feature (Settings, **Features**) is on unless you or the project turned it off. It covers the workspace docs, the ledgers, the chapter cast, knowledge and state events, and the AI writing log. With it off, those changes are refused for you and for Claude and nothing is written; the files stay in the book. See [customization.md](customization.md), "Features (modules)".

The **AI Workspace** tab shows the book's workspace in sections: Overview, Docs, Chapter state, Ledgers, AI tasks and AI Activity.

## 2. Pick an AI level

Settings, **AI level** has one choice per book, and a default for the library. A book that sets none is on Planner.

| Level | The AI may |
|---|---|
| Off | only read |
| Advisor | suggest edits, add tasks, run checks |
| Planner | also change the plan, canvases, workspace docs, ledgers and chapter state |
| Co-writer | also create new chapters and scenes as drafts |

The level always wins. A connection with more permissions than the level still gets only what the level allows. Only you can change the level, unlock a doc, or set the continuity thresholds. The level limits connections only, not what you do yourself in the app.

## 3. Connect Claude

Follow [mcp.md](mcp.md) to make a connection under Settings, **AI connections (MCP)**. Reading is always allowed. Tick the permissions the level needs:

- Advisor: "The AI may suggest changes". To let it add tasks, also tick "Workspace docs and ledgers".
- Planner: also "Change the plan" and "Workspace docs and ledgers". Add "The AI may edit canvases" if you want canvases.
- Co-writer: also "Create chapters and scenes".

The **Integrations** module must be on for the book.

If a call is refused with `AI_LEVEL`, the book's level does not allow it. With `PLUGIN_SCOPE`, the connection lacks the permission. Claude will say what it skipped. `codex_status` shows each book's level.

## 4. Install the chapter-loop skill

The skill is in `skills/storyforge-chapter-loop/` (`SKILL.md` and `references/`). Install it in your Claude client as a skill. Then ask Claude things like "plan chapter 5", "write the next chapter" or "run the chapter loop".

The loop checks the book's level, finds the next chapter, makes a plan, and waits for you to approve the outline before it writes any prose. After the draft it checks continuity, records the chapter's state, and tells you what it did.

## 5. What AI Activity shows

AI Activity (a section of the AI Workspace tab) lists every change an AI connection made in the book, newest first, with the connection's name and the time: plans saved, docs written, ledger items, drafts created, tasks, writing-log entries. Each item has **Undo**, as long as the file has not been edited since. A chapter or scene the AI created has **Archive** instead, because a created file cannot be undone.

The AI never changes a scene you have written or accepted. It can only suggest an edit, which you accept or decline. New chapters and scenes it creates are marked as AI drafts with the status `drafting`; you accept one by changing its status. Words the AI writes are logged as AI words in the writing log, separate from your own, and the Insights numbers carry the human and AI split.

## 6. Undo and archive

- To undo one thing, press **Undo** on its item in AI Activity.
- To drop an AI chapter or scene, press **Archive** on its item. Nothing is deleted.
- Nothing is hard-deleted by the AI either. To drop a promise or question, it retires it (status paid or dropped); to drop a finding, it dismisses it with a reason, and you can restore it.
- Locked docs (finished chapters' state) refuse AI writes. The AI can lock a doc; only you unlock one.
