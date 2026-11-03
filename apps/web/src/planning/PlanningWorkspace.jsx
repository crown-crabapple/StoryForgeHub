import { useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { Link, useNavigate } from '../router.jsx';
import { useWrites } from '../shell/writes.jsx';
import { send, slugify } from '../structure/helpers.js';
import { PreviewDialog } from '../structure/PreviewDialog.jsx';
import { useStructure } from '../structure/useStructure.jsx';
import { usePrefs } from '../prefs/PrefsContext.jsx';
import { BoardView } from './BoardView.jsx';
import { CardDialog, NewThreadDialog } from './dialogs.jsx';
import { MatrixView } from './MatrixView.jsx';
import { OutlineView } from './OutlineView.jsx';
import { ThreadBodyEditor } from './ThreadBodyEditor.jsx';
import { ThreadInspector } from './ThreadInspector.jsx';
import { ThreadsView } from './ThreadsView.jsx';
import { VIEWS, buildModel, stateLabel, viewHref, visibleThreads } from './model.js';
import { explainPlanningFailure, newCardRequest, newThreadRequest, sceneFieldsRequest, threadCharactersRequest, threadListRequest, threadStateRequest, threadUrl } from './requests.js';

/**
 * Write · Board · Outline · Threads: the view switch of the Manuscript tab, as real links (`?view=`). On Threads, a List / Matrix choice sits under it.
 * @param {{ bookId: string, view: string, mode?: string, scene?: string | null }} props
 */
export function ViewSwitch({ bookId, view, mode = 'list', scene = null }) {
  const prefs = usePrefs(); // Board and Threads follow their modules (M07-J04)
  return (
    <nav aria-label="Manuscript views" className="view-switch">
      <ul>
        {VIEWS.filter((v) => (v.key !== 'board' && v.key !== 'threads') || prefs.moduleOn(v.key)).map((v) => (
          <li key={v.key}>
            <Link to={viewHref(bookId, v.key, { scene })} className="view-tab" aria-current={v.key === view ? 'page' : undefined}>
              {v.label}
            </Link>
          </li>
        ))}
      </ul>
      {view === 'threads' && (
        <ul className="view-sub" aria-label="Threads display">
          <li>
            <Link to={viewHref(bookId, 'threads')} className="view-tab" aria-current={mode === 'list' ? 'page' : undefined}>
              List
            </Link>
          </li>
          <li>
            <Link to={viewHref(bookId, 'threads', { mode: 'matrix' })} className="view-tab" aria-current={mode === 'matrix' ? 'page' : undefined}>
              Matrix
            </Link>
          </li>
        </ul>
      )}
    </nav>
  );
}

/**
 * The Board, Outline and Threads views of one book, with every write they make. `render({ main, inspector })` places them in the page layout.
 * Writes: a move is the manuscript tree's move (checked against what you saw, previewed when neighbours renumber, Undo restores it exactly); a single
 * line (card fields, a thread's state) is written at once with Undo; a new card, a new thread and a change of a thread's scene lists show the dry-run diff first.
 * @param {{ book: any, planning: { threads: any[], scenes: any[] } | null, objects?: any[] | null, view: 'board' | 'outline' | 'threads', mode?: 'list' | 'matrix',
 *   threadId?: string | null, outlineFilters?: { status?: string }, version?: string, fallbackInspector?: import('react').ReactNode, onChanged?: (info?: any) => void,
 *   render: (parts: { main: import('react').ReactNode, inspector: import('react').ReactNode }) => import('react').ReactNode }} props
 */
export function PlanningWorkspace({ book, planning, objects = null, view, mode = 'list', threadId = null, outlineFilters = {}, version = '', fallbackInspector = null, onChanged, render }) {
  const navigate = useNavigate();
  const { track } = useWrites();
  const structure = useStructure({ book, activeId: null, onChanged });
  const model = useMemo(() => buildModel(book, planning), [book, planning]);
  const [dialog, setDialog] = useState(null); // { kind: 'new-card', chapter } | { kind: 'edit-card', card } | { kind: 'new-thread' }
  const [editing, setEditing] = useState(null); // thread whose text is open in the editor
  const [flow, setFlow] = useState(null); // dry-run preview of a list change
  const [busy, setBusy] = useState(false);
  const bookId = book.id;

  const selected = model.threadById.get(threadId) ?? model.threads.find((t) => t.slug === threadId) ?? visibleThreads(model.threads)[0] ?? null;
  const { data: threadDoc } = useApi(view === 'threads' && selected ? threadUrl(bookId, selected.id) : null, `${version}|${selected?.sha256 ?? ''}`);
  const characters = (objects ?? []).filter((o) => o.kind === 'entry' && o.type === 'character' && typeof o.slug === 'string').map((o) => ({ slug: o.slug, title: o.title }));
  const takenSlugs = new Set((objects ?? []).map((o) => o.slug).filter(Boolean));
  const cardName = (card) => card.title || 'Untitled scene';

  /** Write one command at once (with Undo); a refusal is shown in the toast. */
  async function quick(cmd) {
    const r = await structure.apply(cmd);
    if (!r.ok) structure.showToast({ message: `Not changed: ${r.message}` });
    return r;
  }
  const fromRequest = (r, extra) => ({ url: r.url, body: r.body, ...extra });

  const setCardFields = (card, patch) => {
    const what = patch.status !== undefined ? `is now ${patch.status}` : 'summary saved';
    return quick(fromRequest(sceneFieldsRequest(bookId, card.id, patch), { done: `"${cardName(card)}" ${what}.`, undoable: true }));
  };
  const setState = (thread, to) =>
    quick(fromRequest(threadStateRequest(bookId, thread, to), { done: `"${thread.title}" is now ${stateLabel(to).toLowerCase()}.`, undoable: true }));

  /** A change of a thread's scene lists: the dry-run diff first, then Apply. */
  async function previewThread(title, request, done) {
    setBusy(true);
    const { status, json } = await send(request.url, { ...request.body, dryRun: true });
    setBusy(false);
    setFlow({
      title,
      changes: status === 200 ? (json?.changes ?? []) : [],
      error: status === 200 ? null : explainPlanningFailure(status, json),
      cmd: { url: request.url, body: request.body, done, undoable: true, after: () => {} },
    });
  }
  async function applyFlow() {
    if (!flow?.cmd) return;
    setBusy(true);
    const r = await track(bookId, () => send(flow.cmd.url, flow.cmd.body));
    setBusy(false);
    if (r.status === 200) {
      setFlow(null);
      structure.showToast({ message: flow.cmd.done, opId: r.json?.opId ?? null });
      onChanged?.(r.json);
    } else {
      setFlow({ ...flow, error: explainPlanningFailure(r.status, r.json) });
      onChanged?.();
    }
  }
  const ROLE_WORDS = { setup: 'setup', develop: 'development', payoff: 'payoff' };
  const markList = (thread, list, sceneId, present) => {
    const card = model.sceneById.get(sceneId);
    const verb = present ? `Mark "${card ? cardName(card) : sceneId}" as ${ROLE_WORDS[list]} of "${thread.title}"` : `Remove "${card ? cardName(card) : sceneId}" from the ${ROLE_WORDS[list]} of "${thread.title}"`;
    return previewThread(verb, threadListRequest(bookId, thread, list, sceneId, present), present ? `Marked as ${ROLE_WORDS[list]}.` : `Removed from the ${ROLE_WORDS[list]}.`);
  };

  const onNewCard = (chapter) => setDialog({ kind: 'new-card', chapter });

  let body;
  if (view === 'board') {
    body = (
      <BoardView
        bookId={bookId}
        model={model}
        onMove={(card, target) => structure.move(card, target)}
        onNewCard={onNewCard}
        onEdit={(card) => setDialog({ kind: 'edit-card', card })}
        onMoveDialog={(card) => structure.start({ type: 'move', scene: card })}
      />
    );
  } else if (view === 'outline') {
    body = <OutlineView key={outlineFilters.status ?? ''} bookId={bookId} model={model} initialFilters={outlineFilters} onSetFields={setCardFields} />;
  } else if (editing) {
    body = <ThreadBodyEditor key={editing.id} bookId={bookId} thread={editing} objects={objects} onDone={() => { setEditing(null); onChanged?.(); }} />;
  } else if (mode === 'matrix') {
    body = <MatrixView bookId={bookId} model={model} onMark={markList} />;
  } else {
    body = (
      <ThreadsView
        model={model}
        selectedId={selected?.id ?? null}
        onSelect={(t) => navigate(viewHref(bookId, 'threads', { thread: t.id }))}
        onNewThread={() => setDialog({ kind: 'new-thread' })}
        onSuggest={setState}
      />
    );
  }

  const main = (
    <>
      <h1 className="sr-only">
        {book.title ?? book.slug ?? 'Book'}: {VIEWS.find((v) => v.key === view)?.label ?? view}
      </h1>
      <ViewSwitch bookId={bookId} view={view} mode={mode} />
      {planning === null ? <p className="muted">Loading...</p> : body}
      {structure.ui}
      {dialog?.kind === 'new-card' && (
        <CardDialog
          mode="new"
          chapterName={dialog.chapter.name}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const scenes = dialog.chapter.scenes;
            const request = newCardRequest(bookId, { chapter: dialog.chapter.chapter, act: dialog.chapter.act, after: scenes.length > 0 ? scenes[scenes.length - 1].id : null, title: v.title, slug: slugify(v.title), summary: v.summary });
            return structure.preview(fromRequest(request, { title: `New card "${v.title}"`, done: 'Card added.', undoable: true }), { stayInForm: true });
          }}
        />
      )}
      {dialog?.kind === 'edit-card' && (
        <CardDialog
          mode="edit"
          card={dialog.card}
          characters={characters}
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const c = dialog.card;
            const patch = {
              ...(v.title !== c.title ? { title: v.title } : {}),
              ...(v.summary !== c.summary ? { summary: v.summary } : {}),
              ...(v.status !== (c.status ?? 'outline') && v.status !== c.status ? { status: v.status } : {}),
              ...(v.pov !== '' && v.pov !== (c.pov ?? '') ? { pov: v.pov } : {}),
            };
            if (Object.keys(patch).length === 0) return { close: true };
            const r = await structure.apply(fromRequest(sceneFieldsRequest(bookId, c.id, patch), { done: `Saved "${v.title || cardName(c)}".`, undoable: true }));
            return r.ok ? { close: true } : { error: r.message };
          }}
        />
      )}
      {dialog?.kind === 'new-thread' && (
        <NewThreadDialog
          takenSlugs={takenSlugs}
          onClose={() => setDialog(null)}
          onSubmit={(v) =>
            structure.preview(
              {
                ...fromRequest(newThreadRequest(bookId, v), { title: `New thread "${v.title}"`, done: 'Thread added.', undoable: true }),
                after: (json) => json?.id && navigate(viewHref(bookId, 'threads', { thread: json.id })),
              },
              { stayInForm: true },
            )
          }
        />
      )}
      {flow && <PreviewDialog preview={flow} busy={busy} onApply={applyFlow} onCancel={() => setFlow(null)} />}
    </>
  );

  const inspector =
    view === 'threads' ? (
      <ThreadInspector
        bookId={bookId}
        thread={selected}
        model={model}
        body={selected ? (threadDoc?.id === selected.id ? threadDoc.body : null) : null}
        objects={objects}
        onState={setState}
        onSuggest={setState}
        onEditText={(t) => setEditing(t)}
        onAddScene={(t, list, sceneId) => markList(t, list, sceneId, true)}
        onRemoveScene={(t, list, sceneId) => markList(t, list, sceneId, false)}
        onSetCharacters={(t, list) =>
          previewThread(`Change the characters of "${t.title}"`, threadCharactersRequest(bookId, t, list), 'Characters changed.')
        }
      />
    ) : (
      fallbackInspector
    );
  return render({ main, inspector });
}
