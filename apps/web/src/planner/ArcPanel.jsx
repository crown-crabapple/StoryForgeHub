import { useCallback, useMemo, useState } from 'react';
import { useApi } from '../api.js';
import { Link } from '../router.jsx';
import { bookVersion, useStatus } from '../status.jsx';
import { useStructure } from '../structure/useStructure.jsx';
import { ArcEditor } from './ArcEditor.jsx';
import { useArcWrites } from './useArcWrites.js';
import { arcsUrl, flowUrl, planHref } from './requests.js';

/**
 * The Arc section of a character's Codex page. For an entry that is not a character it draws nothing. With an arc in this book: the editor, and a link to the Plan tab's Arcs
 * view. Without: "No arc for <name> in this book." and "Start an arc". Presentational.
 * @param {{ bookId: string, entry: { id: string, name?: string, type?: string, shared?: boolean }, arc: any | null, scenes?: any[], loading?: boolean, error?: string | null,
 *   state?: { message?: string | null, error?: string | null, busy?: boolean }, handlers?: any, onStart?: () => void, starting?: boolean }} props
 *   A series-shared character has one arc per book, so the heading says "Arc in this book".
 */
export function ArcPanelView({ bookId, entry, arc, scenes = [], loading = false, error = null, state = {}, handlers = {}, onStart, starting = false }) {
  if (entry?.type !== 'character') return null;
  return (
    <section className="codex-detail-section arc-panel" aria-labelledby="arc-panel-heading">
      <h3 id="arc-panel-heading">{entry.shared ? 'Arc in this book' : 'Arc'}</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : arc ? (
        <>
          <p>
            <Link to={planHref(bookId, { view: 'arcs', arc: arc.slug })}>Open in the Plan tab</Link>
          </p>
          <ArcEditor bookId={bookId} arc={arc} scenes={scenes} state={state} handlers={handlers} />
        </>
      ) : (
        <>
          <p className="muted">{`No arc for ${entry.name ?? 'this character'} in this book.`}</p>
          <p>
            <button type="button" className="btn" disabled={starting} onClick={() => onStart?.()}>
              Start an arc
            </button>
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The Arc section with its data and writes: GET /arcs and /flow, the arc whose `character_id` is the entry's id, and Undo in its own toast.
 * @param {{ bookId: string, entry: any }} props
 */
export function ArcPanel({ bookId, entry }) {
  const { status } = useStatus();
  const [bump, setBump] = useState(0);
  const version = `${bookVersion(status, bookId)}|${bump}`;
  const refresh = useCallback(() => setBump((n) => n + 1), []);
  const book = useMemo(() => ({ id: bookId }), [bookId]);
  const structure = useStructure({ book, activeId: null, onChanged: refresh });
  const arcs = useApi(arcsUrl(bookId), version);
  const flow = useApi(flowUrl(bookId), version);
  const writes = useArcWrites({ bookId, structure, refresh });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const arc = arcs.data?.arcs?.find((a) => a.character_id === entry.id) ?? null;

  async function start() {
    setStarting(true);
    setStartError(null);
    const r = await writes.create({ character: entry.id });
    setStarting(false);
    if (!r.ok) setStartError(r.message);
  }

  return (
    <>
      <ArcPanelView
        bookId={bookId}
        entry={entry}
        arc={arc}
        scenes={flow.data?.nodes ?? []}
        loading={arcs.loading && !arcs.data}
        error={startError ?? (arcs.error ? 'The arcs could not be loaded.' : null)}
        state={arc && writes.state.slug === arc.slug ? writes.state : {}}
        handlers={arc ? writes.handlersFor(arc) : {}}
        onStart={start}
        starting={starting}
      />
      {structure.ui}
    </>
  );
}
