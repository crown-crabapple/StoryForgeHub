import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open dialogs, oldest first. Only the newest one reacts to keys, so a dialog opened from a dialog works.
const open = [];

/**
 * A modal dialog: moves focus in, keeps Tab inside, closes on Escape, and gives focus back to whatever
 * opened it. `label` is its accessible name.
 *
 * In the browser it renders into document.body, so a dialog opened from a panel (the outline, a rail) is never
 * trapped in that panel's stacking context and painted under the manuscript. Without a document (server
 * rendering, tests) it renders in place.
 */
export function Dialog({ label, onClose, className = '', children }) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const node = ref.current;
    const opener = document.activeElement;
    open.push(node);
    const focusables = () => [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    (focusables()[0] ?? node).focus();

    const onKeyDown = (e) => {
      if (open[open.length - 1] !== node) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab') {
        const items = focusables();
        if (items.length === 0) {
          e.preventDefault();
          node.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (!node.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && (document.activeElement === first || document.activeElement === node)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = open.indexOf(node);
      if (at !== -1) open.splice(at, 1);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const ui = (
    <div className="dialog-backdrop">
      <section ref={ref} className={`dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </section>
    </div>
  );
  return typeof document === 'undefined' ? ui : createPortal(ui, document.body);
}
