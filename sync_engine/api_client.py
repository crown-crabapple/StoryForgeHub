"""
api_client.py — thin client for the app's api.php (MASTER-PLAN Phase 2/3).

On the VPS the reconcile engine + MCP server talk to api.php over the LOCAL
loopback (http://127.0.0.1:8081/api.php), so api.php stays the single DB-writer
path. Stdlib only (urllib) so it runs with no deps.
"""
from __future__ import annotations
import json
import urllib.request
import urllib.parse
import urllib.error
from typing import Any, Dict, List, Optional


class ApiError(RuntimeError):
    """api.php returned an error. `payload` carries the full JSON error body
    when there was one (e.g. a 409 conflict's current_hash/current_body), so
    callers can hand Claude enough context to merge and retry."""
    def __init__(self, msg: str, payload: Optional[dict] = None):
        super().__init__(msg)
        self.payload = payload or {}


class CodexApi:
    def __init__(self, base_url: str, token, timeout: int = 30):
        """`token` is a string, or a zero-arg callable resolved per request —
        the MCP server passes each caller's own token through (Track B1), so
        api.php scopes every call to that user instead of the service identity."""
        self.base_url = base_url
        self.token = token
        self.timeout = timeout

    def _token(self) -> str:
        return self.token() if callable(self.token) else self.token

    def _call(self, action: str, body: Optional[dict] = None, params: Optional[dict] = None) -> Any:
        qs = {"action": action}
        if params:
            qs.update({k: v for k, v in params.items() if v is not None})
        url = self.base_url + "?" + urllib.parse.urlencode(qs)
        data = None
        headers = {"X-Codex-Token": self._token(), "Accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers,
                                     method="POST" if data is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read().decode("utf-8"))
            except Exception:
                payload = {"error": f"HTTP {e.code}"}
            raise ApiError(f"{action}: {payload.get('error', e)}", payload if isinstance(payload, dict) else None)
        except Exception as e:  # noqa: BLE001
            raise ApiError(f"{action}: {e}")
        if isinstance(payload, dict) and payload.get("error"):
            raise ApiError(f"{action}: {payload['error']}", payload)
        return payload

    # --- read ---
    def ping(self) -> dict:
        return self._call("ping")

    def export(self) -> dict:
        return self._call("export")

    def get_tasks(self, book: Optional[str] = None, for_claude: Optional[int] = None,
                  status: Optional[str] = None) -> List[dict]:
        p = {"book": book, "for_claude": for_claude, "status": status}
        return (self._call("tasks", params=p) or {}).get("tasks", [])

    def get_writing_log(self, book: Optional[str] = None) -> List[dict]:
        return (self._call("writing-log", params={"book": book}) or {}).get("writing_log", [])

    # --- granular object reads (standalone plan, A3) ---
    def get_chapter(self, book: str, chapter=None, file: Optional[str] = None) -> dict:
        p = {"book": book, "id": chapter, "file": file}
        return (self._call("chapter", params=p) or {}).get("chapter", {})

    def list_entries(self, book: str, db: Optional[str] = None) -> List[dict]:
        return (self._call("entries", params={"book": book, "db": db}) or {}).get("entries", [])

    def search(self, query: str, book: Optional[str] = None, limit: int = 25) -> List[dict]:
        p = {"q": query, "book": book, "limit": limit}
        return (self._call("search", params=p) or {}).get("hits", [])

    def get_diagnostics(self, book: str, chapter) -> dict:
        return (self._call("diagnostics", params={"book": book, "id": chapter}) or {}).get("diagnostics", {})

    def list_docs(self, book: str, prefix: Optional[str] = None) -> dict:
        return self._call("docs", params={"book": book, "prefix": prefix}) or {}

    def get_doc(self, book: str, path: str) -> dict:
        return (self._call("doc", params={"book": book, "path": path}) or {}).get("doc", {})

    # --- continuity: ledger, chapter cast, character knowledge ---
    def get_ledger(self, book: str, kind: Optional[str] = None, status: Optional[str] = None) -> List[dict]:
        p = {"book": book, "kind": kind, "status": status}
        return (self._call("ledger", params=p) or {}).get("items", [])

    def get_cast(self, book: str, chapter: Optional[str] = None, slug: Optional[str] = None) -> dict:
        return self._call("cast", params={"book": book, "chapter": chapter, "slug": slug}) or {}

    def get_knowledge(self, book: str, character: str, at: Optional[str] = None) -> dict:
        return self._call("knowledge", params={"book": book, "character": character, "at": at}) or {}

    # --- granular writes ---
    def save_doc(self, payload: dict) -> dict:
        """{book, path, markdown, base_hash?, title?} — conflicts (409) and
        locked docs (423) surface as ApiError with .payload carrying
        current_hash/current_body."""
        return self._call("save_doc", body=payload)

    def append_doc(self, payload: dict) -> dict:
        return self._call("append_doc", body=payload)

    def lock_docs(self, payload: dict) -> dict:
        return self._call("lock_docs", body=payload)

    def save_ledger_item(self, payload: dict) -> dict:
        return self._call("ledger_save", body=payload)

    def delete_ledger_item(self, payload: dict) -> dict:
        return self._call("ledger_delete", body=payload)

    def set_cast(self, payload: dict) -> dict:
        return self._call("cast_set", body=payload)

    def save_knowledge(self, payload: dict) -> dict:
        return self._call("knowledge_save", body=payload)

    def delete_knowledge(self, payload: dict) -> dict:
        return self._call("knowledge_delete", body=payload)

    def create_task(self, task: dict) -> dict:
        return self._call("task_create", body=task)

    def update_task(self, task: dict) -> dict:
        return self._call("task_update", body=task)

    def save_chapter(self, payload: dict) -> dict:
        """{book, id|file, markdown, base_hash?} — 409-style conflicts surface
        as ApiError with .payload carrying current_hash/current_body."""
        return self._call("save_chapter", body=payload)

    def create_chapter(self, payload: dict) -> dict:
        return self._call("chapter_create", body=payload)

    # --- write (single DB-writer path) ---
    def push(self, books: list) -> dict:
        return self._call("push", body={"books": books})

    def apply(self, payload: dict) -> dict:
        return self._call("apply", body=payload)

    def import_snapshot(self, snapshot: dict) -> dict:
        return self._call("import", body=snapshot)
