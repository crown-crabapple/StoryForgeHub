// Test seams. Production code never sets these.
/**
 * `onReconcile({ bookPath, reason })` runs every time the repository starts an index reconcile for a book
 * (`reason`: 'watch' | 'poll' | 'write' | 'read' | 'ensure' | 'rebuild' | 'repair' | 'series').
 * `onProvenance(event)` sees every event passed to recordProvenance() (M05-J04).
 * @type {{ onReconcile?: (info: { bookPath: string, reason: string }) => void, onProvenance?: (event: import('./provenance.mjs').ProvenanceEvent) => void }}
 */
export const __hooks = { onReconcile: undefined, onProvenance: undefined };
