// Revision policy (M03-J04 section 6): when to snapshot, what to keep, and how a snapshot splits into front matter and body.
// Pure; the bytes themselves are stored by @storyforge/store (saveRevision / pruneRevisions).
import { parse } from 'yaml';

/** Automatic restore points kept per scene (H0 section 2.2, hosted plan Phase 2: "the newest three or four versions"). */
export const KEEP_LATEST = 4;
/** A session ends after this long without a save. */
export const SESSION_IDLE_MS = 10 * 60_000;
/** While editing continues, one snapshot this often. */
export const INTERVAL_MS = 15 * 60_000;

/**
 * Which snapshots to prune. Every `manual` and `restore` one is kept (the author asked for it, or it holds the text a restore replaced); of the
 * automatic ones (session, interval, external) the newest KEEP_LATEST are kept. Returns the files to move to the trash (never deleted here).
 * @param {{ file: string, at: string, reason: string }[]} entries
 * @returns {string[]}
 */
export function planRetention(entries) {
  return entries
    .filter((e) => e.reason !== 'manual' && e.reason !== 'restore')
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.file < b.file ? 1 : -1))
    .slice(KEEP_LATEST)
    .map((e) => e.file);
}

/**
 * Decides, for each body save of a scene, whether a snapshot is due before writing: `session` on the first save after an idle
 * gap (or the first this process has seen), `interval` when INTERVAL_MS have passed since the last snapshot of an ongoing session.
 * @param {{ idleMs?: number, intervalMs?: number }} [opts]
 */
export function createSnapshotTracker({ idleMs = SESSION_IDLE_MS, intervalMs = INTERVAL_MS } = {}) {
  /** @type {Map<string, { lastSaveAt: number, lastSnapshotAt: number }>} */
  const scenes = new Map();
  return {
    /** @param {string} sceneId @param {number} nowMs @returns {'session' | 'interval' | null} */
    due(sceneId, nowMs) {
      const s = scenes.get(sceneId);
      let reason = null;
      if (!s || nowMs - s.lastSaveAt > idleMs) reason = 'session';
      else if (nowMs - s.lastSnapshotAt >= intervalMs) reason = 'interval';
      scenes.set(sceneId, { lastSaveAt: nowMs, lastSnapshotAt: reason || !s ? nowMs : s.lastSnapshotAt });
      return reason;
    },
  };
}

/**
 * A snapshot's front matter (raw text and parsed) and body (everything after the closing `---` line).
 * @param {Buffer} bytes @param {number} bodyStart byte offset where the body begins (-1: no front matter)
 * @returns {{ frontMatterText: string, frontMatter: Record<string, any>, body: string }}
 */
export function splitRevision(bytes, bodyStart) {
  if (bodyStart < 0) return { frontMatterText: '', frontMatter: {}, body: bytes.toString('utf8') };
  const raw = bytes.subarray(0, bodyStart).toString('utf8');
  const head = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = head.split('\n');
  const inner = lines.slice(1, Math.max(1, lines.length - 2)).join('\n').replace(/\r\n?/g, '\n');
  let frontMatter = {};
  try {
    const v = parse(inner, { version: '1.2', schema: 'core' });
    if (v && typeof v === 'object' && !Array.isArray(v)) frontMatter = v;
  } catch {
    frontMatter = {};
  }
  return { frontMatterText: head, frontMatter, body: bytes.subarray(bodyStart).toString('utf8') };
}
