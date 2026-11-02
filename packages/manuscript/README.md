# @storyforge/manuscript

Safe scene insert, move and renumber for a StoryForge book, a disposable index, and repair planning. Files are the truth; the index is never read except by `readIndex`. Built on `@storyforge/format`. The binding rules are in [CONTRACT.md](CONTRACT.md).

```js
import { insertScene, moveScene, renumberChapter, rebuildIndex, readIndex, planRepair, applyRepair } from '@storyforge/manuscript';

await insertScene(book, { chapter: 1, after: null, title: 'Opening', slug: 'opening', body: 'Text.\n' });
await moveScene(book, sceneId, { chapter: 3, after: otherSceneId, dryRun: true });
const { actions } = await planRepair(book);
await applyRepair(book, actions);
```

Every operation returns `{ ok, code, changes, diagnostics? }`. It never throws on bad input and supports `{ dryRun: true }`. It refuses to touch a book with manuscript errors, verifies the book afterwards and rolls back on any new error. Only the `act`, `chapter` and `sequence` lines and the file path ever change; bodies are never touched. Replaced files go to `.storyforge/trash/<op-id>/`; nothing is deleted.

## CLI

```text
sf-manuscript order <book>
sf-manuscript index <book>
sf-manuscript repair <book> [--apply]
sf-manuscript insert <book> --chapter N --after <scene-id|start> --title T --slug S [--body-file F] [--dry-run]
sf-manuscript move <book> <scene-id> --chapter N --after <scene-id|start> [--dry-run]
sf-manuscript renumber <book> --chapter N [--step 10] [--dry-run]
```

Exit 0 ok, 1 refused / rolled back / invalid book, 2 usage.

Test: `npm test` (tests live in `test/`).
