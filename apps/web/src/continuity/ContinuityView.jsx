import { useState } from 'react';
import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { ContinuityPage } from './ContinuityPage.jsx';
import { continuityHref, parseContinuitySearch } from './model.js';
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
          onAcknowledge: actions.acknowledge,
          onRestore: actions.restore,
          onRemove: actions.remove,
        }}
      />
      {actions.ui}
    </>
  );
}
