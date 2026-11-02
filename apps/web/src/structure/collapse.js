// Which acts and chapters are collapsed, remembered per book in localStorage. Every access is wrapped:
// the outline works without storage (private mode, blocked storage, server render).

const storageKey = (bookId) => `storyforge.outline.collapsed.${bookId}`;

/** @param {string} bookId @returns {Set<string>} keys like "act:1" and "ch:3" */
export function readCollapsed(bookId) {
  try {
    const raw = window.localStorage.getItem(storageKey(bookId));
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((k) => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** @param {string} bookId @param {Set<string>} keys */
export function writeCollapsed(bookId, keys) {
  try {
    window.localStorage.setItem(storageKey(bookId), JSON.stringify([...keys]));
  } catch {
    // storage is unavailable; the state just lasts for this page
  }
}

export const actKey = (act) => `act:${act}`;
export const chapterKey = (chapter) => `ch:${chapter}`;
