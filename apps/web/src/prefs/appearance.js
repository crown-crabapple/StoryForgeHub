// Typography, layouts and the CSS variables a profile produces (M07-J04 contract sections 2 and 3). Pure: no DOM, no React, no network.
import { DARK, resolveTheme } from './themes.js';

/** System font stacks only: nothing is downloaded. `serif` is the reference stack (the self-hosted Literata of theme/tokens.css); `accessible` is used if it is installed. */
export const FONT_STACKS = {
  serif: "'Literata Variable', Literata, Georgia, serif",
  sans: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  accessible: "'Atkinson Hyperlegible', Verdana, sans-serif",
};
export const FONT_LABELS = { serif: 'Serif (reference)', sans: 'Sans', mono: 'Monospace', accessible: 'Accessibility (Atkinson Hyperlegible, Verdana)' };

/** The ranges of the typography settings (the same as @storyforge/format TYPOGRAPHY_RANGES). */
export const TYPOGRAPHY_RANGES = {
  size: { min: 14, max: 24, step: 1, unit: 'px' },
  lineHeight: { min: 1.4, max: 2, step: 0.05, unit: '' },
  paragraphSpacing: { min: 0, max: 2, step: 0.1, unit: 'em' },
  letterSpacing: { min: 0, max: 0.12, step: 0.01, unit: 'em' },
  measure: { min: 50, max: 100, step: 1, unit: 'ch' },
};

/** The built-in typography: the reference look (serif 18 px, line height 1.7, 72ch). Equal to @storyforge/format BUILTIN.typography (a test compares them). */
export const DEFAULT_TYPOGRAPHY = Object.freeze({ family: 'serif', size: 18, lineHeight: 1.7, paragraphSpacing: 0, letterSpacing: 0, measure: 72 });

/** @param {number} n @param {{ min: number, max: number }} r */
const clamp = (n, r) => Math.min(r.max, Math.max(r.min, n));
const num = (v, fallback, range) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, range) : fallback);
const trim = (n) => String(Math.round(n * 1000) / 1000);

/**
 * The typography variables (CSS variables only). A missing or out-of-range value falls back to the reference / the nearest limit.
 * @param {Record<string, any> | null | undefined} t @returns {Record<string, string>}
 */
export function typographyVars(t) {
  const x = { ...DEFAULT_TYPOGRAPHY, ...(t ?? {}) };
  const family = Object.hasOwn(FONT_STACKS, x.family) ? x.family : 'serif';
  const measure = x.measure === 'full' ? '100%' : `${trim(num(x.measure, 72, TYPOGRAPHY_RANGES.measure))}ch`;
  return {
    '--font-prose': FONT_STACKS[family],
    '--fs-prose': `${trim(num(x.size, 18, TYPOGRAPHY_RANGES.size))}px`,
    '--lh-prose': trim(num(x.lineHeight, 1.7, TYPOGRAPHY_RANGES.lineHeight)),
    '--para-space': `${trim(num(x.paragraphSpacing, 0, TYPOGRAPHY_RANGES.paragraphSpacing))}em`,
    '--ls-prose': `${trim(num(x.letterSpacing, 0, TYPOGRAPHY_RANGES.letterSpacing))}em`,
    '--measure': measure,
  };
}

// ---------------------------------------------------------------- layouts

/** The right-rail sections a layout can pin, in the default order (the same as @storyforge/format INSPECTOR_SECTIONS). */
export const INSPECTOR_SECTIONS = ['goal', 'scene', 'linked', 'notes', 'events', 'research', 'continuity', 'comments', 'suggestions', 'problems', 'revisions', 'receipts', 'book-problems'];
export const SECTION_LABELS = {
  goal: 'Goal',
  scene: 'Scene facts',
  linked: 'Linked entries',
  notes: 'Notes in the text',
  events: 'Events',
  research: 'Research',
  continuity: 'Continuity',
  comments: 'Comments',
  suggestions: 'Suggestions',
  problems: 'Problems',
  revisions: 'Revisions',
  receipts: 'Receipts',
  'book-problems': 'Book problems',
};
export const PANEL_WIDTHS = { rail: { min: 180, max: 480, step: 16 }, inspector: { min: 240, max: 560, step: 16 } };

/** Named layouts. `pinned: null` shows every section in the default order. Writing is the reference layout (rail 260, inspector 340). */
export const LAYOUT_PRESETS = {
  Writing: { rail: { shown: true, width: 260 }, inspector: { shown: true, width: 340 }, pinned: null },
  Planning: { rail: { shown: true, width: 320 }, inspector: { shown: true, width: 420 }, pinned: ['goal', 'scene', 'linked', 'events', 'research', 'notes', 'problems', 'book-problems'] },
  Review: { rail: { shown: false, width: 260 }, inspector: { shown: true, width: 460 }, pinned: ['continuity', 'comments', 'suggestions', 'receipts', 'revisions', 'problems', 'book-problems', 'goal'] },
};
export const LAYOUT_NAMES = Object.keys(LAYOUT_PRESETS);

