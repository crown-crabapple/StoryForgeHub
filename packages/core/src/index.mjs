// @storyforge/core - domain layer: FileRepository interface, FsRepository, config.
export { createFsRepository } from './fs-repository.mjs';
export { countWords } from './word-count.mjs';
export { loadConfig, ConfigError, DEFAULT_PORT, HOST, LOCK_FILE } from './config.mjs';
export { __hooks } from './hooks.mjs';
export { acquireLock, releaseLock, releaseLockSync, updateLock } from '@storyforge/store';
