import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { send } from '../structure/helpers.js';
import { PreviewDialog } from '../structure/PreviewDialog.jsx';
import { EditNoteDialog, NewNoteDialog } from './NoteDialogs.jsx';
import { NoteBodyEditor } from './NoteBodyEditor.jsx';
import { NotesPage } from './NotesPage.jsx';
import { notesHref, parseNotesSearch } from './model.js';
import { explainNotesFailure, newNoteRequest, noteArchiveRequest, noteFieldsRequest, noteRestoreRequest, noteUrl } from './requests.js';

const enc = encodeURIComponent;
const SEARCH_DELAY_MS = 250;

/**
 * /books/:id/notes. Fetches the notes, keeps the section, tag and open note in the URL (?section=, ?tag=, ?note=), and runs the write flows: a form, the dry-run
 * preview with its diff, and only then the real write.
 * @param {{ bookId: string, search?: string }} props `search` is the query string of the URL
 */
export function NotesView({ bookId, search = '' }) {
  const { status } = useStatus();
  const navigate = useNavigate();
  const { track } = useWrites();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const api = `/api/books/${enc(bookId)}`;
  const url = parseNotesSearch(search);
  const { data, error, loading } = useApi(`${api}/notes`, version);
  const { data: sceneNotes } = useApi(`${api}/scene-notes`, version);
  const { data: objects } = useApi(`${api}/objects?kinds=entry,thread,event`, version);
  const notes = useMemo(() => data?.notes ?? [], [data]);
  const selectedSummary = notes.find((n) => n.id === url.note) ?? null;
  const { data: note } = useApi(selectedSummary ? noteUrl(bookId, selectedSummary.id) : null, `${version}|${selectedSummary?.sha256 ?? ''}`);

  const [query, setQuery] = useState('');
  const [textIds, setTextIds] = useState(null);
  const [dialog, setDialog] = useState(null); // { kind: 'new', noteKind } or { kind: 'edit', note }
  const [flow, setFlow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);

  // the full-text half of the search: what /api/search finds in the bodies of research notes and planning docs
  useEffect(() => {
    if (query.trim() === '') return undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${enc(query.trim())}&book=${enc(bookId)}&kinds=research,doc&limit=100`, { signal: ctrl.signal, headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : []))
        .then((hits) => setTextIds(new Set(hits.map((h) => h.id))))
        .catch(() => {});
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query, bookId]);

  async function startPreview(title, requests, then = {}) {
    setBusy(true);
    const changes = [];
    let failure = null;
    for (const r of requests) {
      const { status: code, json } = await send(r.url, { ...r.body, dryRun: true });
      if (code !== 200) {
        failure = explainNotesFailure(code, json);
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
        setFlow((f) => ({ ...f, error: explainNotesFailure(res.status, res.json) }));
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
    if (then.select === 'result') navigate(notesHref(bookId, { section: then.section ?? url.section, note: last?.id ?? null }));
    else if (then.select !== undefined) navigate(notesHref(bookId, { section: url.section, tag: url.tag, note: then.select }));
  }

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

  const sources = notes.filter((n) => n.kind === 'source' && !n.archived);
  const takenCites = new Set(notes.filter((n) => n.kind === 'source').map((n) => n.cite_key).filter(Boolean));
  const handlers = {
    onQuery: setQuery,
    onNew: (kind) => setDialog({ kind: 'new', noteKind: kind }),
    onEditText: (n) => setEditing(n),
    onEdit: (n) => setDialog({ kind: 'edit', note: n }),
    onArchive: (n) => startPreview(`Archive ${n.title}`, [noteArchiveRequest(bookId, n)], { select: undefined }),
    onRestore: (n) => startPreview(`Restore ${n.title}`, [noteRestoreRequest(bookId, n)], { select: n.id }),
    onCloseNote: () => navigate(notesHref(bookId, { section: url.section, tag: url.tag })),
  };
  const editor = editing && notes.find((n) => n.id === editing.id && !n.archived);

  return (
    <>
      <NotesPage
        bookId={bookId}
        data={data}
        sceneNotes={sceneNotes}
        section={url.section}
        tag={url.tag}
        query={query}
        textIds={textIds}
        selectedId={selectedSummary?.id ?? null}
        note={note && note.id === selectedSummary?.id ? note : null}
        handlers={handlers}
        editor={
          editor ? (
            <NoteBodyEditor
              key={editor.id}
              bookId={bookId}
              note={editor}
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
        <NewNoteDialog
          kind={dialog.noteKind}
          takenCites={takenCites}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            await startPreview(`New ${dialog.noteKind === 'research' ? 'research note' : dialog.noteKind === 'doc' ? 'planning doc' : 'source'}: ${v.title}`, [newNoteRequest(bookId, v)], {
              select: 'result',
              section: dialog.noteKind === 'research' ? 'research' : dialog.noteKind === 'doc' ? 'docs' : 'sources',
            });
            return { close: true };
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditNoteDialog
          note={dialog.note}
          objects={data.objects}
          sources={sources}
          onClose={() => setDialog(null)}
          onSubmit={async (patch) => {
            await startPreview(`Edit ${dialog.note.title}`, [noteFieldsRequest(bookId, dialog.note, patch)], {});
            return { close: true };
          }}
        />
      )}
      {flow && <PreviewDialog preview={flow} busy={busy} onApply={apply} onCancel={() => setFlow(null)} />}
    </>
  );
}
