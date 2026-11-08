// The author's continuity settings: planning/continuity/settings.md (schema storyforge.continuity-settings/v1).
// `overdue_chapters` (TH2, default 12) and `severity`, a map of rule id to error | warning | info | off. Invalid entries are ignored here (the validator reports them).
export const DEFAULT_OVERDUE_CHAPTERS = 12;
export const SEVERITY_WORDS = ['error', 'warning', 'info', 'off'];

/**
 * @param {Record<string, any> | null | undefined} fm the settings file's front matter, or nothing
 * @returns {{ overdue_chapters: number, severity: Record<string, 'error'|'warning'|'info'|'off'> }}
 */
export function readSettings(fm) {
  const n = fm?.overdue_chapters;
  const overdue_chapters = Number.isInteger(n) && n >= 1 ? n : DEFAULT_OVERDUE_CHAPTERS;
  /** @type {Record<string, any>} */
  const severity = {};
  const raw = fm?.severity;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [rule, word] of Object.entries(raw)) if (/^[A-Z]{2}[0-9]+$/.test(rule) && SEVERITY_WORDS.includes(word)) severity[rule] = word;
  }
  return { overdue_chapters, severity };
}
