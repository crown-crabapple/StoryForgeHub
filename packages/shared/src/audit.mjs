// The shared-mode audit log (contract M07-J03 section 4): audit.jsonl in the shared-data folder, append-only, one JSON line per event, each line carrying
// the sha256 of the previous line's exact text, so editing, removing or reordering a line breaks the chain from there on. Lines never hold manuscript text:
// only the fields below are kept, and every string is cut short.
import { createHash } from 'node:crypto';
import { appendSharedLine, readSharedText } from '@storyforge/store';

const FILE = 'audit.jsonl';
const ZERO = '0'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const sha = (/** @type {string} */ text) => createHash('sha256').update(text, 'utf8').digest('hex');
const clip = (/** @type {unknown} */ v, max = 200) => [...String(v)].map((ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch)).join('').slice(0, max);

/**
 * @param {string} dir the shared-data folder
 * @param {{ now?: () => number }} [opts]
 */
export function createAudit(dir, { now = Date.now } = {}) {
  /** @type {{ seq: number, prev: string } | null} */
  let tail = null;
  let queue = Promise.resolve();

  /** The line count and the hash to chain from: read from the file once, then kept in memory. */
  async function load() {
    const text = await readSharedText(dir, FILE);
    if (text === '') return { seq: 0, prev: ZERO, partial: false };
    const partial = !text.endsWith('\n');
    const lines = (partial ? text : text.slice(0, -1)).split('\n');
    return { seq: lines.length, prev: sha(lines[lines.length - 1]), partial };
  }

  /**
   * Append one event. Appends are serialised, so the chain is never forked by two requests at once.
   * @param {{ actor: string, event: string, target?: unknown, ip?: unknown, result?: unknown }} e
   * @returns {Promise<void>}
   */
  function append(e) {
    const run = async () => {
      if (!tail) {
        const t = await load();
        // a crash left a partial last line: end it, so this event starts on a line of its own (verify() still reports the damaged line)
        if (t.partial) await appendSharedLine(dir, FILE, '');
        tail = { seq: t.seq, prev: t.prev };
      }
      const line = {
        seq: tail.seq + 1,
        at: new Date(now()).toISOString(),
        actor: clip(e.actor ?? 'system', 80),
        event: clip(e.event, 80),
        ...(e.target !== undefined && e.target !== null ? { target: clip(e.target) } : {}),
        ...(e.ip !== undefined && e.ip !== null ? { ip: clip(e.ip, 64) } : {}),
        ...(e.result !== undefined && e.result !== null ? { result: typeof e.result === 'number' ? e.result : clip(e.result, 40) } : {}),
        prev: tail.prev,
      };
      const text = JSON.stringify(line);
      await appendSharedLine(dir, FILE, text);
      tail = { seq: line.seq, prev: sha(text) };
    };
    const p = queue.then(run);
    queue = p.catch(() => {
      tail = null; // after a failed write, read the file again before the next append
    });
    return p;
  }

  /**
   * Check the whole chain.
   * @returns {Promise<{ ok: true, lines: number } | { ok: false, code: 'AUDIT_CHAIN_BROKEN', line: number, message: string } | { ok: false, code: 'AUDIT_TAIL_TRUNCATED', line: number, message: string }>}
   */
  async function verify() {
    await queue.catch(() => {});
    const text = await readSharedText(dir, FILE);
    if (text === '') return { ok: true, lines: 0 };
    const partial = !text.endsWith('\n');
    const lines = (partial ? text : text.slice(0, -1)).split('\n');
    const broken = (/** @type {number} */ line, /** @type {string} */ why) => ({ ok: /** @type {const} */ (false), code: /** @type {const} */ ('AUDIT_CHAIN_BROKEN'), line, message: `AUDIT_CHAIN_BROKEN at line ${line}: ${why}` });
    let prev = ZERO;
    for (let i = 0; i < lines.length; i++) {
      const n = i + 1;
      if (partial && i === lines.length - 1) break; // reported below, after the complete lines were checked
      let rec;
      try {
        rec = JSON.parse(lines[i]);
      } catch {
        return broken(n, 'not valid JSON');
      }
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec) || rec.seq !== n || typeof rec.prev !== 'string' || !HEX64.test(rec.prev)) return broken(n, 'not an audit line, or out of sequence');
      if (rec.prev !== prev) return broken(n > 1 ? n - 1 : n, n > 1 ? `line ${n - 1} was changed, or a line is missing before line ${n}` : 'the first line must start the chain');
      prev = sha(lines[i]);
    }
    if (partial) return { ok: false, code: 'AUDIT_TAIL_TRUNCATED', line: lines.length, message: `AUDIT_TAIL_TRUNCATED: line ${lines.length} is incomplete (the process stopped while writing it)` };
    return { ok: true, lines: lines.length };
  }

  return { append, verify, file: FILE };
}
