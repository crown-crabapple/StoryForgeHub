// The rules of the off-canvas side drawers (M08-J04 contract section 1). Pure: no DOM, no React, so the keyboard behaviour is testable under `node --test`.

/** What can take focus inside a drawer. */
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The widths where each panel turns into an overlay drawer: the inspector below 1200 px (tablet and phone), the chapters rail below 900 px. */
export const DRAWER_QUERY = { rail: '(max-width: 899px)', inspector: '(max-width: 1199px)' };

/** The four widths the audit and the keyboard walks use, and the class each belongs to. */
export const AUDIT_WIDTHS = [
  { width: 1280, cls: 'desktop' },
  { width: 900, cls: 'tablet' },
  { width: 600, cls: 'phone' },
  { width: 360, cls: 'phone' },
];

/** @param {number} width @returns {'desktop' | 'tablet' | 'phone'} the device class of a window width (contract section 1) */
export function widthClass(width) {
  if (width >= 1200) return 'desktop';
  if (width >= 768) return 'tablet';
  return 'phone';
}

/** Which panels are overlay drawers at this width. @param {number} width */
export function drawersAt(width) {
  return { rail: width <= 899, inspector: width <= 1199 };
}

/**
 * Where Tab goes inside an open drawer. `index` is the position of the focused element among the drawer's focusable items (-1: focus is outside or on the drawer itself).
 * Returns the index to focus, or null when the browser may move focus by itself.
 * @param {{ count: number, index: number, shift: boolean }} p @returns {number | null}
 */
export function trapTarget({ count, index, shift }) {
  if (count === 0) return -1; // nothing to focus: keep focus on the drawer itself
  if (index === -1) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

/** The text a screen reader hears when a drawer opens or closes. @param {string} name @param {boolean} open */
export const drawerAnnouncement = (name, open) => `${name} panel ${open ? 'opened' : 'closed'}`;

/**
 * Does a width media query of the form `(max-width: Npx)` / `(min-width: Npx)` match this window width? Used to simulate a width in render tests; anything else does not match.
 * @param {string} query @param {number} width
 */
export function matchesWidth(query, width) {
  const max = /\(max-width:\s*(\d+)px\)/.exec(query);
  if (max) return width <= Number(max[1]);
  const min = /\(min-width:\s*(\d+)px\)/.exec(query);
  if (min) return width >= Number(min[1]);
  return false;
}
