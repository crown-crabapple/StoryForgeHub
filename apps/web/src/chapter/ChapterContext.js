// What the chapter editor tells its scene breaks (their titles, save states, notices and notes). The break views are React node views; they read this and call `actions`.
import { createContext, useContext } from 'react';

/**
 * @typedef {{ title: string, summary: string, sourceHref: string, problem: { code?: string, message?: string } | null }} SceneInfo
 * @typedef {{
 *   bookId: string, canEdit: boolean, canReview: boolean, canDecide: boolean,
 *   scenes: Record<string, SceneInfo>,
 *   snaps: Record<string, import('../editor/save-controller.js').SaveSnapshot>,
 *   errors: Record<string, string>, notices: Record<string, string>, offers: Record<string, { text: string, at: string }>, queued: Record<string, true>,
 *   notes: Record<string, { text: string, pos: number }[]>, notesOpen: Record<string, true>,
 *   actions: {
 *     renameScene: (id: string, title: string) => Promise<void>, saveSummary: (id: string, summary: string) => Promise<void>,
 *     toggleNotes: (id: string) => void, goToNote: (pos: number) => void, retry: (id: string) => void, checkDisk: (id: string) => void,
 *     keepMine: (id: string) => Promise<void>, useFile: (id: string) => Promise<void>, useTheirs: (id: string) => Promise<void>, saveCopy: (id: string) => Promise<{ ok: boolean, message?: string }>,
 *     review: (id: string) => void, restoreOffer: (id: string) => void, discardOffer: (id: string) => void, dismissNotice: (id: string) => void,
 *   },
 * }} ChapterValue
 */

export const ChapterContext = createContext(/** @type {ChapterValue | null} */ (null));

/** @returns {ChapterValue | null} */
export const useChapter = () => useContext(ChapterContext);
