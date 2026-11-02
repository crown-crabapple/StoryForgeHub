// Daily goal numbers for the goal card. Pure.

/** @typedef {{ added: number, removed: number, net: number, minutes: number, sessions: number }} DayTotals */
/** @typedef {{ goal: number | null, today: DayTotals, days: any[], streak: number }} Activity */

/** The activity answer with one save's words added to today (the next refetch replaces it with the server's own totals). @param {Activity} activity @param {{ added: number, removed: number }} words @returns {Activity} */
export function applyWords(activity, words) {
  const added = activity.today.added + (words.added || 0);
  const removed = activity.today.removed + (words.removed || 0);
  return { ...activity, today: { ...activity.today, added, removed, net: added - removed } };
}

/** "Today 412 / 500 words", or "Today 412 words" without a goal. @param {DayTotals} today @param {number | null} goal */
export function goalLine(today, goal) {
  return goal ? `Today ${today.net} / ${goal} words` : `Today ${today.net} ${today.net === 1 ? 'word' : 'words'}`;
}

/** Whole percent of the goal reached, 0 to 100 (0 without a goal). @param {number} net @param {number | null} goal */
export function goalPercent(net, goal) {
  if (!goal || goal < 1) return 0;
  return Math.max(0, Math.min(100, Math.round((net / goal) * 100)));
}

/** "+128", "-12", "+0". @param {number} n */
export const signed = (n) => (n < 0 ? `-${Math.abs(n)}` : `+${n}`);

/** "3 days" / "1 day", or null when there is no streak. @param {number} n */
export const streakLabel = (n) => (n > 0 ? `${n} ${n === 1 ? 'day' : 'days'}` : null);

/** The goal as typed in the dialog: a whole number from 1 to 999999999, else null. @param {string} text */
export function parseGoal(text) {
  const t = String(text).trim();
  if (!/^[0-9]{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 ? n : null;
}
