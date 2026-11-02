import { useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { send } from '../structure/helpers.js';
import { PreviewDialog } from '../structure/PreviewDialog.jsx';
import { useStructure } from '../structure/useStructure.jsx';
import { EditEventDialog, EventScenesDialog, NewEventDialog } from './EventDialogs.jsx';
import { EventBodyEditor } from './EventBodyEditor.jsx';
import { TimelinePage } from './TimelinePage.jsx';
import { buildTimeline, orderLabel, parseTimelineSearch, reorderByStep, reorderTo, timelineHref } from './model.js';
import { eventArchiveRequest, eventFieldsRequest, eventOrderRequest, eventRestoreRequest, eventScenesRequest, explainTimelineFailure, newEventRequest } from './requests.js';

const enc = encodeURIComponent;

/**
 * /books/:id/timeline. Fetches the timeline, keeps the selection and the order in the URL (?event= and ?order=book), and runs the write flows: a form, the dry-run
 * preview with its diff, and only then the real write. A reorder is a one-line `order` edit written at once, with Undo in the toast.
 * @param {{ bookId: string, search?: string }} props `search` is the query string of the URL
 */
export function TimelineView({ bookId, search = '' }) {
  const { status } = useStatus();
  const navigate = useNavigate();
  const { track } = useWrites();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const api = `/api/books/${enc(bookId)}`;
  const { data, error, loading } = useApi(`${api}/timeline`, version);
  const { data: objects } = useApi(`${api}/objects?kinds=entry,thread,event`, version);
  const structure = useStructure({ book: { id: bookId }, activeId: null, onChanged: () => setBump((n) => n + 1) });

  const [filters, setFilters] = useState({ character: '', location: '', thread: '', unplacedOnly: false, hasProblems: false });
  const [table, setTable] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind: 'new' } or { kind: 'edit' | 'scenes', event }
  const [flow, setFlow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // the event whose text is open in the editor

  const url = parseTimelineSearch(search);
  const model = useMemo(() => buildTimeline(data), [data]);
  const sorted = model.events.filter((e) => e.order !== null);
  const selected = model.byId.get(url.event) ?? null;
  const takenSlugs = new Set([...(data?.events ?? []), ...(data?.archived ?? []), ...(data?.entries ?? []), ...(data?.threads ?? [])].map((x) => x.slug).filter(Boolean));
  const go = (next) => navigate(timelineHref(bookId, { event: next.event === undefined ? url.event : next.event, order: next.order ?? url.order }));

  /** Dry-run every request, then show the preview. */
  async function startPreview(title, requests, then = {}) {
    setBusy(true);
    const changes = [];
    let failure = null;
    for (const r of requests) {
      const { status: code, json } = await send(r.url, { ...r.body, dryRun: true });
      if (code !== 200) {
        failure = explainTimelineFailure(code, json);
        break;
      }
      changes.push(...(json.changes ?? []));
    }
    setBusy(false);
    setFlow({ title, requests, changes, notes: [], error: failure, then });
  }

  async function apply() {
    if (!flow) return;
    setBusy(true);
    let last = null;
    for (const r of flow.requests) {
      const res = await track(bookId, () => send(r.url, r.body));
      if (res.status < 200 || res.status >= 300) {
        setBusy(false);
        setFlow((f) => ({ ...f, error: explainTimelineFailure(res.status, res.json) }));
        setBump((n) => n + 1);
        return;
      }
      last = res.json;
    }
    const then = flow.then;
    setBusy(false);
    setFlow(null);
    setDialog(null);
    setBump((n) => n + 1);
    if (then.select === 'result') go({ event: last?.id ?? null });
    else if (then.select !== undefined) go({ event: then.select });
  }

  /** Drop an event into a new place in story time: its `order` becomes the midpoint of its new neighbours; one line, written at once, with Undo. */
  async function reorder(id, index) {
    const event = model.byId.get(id);
    if (!event) return;
    if (event.stale) {
      structure.showToast({ message: `Not moved: ${event.title ?? event.slug} cannot be read right now.` });
      return;
    }
    const r = reorderTo(sorted, id, index);
    if (r === null) {
      structure.showToast({ message: `"${event.title ?? event.slug}" is already there.` });
      return;
    }
    if (!r.ok) {
      structure.showToast({ message: 'Not moved: its neighbours are too close for another order between them. Set the order by hand with Edit fields.' });
      return;
    }
    const req = eventOrderRequest(bookId, event, r.order);
    const result = await structure.apply({ title: 'Reorder', url: req.url, body: req.body, done: `Moved "${event.title ?? event.slug}" in story time (order ${orderLabel(r.order)}).`, undoable: true });
    if (!result.ok) structure.showToast({ message: `Not moved: ${result.message}` });
  }
  const moveStep = (id, dir) => {
    const r = reorderByStep(sorted, id, dir);
    if (r === null) {
      structure.showToast({ message: dir < 0 ? 'It is already the first event.' : 'It is already the last event.' });
      return undefined;
    }
    const at = sorted.findIndex((e) => e.id === id);
    return reorder(id, at + dir);
  };

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

  const handlers = {
    onOrder: (order) => go({ order }),
    onFilters: setFilters,
    onSelect: (id) => go({ event: id }),
    onTable: setTable,
    onNew: () => setDialog({ kind: 'new' }),
    onEdit: (event) => setDialog({ kind: 'edit', event }),
    onScenes: (event) => setDialog({ kind: 'scenes', event }),
    onEditText: (event) => setEditing(event),
    onArchive: (event) => startPreview(`Archive ${event.title ?? event.slug}`, [eventArchiveRequest(bookId, event)], { select: null }),
    onRestore: (a) => startPreview(`Restore ${a.title ?? a.slug}`, [eventRestoreRequest(bookId, a)], { select: a.id }),
    onReorder: reorder,
    onMoveStep: moveStep,
  };
  const editor = editing && model.byId.get(editing.id);

  return (
    <>
      <TimelinePage
        bookId={bookId}
        data={data}
        model={model}
        order={url.order}
        filters={filters}
        selectedId={selected?.id ?? null}
        table={table}
        archived={data.archived}
        handlers={handlers}
        editor={
          editor ? (
            <EventBodyEditor
              key={editor.id}
              bookId={bookId}
              event={editor}
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
        <NewEventDialog
          sorted={sorted}
          selectedId={selected?.id ?? null}
          takenSlugs={takenSlugs}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await startPreview(`New event: ${v.title}`, [newEventRequest(bookId, v)], { select: 'result' });
            return { close: true };
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditEventDialog
          event={dialog.event}
          entries={data.entries}
          onClose={() => setDialog(null)}
          onSubmit={async (patch) => {
            await startPreview(`Edit ${dialog.event.title ?? dialog.event.slug}`, [eventFieldsRequest(bookId, dialog.event, patch)], {});
            return { close: true };
          }}
        />
      )}
      {dialog?.kind === 'scenes' && (
        <EventScenesDialog
          event={dialog.event}
          scenes={data.scenes}
          onClose={() => setDialog(null)}
          onSubmit={async (change) => {
            await startPreview(`Scenes of ${dialog.event.title ?? dialog.event.slug}`, [eventScenesRequest(bookId, dialog.event, change)], {});
            return { close: true };
          }}
        />
      )}
      {flow && <PreviewDialog preview={flow} busy={busy} onApply={apply} onCancel={() => setFlow(null)} />}
      {structure.ui}
    </>
  );
}
