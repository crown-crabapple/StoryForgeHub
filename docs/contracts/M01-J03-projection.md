# M01-J03 contract — rebuildable SQLite projection and search

Binding: DECISIONS 1, 5 (SQLite is a cache), FORMAT-v1 §9, [ADR 0001](../decisions/0001-local-web-app-stack.md), [M01-J02](M01-J02-writer-recovery.md).

## Rules

1. The index is **derived only from Markdown files**. Deleting it loses nothing. Every row can be recomputed from the files.
2. It stores **no canonical field the files don't hold**, and nothing typed by the author is written only to it.
3. One index per book: `<book>/.storyforge/index.sqlite`. Library-wide queries union the books' indexes.
4. Built **in memory** (`new DatabaseSync(':memory:')`), then `db.serialize()` → bytes → `store.writeMeta('index.sqlite', bytes)` (atomic). Queries open the file read-only. A reader never sees a half-built index.
5. **Reads never wait for the index.** If it's missing, older than the files, unreadable, or a different `schema_version`, the repository answers from files (J01 path) and schedules a rebuild. While a rebuild runs, the old index (if any) keeps serving.
6. `node:sqlite` is imported only in `packages/index/src/**` (lint rule).

## New package: `@storyforge/index` (`packages/index`)

```js
import { openIndex } from '@storyforge/index';
const idx = openIndex(bookRoot, { store });   // store from @storyforge/store
```

| Method | Behaviour |
|---|---|
| `status()` | `{ state: 'missing'|'fresh'|'stale'|'building'|'error', built_at, schema_version, file_count, stale_paths: string[] }`. Freshness = every indexed file's `(size, mtime_ms)` matches disk and the set of `.md` files is the same; when size/mtime differ, compare sha256 before calling it stale. |
| `rebuild()` | Full rebuild from files. Returns `{ ok, ms, counts }`. Concurrent calls share one in-flight build. |
| `refresh()` | Incremental: re-read only files whose sha changed, plus added/removed files; recompute order, links, mentions and diagnostics for the book (cheap; uses `validate`). Result must equal a full rebuild (tested). |
| `query.*` | Read-only helpers below. Throw `INDEX_NOT_READY` if not fresh — callers fall back to files. |

### Tables (`schema_version = 1`)

| Table | Columns | From |
|---|---|---|
| `meta` | `key`, `value` — `schema_version`, `built_at`, `format`, `book_id` | build |
| `files` | `path` PK, `sha256`, `size`, `mtime_ms`, `kind`, `schema`, `id` | every `.md` under the book (not `.storyforge/`) |
| `objects` | `id` PK, `kind` (scene/entry/thread/event/chapter/act/doc/research/source/book), `slug`, `title`, `type`, `status`, `path`, `archived` 0/1 | front matter |
| `scenes` | `id` PK, `position`, `act`, `chapter`, `sequence`, `act_label`, `chapter_label`, `title`, `status`, `pov`, `word_count`, `path` | `validate` order (non-excluded only) |
| `excluded` | `id`, `path`, `reason` | `validate` |
| `links` | `src_id`, `src_path`, `location`, `raw`, `target_id`, `target_kind`, `resolution` (`ok`/`previous_slug`/`archived`/`broken`/`cross_book`/`wrong_kind`) | body links + front-matter references (spec §1.8) |
| `mentions` | `entry_id`, `scene_id`, `count` | whole-word, case-insensitive, diacritic-insensitive matches of an entry's `name` and `aliases` in scene bodies (HTML comments and code excluded) |
| `diagnostics` | `code`, `severity`, `file`, `location`, `message` | `validate` |
| `fts` | FTS5 virtual table `(id UNINDEXED, kind UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2')` | scene, entry, thread, event, doc, research bodies (comments and code stripped) |

### Query helpers (`idx.query`)

