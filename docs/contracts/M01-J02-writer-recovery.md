# M01-J02 contract — one writer, atomic saves, recovery, external-change detection

Builds on [ADR 0001](../decisions/0001-local-web-app-stack.md) and [M01-J01](M01-J01-app-boundary.md). Binding: `DECISIONS.md` 1, 5, 6, 10; `FORMAT-v1.md` §8 (archive), §9 (`.storyforge/`).

## Goal

Every write to a project file goes through **one** module. A crash at any moment leaves each file either fully old or fully new. Archive never deletes. A file changed outside the app since the author opened it is never silently overwritten.

## New package: `@storyforge/store` (`packages/store`)

The single writer. The only package (besides `packages/format` read-only parsing and `packages/core/src/fs-repository.mjs` reads) allowed to import `node:fs`.

```js
import { openStore } from '@storyforge/store';
const store = await openStore(projectRoot);   // projectRoot = a book root
```

| Method | Behaviour |
|---|---|
| `read(rel)` | `{ bytes, sha256 }` or `null`. |
| `create(rel, bytes, { opId? })` | Fails `EXISTS` if the path exists. |
| `write(rel, bytes, { baseSha256, opId? })` | **Conflict check:** if the current file's sha256 ≠ `baseSha256` → `{ ok:false, code:'CONFLICT', current: { bytes, sha256 } }`, nothing written. `baseSha256: null` means "must not exist". |
| `move(fromRel, toRel, { baseSha256, opId? })` | Conflict check on `fromRel`; fails `EXISTS` if `toRel` exists. Old file goes to trash; never deleted. |
| `archive(rel, { baseSha256 })` | `move(rel, 'archive/' + rel)` (spec §8). |
| `restore(archivedRel, { baseSha256 })` | `move` back from `archive/`. `EXISTS` if the live path is taken. |
| `batch(opName, args, fn)` | Groups several calls under one `opId`, one journal entry, one trash folder. `fn(tx)` receives the same methods. All-or-nothing: if `fn` throws or a call fails, every change in the batch is undone from the trash. |
| `recover()` | See Recovery. Returns `{ completed: [...], rolledBack: [...], needsAttention: [...] }`. |
| `journal()` | Lists journal entries, newest first. |

Every method returns `{ ok, code, ... }`, never throws on expected failures (`EXISTS`, `CONFLICT`, `NOT_FOUND`, `OUTSIDE_ROOT`). Paths: book-root-relative, forward slashes; anything resolving outside the root or into `.storyforge/` → `OUTSIDE_ROOT`.

### Atomic write protocol (per file)

1. Journal: append the op's entry with `state: 'pending'` and, for each file, `{ rel, before_sha256, after_sha256, tmp }` — **fsync the journal file before touching any project file.**
2. Copy the current file (if any) to `.storyforge/trash/<opId>/<rel>` and fsync.
3. Write `<dir>/.<name>.sf-tmp`, fsync.
4. `rename` tmp → target. fsync the directory where the platform allows (skip silently on Windows).
5. After all files: journal entry `state: 'done'`, fsync.

Journal: `.storyforge/journal/<opId>.json`, one file per op, rewritten atomically (tmp + rename) for each state change. `opId` format as in `@storyforge/manuscript` (`YYYYMMDDTHHMMSSmmmZ-XXXXXX`).

### Recovery (`recover()`, also run by `openStore`)

For each journal entry still `pending`, for each file:

| Found on disk | Action |
|---|---|
| target sha = `after_sha256` | already done; remove nothing; leave tmp (if any) → move tmp to trash |
| target sha = `before_sha256` (or target absent and `before_sha256` null) | not done; move tmp (if any) to `trash/<opId>/unfinished/<rel>` |
| anything else | `needsAttention` — touch nothing |

Then: if every file in the entry is "done" → mark entry `completed`; if every file is "not done" → `rolledBack`; if mixed (some new, some old) → **restore the done ones from trash** so the whole op is rolled back, then `rolledBack`. A file in `needsAttention` blocks auto-restore for its entry; the entry stays `pending` and is reported.

Recovery never deletes a file and never writes a project file except to restore a trashed copy.

### Fault injection (tests only)

`import { __faults } from '@storyforge/store'` — `__faults.at = 'after-journal' | 'after-trash' | 'after-tmp' | 'after-rename' | 'before-done' | null`, `__faults.mode = 'throw' | 'exit'`. `'exit'` calls `process.exit(86)` (for child-process crash tests). Production code never sets it.

## Refactor: `@storyforge/manuscript` uses the store

`packages/manuscript/src/commit.mjs` stops writing files itself and uses `store.batch(...)`. Its contract and all 63 tests stay as they are (codes, trash layout `.storyforge/trash/<opId>/<rel>`, `op.json`, rollback). If a manuscript test depends on an internal detail that must change, report it — don't edit the test silently. Remove `node:fs` write calls from manuscript (reads via `@storyforge/format` and the store).

