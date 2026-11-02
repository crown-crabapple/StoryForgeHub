import { BookActions } from '../export/BookActions.jsx';
import { IndexStatus } from '../IndexStatus.jsx';
import { Link } from '../router.jsx';
import { SearchBox } from '../SearchBox.jsx';
import { BookSwitcher } from './BookSwitcher.jsx';
import { BookIcon } from './icons.jsx';
import { SaveStatus } from './SaveStatus.jsx';

/** Logo, book switcher, save status, search, index status. @param {{ books: any[] | null, bookId: string | null }} props */
export function TopBar({ books, bookId }) {
  const current = bookId && books ? (books.find((b) => b.id === bookId) ?? null) : null;
  return (
    <header className="topbar">
      <Link to="/" className="logo" aria-label="StoryForge home">
        <span className="logo-mark">
          <BookIcon width={18} height={18} />
        </span>
        <span className="logo-word">StoryForge</span>
      </Link>
      <BookSwitcher books={books} current={current} />
      {current && <BookActions bookId={current.id} slug={current.slug ?? null} />}
      <SaveStatus bookId={bookId && (books === null || current) ? bookId : null} />
      <SearchBox />
      <IndexStatus />
    </header>
  );
}
