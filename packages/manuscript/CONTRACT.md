# @storyforge/manuscript — ordering and recovery contract (M00-J04)

Proves that scene order survives cache loss and metadata trouble, using only files. Builds on `@storyforge/format` (`../format`). Spec: `E:\StoryForgeHub\storyforge-v2-production-plan\spec\FORMAT-v1.md`. Decisions: `E:\StoryForgeHub\storyforge-v2-production-plan\DECISIONS.md` (6 = atomic writes, 4–5 = files are authoritative).

## Rules every operation obeys

1. **Bodies are never touched.** An operation may change only the front-matter lines for `act`, `chapter`, `sequence`, and the file's path. Every byte of the body, and every other front-matter byte, stays identical.
2. **Minimal front-matter edit.** Change a field by replacing its single top-level line `key: <integer>` (exact regex `^(act|chapter|sequence):[ \t]*-?\d+[ \t]*$`, multiline, preserving the file's line ending). If the line is missing or not in that simple form → refuse with `REFUSED_UNSIMPLE_FIELD`. Never re-serialise YAML.
3. **Atomic write** (decision 6): write `<dir>/.<name>.sf-tmp`, fsync it, copy the current file (if any) to the trash, then `rename` the temp over the target. A path change writes the new path atomically, then **moves** the old file into the trash. Nothing is ever deleted.
4. **Trash:** `<book>/.storyforge/trash/<op-id>/<original relative path>`. `op-id` = `YYYYMMDDTHHMMSSmmmZ-<6 random base32>`. Each operation also writes `<book>/.storyforge/trash/<op-id>/op.json` = `{ op, args, at, changes: [{ from, to, before_sha256, after_sha256 }] }`.
5. **Refuse on a broken book.** Before writing, run `validate(book)`. If any **error** exists on a manuscript file (E1xx/E2xx on any file under `manuscript/`), refuse with `REFUSED_INVALID_BOOK` and the diagnostics. Warnings do not block.
6. **Verify after.** After writing, run `validate` again. If any new error appeared, roll back from the trash (restore every changed file, remove files the op created) and return `ROLLED_BACK`. A rolled-back book must be byte-identical to before.
7. **Dry run first.** Every operation has `{ dryRun: true }` which returns the planned `changes` and writes nothing.

## API

```js
import { insertScene, moveScene, renumberChapter, rebuildIndex, readIndex, planRepair, applyRepair } from '@storyforge/manuscript';
```

All are `async`, take `bookRoot` first, return `{ ok: boolean, code: string, changes: Change[], diagnostics?: Diagnostic[], ... }`. `code` is `OK` or one of the `REFUSED_*` / `ROLLED_BACK` codes. They never throw on bad input.

| Function | Behaviour |
|---|---|
| `insertScene(book, { chapter, act?, after, title, slug, body, status?='drafting', id? })` | Creates a new scene file. `after` = scene ID, or `null` for first in chapter. `act` defaults to the act of other scenes in that chapter (refuse `REFUSED_UNKNOWN_CHAPTER` if the chapter has no scenes and no `act` given). Sequence = midpoint integer between neighbours (`floor((a+b)/2)`); first-in-chapter = `floor(next/2)` (min 1); last = `prev + 10`. If no free integer exists, renumber the chapter first (same op, same trash). New `id` = fresh ULID `scene_…` unless given. File goes to the canonical folder (below). |
| `moveScene(book, sceneId, { chapter, act?, after })` | Changes `chapter`/`act`/`sequence` lines and moves the file to its canonical path. Same sequence rules as insert. Moving within the same chapter is allowed. Unknown scene → `REFUSED_UNKNOWN_SCENE`; `after` not in target chapter → `REFUSED_BAD_ANCHOR`. |
| `renumberChapter(book, chapter, { step=10 })` | Sets sequences to `step, 2·step, …` in current §4.2 order and renames files to match. No-op (empty `changes`, code `OK`) if already so. |
| `rebuildIndex(book)` | Writes `<book>/.storyforge/index.json` (atomic) = `{ schema: "storyforge.index/v1", built_at, scenes: [{ position, id, act, chapter, sequence, path, sha256 }] }` from `validate`. Index is **never read** by any other operation. |
| `readIndex(book)` | Returns the parsed index or `null` if missing/corrupt. |
| `planRepair(book)` | Read-only. Returns `{ actions: RepairAction[], unrepairable: Diagnostic[] }`. |
| `applyRepair(book, actions)` | Applies only the given actions (as returned by `planRepair`), with rules 3–6. Rule 5 does not apply to E204 being repaired. |

Canonical scene path: `manuscript/act-<NN>-<act-slug>/ch-<NNN>-<chapter-slug>/<NNNN>-<scene-slug>.md`. Folder slugs: reuse the existing folder for that act/chapter number if exactly one exists; else take the slug from `act.md`/`chapter.md` title (slugified) ; else `act-NN` / `ch-NNN` with no slug suffix. Scene slug: from the current filename after its prefix; for inserts, the `slug` arg. A target path that already exists → refuse `REFUSED_PATH_TAKEN`.

### Repair actions

`planRepair` proposes, never decides content:

| Diagnostic | Action |
|---|---|
| W202 (scene prefix ≠ sequence) | `{ kind: 'rename', from, to }` to the canonical filename |
| W201 (scene in wrong folder) | `{ kind: 'rename', from, to }` to the canonical path |
| E204 (duplicate sequence) | `{ kind: 'renumber', chapter }` — keeps the current display order (§4.2 tie-break), so no scene moves relative to another |
| E100 / E101 / E102 on a scene | listed in `unrepairable` with the file — the author must fix it by hand |
| anything else | ignored by repair |

Repair never edits a body, never changes a scene's `chapter`/`act`, never deletes, and never chooses between two scenes' content.

## CLI

`sf-manuscript <command> <book> [options]` (`bin/sf-manuscript.mjs`):

- `order <book>` — prints position, chapter label, sequence, id, title, path. Exit 1 if the book has manuscript errors.
- `index <book>` — `rebuildIndex`.
- `repair <book>` — prints the plan; writes **only** with `--apply`.
- `insert`, `move`, `renumber` — thin wrappers; `--dry-run` supported.

Exit: 0 ok, 1 refused/rolled back/invalid book, 2 usage.

## Layout

```text
packages/manuscript/
  package.json   "@storyforge/manuscript", type module, dependency "@storyforge/format": "file:../format",
                 "yaml" NOT needed; test: node --test "test/*.test.mjs"; engines node >=22
  src/index.mjs  src/*.mjs   bin/sf-manuscript.mjs   README.md
  test/*.test.mjs
```

Tests copy fixtures into a temp dir (`fs.mkdtemp(os.tmpdir())`) and never modify `packages/format/fixtures/`.

## Acceptance tests (test-author)

Use `../format/fixtures/valid/salt-orchard` (copied to temp) unless stated.

1. **Rebuild proof (job acceptance):** `rebuildIndex` → save the index's `(id, position)` list → delete the whole `.storyforge/` folder and anything generated → `rebuildIndex` again → identical `(id, position, act, chapter, sequence, path, sha256)` list. Also equal to `validate()` order.
2. **Insert:** after the 1st scene of chapter 1, at start of chapter 1, at end of chapter 3; order is as expected; all other files byte-identical; new file valid.
3. **Insert with no gap:** make sequences 10, 11 in a chapter (via a prepared copy), insert between → chapter renumbered and new scene in the middle; all bodies byte-identical.
4. **Move (drag-equivalent):** move a scene from chapter 1 to after a scene in chapter 3; move within a chapter to first position. Order as expected; moved file's body byte-identical; old path now only in trash.
5. **Renumber:** a chapter with sequences 10, 15, 35 → 10, 20, 30; filenames match; bodies identical; second run is a no-op.
6. **Duplicate refusal:** on `../format/fixtures/invalid/E204-duplicate-sequence`, insert/move/renumber all return `REFUSED_INVALID_BOOK`, nothing written (hash every file before/after).
7. **Repair:** on `../format/fixtures/valid/spec-example` (W201 + W202), `planRepair` proposes exactly the two renames; `applyRepair` → `validate` shows no W201/W202 for those files; order unchanged; bodies identical. On E204 fixture → one renumber action; after apply, no E204, order equals the pre-repair display order. On E100 fixture → that file in `unrepairable`, no actions.
8. **Never discards prose:** after every test above, every body that existed before still exists byte-for-byte somewhere in the book or its trash.
9. **Rollback:** force a post-write validation failure (e.g. test hook / injected bad file between plan and verify — implementer exposes `__testHooks.afterWrite`) → `ROLLED_BACK`, book byte-identical to before.
10. **Unsimple field:** a scene with `sequence: 20 # note` or `sequence: "20"` → move refuses `REFUSED_UNSIMPLE_FIELD`, nothing written.
11. **Index is not authoritative:** write a deliberately wrong `index.json` (reversed order), then `order` CLI / `validate` order is still correct.
12. **CLI:** `order` on salt-orchard exit 0; `repair` without `--apply` writes nothing; exit codes as above.

## Done

`npm test` passes in both `packages/format` and `packages/manuscript`.
