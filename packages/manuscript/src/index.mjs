// @storyforge/manuscript - safe scene insert/move/renumber, structure commands, disposable index, repair planning.
export { insertScene, moveScene, renumberChapter, planRepair, applyRepair } from './ops.mjs';
export {
  setSceneFields,
  createChapter,
  setChapterFields,
  renumberChapters,
  archiveChapter,
  createAct,
  setActFields,
  splitScene,
  mergeScenes,
  restoreOp,
} from './structure.mjs';
export { createEntry, setEntryFields, changeEntrySlug, archiveEntry, restoreEntry, createCodexType, replaceFrontMatterBlock, entryFolder, ENTRY_STATUSES } from './codex.mjs';
export { editFrontMatterLine } from './frontmatter.mjs';
export { unifiedDiff } from './diff.mjs';
export { rebuildIndex, readIndex } from './indexfile.mjs';
export { __testHooks } from './commit.mjs';
export { ulid, slugify, SLUG_RE } from './util.mjs';