## `@storyforge/core` write methods

Added to `FileRepository` (and `FsRepository`), all via `@storyforge/store` and `@storyforge/manuscript`:

| Method | Behaviour |
|---|---|
| `getScene(...)` | now also returns `sha256` of the whole file |
| `updateSceneBody(bookId, sceneId, body, { baseSha256 })` | Replaces only the body; front-matter bytes kept exactly. `CONFLICT` → returns `{ code:'CONFLICT', current: SceneDoc }` so the UI can reload or compare. |
| `createScene(bookId, { chapter, act?, after, title, slug, body })` | Delegates to `insertScene`. |
| `archiveScene(bookId, sceneId, { baseSha256 })` | `store.archive`. Then re-validate; if a new error appears (e.g. a thread `setup` now points into the archive is a warning W303, fine; an error is not), roll back and return `ROLLED_BACK`. |
| `restoreScene(bookId, archivedPath, { baseSha256 })` | `store.restore`; same validation rule; `E204` on restore is refused, not auto-fixed. |
| `recover()` | `store.recover()` for every book. |

Body replacement rule: the new file = original bytes up to and including the closing front-matter `---` line terminator, followed by the new body. If the body arrives with CRLF/LF mixed, write it as given.

## Server write routes

Writes are allowed only with **all** of: loopback + Host guard (J01), `content-type: application/json`, header `x-storyforge: 1` (forces a CORS preflight; no CORS headers are ever sent). Otherwise 403 `{ error: 'forbidden' }`. Other non-GET methods/paths stay 405.

| Route | Body | Success | Failure |
|---|---|---|---|
| `PUT /api/books/:b/scenes/:s/body` | `{ body, base_sha256 }` | 200 `{ sha256 }` | 409 `{ error:'conflict', current: SceneDoc }`; 404; 400 bad JSON |
| `POST /api/books/:b/scenes` | `{ chapter, act?, after, title, slug, body }` | 201 `{ id, path }` | 400/409 with `code` |
| `POST /api/books/:b/scenes/:s/archive` | `{ base_sha256 }` | 200 `{ path }` | 409 conflict |
| `POST /api/books/:b/archive/restore` | `{ path, base_sha256 }` | 200 `{ path }` | 409 |
| `POST /api/recover` | `{}` | 200 recover report | — |

Request body limit 5 MB → 413.

## UI (minimal)

No editor yet (M03). Book view adds only: an **Archive** button on the selected scene (confirm dialog), and a banner when `recover()` at startup reported anything (`needsAttention` or rolled-back ops), listing them. No other write UI.

## Lint

Allowed `node:fs` importers become: `packages/store/src/**`, `packages/core/src/fs-repository.mjs` (reads only — no write calls; enforced by a test that greps it for `writeFile|rename|copyFile|unlink|rm`), `apps/server/src/static.mjs`, and `packages/format` (reads). `packages/manuscript/src/**` loses fs write access (lint forbids `node:fs` there except read helpers if any — prefer none).

## Acceptance (test-author)

1. **Crash matrix:** for each fault point × {create, write, move, batch of 3 files}, in a **child process** with `mode:'exit'`, then `openStore` in the parent → every touched file is either byte-identical old or byte-identical new; never partial; never missing (unless it was a create that rolled back); batch ops are all-old or all-new; journal entry ends `completed` or `rolledBack`. No tmp file left outside the trash.
2. **Same with `mode:'throw'`** in-process (no child) — the call returns a failure code; files old; trash holds copies.
3. **Archive never deletes:** archive → the file exists under `archive/` byte-identical; restore → back byte-identical; nothing missing at any step; `validate` order excludes it while archived.
4. **External change:** read a scene (sha A), modify the file on disk with plain `fs.writeFile` (sha B), then `updateSceneBody(..., {baseSha256: A})` → `CONFLICT` with `current.sha256 === B` and current body; the disk still holds B. Same for archive and via the HTTP route (409).
5. **Body-only update:** front-matter bytes identical, body replaced, file valid, order unchanged.
6. **needsAttention:** after a crash, edit the target to a third version, then recover → reported, file untouched.
7. **HTTP write guards:** missing `x-storyforge` → 403; wrong content-type → 403; `Host: evil.example` → 403; 6 MB body → 413; GET routes still work without the header.
8. **Manuscript regression:** its 63 tests still pass unmodified.
9. **Single writer:** grep/lint test — no `writeFile`, `rename`, `copyFile`, `unlink`, `rm`, `mkdir` outside `packages/store/src` (and test files).

`npm ci && npm run build && npm run lint && npm test` pass on a clean clone.
