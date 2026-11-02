import { useState } from 'react';
import { createPortal } from 'react-dom';

const STACK_ID = 'toast-stack';

/**
 * The one place the app's toasts (the "Moved ... Undo" messages) are drawn. It is always on the page, so it is a live region before any message is put into it:
 * a screen reader reads each new toast, and several toasts from different parts of the page stack up instead of sitting on top of each other.
 */
export function ToastStack() {
  return <div id={STACK_ID} className="toast-stack" role="status" aria-live="polite" aria-atomic="false" />;
}

/**
 * The frame of one toast. On a page with the stack the toast goes into it; without one (a part rendered alone) it is a live region of its own.
 * @param {{ children: import('react').ReactNode }} props
 */
export function ToastFrame({ children }) {
  const [host] = useState(() => (typeof document === 'undefined' ? null : document.getElementById(STACK_ID)));
  if (host) return createPortal(<div className="toast">{children}</div>, host);
  return (
    <div className="toast" role="status">
      {children}
    </div>
  );
}
