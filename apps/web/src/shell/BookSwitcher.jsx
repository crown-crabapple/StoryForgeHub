import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from '../router.jsx';
import { ChevronDownIcon } from './icons.jsx';

const titleOf = (b) => b.title ?? b.slug ?? b.id;

/**
 * Button showing the current book (initial, title, chevron) that opens a listbox of books.
 * Up/Down/Home/End move, Enter opens the book, Escape closes and returns focus to the button,
 * typing a letter jumps to the next book starting with it.
 * @param {{ books: any[] | null, current: any | null }} props
 */
export function BookSwitcher({ books, current }) {
  const list = books ?? [];
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const button = useRef(null);
  const listbox = useRef(null);
  const id = useId();
  const optionId = (i) => `${id}-opt-${i}`;

  const currentTitle = current ? titleOf(current) : 'Library';

  function show() {
    const at = list.findIndex((b) => current && b.id === current.id);
    setActive(at === -1 ? 0 : at);
    setOpen(true);
  }
  function close(refocus) {
    setOpen(false);
    if (refocus) button.current?.focus();
  }

  useEffect(() => {
    if (open) listbox.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (root.current && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function onButtonKeyDown(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      show();
    }
  }

  function onListKeyDown(e) {
    const last = list.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(last, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (list[active]) {
          navigate(`/books/${encodeURIComponent(list[active].id)}`);
          close(true);
        }
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const ch = e.key.toLowerCase();
          const n = list.length;
          for (let step = 1; step <= n; step++) {
            const i = (active + step) % n;
            if (titleOf(list[i]).toLowerCase().startsWith(ch)) {
              setActive(i);
              break;
            }
          }
        }
    }
  }

  return (
    <div className="book-switcher" ref={root}>
      <button
        type="button"
        ref={button}
        className="switcher-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onButtonKeyDown}
      >
        <span className="switcher-initial" aria-hidden="true">
          {currentTitle.slice(0, 1).toUpperCase()}
        </span>
        <span className="switcher-title">{currentTitle}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <ul
          id={`${id}-list`}
          ref={listbox}
          role="listbox"
          tabIndex={-1}
          aria-label="Books"
          aria-activedescendant={list.length > 0 ? optionId(active) : undefined}
          className="switcher-list"
          onKeyDown={onListKeyDown}
        >
          {list.length === 0 && <li className="switcher-empty muted">No books</li>}
          {list.map((b, i) => (
            <li key={b.id} role="presentation">
              <Link
                to={`/books/${encodeURIComponent(b.id)}`}
                id={optionId(i)}
                role="option"
                tabIndex={-1}
                aria-selected={current ? b.id === current.id : false}
                data-active={i === active ? 'true' : 'false'}
                onClick={() => setOpen(false)}
              >
                {titleOf(b)}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
