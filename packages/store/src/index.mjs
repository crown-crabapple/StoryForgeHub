// @storyforge/store - the single writer: journaled atomic saves, trash, conflict detection, recovery.
export { openStore } from './store.mjs';
export { currentActor, runAsActor } from './actor.mjs';
export { acquireLock, lockHolder, releaseLock, releaseLockSync, updateLock } from './instance-lock.mjs';
export { __faults } from './faults.mjs';
export { createTree } from './tree.mjs';
export { DEFAULT_PROFILE, deleteProfile, isProfileName, listProfiles, readProfile, readUserConfig, userConfigDir, writeProfile, writeUserConfig } from './userconfig.mjs';
export { escapesRoot } from './contain.mjs';
export { withScratchFile } from './scratch.mjs';
export { writeNewTree, writeOutFile, writeWorkFile, replaceWorkDir } from './foreign-files.mjs';
export { onWrite } from './write-hooks.mjs';
export { appendSharedLine, readSharedJson, readSharedText, writeSharedJson } from './shared-files.mjs';
