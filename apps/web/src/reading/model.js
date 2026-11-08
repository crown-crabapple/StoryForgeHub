// What the Read view shows: the whole manuscript in reading order, one scene after another. Pure: no DOM, no fetch.
//
// `book` is GET /api/books/:id: { acts: [{ act, label, title?, chapters: [{ chapter, label, title?, scenes: [{ id, title, word_count, ... }] }] }] }.
import { actName, chapterName } from '../structure/helpers.js';

/** Words a minute used for "minutes left". */
export const READING_WPM = 250;

/**
 * The book in reading order: every act, its chapters and their scenes, with running word counts so the view can say how far in a scene is.
 * Chapters with no scenes are left out (nothing to read); an act with no chapters left is left out too.
 * @param {any} book
 * @returns {{ acts: { key: string, name: string, chapters: { key: string, name: string, scenes: any[] }[] }[], scenes: { id: string, title: string, chapterKey: string, before: number, words: number }[], words: number }}
 */
export function readingOrder(book) {
  const acts = [];
  const scenes = [];
  let words = 0;
  const showActs = (book?.acts ?? []).length > 1;
  for (const act of book?.acts ?? []) {
    const chapters = [];
    for (const ch of act.chapters ?? []) {
      if (!ch.scenes?.length) continue;
      const key = `a${act.act}-c${ch.chapter}`;
      chapters.push({ key, name: chapterName(ch), scenes: ch.scenes });
      for (const s of ch.scenes) {
        const w = Number.isFinite(s.word_count) ? s.word_count : 0;
        scenes.push({ id: s.id, title: s.title || 'Untitled scene', chapterKey: key, before: words, words: w });
        words += w;
      }
    }
    if (chapters.length) acts.push({ key: `a${act.act}`, name: showActs ? actName(act) : '', chapters });
  }
  return { acts, scenes, words };
}

/** "12 min" / "1 h 5 min" / "under a minute". @param {number} words */
export function readingTime(words) {
  const min = Math.round(words / READING_WPM);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * Where the reader is: "Scene 3 of 40 · 12% · 2 h 5 min left". Null when the scene is unknown.
 * @param {ReturnType<typeof readingOrder>} order @param {string | null} sceneId
 */
export function readingProgress(order, sceneId) {
  const i = order.scenes.findIndex((s) => s.id === sceneId);
  if (i === -1) return null;
  const s = order.scenes[i];
  const percent = order.words > 0 ? Math.round((s.before / order.words) * 100) : Math.round((i / order.scenes.length) * 100);
  return { index: i + 1, total: order.scenes.length, percent, left: readingTime(order.words - s.before) };
}

/** Drop the HTML comments (notes to self) from a scene body, for a clean read. The file is never changed. @param {string} body */
export function withoutComments(body) {
  // a note on a line of its own goes with its line, so no extra blank line is left where it was
  return body.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\n|$)/gm, '').replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
}

/** The space to keep for a scene that has not loaded yet, so the page does not jump when it arrives. @param {number} words */
export const placeholderHeight = (words) => Math.max(48, Math.round(words * 2.4));

/** The localStorage key of the last scene read in a book. @param {string} bookId */
export const positionKey = (bookId) => `storyforge.read.${bookId}`;
