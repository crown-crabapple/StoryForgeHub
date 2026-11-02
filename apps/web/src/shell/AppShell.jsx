import { useFocus } from '../writing/FocusContext.jsx';
import { ProjectNav } from './ProjectNav.jsx';
import { SkipLink } from './SkipLink.jsx';
import { TopBar } from './TopBar.jsx';

/**
 * The frame around every page: skip link, top bar, project nav (inside a book), an optional banner, then the page.
 * @param {{ books: any[] | null, bookId: string | null, tab?: string, banner?: import('react').ReactNode, children: import('react').ReactNode }} props
 */
export function AppShell({ books, bookId, tab = 'manuscript', banner = null, children }) {
  const known = bookId && (books === null || books.some((b) => b.id === bookId));
  const focus = useFocus().active; // focus mode hides the top bar and the project nav (the slots stay, so the page below keeps its state)
  return (
    <div className={focus ? 'app app-focus' : 'app'}>
      <SkipLink />
      {!focus && <TopBar books={books} bookId={bookId} />}
      {known && !focus && <ProjectNav bookId={bookId} active={tab} />}
      {banner}
      {children}
    </div>
  );
}
