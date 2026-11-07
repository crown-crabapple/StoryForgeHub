// The series plan on the canvas page (M10 decision 6): the Series section of the old Overview in the same kind of wide, non-modal side drawer as the plan drawer.
// Focus moves in on open, Escape or Close shuts it, and focus goes back to the button that opened it.
import { useEffect, useRef } from 'react';
import { SeriesPlan } from '../../planner/SeriesSection.jsx';

/** @param {{ bookId: string, series: any, onClose: () => void }} props `series` is GET /series-plan (a book in a series) */
export function SeriesDrawer({ bookId, series, onClose }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const node = ref.current;
    const opener = document.activeElement;
    node?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <aside
      ref={ref}
      className="cv-drawer"
      role="dialog"
      aria-label="Series plan"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
        }
      }}
    >
      <header className="cv-drawer-head">
        <h2>Series plan</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="cv-drawer-body">
        <SeriesPlan plan={series} bookId={bookId} />
      </div>
    </aside>
  );
}
