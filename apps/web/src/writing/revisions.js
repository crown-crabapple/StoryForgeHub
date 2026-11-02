// Wording for the Revisions list. Pure.

const two = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today 14:02", "Yesterday 09:30" or "Oct 30 14:02" (local time). @param {string} iso @param {number} [nowMs] */
export function whenLabel(iso, nowMs = Date.now()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date(nowMs)) - day(d)) / 86_400_000);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Yesterday ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

/** "Today 14:02 · session · 812 words". @param {{ at: string, reason: string, words?: number }} entry @param {number} [nowMs] */
export function revisionSummary(entry, nowMs = Date.now()) {
  const words = Number.isInteger(entry.words) ? entry.words : 0;
  return `${whenLabel(entry.at, nowMs)} · ${entry.reason} · ${words} ${words === 1 ? 'word' : 'words'}`;
}

/** Newest first (the server already sends them so; this keeps the list right if it ever does not). @template {{ at: string, file: string }} T @param {T[]} list @returns {T[]} */
export function newestFirst(list) {
  return [...list].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.file < b.file ? 1 : -1));
}

export const SAFETY_NOTE = "Local safety copies on this computer. Use Git or backups for history you can't lose.";
