// Test seams. Production code never sets these.
/**
 * `onReconcile({ bookPath, reason })` runs every time the repository starts an index reconcile for a book
 * (`reason`: 'watch' | 'poll' | 'write' | 'read' | 'ensure' | 'rebuild' | 'repair' | 'series').
 * @type {{ onReconcile?: (info: { bookPath: string, reason: string }) => void }}
 */
export const __hooks = { onReconcile: undefined };