`bookSummary()`, `scenes()`, `excluded()`, `chapters()`, `links({ srcId?, targetId?, resolution? })`, `backlinks(id)`, `mentions({ entryId?, sceneId? })`, `diagnostics()`, `counts()` → `{ scenes, entries, threads, events, links, broken_links, words }`, `search(q, { kinds?, limit=20 })` → `[{ id, kind, title, path, snippet }]` ranked by bm25; `q` is user text — escape it into a phrase/prefix FTS query, never pass raw FTS syntax.

## `@storyforge/core` changes

- `FsRepository` keeps one `openIndex` per book. `listBooks` / `getBook` use the index when `fresh`, else files (rule 5) and trigger `refresh()` in the background.
- After every successful write (J02 methods) call `refresh()` for that book.
- New methods: `search(q, { bookId?, kinds?, limit? })`, `getBacklinks(bookId, id)`, `getMentions(bookId, { entryId?, sceneId? })`, `indexStatus(bookId?)`, `rebuildIndex(bookId?)`.
- Results from index and from files must be identical in shape and value for `listBooks` / `getBook` (tested).

## Server

| Route | Notes |
|---|---|
| `GET /api/search?q=&book=&kinds=scene,entry&limit=` | `q` required, 1–200 chars; 400 otherwise |
| `GET /api/books/:b/backlinks/:id` | |
| `GET /api/books/:b/mentions?entry=&scene=` | |
| `GET /api/index/status` | all books |
| `POST /api/index/rebuild` | write-guarded (J02 rules); `{ book? }` |

Startup: `main.mjs` opens the server immediately, then builds missing/stale indexes in the background.

## Web (minimal)

A search box in the top bar → results list (title, kind, snippet with the match in `<mark>`; snippet text is escaped, `<mark>` added by the client). Clicking a scene result opens it in the book view. An index status dot (fresh / building / stale) with a "Rebuild index" button. No other UI.

## Acceptance (test-author)

1. **Delete and rebuild:** on temp copies of `salt-orchard`, `library`, `spec-example`: build; record `scenes`, `objects`, `links`, `mentions`, `diagnostics`, `counts`, and 6 search results; delete `.storyforge/`; rebuild; all identical (except `built_at`).
2. **Matches fixtures:** index `scenes` order/IDs = `expected.json`; `diagnostics` = `validate()` diagnostics; `links` resolution counts match a recount from `validate` + file parsing; counts match FsRepository-from-files.
3. **Search:** `"isle"` finds the scene with `Ísle` (diacritics); a word only inside an HTML comment is **not** found; a word only in a fenced code block is not found; a Japanese phrase from salt-orchard is found; FTS syntax injection (`"a" OR b*`, `NEAR(`, `:`, quotes) never throws and returns a plain-text match or nothing.
4. **Incremental = full:** edit a body, add a scene (via `createScene`), archive a scene, rename an entry slug with `previous_slugs` — after each, `refresh()` tables equal a fresh `rebuild()`.
5. **Stale detection:** external `fs.writeFile` to a scene → `status().state === 'stale'` with that path; `getBook` still returns the new text (from files) immediately.
6. **Reads during rebuild:** start a rebuild, and while it runs call `getBook` / `getScene` → correct answers (from old index or files); never `INDEX_NOT_READY` to the caller.
7. **Corrupt index:** write garbage bytes to `index.sqlite` → status `error`, reads fall back to files, `rebuild()` replaces it.
8. **No canonical data only in index:** for every table, every value is reproducible from files (covered by 1); plus a grep test that `packages/index/src` never calls the store's `write`/`create`/`move`/`archive` (only `writeMeta`).
9. **Index == files:** `listBooks`/`getBook` with fresh index deep-equal the file path for all valid fixtures.
10. **Server:** search route (400 on empty/too long), backlinks, mentions, status, rebuild guard (403 without header).
11. **Speed:** `getBook` on salt-orchard with a fresh index under 50 ms (median of 20, after warm-up). Record the number.

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
