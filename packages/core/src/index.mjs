// @storyforge/core - domain layer: FileRepository interface, FsRepository, config.
export { createFsRepository, checkLibraryFolder, folderExists } from './fs-repository.mjs';
export { createLibraryHost } from './library-host.mjs';
export { countWords } from './word-count.mjs';
export { wordDelta, FALLBACK_TOKENS } from './word-delta.mjs';
export { LOG_PATH, applyToWritingLog, computeStreak, localDate, newWritingLog, parseWritingLog } from './writing-log.mjs';
export { KEEP_DAYS, KEEP_LATEST, createSnapshotTracker, planRetention } from './revisions.mjs';
export { FLUSH_MS, createActivity } from './activity.mjs';
export { loadConfig, ConfigError, DEFAULT_PORT, HOST, LOCK_FILE } from './config.mjs';
export { __hooks } from './hooks.mjs';
export { acquireLock, releaseLock, releaseLockSync, updateLock } from '@storyforge/store';
export { readUserConfig, userConfigDir, writeUserConfig } from '@storyforge/store';
export { listTemplates } from '@storyforge/templates';
