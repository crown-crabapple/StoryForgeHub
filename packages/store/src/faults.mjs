// Fault injection for tests only. Production code never sets `at`.
// at: 'after-journal' | 'after-trash' | 'after-tmp' | 'after-rename' | 'before-done' | 'before-tree-rename' | null
// ('before-tree-rename': createTree has staged and validated a new folder but not yet moved it into place)
// mode: 'throw' (in-process failure) | 'exit' (process.exit(86), for child-process crash tests)
export const __faults = { at: null, mode: 'throw' };

/** @param {string} point */
export function fault(point) {
  if (__faults.at !== point) return;
  if (__faults.mode === 'exit') process.exit(86);
  throw new Error(`injected fault at ${point}`);
}
