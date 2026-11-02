import { Link } from './router.jsx';
import { tabHref } from './routes.js';

const PAGES = {
  codex: {
    title: 'Codex',
    text: 'The Codex will hold your characters, places, objects and lore as entries you can browse, edit and link from your scenes.',
  },
  timeline: {
    title: 'Timeline',
    text: 'The Timeline will lay out your story events and plot threads in order, with the scenes that carry them.',
  },
  places: {
    title: 'Places',
    text: 'Places will gather every location in your book, with the scenes that happen there.',
  },
  notes: {
    title: 'Notes',
    text: 'Notes will hold your planning documents and research alongside the manuscript.',
  },
};

/** A real route for a tab that is not built yet: says what it will hold and when. No mock data. */
export function PlaceholderView({ bookId, tab }) {
  const page = PAGES[tab];
  return (
    <main id="main" tabIndex={-1} className="page">
      <h1>{page.title}</h1>
      <p className="placeholder-text">{page.text}</p>
      <p className="secondary">This arrives in M04. Nothing here is saved or shown yet.</p>
      <p>
        <Link to={tabHref(bookId, 'manuscript')}>Back to the manuscript</Link>
        {' · '}
        <Link to="/">Library</Link>
      </p>
    </main>
  );
}
