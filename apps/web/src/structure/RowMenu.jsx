import { useEffect, useId, useRef, useState } from 'react';

/**
 * The "More actions for <name>" button and its menu. Both are real buttons. Escape closes the menu and puts
 * focus back on the trigger; Up/Down move between items; clicking elsewhere closes it.
 * `items`: [{ label, run } | { label, items: [{ label, run, current? }] } (a submenu) | { label, disabled }].
 */
export function RowMenu({ name, items }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (root.current && !root.current.contains(e.target)) {
        setOpen(false);
        setSub(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) root.current?.querySelector('[data-menu-item]')?.focus();
  }, [open]);

  const close = (refocus) => {
    setOpen(false);
    setSub(null);
    if (refocus) trigger.current?.focus();
  };

  const onKeyDown = (e) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const nodes = [...root.current.querySelectorAll('[data-menu-item]:not([disabled])')];
      const at = nodes.indexOf(document.activeElement);
      const next = nodes[(at + (e.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length];
      if (next) {
        e.preventDefault();
        e.stopPropagation();
        next.focus();
      }
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const pick = (item) => {
    close(true); // focus goes back first, so a dialog opened by the command returns focus here when it closes
    item.run();
  };

  return (
    <span className="row-menu" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="row-menu-button"
        aria-label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span aria-hidden="true">...</span>
      </button>
      {open && (
        <ul id={menuId} role="menu" aria-label={`Actions for ${name}`} className="row-menu-list">
          {items.map((item) =>
            item.items ? (
              <li key={item.label} role="none">
                <button type="button" role="menuitem" data-menu-item="" aria-haspopup="menu" aria-expanded={sub === item.label} onClick={() => setSub(sub === item.label ? null : item.label)}>
                  {item.label} <span aria-hidden="true">{sub === item.label ? '▾' : '▸'}</span>
                </button>
                {sub === item.label && (
                  <ul role="menu" aria-label={item.label} className="row-submenu">
                    {item.items.map((s) => (
                      <li key={s.label} role="none">
                        <button type="button" role="menuitemradio" aria-checked={Boolean(s.current)} data-menu-item="" onClick={() => pick(s)}>
                          {s.label}
                          {s.current ? ' (current)' : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ) : (
              <li key={item.label} role="none">
                <button type="button" role="menuitem" data-menu-item="" disabled={item.disabled} onClick={() => pick(item)}>
                  {item.label}
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </span>
  );
}
