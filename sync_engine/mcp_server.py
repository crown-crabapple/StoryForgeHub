"""
mcp_server.py — remote MCP tool surface for Stephen's Codex.

Streamable-HTTP MCP server (FastMCP), bound to loopback 127.0.0.1:8765 and
fronted by Caddy at https://<domain>/mcp.

Auth (standalone plan, Track B1 — per-user): every request must carry a token
(`Authorization: Bearer` or `?k=` for Claude's URL-only connector UI). The
shared service API_KEY still works and stays unscoped (admin automation); any
other value is validated against api.php as a personal token from
Account → API tokens, and — the point — is passed through as the X-Codex-Token
on every api.php call, so the request acts as that user: same book membership
scoping, same role checks, same activity-log attribution as the web UI.

The server runs stateless (no MCP session affinity), so each tool call executes
inside the HTTP request that carried it and the caller's token rides a
contextvar from the auth middleware into the api client.

Run (under the venv python, by the codex-mcp systemd unit):
    API_KEY=... python -m sync_engine.mcp_server
"""
from __future__ import annotations
import contextvars
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp.server.fastmcp import FastMCP
from mcp.server.streamable_http import TransportSecuritySettings
from starlette.requests import Request
from starlette.responses import JSONResponse

from api_client import CodexApi, ApiError
from mcp_auth import TokenGate, extract_token
from mcp_tools import CodexTools

# The authenticated caller's token for the request being served. Set by the
# auth middleware, read by the CodexApi token provider on every api.php call.
CURRENT_TOKEN: contextvars.ContextVar[str] = contextvars.ContextVar("codex_token", default="")


class TokenAuthMiddleware:
    """Pure ASGI (not BaseHTTPMiddleware): the downstream app runs in this same
    context, so the contextvar set here is visible to the tool call it guards.

    When `public_url` is set, 401s carry the RFC 9728 discovery pointer so an
    OAuth-capable client (Claude's connector UI, Track B3) can find the
    authorization server and sign the user in instead of failing."""

    def __init__(self, app, gate: TokenGate, public_url: str = ""):
        self.app = app
        self.gate = gate
        self.public_url = public_url.rstrip("/")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        request = Request(scope)
        token = extract_token(request.headers.get("authorization", ""),
                              request.query_params.get("k", ""))
        if not self.gate.check(token):
            headers = {}
            if self.public_url:
                headers["WWW-Authenticate"] = (
                    'Bearer resource_metadata='
                    f'"{self.public_url}/.well-known/oauth-protected-resource"')
            return await JSONResponse({"error": "unauthorized"}, status_code=401,
                                      headers=headers)(scope, receive, send)
        ctx = CURRENT_TOKEN.set(token)
        try:
            await self.app(scope, receive, send)
        finally:
            CURRENT_TOKEN.reset(ctx)


