// A tiny client-side router: History API, no dependency.
import { useCallback, useEffect, useState } from 'react';

const NAV_EVENT = 'storyforge:navigate';

/** Current location as { pathname, search }, updated on navigation. */
export function useLocation() {
  const read = () => ({ pathname: window.location.pathname, search: window.location.search });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const onChange = () => setLoc(read());
    window.addEventListener('popstate', onChange);
    window.addEventListener(NAV_EVENT, onChange);
    return () => {
      window.removeEventListener('popstate', onChange);
      window.removeEventListener(NAV_EVENT, onChange);
    };
  }, []);
  return loc;
}

/** @returns {(to: string) => void} */
export function useNavigate() {
  return useCallback((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new Event(NAV_EVENT));
  }, []);
}

/** A real <a href>; plain left-clicks navigate in-app, everything else behaves natively. */
export function Link({ to, onClick, children, ...rest }) {
  const navigate = useNavigate();
  const handle = (e) => {
    if (onClick) onClick(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
