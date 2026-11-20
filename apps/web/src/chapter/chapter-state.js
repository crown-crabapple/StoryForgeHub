// Small pure helpers of the chapter editor: the save-state chip, the one state the top bar shows for the whole chapter, and the remembered open / closed state of the
// scene-notes margins. No DOM, no React; the storage is passed in so every case runs under `node --test`.

/** @typedef {import('../editor/save-controller.js').SaveState} SaveState */

/** The word on a scene's chip, or null when there is nothing to say (a scene nobody touched). @param {SaveState | undefined} state @returns {string | null} */
export function chipLabel(state) {
  switch (state) {
    case 'saved':
      return 'Saved';
    case 'saving':
      return 'Saving';
    case 'offline':
      return 'Offline';
    case 'conflict':
      return 'Conflict';
    case 'dirty':
      return 'Unsaved';
    case 'error':
      return 'Not saved';
    default:
      return null;
  }
}

const WORST_FIRST = ['conflict', 'error', 'offline', 'saving', 'dirty', 'saved', 'clean'];

/**
 * The one state the top bar shows for the chapter: the worst of its scenes' states. `savedAt` is the latest save of any scene.
 * @param {Iterable<{ state: SaveState, savedAt: string | null }>} snapshots @returns {{ state: SaveState, savedAt: string | null } | null} null when there are no scenes
 */
export function aggregateSaveState(snapshots) {
  let rank = WORST_FIRST.length;
  let savedAt = null;
  let seen = false;
  for (const s of snapshots) {
    seen = true;
    rank = Math.min(rank, WORST_FIRST.indexOf(s.state));
    if (s.savedAt && (savedAt === null || s.savedAt > savedAt)) savedAt = s.savedAt;
  }
  if (!seen) return null;
  return { state: /** @type {SaveState} */ (WORST_FIRST[rank] ?? 'clean'), savedAt };
}

export const NOTES_KEY = 'storyforge.chapter.notesOpen';

/** Which scenes' notes margins are open. Collapsed unless remembered otherwise; a storage that is missing or broken means "all collapsed". @param {{ getItem: (k: string) => string | null } | null | undefined} storage @returns {Record<string, true>} */
export function readNotesOpen(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(NOTES_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v === true));
  } catch {
    return {};
  }
}

/** Remember a scene's margin as open or collapsed. Never throws. @param {{ getItem: (k: string) => string | null, setItem: (k: string, v: string) => void } | null | undefined} storage @param {string} sceneId @param {boolean} open @returns {Record<string, true>} what is open now */
export function writeNotesOpen(storage, sceneId, open) {
  const now = readNotesOpen(storage);
  if (open) now[sceneId] = true;
  else delete now[sceneId];
  try {
    storage?.setItem(NOTES_KEY, JSON.stringify(now));
  } catch {
    // not remembered; the margin still opens and closes for this visit
  }
  return now;
}

/** A calm sentence for a scene that could not be written back as Markdown. @param {string} reason */
export const cannotSaveText = (reason) => `This scene can't be saved yet: ${reason}. Nothing was saved; your changes are kept here and in this browser.`;
