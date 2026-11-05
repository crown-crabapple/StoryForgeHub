import { useState } from 'react';
import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { ContinuityPage } from './ContinuityPage.jsx';
import { continuityHref, parseContinuitySearch } from './model.js';
import { suggestionUrl, suggestionsUrl } from '../suggestions/model.js';
import { useSuggestionActions } from '../suggestions/useSuggestionActions.jsx';
import { continuityUrl } from './requests.js';
import { useContinuityActions } from './useContinuityActions.jsx';

/**
 * /books/:id/continuity. Fetches the findings (again after every write and on the status poll, so an outside edit shows within a few seconds), keeps the open finding
 * in the URL (?finding=<fingerprint>) and the filters in the page. Acknowledge, Restore finding and Remove write only exception files.
 * @param {{ bookId: string, search?: string }} props `search` is the query string of the URL
 */
export function ContinuityView({ bookId, search = '' }) {
  const { status } = useStatus();
  const navigate = useNavigate();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const { data, error, loading } = useApi(continuityUrl(bookId), version);
  const [filter, setFilter] = useState({ status: 'all', rule: null, subject: null });
  const actions = useContinuityActions({ bookId, onChanged: () => setBump((n) => n + 1) });
  const url = parseContinuitySearch(search);
  // M05-J06: the Suggestions group (all suggestions of the book) and the one open for review
  const sg = useSuggestionActions({ bookId, onChanged: () => setBump((n) => n + 1) });
  const sgKey = `${version}|${sg.stamp}`;
  const sgList = useApi(suggestionsUrl(bookId), sgKey);
  const sgOne = useApi(url.suggestion ? suggestionUrl(bookId, url.suggestion) : null, sgKey);

  if (loading && !data) {
    return (
      <main id="main" tabIndex={-1} className="page muted">
        Loading…
      </main>
    );
  }
  if (error) {
    return (
      <main id="main" tabIndex={-1} className="page error">
        {error}
      </main>
    );
  }
  if (!data) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Book not found</h1>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }
  return (
    <>
      <ContinuityPage
        bookId={bookId}
        result={data}
        filter={filter}
        selectedFp={url.finding}
        version={version}
        handlers={{
          onFilter: (patch) => setFilter((f) => ({ ...f, ...patch })),
          onSelect: (fp) => navigate(continuityHref(bookId, { finding: fp })),
          onClose: () => navigate(continuityHref(bookId)),
          onAcknowledge: actions.acknowledge,
          onRestore: actions.restore,
          onRemove: actions.remove,
        }}
        suggestions={sgList.data?.suggestions ?? null}
        selectedSuggestion={sgOne.data}
        selectedSuggestionId={url.suggestion}
        suggestionHandlers={{
          busy: sg.busy,
          error: sg.error,
          onSelect: (id) => navigate(continuityHref(bookId, { suggestion: id })),
          onAccept: (h) => sg.decide(url.suggestion, 'accept', h),
          onDecline: (h) => sg.decide(url.suggestion, 'decline', h),
          onAcceptAll: () => sg.decide(url.suggestion, 'accept'),
          onDeclineAll: () => sg.decide(url.suggestion, 'decline'),
        }}
      />
      {actions.ui}
      {sg.ui}
    </>
  );
}
