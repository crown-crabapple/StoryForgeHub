// @storyforge/continuity - deterministic, read-only continuity findings for one book (contract M05-J01).
export { checkContinuity } from './engine.mjs';
export { RULES, fingerprintOf } from './rules.mjs';
export { readSettings, DEFAULT_OVERDUE_CHAPTERS } from './settings.mjs';

/** @typedef {import('./engine.mjs').ContinuityResult} ContinuityResult */
/** @typedef {import('./engine.mjs').Finding} Finding */
