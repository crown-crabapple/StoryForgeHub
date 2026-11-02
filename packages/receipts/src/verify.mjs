// Chain verification (contract section 6). Reports problems; never repairs, rewrites or renumbers anything.
// RCPT_UNRECORDED (the scene's current bytes differ from its last receipt) needs the book's files and is added by core.
import { applyDiff } from './diff.mjs';
import { parseReceipt, sha256Hex } from './receipt.mjs';

/** Oldest first: by `at`, then id (ids are ULIDs, so they sort by time too). */
export function compareReceipts(a, b) {
  const x = a.at ?? '';
  const y = b.at ?? '';
  if (x !== y) return x < y ? -1 : 1;
  return (a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0;
}

const asBuffer = (b) => (b === null || b === undefined ? null : Buffer.isBuffer(b) ? b : Buffer.from(b));

/**
 * @param {{ receipts: { path: string, bytes: Buffer | Uint8Array }[], objectBytes: (sha256: string) => Buffer | Uint8Array | null | undefined }} input
 * @returns {{ ok: boolean, receipts: number, problems: { code: string, file: string, receipt?: string, detail: string }[] }}
 */
export function verifyChain({ receipts, objectBytes }) {
  /** @type {{ code: string, file: string, receipt?: string, detail: string }[]} */
  const problems = [];
  const parsed = [];
  const byId = new Map();
  for (const r of receipts) {
    try {
      const receipt = parseReceipt(r.bytes);
      const item = { path: r.path, bytes: asBuffer(r.bytes), receipt };
      parsed.push(item);
      byId.set(receipt.id, item);
    } catch (e) {
      problems.push({ code: 'RCPT_MALFORMED', file: r.path, detail: String(e?.message ?? e) });
    }
  }

  const objectCache = new Map();
  /** The object's bytes, null when absent; records RCPT_OBJECT_ALTERED once per object. */
  const object = (sha, item) => {
    if (sha === '') return Buffer.alloc(0);
    if (!objectCache.has(sha)) {
      const bytes = asBuffer(objectBytes(sha));
      objectCache.set(sha, { bytes, altered: bytes !== null && sha256Hex(bytes) !== sha });
    }
    const o = objectCache.get(sha);
    if (o.bytes === null) {
      problems.push({ code: 'RCPT_OBJECT_MISSING', file: item.path, receipt: item.receipt.id, detail: `object ${sha} is not in provenance/objects` });
      return null;
    }
    if (o.altered) {
      problems.push({ code: 'RCPT_OBJECT_ALTERED', file: item.path, receipt: item.receipt.id, detail: `object ${sha} no longer hashes to its name` });
      return null;
    }
    return o.bytes;
  };

  for (const item of parsed) {
    const r = item.receipt;
    for (const p of r.parents) {
      const parent = byId.get(p.id);
      if (!parent) problems.push({ code: 'RCPT_PARENT_MISSING', file: item.path, receipt: r.id, detail: `parent ${p.id} has no receipt file` });
      else if (sha256Hex(parent.bytes) !== p.sha256) problems.push({ code: 'RCPT_PARENT_ALTERED', file: item.path, receipt: r.id, detail: `parent ${p.id} (${parent.path}) no longer hashes to ${p.sha256}` });
    }
    const before = object(r.before_sha256, item);
    const after = r.after_sha256 === r.before_sha256 ? before : object(r.after_sha256, item);
    // a receipt that wrote nothing (proposal, decline, check) may carry the proposed diff: only a change is replayed
    if (before && after && r.before_sha256 !== r.after_sha256) {
      const ok = (() => {
        try {
          return applyDiff(before, r.diff).equals(after);
        } catch {
          return false;
        }
      })();
      if (!ok) problems.push({ code: 'RCPT_DIFF_MISMATCH', file: item.path, receipt: r.id, detail: 'applying the diff to the before text does not give the after text' });
    }
  }

  // per target: each receipt starts where the previous one ended
  /** @type {Map<string, any[]>} */
  const byTarget = new Map();
  for (const item of parsed) {
    if (item.receipt.target.id === '') continue;
    if (!byTarget.has(item.receipt.target.id)) byTarget.set(item.receipt.target.id, []);
    byTarget.get(item.receipt.target.id).push(item);
  }
  for (const list of byTarget.values()) {
    list.sort((a, b) => compareReceipts(a.receipt, b.receipt));
    for (let i = 1; i < list.length; i++) {
      if (list[i].receipt.before_sha256 !== list[i - 1].receipt.after_sha256) {
        problems.push({ code: 'RCPT_CHAIN_GAP', file: list[i].path, receipt: list[i].receipt.id, detail: `starts at ${list[i].receipt.before_sha256 || '(nothing)'} but the previous receipt ${list[i - 1].receipt.id} ended at ${list[i - 1].receipt.after_sha256 || '(nothing)'}` });
      }
    }
  }
  return { ok: problems.length === 0, receipts: parsed.length, problems };
}