def build_app(service_token: str, api_url: str, public_url: str = ""):
    """Build the Starlette ASGI app: stateless FastMCP + per-user token gate.
    `public_url` (e.g. https://<domain>) enables the OAuth discovery pointer on 401s."""
    api = CodexApi(api_url, lambda: CURRENT_TOKEN.get())
    tools = CodexTools(api)

    def validate(candidate: str) -> bool:
        try:
            CodexApi(api_url, candidate).ping()
            return True
        except ApiError:
            return False

    gate = TokenGate(service_token, validate)
    mcp = FastMCP("codex", host="127.0.0.1", port=8765, streamable_http_path="/mcp",
                  stateless_http=True,
                  transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))

    @mcp.tool()
    def codex_status() -> dict:
        """Health + counts: app name, and the books/entries/chapters you can see."""
        return tools.status()

    @mcp.tool()
    def codex_search(query: str, book: str | None = None, limit: int = 25) -> list:
        """Search entries, chapters, notes, and Workspace docs (server-side, with snippets)."""
        return tools.search(query, book, limit)

    @mcp.tool()
    def codex_get_entry(book: str, db: str, slug: str) -> str:
        """Return one entry rendered as Markdown (db: characters|locations|factions|objects|lore)."""
        return tools.get_entry(book, db, slug) or "(not found)"

    @mcp.tool()
    def codex_list_entries(book: str, db: str | None = None) -> list:
        """List a book's entries (db, slug, name, status, type) without bodies."""
        return tools.list_entries(book, db)

    @mcp.tool()
    def codex_save_entry(book: str, db: str, slug: str, markdown: str) -> dict:
        """Save (create/update) an entry from Markdown."""
        return tools.save_entry(book, db, slug, markdown)

    @mcp.tool()
    def codex_get_chapter(book: str, chapter_id: int | None = None,
                          file: str | None = None) -> dict:
        """Read one manuscript chapter INCLUDING its Markdown body, by id or by
        filename (e.g. 'ch01.md'). Also returns num/title/status/words."""
        return tools.get_chapter(book, chapter_id, file)

    @mcp.tool()
    def codex_save_chapter(book: str, filename: str, markdown: str,
                           base_hash: str = "") -> dict:
        """Create/update a manuscript chapter. filename is a bare name (e.g.
        'ch-05-the-wall.md'). Creating a new chapter needs no base_hash; to
        UPDATE an existing one you must pass the body_hash you got from
        codex_get_chapter — if the chapter moved meanwhile the save is refused
        and the result carries the current hash + body so you can merge and
        retry. Never save over prose you haven't read."""
        return tools.save_chapter(book, filename, markdown, base_hash)

    @mcp.tool()
    def codex_create_chapter(book: str, title: str, num: str = "") -> dict:
        """Create a new, empty titled chapter (ch-NN-title.md seeded with its
        heading). num defaults to one past the highest existing chapter."""
        return tools.create_chapter(book, title, num)

    @mcp.tool()
    def codex_push_files(book: str, files: dict, reconcile_chapters: bool = False) -> dict:
        """Push new/updated files (a map of relpath -> Markdown) to a book.
        Handles chapters (Manuscript/<file>.md), entries (Codex/<Folder>/<slug>.md),
        notes (Codex/Notes/<slug>.md), meta (Codex/Meta/<slug>.md), sources
        (Codex/Sources/<key>.md), and Workspace docs (Workspace/<path>.md, bulk —
        no hash check; prefer codex_save_doc). reconcile_chapters=True lets a manuscript push
        archive chapters it omits; default False preserves existing chapters."""
        return tools.push_files(book, files, reconcile_chapters)

    @mcp.tool()
    def codex_list_chapters(book: str | None = None) -> list:
        """List chapters (num, title, status, words, file)."""
        return tools.list_chapters(book)

    @mcp.tool()
    def codex_get_diagnostics(book: str, chapter_id: int) -> dict:
        """Prose diagnostics for a chapter — overused words, repeated phrases,
        patterns to review, dialogue tags — the app's Smart-editing data."""
        return tools.get_diagnostics(book, chapter_id)

    @mcp.tool()
    def codex_list_docs(book: str, prefix: str | None = None) -> dict:
        """List a book's Workspace docs (path, title, locked, words, body_hash)
        without bodies, optionally under a prefix ('development', 'state/chapter-05').
        The Workspace holds the planning layer: book (settings), synopsis, plan
        (the outline), structure, style, development/* proposals (not canon),
        state/chapter-NN/{characters,inventory,knowledge,situation}, and
        timeline/{history,current-chapter}. latest_state names the newest
        state/chapter-NN folder."""
        return tools.list_docs(book, prefix)

    @mcp.tool()
    def codex_get_doc(book: str, path: str) -> dict:
        """Read one Workspace doc with its body and body_hash. Paths are
        Claude-Book relpaths without '.md' (e.g. 'plan', 'style',
        'development/world/region-cut'). state/current/<file> reads the newest
        state/chapter-NN/<file>."""
        return tools.get_doc(book, path)

    @mcp.tool()
    def codex_save_doc(book: str, path: str, markdown: str,
                       base_hash: str = "", title: str = "") -> dict:
        """Create or update a Workspace doc. Creating needs no base_hash; to
        UPDATE you must pass the body_hash from codex_get_doc — a stale hash is
        refused with the current hash + body so you can merge and retry. Locked
        docs (finished chapters' state) refuse writes. timeline/history is
        append-only — use codex_append_doc. state/current/* can't be written:
        write state/chapter-NN/* instead."""
        return tools.save_doc(book, path, markdown, base_hash, title)

    @mcp.tool()
    def codex_append_doc(book: str, path: str, markdown: str) -> dict:
        """Append Markdown to the end of a Workspace doc (created if missing);
        no hash needed. Use for timeline/history and running logs."""
        return tools.append_doc(book, path, markdown)

    @mcp.tool()
    def codex_lock_docs(book: str, path: str, locked: bool = True) -> dict:
        """Lock a doc or a whole folder (e.g. 'state/chapter-05') once the
        chapter is done, so it can't be edited. Unlocking needs the owner role."""
        return tools.lock_docs(book, path, locked)

    @mcp.tool()
    def codex_get_ledger(book: str, kind: str | None = None, status: str | None = None) -> list:
        """The book's promises and open questions, ordered by the chapter that
        sets them up. kind: promise|question. Promise status: planned|planted|
        paid-off|dropped|abandoned; question status: open|resolved|dropped|
        abandoned. planted_in/payoff_in are chapter numbers (for a question:
        introduced / resolved). Check this before planning a chapter so setups
        get paid off and no payoff lands before its setup."""
        return tools.get_ledger(book, kind, status)

    @mcp.tool()
    def codex_save_ledger_item(book: str, slug: str = "", title: str = "", kind: str = "",
                               status: str = "", planted_in: str | None = None,
                               payoff_in: str | None = None, characters: list[str] | None = None,
                               notes: str | None = None) -> dict:
        """Create or update one promise (a setup the reader expects to pay off)
        or question (something the reader is waiting to learn), keyed by slug
        (derived from title when new). Only the fields you pass change.
        Chapters accept '7', 'chapter-07' or 'Ch. 7'; '' clears one. Status
        defaults from the chapters (planted / paid-off, open / resolved).
        kind defaults to promise and can't change later. Record one item per
        setup, at the chapter where it is planted or paid off."""
        return tools.save_ledger_item(book, slug, title, kind, status, planted_in,
                                      payoff_in, characters, notes)

    @mcp.tool()
    def codex_delete_ledger_item(book: str, slug: str) -> dict:
        """Delete a ledger item recorded by mistake. To retire a real setup,
        save it with status 'dropped' or 'abandoned' instead."""
        return tools.delete_ledger_item(book, slug)

    @mcp.tool()
    def codex_get_cast(book: str, chapter: str | None = None, slug: str | None = None) -> dict:
        """Who is in a chapter. With chapter (number or file): that chapter's
        cast as {slug, role} — role pov|appears (physically present) or
        mentioned (remembered, in a letter or flashback, talked about). With
        slug: every chapter that character/object is in, with its role.
        With neither: every recorded chapter cast."""
        return tools.get_cast(book, chapter, slug)

    @mcp.tool()
    def codex_set_chapter_cast(book: str, chapter: str, cast: list[dict]) -> dict:
        """Replace a chapter's cast: [{slug, role}] with role pov|appears|
        mentioned (default appears; at most one pov). Use 'appears' only for
        those physically on the page; a dead character in a flashback or a
        letter is 'mentioned'. Slugs are bible entry slugs (characters,
        objects); unknown slugs are saved with a warning."""
        return tools.set_chapter_cast(book, chapter, cast)

    @mcp.tool()
    def codex_knowledge_at(book: str, character: str, at: str | None = None) -> dict:
        """What a character knows by chapter `at` (all chapters if omitted):
        facts known before the story plus those learned up to and including
        that chapter, each with learned_in, and the character's arc beats
        (progressions) up to that point. Use it to keep a scene inside a POV
        character's knowledge."""
        return tools.knowledge_at(book, character, at)

    @mcp.tool()
    def codex_record_knowledge(book: str, facts: list[dict]) -> dict:
        """Record what characters learn: [{character, knows, learned_in?, fact?}].
        learned_in is the chapter number ('' = known before the story); fact is
        a short kebab id, unique per character, derived from `knows` if
        omitted — saving the same id again updates it. All-or-nothing."""
        return tools.record_knowledge(book, facts)

    @mcp.tool()
    def codex_delete_knowledge(book: str, character: str, fact: str) -> dict:
        """Delete one recorded fact (by its fact id) for a character."""
        return tools.delete_knowledge(book, character, fact)

    @mcp.tool()
    def codex_continuity_check(book: str, chapter: str | None = None,
                               cast: list[dict] | None = None) -> dict:
        """Deterministic continuity check over the recorded ledgers (cast,
        state events, knowledge, promises/questions) — no prose is read, the
        same data always gives the same findings. Run it BEFORE the AI
        reviewers. With chapter (+ optional cast [{slug, role}]) a draft
        chapter is checked as a candidate without saving; its findings carry
        candidate=true. Returns pass, errors, warnings, findings
        [{code, severity, chapter, slug, message}] (errors first) and
        dismissed_findings. Errors are plain contradictions (dead character on
        the page, payoff before setup, destroyed object used) — fix the
        chapter or the record. Warnings are prompts (unpaid promise, object
        away from its holder). Dismiss a deliberate one with
        codex_dismiss_finding, never by editing the record to hide it."""
        return tools.continuity_check(book, chapter, cast)

    @mcp.tool()
    def codex_get_state_events(book: str, slug: str | None = None) -> list:
        """Status changes in story order: characters died|revived; objects
        destroyed|lost|found, holder (value = who has it), location
        (value = where it is). Each holds as of the end of its chapter."""
        return tools.get_state_events(book, slug)

    @mcp.tool()
    def codex_record_state_events(book: str, events: list[dict]) -> dict:
        """Record status changes after a chapter: [{slug, event, chapter,
        value?, note?}]. event: died|revived (characters) or destroyed|lost|
        found|holder|location (objects); holder and location need value (a
        slug). One per (slug, event, chapter) — saving again replaces it.
        All-or-nothing. Record a handover as a holder event in the chapter it
        happens."""
        return tools.record_state_events(book, events)

    @mcp.tool()
    def codex_delete_state_event(book: str, slug: str, event: str, chapter: str) -> dict:
        """Delete one recorded state event (recorded by mistake)."""
        return tools.delete_state_event(book, slug, event, chapter)

    @mcp.tool()
    def codex_dismiss_finding(book: str, code: str, reason: str,
                              slug: str = "", chapter: str = "") -> dict:
        """Dismiss a deliberate continuity finding (a seance, an unreliable
        narrator, a payoff in the sequel). Needs the finding code, a reason,
        and its slug and/or chapter — a code alone is refused as too broad.
        Dismissed findings still show under dismissed_findings."""
        return tools.dismiss_finding(book, code, reason, slug, chapter)

    @mcp.tool()
    def codex_restore_finding(book: str, code: str, slug: str = "", chapter: str = "") -> dict:
        """Undo a dismissal (same code/slug/chapter it was saved with)."""
        return tools.restore_finding(book, code, slug, chapter)

    @mcp.tool()
    def codex_set_continuity_thresholds(book: str, promise_gap: int | None = None,
                                        question_gap: int | None = None) -> dict:
        """How many chapters a planted promise (default 3) or an open question
        (default 12) may go unanswered before a warning. 0 restores the
        default. Needs the owner role."""
        return tools.set_continuity_thresholds(book, promise_gap, question_gap)

    @mcp.tool()
    def codex_get_tasks(book: str | None = None, for_claude: int | None = None,
                        status: str | None = None) -> list:
        """List tasks, optionally filtered (for_claude=1, status=todo)."""
        return tools.get_tasks(book, for_claude, status)

    @mcp.tool()
    def codex_create_task(book: str, title: str, body: str = "",
                          for_claude: bool = False, priority: str = "med") -> dict:
        """Create a task on a book's Tasks page (priority: low|med|high).
        for_claude=True flags it for a future Claude session to pick up."""
        return tools.create_task(book, title, body, for_claude, priority)

    @mcp.tool()
    def codex_update_task(task_id: int, status: str | None = None,
                          result: str | None = None, title: str | None = None,
                          body: str | None = None) -> dict:
        """Update a task's status (todo|doing|done), result note, title, or body."""
        return tools.update_task(task_id, status, result, title, body)

    @mcp.tool()
    def codex_complete_task(task_id: int, result: str = "") -> dict:
        """Mark a task done with an optional result note."""
        return tools.complete_task(task_id, result)

    @mcp.tool()
    def codex_log_writing(book: str, words_added: int, total_words: int = 0,
                          chapters: str = "", minutes: int = 0, mood: str = "", note: str = "") -> dict:
        """Append a writing-log row for today."""
        return tools.log_writing(book, words_added, total_words, chapters, minutes, mood, note)

    app = mcp.streamable_http_app()
    return TokenAuthMiddleware(app, gate, public_url)


def main() -> int:
    token = os.environ.get("API_KEY", "")
    if not token:
        print("ERROR: API_KEY not set."); return 2
    api_url = os.environ.get("CODEX_API_URL", "http://127.0.0.1:8081/api.php")
    public_url = os.environ.get("CODEX_PUBLIC_URL", "")
    app = build_app(token, api_url, public_url=public_url)
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
