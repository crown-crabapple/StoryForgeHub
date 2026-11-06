import { Link, useLocation } from './router.jsx';
import { LibraryView } from './LibraryView.jsx';
import { BookView } from './BookView.jsx';
import { CodexView } from './codex/CodexView.jsx';
import { ContinuityView } from './continuity/ContinuityView.jsx';
import { NotesView } from './notes/NotesView.jsx';
import { PlanView } from './planner/PlanView.jsx';
import { CanvasView } from './canvas/CanvasView.jsx';
import { TimelineView } from './timeline/TimelineView.jsx';
import { InsightsView } from './insights/InsightsView.jsx';
import { TasksView } from './tasks/TasksView.jsx';
import { TimerProvider } from './writing/TimerProvider.jsx';
import { useApi } from './api.js';
import { SettingsView } from './ai/SettingsView.jsx';
import { RoutedPrefsProvider, usePrefs } from './prefs/PrefsContext.jsx';
import { parseRoute, tabModule } from './routes.js';
import { ShortcutsProvider } from './shortcuts/ShortcutsContext.jsx';
import { AppShell } from './shell/AppShell.jsx';
import { WritesProvider } from './shell/writes.jsx';
import { SearchQueryProvider } from './searchQuery.jsx';
import { StatusProvider, libraryVersion, useStatus } from './status.jsx';
import { FocusProvider } from './writing/FocusContext.jsx';
import { InvitePage } from './shared/InvitePage.jsx';
import { LoginPage } from './shared/LoginPage.jsx';
import { MembersView } from './shared/MembersView.jsx';
import { SessionProvider, useSession } from './shared/session.jsx';
import { SetupPage } from './shared/SetupPage.jsx';
import { ShareEntry } from './shared/ShareEntry.jsx';
import { ShareReader } from './shared/ShareReader.jsx';
import { postJson } from './api.js';

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
  const prefs = usePrefs();
  const { data: books } = useApi('/api/books', libraryVersion(status));
  const route = parseRoute(pathname, search);
  let view;
  let bookId = null;
  let tab = 'manuscript';
  if (route.name === 'library') view = <LibraryView />;
  else if (route.name === 'settings') view = <SettingsView />;
  else if (route.name === 'members') view = <MembersView />;
  else if (route.name === 'book') {
    bookId = route.bookId;
    view = <BookView bookId={route.bookId} sceneId={route.sceneId} file={route.file} />;
  } else if (route.name === 'tab') {
    bookId = route.bookId;
    tab = route.tab;
    const gate = tabModule(route.tab);
    if (gate !== null && !prefs.moduleOn(gate)) {
      // the page of a module that is off (M07-J04): the address still works, it just says so
      view = (
        <main id="main" tabIndex={-1} className="page">
          <h1>This feature is turned off</h1>
          <p>
            The {gate} module is off for this profile or this project. Turn it on in <Link to="/settings">Settings</Link> (a project that requires it off must be changed in library.md or book.md).
          </p>
        </main>
      );
    } else if (route.tab === 'timeline') view = <TimelineView bookId={route.bookId} search={search} />;
    else if (route.tab === 'continuity') view = <ContinuityView bookId={route.bookId} search={search} />;
    else if (route.tab === 'notes') view = <NotesView bookId={route.bookId} search={search} />;
    else if (route.tab === 'plan') view = <PlanView bookId={route.bookId} search={search} />;
    else if (route.tab === 'canvas') view = <CanvasView bookId={route.bookId} search={search} />;
    else if (route.tab === 'insights') view = <InsightsView bookId={route.bookId} search={search} />;
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

/** The whole writing app: what personal mode has always shown, and what a signed-in person sees in shared mode. */
function Workspace() {
  return (
    <StatusProvider>
      <RoutedPrefsProvider>
        <ShortcutsProvider>
          <WritesProvider>
            <FocusProvider>
              <TimerProvider>
                <SearchQueryProvider>
                  <Routes />
                </SearchQueryProvider>
              </TimerProvider>
            </FocusProvider>
          </WritesProvider>
        </ShortcutsProvider>
      </RoutedPrefsProvider>
    </StatusProvider>
  );
}

/**
 * Personal mode (GET /api/auth/me is 404) shows the app exactly as before. Shared mode adds the pages for people who are not signed in: login, /setup, /invite and /s
 * (a read-only share link), and a read-only reader for a share session.
 */
function SessionGate() {
  const session = useSession();
  const { pathname } = useLocation();
  if (session.mode === 'loading') return null;
  if (session.mode === 'personal') return <Workspace />;
  if (session.share) {
    return (
      <ShareReader
        share={session.share}
        onLeave={async () => {
          await postJson('/api/auth/logout', {});
          await session.refresh();
        }}
      />
    );
  }
  if (session.user) return <Workspace />;
  if (pathname === '/setup') return <SetupPage onDone={session.refresh} />;
  if (pathname === '/invite') return <InvitePage onDone={session.refresh} />;
  if (pathname === '/s') return <ShareEntry onOpened={session.refresh} />;
  return <LoginPage needsOwner={session.needsOwner} onSignedIn={session.refresh} />;
}

export function App() {
  return (
    <SessionProvider>
      <SessionGate />
    </SessionProvider>
  );
}
