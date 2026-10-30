"""Offline tests for CodexTools using a fake api (no server, no network)."""
import os, sys, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from api_client import ApiError   # noqa: E402
from mcp_tools import CodexTools  # noqa: E402


def E(slug, name, db="characters", body="Hi"):
    return {"slug": slug, "name": name, "db": db, "status": "seed", "type": "Character",
            "fields": [{"label": "Species", "value": "Human"}], "related": [], "relatedRaw": None,
            "sections": [{"h": "Overview", "body": body}]}


class FakeApi:
    def __init__(self):
        self.applied = []
        self.pushed = []
        self.calls = []
        self.conflict = False
        self._export = {"books": [{"book": {"id": "b1", "folder": "book-one"},
                                   "entries": [E("aria", "Aria", body="captain"), E("bram", "Bram")],
                                   "chapters": [{"num": "01", "title": "The Wall", "status": "drafted",
                                                 "words": "1,200", "file": "ch01.md"},
                                                {"num": "02", "title": "The Gate", "status": "drafted",
                                                 "words": "900", "file": "ch02.md"}]}]}
    def ping(self): return {"app": "Stephen's Codex", "time": "now"}
    def export(self): return self._export
    def get_tasks(self, book=None, for_claude=None, status=None): return [{"id": 4, "title": "x"}]
    def apply(self, payload): self.applied.append(payload); return {"ok": True, "report": {"tasks": 1}}
    def push(self, books): self.pushed.append(books); return {"ok": True, "report": {"entries": 1}}
    # granular actions (Track A3/B2) — record the call, echo a plausible shape
    def search(self, q, book=None, limit=25):
        self.calls.append(("search", q, book, limit)); return [{"kind": "entry", "slug": "aria"}]
    def get_chapter(self, book, chapter=None, file=None):
        self.calls.append(("chapter", book, chapter, file)); return {"id": 7, "body": "# One"}
    def list_entries(self, book, db=None):
        self.calls.append(("entries", book, db)); return [{"db": "characters", "slug": "aria"}]
    def get_diagnostics(self, book, chapter):
        self.calls.append(("diagnostics", book, chapter)); return {"data": {"flags": []}}
    def create_task(self, task):
        self.calls.append(("task_create", task)); return {"ok": True, "task": {"id": 9, **task}}
    def update_task(self, patch):
        self.calls.append(("task_update", patch)); return {"ok": True, "task": {"id": patch["id"]}}
    def save_chapter(self, payload):
        self.calls.append(("save_chapter", payload))
        if self.conflict:
            raise ApiError("save_chapter: conflict",
                           {"error": "conflict", "current_hash": "abc123", "current_body": "# Newer"})
        return {"ok": True, "chapter": {"id": 7, "body_hash": "def456"}}
    def create_chapter(self, payload):
        self.calls.append(("chapter_create", payload)); return {"ok": True, "chapter": {"id": 8, "file": "ch-03-x.md"}}
    # workspace docs
    def list_docs(self, book, prefix=None):
        self.calls.append(("docs", book, prefix)); return {"ok": True, "latest_state": "chapter-05", "docs": []}
    def get_doc(self, book, path):
        self.calls.append(("doc", book, path)); return {"path": path, "body": "# Plan", "body_hash": "h1"}
    def save_doc(self, payload):
        self.calls.append(("save_doc", payload))
        if self.conflict:
            raise ApiError("save_doc: locked", {"error": "locked", "current_hash": "h9", "current_body": "# Done"})
        return {"ok": True, "doc": {"path": payload["path"], "body_hash": "h2"}}
    def append_doc(self, payload):
        self.calls.append(("append_doc", payload)); return {"ok": True}
    def lock_docs(self, payload):
        self.calls.append(("lock_docs", payload)); return {"ok": True, "changed": 4}
    # continuity ledgers
    def get_ledger(self, book, kind=None, status=None):
        self.calls.append(("ledger", book, kind, status)); return [{"slug": "the-sealed-letter"}]
    def save_ledger_item(self, payload):
        self.calls.append(("ledger_save", payload))
        if self.conflict:
            raise ApiError("ledger_save: status for a promise must be planned|planted|paid-off|dropped|abandoned",
                           {"error": "status for a promise must be planned|planted|paid-off|dropped|abandoned"})
        return {"ok": True, "created": True, "item": {"slug": "the-sealed-letter"}}
    def delete_ledger_item(self, payload):
        self.calls.append(("ledger_delete", payload))
        raise ApiError("ledger_delete: ledger item not found", {"error": "ledger item not found"})
    def get_cast(self, book, chapter=None, slug=None):
        self.calls.append(("cast", book, chapter, slug)); return {"ok": True, "cast": []}
    def set_cast(self, payload):
        self.calls.append(("cast_set", payload)); return {"ok": True, "msg": "2 in cast"}
    def get_knowledge(self, book, character, at=None):
        self.calls.append(("knowledge", book, character, at)); return {"ok": True, "facts": []}
    def save_knowledge(self, payload):
        self.calls.append(("knowledge_save", payload)); return {"ok": True}
    def delete_knowledge(self, payload):
        self.calls.append(("knowledge_delete", payload)); return {"ok": True}


