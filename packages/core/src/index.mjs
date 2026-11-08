// @storyforge/core - domain layer: FileRepository interface, FsRepository, config.
export { createFsRepository, checkLibraryFolder, folderExists } from './fs-repository.mjs';
export { createLibraryHost } from './library-host.mjs';
export { countWords } from './word-count.mjs';
export { wordDelta, FALLBACK_TOKENS } from './word-delta.mjs';
export { LOG_PATH, applyToWritingLog, computeStreak, localDate, newWritingLog, parseWritingLog } from './writing-log.mjs';
export { KEEP_DAYS, KEEP_LATEST, createSnapshotTracker, planRetention } from './revisions.mjs';
export { FLUSH_MS, createActivity } from './activity.mjs';
export { loadConfig, resolveConfig, defaultLibraryRoot, ConfigError, DEFAULT_PORT, HOST, LOCK_FILE } from './config.mjs';
export { __hooks } from './hooks.mjs';
export { recordProvenance, recordProvenanceAt, publishWithReceipt, notifyProvenance } from './provenance.mjs';
export { createReceiptEngine, FLUSH_AFTER_MS, promptText } from './receipts.mjs';
export { renderAiRecord, selectRange, spliceReplacement } from './ai-rewrite.mjs';
export { acquireLock, releaseLock, releaseLockSync, updateLock, writeNewTree } from '@storyforge/store';
export { readUserConfig, userConfigDir, writeUserConfig } from '@storyforge/store';
export { listTemplates } from '@storyforge/templates';
export { runAs, currentBy } from './actor.mjs';
export { assembleContext, normalizeBudget, tailOf, DEFAULT_BUDGET, MIN_BUDGET, MAX_BUDGET, TAIL_CHARS } from './context-pack.mjs';
