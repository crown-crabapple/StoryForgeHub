// A resizable edge between the main column and a side panel (M07-J04 contract section 3). A real separator: focusable, role=separator with aria-valuenow, resized with the
// mouse (drag) and with the keyboard (arrows, Shift for big steps, Home and End for the limits). The new width is kept in the profile when the drag or the key press ends.
import { useRef } from 'react';
import { PANEL_WIDTHS, widthForKey } from './appearance.js';
import { usePrefs } from './PrefsContext.jsx';

const LABELS = { rail: 'Resize the chapters panel', inspector: 'Resize the right panel' };

/** @param {{ which: 'rail' | 'inspector', containerRef: { current: HTMLElement | null } }} props */
export function PanelSeparator({ which, containerRef }) {
  const { layout, resizePanel } = usePrefs();
  const range = PANEL_WIDTHS[which];
  const width = layout[which].width;
  const dragging = useRef(false);

  /** @param {number} clientX @returns {number | null} */
  const widthAt = (clientX) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return null;
    return Math.round(which === 'rail' ? clientX - box.left : box.right - clientX);
  };
  const clamp = (n) => Math.min(range.max, Math.max(range.min, n));

  function onKeyDown(e) {
    const next = widthForKey(which, width, e);
    if (next === null) return;
    e.preventDefault();
    resizePanel(which, next, true);
  }
  function onPointerDown(e) {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!dragging.current) return;
    const w = widthAt(e.clientX);
    if (w !== null) resizePanel(which, clamp(w), false);
  }
  function onPointerUp(e) {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const w = widthAt(e.clientX);
    if (w !== null) resizePanel(which, clamp(w), true);
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={LABELS[which]}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels wide`}
      className="panel-separator"
      data-panel={which}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