class Tools(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()
        self.t = CodexTools(self.api)

    def test_status(self):
        s = self.t.status()
        self.assertEqual(s["books"], 1)
        self.assertEqual(s["entries"], 2)
        self.assertEqual(s["chapters"], 2)

    def test_search_delegates_to_server(self):
        hits = self.t.search("  captain  ", "b1", 10)
        self.assertEqual(hits[0]["slug"], "aria")
        self.assertEqual(self.api.calls[-1], ("search", "captain", "b1", 10))
        self.assertEqual(self.t.search("   "), [])     # blank query never hits the API
        self.assertEqual(len(self.api.calls), 1)

    def test_get_chapter(self):
        c = self.t.get_chapter("b1", 7)
        self.assertEqual(c["body"], "# One")
        self.assertEqual(self.api.calls[-1], ("chapter", "b1", 7, None))
        self.t.get_chapter("b1", file="ch01.md")
        self.assertEqual(self.api.calls[-1], ("chapter", "b1", None, "ch01.md"))
        with self.assertRaises(ValueError):
            self.t.get_chapter("b1")                   # neither id nor file

    def test_list_entries(self):
        self.t.list_entries("b1", "characters")
        self.assertEqual(self.api.calls[-1], ("entries", "b1", "characters"))

    def test_get_diagnostics(self):
        self.t.get_diagnostics("b1", 7)
        self.assertEqual(self.api.calls[-1], ("diagnostics", "b1", 7))

    def test_create_task_shape(self):
        self.t.create_task("b1", " Fix ch2 ", "details", for_claude=True, priority="high")
        kind, task = self.api.calls[-1]
        self.assertEqual(task, {"book": "b1", "title": "Fix ch2", "body": "details",
                                "for_claude": True, "priority": "high"})
        with self.assertRaises(ValueError):
            self.t.create_task("b1", "   ")
        with self.assertRaises(ValueError):
            self.t.create_task("b1", "x", priority="urgent")

    def test_update_task_patch(self):
        self.t.update_task(9, status="done", result="ok")
        self.assertEqual(self.api.calls[-1], ("task_update", {"id": 9, "status": "done", "result": "ok"}))
        with self.assertRaises(ValueError):
            self.t.update_task(9)                      # empty patch
        with self.assertRaises(ValueError):
            self.t.update_task(9, status="blocked")    # not a real status

    def test_get_entry_renders_md(self):
        md = self.t.get_entry("b1", "characters", "aria")
        self.assertIn("# Aria", md)
        self.assertIsNone(self.t.get_entry("b1", "characters", "ghost"))

    def test_list_chapters(self):
        ch = self.t.list_chapters("b1")
        self.assertEqual(ch[0]["file"], "ch01.md")

    def test_complete_task_shape(self):
        self.t.complete_task(4, "done it")
        self.assertEqual(self.api.applied[-1]["task_results"][0], {"id": 4, "status": "done", "result": "done it"})

    def test_log_writing_shape(self):
        self.t.log_writing("b1", 500, note="good day")
        row = self.api.applied[-1]["writing_log"][0]
        self.assertEqual(row["book_id"], "b1")
        self.assertEqual(row["words_added"], 500)
        self.assertEqual(row["source"], "claude")

    def test_save_entry_resolves_folder_from_snapshot(self):
        # No local books_root: folder must come from the server export.
        self.t.save_entry("b1", "characters", "cade", "# Cade")
        book = self.api.pushed[-1][0]
        self.assertEqual(book["folder"], "book-one")
        self.assertEqual(book["files"], {"Codex/Characters/cade.md": "# Cade"})
        self.assertNotIn("manuscript_present", book)  # entries never trigger archive

    def test_save_entry_rejects_unknown(self):
        with self.assertRaises(ValueError):
            self.t.save_entry("nope", "characters", "x", "y")
        with self.assertRaises(ValueError):
            self.t.save_entry("b1", "not-a-db", "x", "y")

    def test_save_chapter_routes_to_guarded_action(self):
        r = self.t.save_chapter("b1", "ch-03-the-tower", "# Chapter 3")
        kind, payload = self.api.calls[-1]
        self.assertEqual(kind, "save_chapter")
        self.assertEqual(payload, {"book": "b1", "file": "ch-03-the-tower.md", "markdown": "# Chapter 3"})
        self.assertTrue(r["ok"])
        self.t.save_chapter("b1", "ch01.md", "# One v2", base_hash="aaa")
        self.assertEqual(self.api.calls[-1][1]["base_hash"], "aaa")
        with self.assertRaises(ValueError):
            self.t.save_chapter("b1", "   ", "# x")

    def test_save_chapter_conflict_is_returned_as_data(self):
        # A refused save must come back with the current hash + body, not raise.
        self.api.conflict = True
        r = self.t.save_chapter("b1", "ch01.md", "# Stale edit", base_hash="old")
        self.assertEqual(r["status"], "refused")
        self.assertEqual(r["error"], "conflict")
        self.assertEqual(r["current_hash"], "abc123")
        self.assertEqual(r["current_body"], "# Newer")

    def test_create_chapter(self):
        r = self.t.create_chapter("b1", " The Tower ", "3")
        self.assertEqual(self.api.calls[-1], ("chapter_create", {"book": "b1", "title": "The Tower", "num": "3"}))
        self.assertEqual(r["chapter"]["file"], "ch-03-x.md")
        with self.assertRaises(ValueError):
            self.t.create_chapter("b1", "  ")

    def test_push_files_multi(self):
        self.t.push_files("b1", {"Codex/Notes/outline.md": "# O",
                                 "Codex\\Meta\\theme.md": "# T"})
        book = self.api.pushed[-1][0]
        self.assertEqual(set(book["files"]), {"Codex/Notes/outline.md", "Codex/Meta/theme.md"})
        self.assertNotIn("manuscript_present", book)  # no manuscript file in push

    def test_push_files_empty_rejected(self):
        with self.assertRaises(ValueError):
            self.t.push_files("b1", {})

    # ---- workspace docs ----
    def test_list_docs_passes_prefix(self):
        r = self.t.list_docs("b1", "state/chapter-05")
        self.assertEqual(self.api.calls[-1], ("docs", "b1", "state/chapter-05"))
        self.assertEqual(r["latest_state"], "chapter-05")
        self.t.list_docs("b1", "")
        self.assertEqual(self.api.calls[-1], ("docs", "b1", None))

    def test_get_doc_requires_path(self):
        self.assertEqual(self.t.get_doc("b1", "plan")["body_hash"], "h1")
        with self.assertRaises(ValueError):
            self.t.get_doc("b1", "  ")

    def test_save_doc_create_sends_no_hash(self):
        self.t.save_doc("b1", "development/world/region-cut", "# Cut")
        _, payload = self.api.calls[-1]
        self.assertEqual(payload, {"book": "b1", "path": "development/world/region-cut", "markdown": "# Cut"})

    def test_save_doc_update_sends_hash_and_title(self):
        self.t.save_doc("b1", "plan", "# Plan v2", base_hash="h1", title="Outline")
        _, payload = self.api.calls[-1]
        self.assertEqual(payload["base_hash"], "h1")
        self.assertEqual(payload["title"], "Outline")

    def test_save_doc_refusal_is_returned_as_data(self):
        self.api.conflict = True
        r = self.t.save_doc("b1", "state/chapter-01/situation", "x", base_hash="old")
        self.assertEqual(r["status"], "refused")
        self.assertEqual(r["error"], "locked")
        self.assertEqual(r["current_body"], "# Done")

    def test_append_and_lock_shapes(self):
        self.t.append_doc("b1", "timeline/history", "## Ch 05")
        self.assertEqual(self.api.calls[-1], ("append_doc", {"book": "b1", "path": "timeline/history", "markdown": "## Ch 05"}))
        self.assertEqual(self.t.lock_docs("b1", "state/chapter-05")["changed"], 4)
        self.assertEqual(self.api.calls[-1], ("lock_docs", {"book": "b1", "path": "state/chapter-05", "locked": True}))

    # ---- continuity ledgers ----
    def test_get_ledger_blank_filters_become_none(self):
        self.t.get_ledger("b1", "", "planted")
        self.assertEqual(self.api.calls[-1], ("ledger", "b1", None, "planted"))

    def test_save_ledger_item_sends_only_given_fields(self):
        self.t.save_ledger_item("b1", title="The Sealed Letter", planted_in="chapter-01", characters=["aria"])
        self.assertEqual(self.api.calls[-1], ("ledger_save", {"book": "b1", "title": "The Sealed Letter",
                                                              "planted_in": "chapter-01", "characters": ["aria"]}))

    def test_save_ledger_item_empty_string_clears_a_chapter(self):
        self.t.save_ledger_item("b1", slug="the-sealed-letter", payoff_in="")
        self.assertEqual(self.api.calls[-1][1], {"book": "b1", "slug": "the-sealed-letter", "payoff_in": ""})

    def test_save_ledger_item_needs_slug_or_title(self):
        with self.assertRaises(ValueError):
            self.t.save_ledger_item("b1")

    def test_ledger_refusals_are_returned_as_data(self):
        self.api.conflict = True
        r = self.t.save_ledger_item("b1", slug="x", status="open")
        self.assertEqual(r["status"], "refused")
        self.assertIn("planned|planted", r["error"])
        self.assertEqual(self.t.delete_ledger_item("b1", "nope")["error"], "ledger item not found")

    def test_get_cast_passes_chapter_as_string(self):
        self.t.get_cast("b1", 4)
        self.assertEqual(self.api.calls[-1], ("cast", "b1", "4", None))
        self.t.get_cast("b1", slug="aria")
        self.assertEqual(self.api.calls[-1], ("cast", "b1", None, "aria"))

    def test_set_chapter_cast_accepts_bare_slugs(self):
        self.t.set_chapter_cast("b1", "chapter-04", [{"slug": "aria", "role": "pov"}, "bram"])
        self.assertEqual(self.api.calls[-1], ("cast_set", {"book": "b1", "chapter": "chapter-04",
                                                           "cast": [{"slug": "aria", "role": "pov"}, {"slug": "bram"}]}))
        with self.assertRaises(ValueError):
            self.t.set_chapter_cast("b1", " ", [])

    def test_knowledge_at_and_record(self):
        self.t.knowledge_at("b1", "aria", 12)
        self.assertEqual(self.api.calls[-1], ("knowledge", "b1", "aria", "12"))
        self.t.knowledge_at("b1", "aria")
        self.assertEqual(self.api.calls[-1], ("knowledge", "b1", "aria", None))
        facts = [{"character": "aria", "knows": "Bram lit the fire", "learned_in": "10"}]
        self.t.record_knowledge("b1", facts)
        self.assertEqual(self.api.calls[-1], ("knowledge_save", {"book": "b1", "facts": facts}))
        with self.assertRaises(ValueError):
            self.t.record_knowledge("b1", [])
        self.t.delete_knowledge("b1", "aria", "bram-lit-the-fire")
        self.assertEqual(self.api.calls[-1], ("knowledge_delete", {"book": "b1", "character": "aria", "fact": "bram-lit-the-fire"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
