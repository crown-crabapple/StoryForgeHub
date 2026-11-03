import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { send } from '../structure/helpers.js';
import { PreviewDialog } from '../structure/PreviewDialog.jsx';
import { SHARED_NOTICE, crossBookTarget } from '../world/model.js';
import { CodexPage } from './CodexPage.jsx';
import { ChangeSlugDialog, EditFieldsDialog, NewEntryDialog, NewTypeDialog } from './dialogs.jsx';
import { EntryBodyEditor } from './EntryBodyEditor.jsx';
import { codexHref, defaultTypeKey, parseCodexSearch, placesHref, sidebarRows } from './model.js';
import { archiveRequest, copyToBookRequest, explainCodexFailure, moveToSeriesRequest, restoreRequest } from './requests.js';

const enc = encodeURIComponent;
const SEARCH_DELAY_MS = 250;

/**
 * /books/:id/codex. Fetches the entries, keeps the selection in the URL (?type= and ?entry=) and runs the write flows: a form, the dry-run
 * preview with its diffs, and only then the real write.
 * `places` (M04-J04): the Places tab, the same page locked to the location type, with its own URL (/books/:id/places?entry=).
 * @param {{ bookId: string, search?: string, places?: boolean }} props `search` is the query string of the URL
 */
export function CodexView({ bookId, search = '', places = false }) {
  const { status } = useStatus();
  const navigate = useNavigate();
  const { track } = useWrites();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const api = `/api/books/${enc(bookId)}`;
  const { data: types } = useApi(`${api}/codex/types`, version);
  const { data: list, error, loading } = useApi(`${api}/codex/entries`, version);
  const { data: objects } = useApi(`${api}/objects?kinds=entry,thread,event`, version);
  const { data: notesData } = useApi(`${api}/notes`, version);
  const { data: labelData } = useApi(`${api}/labels`, version); // the label chips and the label filter
  const { data: targets } = useApi(`${api}/link-targets`, version); // where a link into another book leads

  const [query, setQuery] = useState('');
  const [statusKey, setStatusKey] = useState('all');
  const [sort, setSort] = useState('name');
  const [searchText, setSearchText] = useState(false);
  const [scope, setScope] = useState('all'); // All / This book / Shared (books in a series)
  const [labelFilter, setLabelFilter] = useState('');
  const [banner, setBanner] = useState(null); // what the last change reported (the W309 of a copy)
  const [textIds, setTextIds] = useState(null);
  const [dialog, setDialog] = useState(null); // { kind: 'new' | 'type' } or { kind: 'edit' | 'slug', entry }
  const [flow, setFlow] = useState(null); // the preview: { title, requests, changes, notes, error, then }
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // id of the entry whose text is open in the editor

  const entries = useMemo(() => list?.entries ?? [], [list]);
  const chapters = list?.chapters ?? [];
  const series = list?.series ?? null;
  const labelDefs = useMemo(
    () => (labelData ? [...labelData.book.labels.map((l) => ({ ...l, scope: 'book' })), ...(labelData.series?.labels ?? []).map((l) => ({ ...l, scope: 'series' }))] : null),
    [labelData],
  );
  const typeList = types ?? [];
  const url = parseCodexSearch(search);
  const urlEntry = url.entry ? (entries.find((e) => e.id === url.entry || e.slug === url.entry) ?? null) : null;
  const rows = sidebarRows(typeList, entries);
  const typeKey = places ? 'location' : (url.type ?? (urlEntry ? (urlEntry.archived ? 'archived' : (urlEntry.type ?? 'all')) : defaultTypeKey(rows)));
  const selectedId = urlEntry?.id ?? null;

  // the full-text half of the search: what /api/search finds in the entries' text
  useEffect(() => {
    if (!searchText || query.trim() === '') return undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${enc(query.trim())}&book=${enc(bookId)}&kinds=entry&limit=100`, { signal: ctrl.signal, headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : []))
        .then((hits) => setTextIds(new Set(hits.map((h) => h.id))))
        .catch(() => {});
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [searchText, query, bookId]);

  const resolve = (ref) => {
    const e = entries.find((x) => x.slug === ref || x.id === ref);
    return e ? { id: e.id, name: e.name } : null;
  };
  const takenSlugs = new Set((objects ?? []).map((o) => o.slug).filter(Boolean));
  const sharedSlugs = new Set(entries.filter((e) => e.shared).map((e) => e.slug).filter(Boolean));
  const linkOf = (ref) => crossBookTarget(ref, targets, bookId, (b, id) => codexHref(b, { entry: id }));
  const go = (next) => navigate(places ? placesHref(bookId, { entry: next.entry ?? null }) : codexHref(bookId, next));

  /** Dry-run every request, then show the preview. */
  async function startPreview(title, requests, then = {}, { shared = false } = {}) {
    setBusy(true);
    const changes = [];
    const sources = [];
    const warnings = [];
    let failure = null;
    for (const r of requests) {
      const { status: code, json } = await send(r.url, { ...r.body, dryRun: true });
      if (code !== 200) {
        failure = explainCodexFailure(code, json);
        break;
      }
      changes.push(...(json.changes ?? []));
      for (const s of json.linked_from ?? []) if (!sources.includes(s.path)) sources.push(s.path);
      for (const w of json.warnings ?? []) if (!warnings.includes(w.message)) warnings.push(`${w.code}: ${w.message}`);
    }
    setBusy(false);
    setFlow({
      title,
      requests,
      changes,
      notes: sources.length > 0 ? [{ heading: 'These scenes and entries link to it. They keep working, but will show a warning (W303):', items: sources }] : [],
      error: failure,
      notice: shared ? SHARED_NOTICE : null,
      warnings,
      then,
    });
  }

  async function apply() {
    if (!flow) return;
    setBusy(true);
    let last = null;
    for (const r of flow.requests) {
      const res = await track(bookId, () => send(r.url, r.body));
      if (res.status < 200 || res.status >= 300) {
        setBusy(false);
        setFlow((f) => ({ ...f, error: explainCodexFailure(res.status, res.json) }));
        setBump((n) => n + 1);
        return;
      }
      last = res.json;
    }
    const then = flow.then;
    setBanner(last?.warnings?.length > 0 ? last.warnings.map((w) => `${w.code}: ${w.message}`).join(' ') : null);
    setBusy(false);
    setFlow(null);
    setDialog(null);
    setBump((n) => n + 1);
    const entry = then.entry === 'result' ? (last?.id ?? null) : (then.entry ?? null);
    if (then.entry !== undefined || then.type !== undefined) go({ type: then.type ?? null, entry });
  }

  if (loading && !list) {
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
  if (!list) {
    return (
      <main id="main" tabIndex={-1} className="page">
        <h1>Book not found</h1>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </main>
    );
  }

  const editor = editing && entries.find((e) => e.id === editing && !e.archived);
  /** The buttons of the inspector for the entry it shows (the page decides which one that is). */
  const actionsFor = (entry) => ({
    onEdit: () => setDialog({ kind: 'edit', entry }),
    onEditText: () => setEditing(entry.id),
    onChangeSlug: () => setDialog({ kind: 'slug', entry }),
    onArchive: () => startPreview(`Archive ${entry.name}`, [archiveRequest(bookId, entry.id)], { entry: null, type: typeKey }, { shared: entry.shared }),
    onRestore: () => startPreview(`Restore ${entry.name}`, [restoreRequest(bookId, entry.id)], { entry: entry.id, type: entry.type }, { shared: entry.shared }),
    // a book's own entry can move into its series' codex; a shared one can be copied into the book (it then shadows the shared entry, W309)
    onMoveToSeries: series && !entry.shared ? () => startPreview(`Move ${entry.name} to the series`, [moveToSeriesRequest(bookId, entry.id)], { entry: entry.id, type: entry.type }) : undefined,
    onCopyIntoBook: entry.shared ? () => startPreview(`Copy ${entry.name} into this book`, [copyToBookRequest(bookId, entry.id)], { entry: 'result', type: entry.type }) : undefined,
  });

  return (
    <>
      <CodexPage
        bookId={bookId}
        types={typeList}
        entries={entries}
        chapters={chapters}
        typeKey={typeKey}
        selectedId={selectedId}
        query={query}
        status={statusKey}
        sort={sort}
        searchText={searchText}
        textIds={textIds}
        onTypeChange={(key) => go({ type: key })}
        onSelect={(id) => {
          // keep the sidebar row when the entry is in it; an entry of another type (a relationship) opens in its own row
          const e = entries.find((x) => x.id === id);
          const inRow = e && (typeKey === 'archived' ? e.archived : !e.archived && (typeKey === 'all' || e.type === typeKey));
          go({ type: inRow ? typeKey : null, entry: id });
        }}
        onQuery={setQuery}
        onStatus={setStatusKey}
        onSort={setSort}
        onSearchText={setSearchText}
        onNewEntry={() => setDialog({ kind: 'new' })}
        onNewType={() => setDialog({ kind: 'type' })}
        resolve={resolve}
        linkOf={linkOf}
        series={series}
        scope={scope}
        onScope={setScope}
        labelDefs={labelDefs}
        label={labelFilter}
        onLabel={setLabelFilter}
        banner={
          banner && (
            <p className="banner banner-warning" role="status">
              {banner}
            </p>
          )
        }
        notes={notesData?.notes ?? null}
        lockedType={places ? 'location' : null}
        actions={actionsFor}
        editor={
          editor ? (
            <EntryBodyEditor
              key={editor.id}
              bookId={bookId}
              entry={editor}
              types={typeList}
              objects={objects}
              onDone={() => {
                setEditing(null);
                setBump((n) => n + 1);
              }}
            />
          ) : null
        }
      />
      {dialog?.kind === 'new' && (
        <NewEntryDialog
          bookId={bookId}
          types={typeList}
          takenSlugs={takenSlugs}
          series={series}
          sharedSlugs={sharedSlugs}
          defaultType={typeKey !== 'all' && typeKey !== 'archived' ? typeKey : null}
          onClose={() => setDialog(null)}
          onPreview={(title, requests, then) => startPreview(title, requests, { entry: 'result', type: null, ...then }, { shared: then?.where === 'series' })}
        />
      )}
      {dialog?.kind === 'type' && <NewTypeDialog bookId={bookId} types={typeList} onClose={() => setDialog(null)} onPreview={(title, requests) => startPreview(title, requests, {})} />}
      {dialog?.kind === 'edit' && (
        <EditFieldsDialog
          bookId={bookId}
          entry={dialog.entry}
          entries={entries}
          types={typeList}
          labelDefs={labelDefs}
          onClose={() => setDialog(null)}
          onPreview={(title, requests) => startPreview(title, requests, {}, { shared: dialog.entry.shared })}
        />
      )}
      {dialog?.kind === 'slug' && (
        <ChangeSlugDialog
          bookId={bookId}
          entry={dialog.entry}
          takenSlugs={dialog.entry.shared ? sharedSlugs : takenSlugs}
          onClose={() => setDialog(null)}
          onPreview={(title, requests) => startPreview(title, requests, {}, { shared: dialog.entry.shared })}
        />
      )}
      {flow && <PreviewDialog preview={flow} busy={busy} onApply={apply} onCancel={() => setFlow(null)} />}
    </>
  );
}