/**
 * The layout in force: the named layout (a built-in, or one the profile saved), with the panel settings the preference itself carries laid over it.
 * @param {Record<string, any> | null | undefined} pref the resolved `layout` preference: { name, rail?, inspector?, pinned? }
 * @param {Record<string, any> | null | undefined} custom the profile's saved layouts by name
 * @returns {{ name: string, rail: { shown: boolean, width: number }, inspector: { shown: boolean, width: number }, pinned: string[] | null }}
 */
export function effectiveLayout(pref, custom) {
  const name = typeof pref?.name === 'string' ? pref.name : 'Writing';
  const base = custom?.[name] ?? LAYOUT_PRESETS[name] ?? LAYOUT_PRESETS.Writing;
  const panel = (key) => {
    const b = base[key] ?? LAYOUT_PRESETS.Writing[key];
    const o = pref?.[key] ?? {};
    const r = PANEL_WIDTHS[key];
    const width = Number.isInteger(o.width) ? o.width : Number.isInteger(b.width) ? b.width : LAYOUT_PRESETS.Writing[key].width;
    return { shown: typeof o.shown === 'boolean' ? o.shown : b.shown !== false, width: clamp(width, r) };
  };
  const pinned = Array.isArray(pref?.pinned) ? pref.pinned : Array.isArray(base.pinned) ? base.pinned : null;
  return { name, rail: panel('rail'), inspector: panel('inspector'), pinned: pinned ? pinned.filter((s) => INSPECTOR_SECTIONS.includes(s)) : null };
}

/** The layout variables: a hidden panel has no width at all. @param {ReturnType<typeof effectiveLayout>} layout @returns {Record<string, string>} */
export function layoutVars(layout) {
  return { '--rail': layout.rail.shown ? `${layout.rail.width}px` : '0px', '--inspector': layout.inspector.shown ? `${layout.inspector.width}px` : '0px' };
}

/**
 * The new width of a panel after a key press on its separator, or null when the key does nothing. The rail grows to the right, the right panel to the left;
 * Shift makes the step four times bigger; Home and End go to the limits. Never outside the panel's range.
 * @param {'rail' | 'inspector'} which @param {number} width @param {{ key: string, shiftKey?: boolean, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean }} e
 */
export function widthForKey(which, width, e) {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  const r = PANEL_WIDTHS[which];
  const step = e.shiftKey ? r.step * 4 : r.step;
  const grow = which === 'rail' ? 'ArrowRight' : 'ArrowLeft';
  const shrink = which === 'rail' ? 'ArrowLeft' : 'ArrowRight';
  let next = null;
  if (e.key === grow) next = width + step;
  else if (e.key === shrink) next = width - step;
  else if (e.key === 'Home') next = r.min;
  else if (e.key === 'End') next = r.max;
  return next === null ? null : clamp(next, r);
}

/**
 * Where one right-rail section goes: shown or not, and its place in the order (CSS `order`). With nothing pinned every section is shown in the default order.
 * @param {string[] | null} pinned @param {string} id
 */
export function sectionPlace(pinned, id) {
  if (pinned === null) return { shown: true, order: INSPECTOR_SECTIONS.indexOf(id) };
  const at = pinned.indexOf(id);
  return { shown: at !== -1, order: at };
}

// ---------------------------------------------------------------- the CSS a profile produces

/**
 * Every CSS variable the resolved preferences set: the theme's colours (none for the reference dark theme, which tokens.css already is), typography and layout.
 * @param {{ theme?: string, typography?: object, layout?: object }} effective the resolved preferences
 * @param {{ customThemes?: Record<string, Record<string, string>>, layouts?: Record<string, any>, layoutOverride?: ReturnType<typeof effectiveLayout> | null }} [extra]
 * @returns {Record<string, string>}
 */
export function cssVariables(effective, extra = {}) {
  const theme = resolveTheme(effective?.theme ?? 'dark', extra.customThemes ?? {});
  /** @type {Record<string, string>} */
  const vars = {};
  if (theme.name !== 'dark') for (const [k, v] of Object.entries(theme.tokens)) if (DARK[k] !== v || theme.name.startsWith('custom:')) vars[k] = v;
  Object.assign(vars, typographyVars(effective?.typography));
  Object.assign(vars, layoutVars(extra.layoutOverride ?? effectiveLayout(effective?.layout, extra.layouts)));
  return vars;
}

/** The stylesheet text for those variables: one rule on the root, with the colour scheme the theme wants. @param {Record<string, string>} vars @param {'dark' | 'light'} [scheme] */
export function cssText(vars, scheme = 'dark') {
  const body = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
  return `html:root{${body};color-scheme:${scheme}}`;
}

/** @param {{ theme?: string }} effective @param {Record<string, Record<string, string>>} [customThemes] */
export const schemeOf = (effective, customThemes) => resolveTheme(effective?.theme ?? 'dark', customThemes ?? {}).scheme;
