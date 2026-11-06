import { useState } from 'react';
import { Dialog } from '../shell/Dialog.jsx';
import { describeLink } from './model.js';
import { RELATIONS, relationLabel } from './requests.js';

/**
 * The side panel for one selected link: its two scenes (buttons that select them), the relation and the rationale to edit, and Reverse direction and Archive.
 * Presentational: `link` is one of GET /links `links`; `nodeById` the live scenes of GET /flow. The container gives it a `key` that changes with the link's sha256, so a
 * reload starts it from what is on disk.
 * @param {{ link: any, nodeById?: Map<string, any> | null, busy?: boolean, message?: string | null, error?: string | null,
 *   handlers?: { onSelectNode?: (id: string) => void, onSave?: (link: any, patch: { relation?: string, rationale?: string }) => void, onReverse?: (link: any) => void, onArchive?: (link: any) => void } }} props
 */
export function LinkPanel({ link, nodeById = null, busy = false, message = null, error = null, handlers = {} }) {
  const [relation, setRelation] = useState(link.relation);
  const [rationale, setRationale] = useState(link.rationale ?? '');
  const [confirming, setConfirming] = useState(false);
  const d = describeLink(link, nodeById);
  const patch = {
    ...(relation !== link.relation ? { relation } : {}),
    ...(rationale !== (link.rationale ?? '') ? { rationale } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  return (
    <section className="flow-panel" aria-labelledby="link-panel-h">
      <h2 id="link-panel-h">Link</h2>
      <p className="flow-sentence">{d.sentence}</p>
      <dl className="flow-ends">
        <dt>From</dt>
        <dd>
          <button type="button" className="btn btn-small" disabled={Boolean(nodeById) && !nodeById.has(link.from)} onClick={() => handlers.onSelectNode?.(link.from)}>
            {d.from}
          </button>
        </dd>
        <dt>To</dt>
        <dd>
          <button type="button" className="btn btn-small" disabled={Boolean(nodeById) && !nodeById.has(link.to)} onClick={() => handlers.onSelectNode?.(link.to)}>
            {d.to}
          </button>
        </dd>
      </dl>
      <form
        className="flow-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) handlers.onSave?.(link, patch);
        }}
      >
        <div className="form-row">
          <label htmlFor="link-relation">Relation</label>
          <select id="link-relation" value={relation} onChange={(e) => setRelation(e.target.value)}>
            {RELATIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {relationLabel(r.value)}
              </option>
            ))}
            {!RELATIONS.some((r) => r.value === link.relation) && <option value={link.relation}>{relationLabel(link.relation)}</option>}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="link-rationale">Rationale</label>
          <textarea id="link-rationale" rows={4} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        </div>
        {message && (
          <p className="muted" role="status">
            {message}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="flow-actions">
          <button type="submit" className="btn btn-primary" disabled={!changed || busy}>
            Save
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(true)}>
            Reverse direction
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => handlers.onArchive?.(link)}>
            Archive
          </button>
        </div>
      </form>
      {confirming && (
        <Dialog label="Reverse direction" onClose={() => setConfirming(false)}>
          <h2>Reverse direction?</h2>
          <p>
            Now: <strong>{d.sentence}</strong>
          </p>
          <p>
            After: <strong>{`${d.to} — ${relationLabel(link.relation)} → ${d.from}`}</strong>
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setConfirming(false);
                handlers.onReverse?.(link);
              }}
            >
              Reverse
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
