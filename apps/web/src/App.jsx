import { Link, useLocation } from './router.jsx';
import { LibraryView } from './LibraryView.jsx';
import { BookView } from './BookView.jsx';
import { CodexView } from './codex/CodexView.jsx';
import { ContinuityView } from './continuity/ContinuityView.jsx';
import { NotesView } from './notes/NotesView.jsx';
import { TimelineView } from './timeline/TimelineView.jsx';
import { InsightsView } from './insights/InsightsView.jsx';
import { TasksView } from './tasks/TasksView.jsx';
import { TimerProvider } from './writing/TimerProvider.jsx';
import { useApi } from './api.js';
import { SettingsView } from './ai/SettingsView.jsx';
import { parseRoute } from './routes.js';
import { AppShell } from './shell/AppShell.jsx';
import { WritesProvider } from './shell/writes.jsx';
import { SearchQueryProvider } from './searchQuery.jsx';
import { StatusProvider, libraryVersion, useStatus } from './status.jsx';
import { FocusProvider } from './writing/FocusContext.jsx';

/** Shown when the startup recovery pass rolled an interrupted save back or needs the author's eyes. */
function RecoverBanner() {
  const { data: report } = useApi('/api/recover/last');
  if (!report) return null;
  const rolledBack = report.rolledBack ?? [];
  const needsAttention = report.needsAttention ?? [];
  if (rolledBack.length === 0 && needsAttention.length === 0) return null;
  const label = (item) => `${item.op ?? 'operation'} ${item.opId}${item.files?.length ? ` (${item.files.join(', ')})` : ''}`;
  return (
    <aside role="alert" className="banner banner-warning">
      <strong>StoryForge recovered from an interrupted save.</strong>
      {rolledBack.length > 0 && (
        <>
          <p>Rolled back to the previous version (nothing was lost):</p>
          <ul>
            {rolledBack.map((item) => (
              <li key={item.opId}>{label(item)}</li>
            ))}
          </ul>
        </>
      )}
      {needsAttention.length > 0 && (
        <>
          <p>Needs your attention (these files were left untouched):</p>
          <ul>
            {needsAttention.map((item) => (
              <li key={item.opId}>
                {label(item)}
                {item.reason ? ` - ${item.reason}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

function Routes() {
  const { pathname, search } = useLocation();
  const { status } = useStatus();
  const { data: books } = useApi('/api/books', libraryVersion(status));
  const route = parseRoute(pathname, search);
  let view;
  let bookId = null;
  let tab = 'manuscript';
  if (route.name === 'library') view = <LibraryView />;
  else if (route.name === 'settings') view = <SettingsView />;
  else if (route.name === 'book') {
    bookId = route.bookId;
    view = <BookView bookId={route.bookId} sceneId={route.sceneId} file={route.file} />;
  } else if (route.name === 'tab') {
    bookId = route.bookId;
    tab = route.tab;
    if (route.tab === 'timeline') view = <TimelineView bookId={route.bookId} search={search} />;
    else if (route.tab === 'continuity') view = <ContinuityView bookId={route.bookId} search={search} />;
    else if (route.tab === 'notes') view = <NotesView bookId={route.bookId} search={search} />;
    else if (route.tab === 'insights') view = <InsightsView bookId={route.bookId} />;
    else if (route.tab === 'tasks') view = <TasksView bookId={route.bookId} search={search} />;
    else view = <CodexView bookId={route.bookId} search={search} places={route.tab === 'places'} />;
  } else {
    view = (
      <main id="main" tabIndex={-1} className="page">
        <h1>Not found</h1>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }
  return (
    <AppShell books={books} bookId={bookId} tab={tab} banner={<RecoverBanner />}>
      {view}
    </AppShell>
  );
}

export function App() {
  return (
    <StatusProvider>
      <WritesProvider>
        <FocusProvider>
          <TimerProvider>
            <SearchQueryProvider>
              <Routes />
            </SearchQueryProvider>
          </TimerProvider>
        </FocusProvider>
      </WritesProvider>
    </StatusProvider>
  );
}
