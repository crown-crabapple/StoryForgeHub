import { useState } from 'react';
import { Link } from '../router.jsx';
import { BeatSheetEditor } from './BeatSheetEditor.jsx';
import { planHref } from './requests.js';

/** The name of a structure, with the primary one marked in words. */
const tabName = (s) => `${s.name}${s.primary ? ' (Primary)' : ''}`;

/** The name of the structure as a labelled input with its own Save button. */
function NameForm({ saved, onSave }) {
  const [text, setText] = useState(saved);
  const changed = text.trim() !== saved && text.trim() !== '';
  return (
    <form
      className="st-name"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave?.(text.trim());
      }}
    >
      <label htmlFor="st-name">Structure name</label>
      <input id="st-name" type="text" value={text} autoComplete="off" onChange={(e) => setText(e.target.value)} />
      <div>
        <button type="submit" className="btn" disabled={!changed}>
          Save name
        </button>
      </div>
    </form>
  );
}

/** The notes text of a structure, with an explicit Save button. */
function Notes({ saved, onSave }) {
  const [text, setText] = useState(saved);
  const changed = text !== saved;
  return (
    <form
      className="st-notes"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) onSave?.(text);
      }}
    >
      <label htmlFor="st-notes">Notes</label>
      <textarea id="st-notes" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      <div>
        <button type="submit" className="btn" disabled={!changed}>
          Save notes
        </button>
      </div>
    </form>
  );
}

/**
 * The Structure view of the Plan tab: one tab per structure (the primary one marked "Primary"), and the selected structure's name, template, notes, primary and archive
 * buttons, and beat sheet. Presentational.
 * @param {{ bookId: string, structures: { structures: any[], archived?: any[] } | null, flow: { nodes: any[] } | null, url: ReturnType<typeof import('./model.js').parsePlanSearch>,
 *   state?: { message?: string | null, error?: string | null, busy?: boolean },
 *   handlers?: { onNewStructure?: () => void, onSetPrimary?: (structure: any) => void, onRestore?: (archived: any) => void,
 *     onSaveName?: (name: string) => void, onSaveNotes?: (text: string) => void, onSaveBeats?: (list: any[]) => void, onArchive?: () => void } }} props
 *   `handlers` for the selected structure come from `useStructureWrites().handlersFor`; the primary (else the first) structure is shown when `url.structure` names none.
 */
export function StructureView({ bookId, structures, flow, url, state = {}, handlers = {} }) {
  const live = structures?.structures ?? [];
  const archived = structures?.archived ?? [];
  const selected = url.structure ? live.find((s) => s.slug === url.structure) : (live.find((s) => s.primary) ?? live[0]);
  return (
    <div className="st-view">
      {live.length > 0 && (
        <div className="flow-toolbar">
          <button type="button" className="btn btn-primary" onClick={() => handlers.onNewStructure?.()}>
            New structure…
          </button>
        </div>
      )}
      {structures === null || flow === null ? (
        <p className="muted">Loading…</p>
      ) : live.length === 0 ? (
        <section className="plan-block st-empty">
          <h2>No structures yet</h2>
          <p>A structure is optional guidance: a beat sheet you can lay your scenes against, or ignore.</p>
          <p>
            <button type="button" className="btn btn-primary" onClick={() => handlers.onNewStructure?.()}>
              New structure
            </button>
          </p>
        </section>
      ) : (
        <>
          <nav aria-label="Structures">
            <ul className="st-tabs">
              {live.map((s) => (
                <li key={s.slug}>
                  <Link to={planHref(bookId, { view: 'structure', structure: s.slug })} className="view-tab" aria-current={selected?.slug === s.slug ? 'page' : undefined}>
                    {tabName(s)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {selected ? (
            <section className="plan-block st-sheet" aria-labelledby="st-sheet-h">
              <h2 id="st-sheet-h">{tabName(selected)}</h2>
              {state.message && (
                <p className="muted" role="status">
                  {state.message}
                </p>
              )}
              {state.error && (
                <p className="error" role="alert">
                  {state.error}
                </p>
              )}
              <p className="muted st-template-line">{`Template: ${selected.template} (version ${selected.template_version})`}</p>
              <p className="muted">{`${selected.counts?.beats ?? selected.beats.length} beats, ${selected.counts?.assigned ?? 0} with scenes, ${selected.counts?.omitted ?? 0} omitted.`}</p>
              <NameForm key={`name:${selected.sha256}:${selected.name}`} saved={selected.name} onSave={handlers.onSaveName} />
              <Notes key={`notes:${selected.sha256}`} saved={selected.body ?? ''} onSave={handlers.onSaveNotes} />
              <div className="st-actions">
                {selected.primary ? (
                  <p className="st-primary-note">This is the primary structure.</p>
                ) : (
                  <button type="button" className="btn" onClick={() => handlers.onSetPrimary?.(selected)}>
                    Set as primary
                  </button>
                )}
                <button type="button" className="btn" onClick={() => handlers.onArchive?.()}>
                  Archive structure
                </button>
              </div>
              <BeatSheetEditor key={`beats:${selected.slug}:${selected.sha256}`} structure={selected} scenes={flow?.nodes ?? []} busy={state.busy} onSave={handlers.onSaveBeats} />
            </section>
          ) : (
            <p className="muted">That structure is not there any more.</p>
          )}
        </>
      )}
      {archived.length > 0 && (
        <details className="flow-archived">
          <summary>{`Archived structures (${archived.length})`}</summary>
          <ul className="flow-unlinked">
            {archived.map((a) => (
              <li key={a.slug}>
                <span>{a.name || a.slug}</span>{' '}
                <button type="button" className="btn btn-small" aria-label={`Restore ${a.name || a.slug}`} onClick={() => handlers.onRestore?.(a)}>
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
